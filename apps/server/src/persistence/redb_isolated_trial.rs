use super::{
    IsolatedTrialPreparation, IsolatedTrialRequest, IsolatedTrialSelection,
    IsolatedTrialVerification, MAX_TRIAL_FILE_BYTES, TrialBackupReceipt, TrialFileIdentity,
    TrialRestoreDirectories, TrialSnapshot, checked_generation, io_error, read_trial_receipt,
    trial_file_digest, trial_file_identity, validate_isolated_trial_preparation,
    validate_isolated_trial_request, verify_restore_snapshot, write_trial_receipt,
};
use crate::application_bootstrap::bootstrap_schema_sha256;
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::Deserialize;
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
        let receipt = read_trial_receipt::<TrialBackupReceipt>(
            &backups.join(format!("{}.backup-receipt-v1.json", request.update_id)),
        )?
        .ok_or(Error::IncompatibleStore)?;
        if receipt.database != request.database || receipt.snapshot != request.checkpoint {
            return Err(Error::IncompatibleStore);
        }
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

// Ported from cloud/serviceProtocol.ts, retained stock 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f.
// This observer compares expectations with the pending record and selects no runtime.
fn exact_service_version(value: &str) -> bool {
    regex::Regex::new(
        r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
    ).expect("service version grammar").is_match(value)
}

fn compare_service_versions(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn parts(version: &str) -> (&str, &str) {
        let version = version.split('+').next().unwrap_or_default();
        let (core, prerelease) = version.split_once('-').unwrap_or((version, ""));
        (core, prerelease)
    }
    let (left_core, left_pre) = parts(left);
    let (right_core, right_pre) = parts(right);
    let numeric = |left: &str, right: &str| left.len().cmp(&right.len()).then(left.cmp(right));
    for (left, right) in left_core.split('.').zip(right_core.split('.')) {
        let order = numeric(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    if left_pre.is_empty() || right_pre.is_empty() {
        return left_pre.is_empty().cmp(&right_pre.is_empty());
    }
    let mut left = left_pre.split('.');
    let mut right = right_pre.split('.');
    loop {
        let (a, b) = match (left.next(), right.next()) {
            (Some(a), Some(b)) => (a, b),
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        };
        let a_numeric = a.bytes().all(|byte| byte.is_ascii_digit());
        let b_numeric = b.bytes().all(|byte| byte.is_ascii_digit());
        let order = match (a_numeric, b_numeric) {
            (true, true) => numeric(a, b),
            (false, false) => a.cmp(b),
            _ => b_numeric.cmp(&a_numeric),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
}

#[cfg(test)]
#[test]
fn selection_versions_match_the_launcher_order() {
    use std::cmp::Ordering;
    let ordered = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.1.0",
        "1000000000000000000000000000.0.0",
    ];
    for pair in ordered.windows(2) {
        assert!(pair.iter().all(|version| exact_service_version(version)));
        assert_eq!(compare_service_versions(pair[0], pair[1]), Ordering::Less);
        assert_eq!(
            compare_service_versions(pair[1], pair[0]),
            Ordering::Greater
        );
    }
    assert_eq!(
        compare_service_versions("1.0.0+one", "1.0.0+two"),
        Ordering::Equal
    );
    for invalid in ["01.0.0", "1.0.0-01", "1.0.0\n", "１.0.0", "1.0", "1.0.0-"] {
        assert!(!exact_service_version(invalid));
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingSelection {
    id: String,
    from_version: String,
    target_version: String,
    db_path: PathBuf,
    status: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceSelection {
    protocol: u32,
    active_version: String,
    update: PendingSelection,
}

pub(super) async fn inspect_selection(
    home: PathBuf,
    update_id: String,
    from_version: String,
    target_version: String,
) -> Result<IsolatedTrialSelection> {
    if !exact_service_version(&from_version)
        || !exact_service_version(&target_version)
        || compare_service_versions(&target_version, &from_version) != std::cmp::Ordering::Greater
    {
        return Err(Error::Invalid("invalid service version expectation".into()));
    }
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let lease = TrialLease::open(home.clone(), &saved.request).await?;
    directories.verify(&home)?;
    let state_path =
        TrialRestoreDirectories::pinned(&lease.directories.runtime).join("service-state.json");
    let selection =
        read_trial_receipt::<ServiceSelection>(&state_path)?.ok_or(Error::IncompatibleStore)?;
    if !matches!(selection.protocol, 3 | 4)
        || selection.active_version != from_version
        || selection.update.id != update_id
        || selection.update.from_version != from_version
        || selection.update.target_version != target_version
        || selection.update.status != "pending"
        || selection.update.db_path != home.join("userdata/statev2.omdb")
    {
        return Err(Error::IncompatibleStore);
    }
    lease.verify_candidate(&saved.preparation).await?;
    if read_trial_receipt::<ServiceSelection>(&state_path)?.as_ref() != Some(&selection) {
        return Err(Error::IncompatibleStore);
    }
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
        return Err(Error::IncompatibleStore);
    }
    lease.verify_inputs()?;
    Ok(IsolatedTrialSelection {
        update_id,
        from_version,
        target_version,
        source_database: saved.request.database,
        prepared_database: saved.preparation.database,
    })
}

pub(super) async fn prepare(
    home: PathBuf,
    request: IsolatedTrialRequest,
) -> Result<IsolatedTrialPreparation> {
    let lease = TrialLease::open(home, &request).await?;
    let trial = &lease.trial;
    let receipt = trial.with_extension("receipt-v1.json");
    if let Some(saved) = read_trial_receipt::<IsolatedTrialVerification>(&receipt)? {
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
    write_trial_receipt(
        &receipt,
        &TrialRestoreDirectories::pinned(&lease.directories.state),
        &verification,
    )?;
    lease.sync_publication()?;
    Ok(verification.preparation)
}
