use super::{
    IsolatedTrialPreparation, IsolatedTrialRequest, MAX_TRIAL_FILE_BYTES, TrialFileIdentity,
    TrialRestoreDirectories, TrialSnapshot, checked_generation, io_error, trial_file_digest,
    trial_file_identity, verify_restore_snapshot,
};
use crate::application_bootstrap::bootstrap_schema_sha256;
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

struct TrialInput {
    path: PathBuf,
    store: Store,
    identity: TrialFileIdentity,
    sha256: String,
}

impl TrialInput {
    async fn open(path: PathBuf, expected: &TrialSnapshot) -> Result<Self> {
        let store = verify_restore_snapshot(&path, expected).await?;
        let file = store.db.open_verified_offline_file(&path)?;
        let (identity, links) = trial_file_identity(&file)?;
        if links != 1 {
            return Err(Error::IncompatibleStore);
        }
        Ok(Self {
            path,
            store,
            identity,
            sha256: trial_file_digest(&file)?,
        })
    }

    fn verify(&self) -> Result<()> {
        let file = self.store.db.open_verified_offline_file(&self.path)?;
        let (identity, links) = trial_file_identity(&file)?;
        if links != 1 || identity != self.identity || trial_file_digest(&file)? != self.sha256 {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }
}

fn disposable_file_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.nlink() == 1 => Ok(true),
        Ok(_) => Err(Error::IncompatibleStore),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

struct TrialLease {
    home: PathBuf,
    live: TrialInput,
    checkpoint: TrialInput,
    trial: PathBuf,
    owner: OwnerLock,
    directories: TrialRestoreDirectories,
}

impl TrialLease {
    async fn open(home: PathBuf, request: &IsolatedTrialRequest) -> Result<Self> {
        if request.target_schema_sha256 != bootstrap_schema_sha256() {
            return Err(Error::IncompatibleStore);
        }
        let directories = TrialRestoreDirectories::open(&home)?;
        let state = TrialRestoreDirectories::pinned(&directories.state);
        let backups = TrialRestoreDirectories::pinned(&directories.backups);
        let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
        let live = TrialInput::open(state.join("statev2.omdb"), &request.checkpoint).await?;
        if live.identity != request.database {
            return Err(Error::IncompatibleStore);
        }
        let checkpoint = TrialInput::open(
            backups.join(format!("{}.omdb", request.update_id)),
            &request.checkpoint,
        )
        .await?;
        let lease = Self {
            home,
            live,
            checkpoint,
            trial: state.join(format!(".statev2-trial-{}.omdb", request.update_id)),
            owner,
            directories,
        };
        lease.verify_inputs()?;
        Ok(lease)
    }

    fn verify_inputs(&self) -> Result<()> {
        self.directories.verify(&self.home)?;
        self.owner.verify_native()?;
        self.live.verify()?;
        self.checkpoint.verify()
    }
}

pub(super) async fn verify(
    home: PathBuf,
    request: IsolatedTrialRequest,
    preparation: IsolatedTrialPreparation,
) -> Result<()> {
    let lease = TrialLease::open(home, &request).await?;
    let candidate = TrialInput::open(lease.trial.clone(), &preparation.snapshot).await?;
    if candidate.identity != preparation.database || candidate.sha256 != preparation.file_sha256 {
        return Err(Error::IncompatibleStore);
    }
    candidate.store.verify_bootstrap_schema().await?;
    lease.verify_inputs()?;
    candidate.verify()
}

pub(super) async fn prepare(
    home: PathBuf,
    request: IsolatedTrialRequest,
) -> Result<IsolatedTrialPreparation> {
    let lease = TrialLease::open(home, &request).await?;
    let trial = &lease.trial;
    let working = trial.with_extension("staging");
    disposable_file_exists(trial)?;
    // An interrupted bootstrap may have partially changed its copy. Start
    // each attempt from the same checkpoint and leave the preceding result
    // available until a new candidate has been verified.
    if disposable_file_exists(&working)? {
        fs::remove_file(&working).map_err(io_error)?;
    }
    let (fingerprint, copied) = lease
        .checkpoint
        .store
        .db
        .storage_backup(working.clone())
        .await?;
    if fingerprint.rows != request.checkpoint.rows
        || fingerprint.checksum != request.checkpoint.checksum
    {
        return Err(Error::IncompatibleStore);
    }
    let staged_identity = path_identity(&working)?;
    if staged_identity != copied {
        return Err(Error::IncompatibleStore);
    }
    let candidate = Store {
        db: Backend::open_exclusive_trial(working.clone(), staged_identity).await?,
    };
    if candidate.bootstrap_application().await?.initialized {
        return Err(Error::IncompatibleStore);
    }
    candidate.shutdown().await?;

    let candidate = Store {
        db: Backend::open_bounded_offline_snapshot(&working, MAX_TRIAL_FILE_BYTES).await?,
    };
    if path_identity(&working)? != copied {
        return Err(Error::IncompatibleStore);
    }
    let generation = checked_generation(&candidate).await?;
    candidate.verify_bootstrap_schema().await?;
    let fingerprint = candidate.db.bounded_storage_fingerprint().await?;
    let file = candidate.db.open_verified_offline_file(&working)?;
    let (database, links) = trial_file_identity(&file)?;
    if links != 1 || database.created.is_none() {
        return Err(Error::IncompatibleStore);
    }
    let file_sha256 = trial_file_digest(&file)?;
    file.sync_all().map_err(io_error)?;

    lease.verify_inputs()?;
    disposable_file_exists(trial)?;
    candidate.db.verify_identity()?;
    fs::rename(&working, trial).map_err(io_error)?;
    lease
        .directories
        .state
        .sync_all()
        .map_err(|_| Error::UnknownCommit)?;
    lease.verify_inputs().map_err(|_| Error::UnknownCommit)?;
    let published = candidate
        .db
        .open_verified_offline_file(trial)
        .map_err(|_| Error::UnknownCommit)?;
    if trial_file_identity(&published).map_err(|_| Error::UnknownCommit)? != (database.clone(), 1) {
        return Err(Error::UnknownCommit);
    }
    Ok(IsolatedTrialPreparation {
        update_id: request.update_id,
        database,
        snapshot: TrialSnapshot {
            catalog_sha256: generation.catalog_sha256,
            rows: fingerprint.rows,
            checksum: fingerprint.checksum,
        },
        file_sha256,
        target_schema_sha256: request.target_schema_sha256,
    })
}
