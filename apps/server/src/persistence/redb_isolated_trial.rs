use super::{
    IsolatedTrialPreparation, IsolatedTrialRequest, IsolatedTrialVerification,
    MAX_TRIAL_FILE_BYTES, TrialFileIdentity, TrialRestoreDirectories, TrialSnapshot,
    checked_generation, io_error, trial_file_digest, trial_file_identity,
    validate_isolated_trial_preparation, verify_restore_snapshot,
};
use crate::application_bootstrap::bootstrap_schema_sha256;
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const MAX_RECEIPT_BYTES: u64 = 8 * 1024;

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

fn read_preparation_receipt(path: &Path) -> Result<Option<IsolatedTrialVerification>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(Error::IncompatibleStore);
        }
        Err(error) => return Err(io_error(error)),
    };
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_RECEIPT_BYTES {
        return Err(Error::IncompatibleStore);
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(Error::IncompatibleStore);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| Error::IncompatibleStore)
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

    async fn verify_candidate(&self, preparation: &IsolatedTrialPreparation) -> Result<()> {
        let candidate = TrialInput::open(self.trial.clone(), &preparation.snapshot).await?;
        if candidate.identity != preparation.database || candidate.sha256 != preparation.file_sha256
        {
            return Err(Error::IncompatibleStore);
        }
        candidate.store.verify_bootstrap_schema().await?;
        self.verify_inputs()?;
        candidate.verify()
    }

    fn sync_publication(&self) -> Result<()> {
        self.directories
            .state
            .sync_all()
            .map_err(|_| Error::UnknownCommit)
    }
}

pub(super) async fn verify(
    home: PathBuf,
    request: IsolatedTrialRequest,
    preparation: IsolatedTrialPreparation,
) -> Result<()> {
    let lease = TrialLease::open(home, &request).await?;
    lease.verify_candidate(&preparation).await
}

pub(super) async fn prepare(
    home: PathBuf,
    request: IsolatedTrialRequest,
) -> Result<IsolatedTrialPreparation> {
    let lease = TrialLease::open(home, &request).await?;
    let trial = &lease.trial;
    let receipt = trial.with_extension("receipt-v1.json");
    if let Some(saved) = read_preparation_receipt(&receipt)? {
        if saved.request != request {
            return Err(Error::IncompatibleStore);
        }
        validate_isolated_trial_preparation(&request, &saved.preparation)?;
        lease.verify_candidate(&saved.preparation).await?;
        lease.sync_publication()?;
        return Ok(saved.preparation);
    }
    let working = trial.with_extension("staging");
    disposable_file_exists(trial)?;
    // Without a receipt, restart from the immutable checkpoint. An interrupted
    // bootstrap may have left a partially changed copy.
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
    lease.sync_publication()?;
    lease.verify_inputs().map_err(|_| Error::UnknownCommit)?;
    let published = candidate
        .db
        .open_verified_offline_file(trial)
        .map_err(|_| Error::UnknownCommit)?;
    if trial_file_identity(&published).map_err(|_| Error::UnknownCommit)? != (database.clone(), 1) {
        return Err(Error::UnknownCommit);
    }
    let preparation = IsolatedTrialPreparation {
        update_id: request.update_id.clone(),
        database,
        snapshot: TrialSnapshot {
            catalog_sha256: generation.catalog_sha256,
            rows: fingerprint.rows,
            checksum: fingerprint.checksum,
        },
        file_sha256,
        target_schema_sha256: request.target_schema_sha256.clone(),
    };
    let verification = IsolatedTrialVerification {
        request,
        preparation,
    };
    let mut staged_receipt =
        NamedTempFile::new_in(TrialRestoreDirectories::pinned(&lease.directories.state))
            .map_err(io_error)?;
    serde_json::to_writer(staged_receipt.as_file_mut(), &verification)
        .map_err(|_| Error::UnknownCommit)?;
    staged_receipt.as_file().sync_all().map_err(io_error)?;
    staged_receipt
        .persist_noclobber(receipt)
        .map_err(|error| io_error(error.error))?;
    lease.sync_publication()?;
    Ok(verification.preparation)
}
