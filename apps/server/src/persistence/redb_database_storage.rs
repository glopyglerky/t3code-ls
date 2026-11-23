//! Native file accounting, snapshot backups and offline compaction.

use crate::application::{
    ApplicationGenerationIdentity, ApplicationTransactions, PreparedServiceActivation,
};
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
#[cfg(unix)]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[cfg(unix)]
const MAX_TRIAL_FILE_BYTES: u64 = 128 * 1024 * 1024;
#[cfg(unix)]
const MAX_TRIAL_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;

#[cfg(target_os = "linux")]
#[path = "redb_isolated_trial.rs"]
mod isolated;

#[derive(Debug, Deserialize, Serialize)]
pub struct StorageStatistics {
    pub database_bytes: u64,
    /// Guaranteed removable file bytes. Zero until the engine exposes a shrink prediction.
    pub reclaimable_bytes: u64,
    /// Conservative reusable free-page capacity, not a promise of filesystem shrink.
    pub reusable_bytes: u64,
    pub fragmented_bytes: u64,
    pub allocated_bytes: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StorageBackup {
    pub rows: u64,
    pub bytes: u64,
    pub checksum: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StorageCompaction {
    pub before_bytes: u64,
    pub after_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct TrialBackup {
    pub backup: StorageBackup,
    pub reused: bool,
    #[cfg(unix)]
    pub database: TrialFileIdentity,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialFileIdentity {
    pub device: String,
    pub inode: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialSnapshot {
    pub catalog_sha256: String,
    pub rows: u64,
    pub checksum: String,
}

#[cfg(unix)]
#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct TrialBackupReceipt {
    database: TrialFileIdentity,
    snapshot: TrialSnapshot,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IsolatedTrialRequest {
    pub update_id: String,
    /// Identity returned by the original checkpoint command.
    pub database: TrialFileIdentity,
    /// Both the stopped live store and the original checkpoint must match.
    pub checkpoint: TrialSnapshot,
    /// SHA-256 of the expected candidate's bundled omdb-schema.json.
    pub target_schema_sha256: String,
    /// Native protocol-5 trials additionally bind their installed target artifacts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<PreparedServiceActivation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IsolatedTrialPreparation {
    pub update_id: String,
    pub database: TrialFileIdentity,
    pub snapshot: TrialSnapshot,
    pub file_sha256: String,
    pub target_schema_sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IsolatedTrialVerification {
    pub request: IsolatedTrialRequest,
    pub preparation: IsolatedTrialPreparation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_observation: Option<CandidatePreparationObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_intent: Option<NativePromotionIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_publication: Option<SealedPromotionPublication>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SealedPromotionPhase {
    Publishing,
    Published,
    RollingBack,
    RolledBack,
    ForwardCommitted,
}

/// Durable state of a sealed trial; this never selects or unseals a runtime.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SealedPromotionPublication {
    pub version: u32,
    pub selection_sha256: String,
    pub phase: SealedPromotionPhase,
}

/// A recorded decision to pursue promotion, never authority to serve the stage.
/// Update, target artifacts, stage and checkpoint remain bound by the enclosing receipt.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativePromotionIntent {
    pub version: u32,
    pub verification_sha256: String,
    pub source_entry_sha256: String,
    pub source_helper_sha256: String,
    pub source_helper_schema_sha256: String,
}

pub async fn record_native_promotion_intent(
    home: PathBuf,
    update_id: String,
    intent: NativePromotionIntent,
) -> Result<serde_json::Value> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::IncompatibleStore);
    }
    #[cfg(target_os = "linux")]
    return tokio::spawn(isolated::record_promotion_intent(home, update_id, intent))
        .await
        .map_err(|_| Error::IncompatibleStore)?;
    #[cfg(not(target_os = "linux"))]
    Err(Error::IncompatibleStore)
}

/// Exact input and response observed by the stopped launcher caller.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidatePreparationObservation {
    pub verification_json: String,
    pub witness: CandidatePreparationWitness,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidatePreparationWitness {
    pub protocol: u32,
    pub status: String,
    pub update_id: String,
    pub target_version: String,
    pub entry_sha256: String,
    pub helper_sha256: String,
    pub verification_sha256: String,
}

pub async fn record_isolated_candidate_preparation(
    home: PathBuf,
    update_id: String,
    observation: CandidatePreparationObservation,
) -> Result<serde_json::Value> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::IncompatibleStore);
    }
    #[cfg(target_os = "linux")]
    return tokio::spawn(isolated::record_observation(home, update_id, observation))
        .await
        .map_err(|_| Error::IncompatibleStore)?;
    #[cfg(not(target_os = "linux"))]
    Err(Error::IncompatibleStore)
}

#[derive(Debug, Serialize)]
pub struct IsolatedTrialSelection {
    pub update_id: String,
    pub from_version: String,
    pub target_version: String,
    pub source_database: TrialFileIdentity,
    pub prepared_database: TrialFileIdentity,
}

#[derive(Debug, Serialize)]
pub struct IsolatedTrialPublication {
    pub activation: PreparedServiceActivation,
    pub database: TrialFileIdentity,
    pub preserved_database: TrialFileIdentity,
    pub reused: bool,
}

/// Publish the still-sealed candidate while preserving its stopped predecessor.
/// The sealed catalog keeps ordinary server startup fenced pending activation.
pub async fn publish_isolated_service_trial(
    home: PathBuf,
    update_id: String,
) -> Result<IsolatedTrialPublication> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::Invalid("invalid isolated trial selection".into()));
    }
    #[cfg(target_os = "linux")]
    return tokio::spawn(isolated::move_sealed(
        home,
        update_id,
        isolated::SealedMove::Publish,
    ))
    .await
    .map_err(|_| Error::UnknownCommit)?;
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated service trial publication is unsupported on this platform".into(),
    ))
}

/// Explicitly publish an intended candidate while keeping its catalog sealed.
pub async fn publish_intended_isolated_service_trial(
    home: PathBuf,
    update_id: String,
) -> Result<IsolatedTrialPublication> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::Invalid("invalid intended trial publication".into()));
    }
    #[cfg(target_os = "linux")]
    return tokio::spawn(isolated::move_sealed(
        home,
        update_id,
        isolated::SealedMove::PublishIntended,
    ))
    .await
    .map_err(|_| Error::UnknownCommit)?;
    #[cfg(not(target_os = "linux"))]
    Err(Error::IncompatibleStore)
}

/// Restore the original inode while the canonical store still matches the sealed trial.
pub async fn rollback_isolated_service_trial(
    home: PathBuf,
    update_id: String,
) -> Result<IsolatedTrialPublication> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::Invalid("invalid isolated trial selection".into()));
    }
    #[cfg(target_os = "linux")]
    return tokio::spawn(isolated::move_sealed(
        home,
        update_id,
        isolated::SealedMove::Rollback,
    ))
    .await
    .map_err(|_| Error::UnknownCommit)?;
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated service trial rollback is unsupported on this platform".into(),
    ))
}

/// Inspect a pending selection together with its durable native trial.
/// The observation grants no authority after the ownership leases are dropped.
pub async fn inspect_isolated_service_trial_selection(
    home: PathBuf,
    update_id: String,
    from_version: String,
    target_version: String,
) -> Result<IsolatedTrialSelection> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::Invalid("invalid isolated trial selection".into()));
    }
    #[cfg(target_os = "linux")]
    {
        isolated::inspect_selection(home, update_id, from_version, target_version).await
    }
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated trial selection inspection is unsupported on this platform".into(),
    ))
}

#[cfg(target_os = "linux")]
const SEALED_GENERIC_RESTORE_FENCE_VERSION: u32 = 1;

/// The launcher reads this before stopping an active runtime for a native trial.
pub fn service_trial_capabilities() -> Result<serde_json::Value> {
    #[cfg(target_os = "linux")]
    {
        Ok(serde_json::json!({
            "version": 1,
            "engine": "omdb",
            "engineRevision": crate::application::OMDB_REVISION,
            "targetSchemaSha256": crate::application_bootstrap::bootstrap_schema_sha256(),
            "sealedTrialRollback": 1,
            "promotionIntent": 1,
            "sealedIntentPublication": 1,
            "sealedGenericRestoreFence": SEALED_GENERIC_RESTORE_FENCE_VERSION,
        }))
    }
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated service trials are unsupported on this platform".into(),
    ))
}

// Only the process fixture can make an irreversible decision until a forward
// completion path can reopen the same profile.
#[cfg(all(test, target_os = "linux"))]
pub(crate) async fn record_fixture_forward_commit(
    home: PathBuf,
    update_id: String,
) -> Result<bool> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::IncompatibleStore);
    }
    isolated::record_forward_commit(home, update_id).await
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) async fn record_fixture_forward_selection(
    home: PathBuf,
    update_id: String,
) -> Result<bool> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::IncompatibleStore);
    }
    isolated::record_forward_selection(home, update_id).await
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) async fn record_fixture_forward_catalog(
    home: PathBuf,
    update_id: String,
) -> Result<bool> {
    if !home.is_absolute() || !valid_update_id(&update_id) {
        return Err(Error::IncompatibleStore);
    }
    // Keep the trial leases on the worker if the caller drops its future.
    tokio::spawn(isolated::record_forward_catalog(home, update_id))
        .await
        .map_err(|_| Error::UnknownCommit)?
}

fn validate_isolated_trial_request(
    home: &Path,
    update_id: &str,
    request: &IsolatedTrialRequest,
) -> Result<()> {
    if !home.is_absolute()
        || !valid_update_id(update_id)
        || update_id != request.update_id
        || request.database.created.is_none()
        || !valid_digest(&request.checkpoint.catalog_sha256)
        || !valid_digest(&request.checkpoint.checksum)
        || !valid_digest(&request.target_schema_sha256)
    {
        return Err(Error::Invalid("invalid isolated trial identity".into()));
    }
    if let Some(activation) = &request.activation {
        activation.validate()?;
        if activation.update_id != update_id
            || activation.target_schema_sha256 != request.target_schema_sha256
        {
            return Err(Error::IncompatibleStore);
        }
    }
    Ok(())
}

/// Exercise the candidate's native bootstrap on a private copy of an offline
/// checkpoint. A retry reuses the verified preparation stored under this ID.
pub async fn prepare_isolated_service_trial(
    home: PathBuf,
    update_id: String,
    request: IsolatedTrialRequest,
) -> Result<IsolatedTrialPreparation> {
    validate_isolated_trial_request(&home, &update_id, &request)?;
    #[cfg(target_os = "linux")]
    {
        // The worker owns the home and database leases through completion,
        // even if the caller drops its future.
        tokio::spawn(isolated::prepare(home, request))
            .await
            .map_err(|_| Error::UnknownCommit)?
    }
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated trial preparation is unsupported on this platform".into(),
    ))
}

/// Revalidate a preparation receipt against the stopped source, checkpoint and
/// trial. This read-only check grants no authority after the leases are dropped.
pub async fn verify_isolated_service_trial(
    home: PathBuf,
    update_id: String,
    verification: IsolatedTrialVerification,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    isolated::validate_observation(&verification)?;
    let IsolatedTrialVerification {
        request,
        preparation,
        ..
    } = verification;
    validate_isolated_trial_request(&home, &update_id, &request)?;
    validate_isolated_trial_preparation(&request, &preparation)?;
    #[cfg(target_os = "linux")]
    {
        isolated::verify(home, request, preparation).await
    }
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "isolated trial verification is unsupported on this platform".into(),
    ))
}

fn validate_isolated_trial_preparation(
    request: &IsolatedTrialRequest,
    preparation: &IsolatedTrialPreparation,
) -> Result<()> {
    if preparation.update_id != request.update_id
        || preparation.database == request.database
        || preparation.database.created.is_none()
        || preparation.target_schema_sha256 != request.target_schema_sha256
        || !valid_digest(&preparation.file_sha256)
        || !valid_digest(&preparation.snapshot.catalog_sha256)
        || !valid_digest(&preparation.snapshot.checksum)
    {
        return Err(Error::Invalid("invalid isolated trial preparation".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrialRestorePhase {
    FailedBeforeActivation,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialRestoreRequest {
    pub update_id: String,
    pub phase: TrialRestorePhase,
    /// The live file identity recorded before the candidate started.
    pub database: TrialFileIdentity,
    pub checkpoint: TrialSnapshot,
    /// An independently recorded candidate snapshot while activation was still fenced.
    /// A scan performed after a failed child exits cannot establish that fence.
    pub target: TrialSnapshot,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialRestorePreparation {
    pub staged_database: TrialFileIdentity,
    pub staged_file_sha256: String,
    pub reused: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TrialRestoreWitness {
    /// The offline operator independently witnessed the failed pre-activation trial
    /// and holds exclusive control of the home namespace through publication.
    OfflinePreActivation { target_file_sha256: String },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialRestorePublicationRequest {
    pub restore: TrialRestoreRequest,
    pub preparation: TrialRestorePreparation,
    pub witness: TrialRestoreWitness,
}

#[derive(Debug, Serialize)]
pub struct TrialRestorePublication {
    pub database: TrialFileIdentity,
    pub preserved_database: TrialFileIdentity,
    pub reused: bool,
}

/// Publish a checkpoint of the stopped service's active native store. An existing
/// checkpoint is reusable only while the live store still matches it. Dirty
/// stores require the separate startup recovery path before this can run.
pub async fn backup_service_trial(
    home: PathBuf,
    update_id: String,
    catalog_sha256: String,
) -> Result<TrialBackup> {
    if !home.is_absolute() {
        return Err(Error::Invalid("service home must be absolute".into()));
    }
    if !valid_update_id(&update_id) || !valid_digest(&catalog_sha256) {
        return Err(Error::Invalid("invalid update or catalog identity".into()));
    }
    // Dropping a caller's future must not release the home lease while the
    // blocking snapshot worker is still writing its staging file.
    tokio::spawn(backup_trial(home, update_id, catalog_sha256))
        .await
        .map_err(|_| Error::UnknownCommit)?
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(lower_hex)
}

pub(crate) fn valid_update_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => lower_hex(byte),
        })
}

fn io_error(_: io::Error) -> Error {
    Error::Database("trial checkpoint filesystem operation failed".into())
}

fn checked_directory(path: PathBuf) -> Result<PathBuf> {
    if fs::canonicalize(&path).map_err(io_error)? != path
        || !fs::symlink_metadata(&path).map_err(io_error)?.is_dir()
    {
        return Err(Error::IncompatibleStore);
    }
    Ok(path)
}

#[cfg(unix)]
fn sync_publication(directory: &Path, parent: &Path) -> io::Result<()> {
    fs::File::open(directory)?.sync_all()?;
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_publication(_: &Path, _: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn read_trial_receipt<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    read_trial_file(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| Error::IncompatibleStore))
        .transpose()
}

#[cfg(unix)]
const MAX_TRIAL_RECEIPT_BYTES: usize = 8 * 1024;

#[cfg(unix)]
fn read_trial_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let limit = MAX_TRIAL_RECEIPT_BYTES as u64;
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
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > limit {
        return Err(Error::IncompatibleStore);
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_TRIAL_RECEIPT_BYTES {
        return Err(Error::IncompatibleStore);
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn write_trial_receipt(path: &Path, directory: &Path, receipt: &impl Serialize) -> Result<()> {
    let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(io_error)?;
    serde_json::to_writer(staged.as_file_mut(), receipt).map_err(|_| Error::UnknownCommit)?;
    staged.as_file().sync_all().map_err(io_error)?;
    staged
        .persist_noclobber(path)
        .map_err(|error| io_error(error.error))?;
    Ok(())
}

async fn checked_checkpoint(path: &Path) -> Result<(Store, ApplicationGenerationIdentity)> {
    let store = Store {
        db: Backend::open_offline_snapshot(path).await?,
    };
    let identity = checked_generation(&store).await?;
    Ok((store, identity))
}

async fn checked_generation(store: &Store) -> Result<ApplicationGenerationIdentity> {
    store.metadata().await?;
    ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await?
        .ok_or(Error::IncompatibleStore)
}

#[cfg(unix)]
fn trial_file_identity(file: &fs::File) -> Result<(TrialFileIdentity, u64)> {
    let metadata = file.metadata().map_err(io_error)?;
    let created = metadata
        .created()
        .ok()
        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|created| created.as_nanos().to_string());
    Ok((
        TrialFileIdentity {
            device: format!("{:016x}", metadata.dev()),
            inode: format!("{:016x}", metadata.ino()),
            created,
        },
        metadata.nlink(),
    ))
}

#[cfg(unix)]
fn trial_file_digest(file: &fs::File) -> Result<String> {
    bounded_trial_digest(file, MAX_TRIAL_FILE_BYTES)
}

#[cfg(unix)]
fn trial_executable_digest(file: &fs::File) -> Result<String> {
    // The SEA includes Node and the application. Its bound is independent of
    // the database snapshot and native helper bounds.
    bounded_trial_digest(file, MAX_TRIAL_EXECUTABLE_BYTES)
}

#[cfg(unix)]
fn bounded_trial_digest(file: &fs::File, limit: u64) -> Result<String> {
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() || before.len() > limit {
        return Err(Error::IncompatibleStore);
    }
    let mut input = file.take(limit + 1);
    let mut digest = Sha256::new();
    let mut buffer = [0; 32 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            let after = file.metadata().map_err(io_error)?;
            if before.dev() != after.dev()
                || before.ino() != after.ino()
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Err(Error::IncompatibleStore);
            }
            return Ok(digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect());
        }
        if input.limit() == 0 {
            return Err(Error::IncompatibleStore);
        }
        digest.update(&buffer[..count]);
    }
}

async fn backup_trial(home: PathBuf, update_id: String, expected: String) -> Result<TrialBackup> {
    let home = fs::canonicalize(home).map_err(io_error)?;
    let state = checked_directory(home.join("userdata"))?;
    let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
    let live_path = state.join("statev2.omdb");
    let (source, identity) = checked_checkpoint(&live_path).await?;
    if identity.catalog_sha256 != expected {
        return Err(Error::IncompatibleStore);
    }
    owner.verify_native()?;
    source.db.verify_identity()?;
    #[cfg(unix)]
    let (database, _) = trial_file_identity(&source.db.open_verified_offline_file(&live_path)?)?;

    let runtime = checked_directory(home.join("runtime"))?;
    let directory = runtime.join("native-db-backup");
    let builder = &mut fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    match builder.create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_error(error)),
    }
    let directory = checked_directory(directory)?;
    let destination = directory.join(format!("{update_id}.omdb"));
    #[cfg(unix)]
    let (receipt_path, receipt) = {
        let path = directory.join(format!("{update_id}.backup-receipt-v1.json"));
        let receipt = read_trial_receipt::<TrialBackupReceipt>(&path)?;
        if receipt.as_ref().is_some_and(|saved| {
            saved.database != database || saved.snapshot.catalog_sha256 != identity.catalog_sha256
        }) {
            return Err(Error::IncompatibleStore);
        }
        (path, receipt)
    };
    // The exclusive home lease serializes reuse of this update's staging name.
    let staging = directory.join(format!("{update_id}.staging"));
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let (checkpoint, recorded) = checked_checkpoint(&destination).await?;
            if recorded != identity {
                return Err(Error::IncompatibleStore);
            }
            let backup = checkpoint.db.storage_fingerprint().await?;
            let current = source.db.storage_fingerprint().await?;
            #[cfg(unix)]
            if !receipt.as_ref().is_some_and(|saved| {
                saved.snapshot.rows == backup.rows && saved.snapshot.checksum == backup.checksum
            }) {
                return Err(Error::IncompatibleStore);
            }
            if current.rows != backup.rows || current.checksum != backup.checksum {
                return Err(Error::IncompatibleStore);
            }
            sync_publication(&directory, &runtime).map_err(|_| Error::UnknownCommit)?;
            owner.verify_native()?;
            source.db.verify_identity()?;
            checkpoint.db.verify_identity()?;
            let published_identity = path_identity(&destination)?;
            remove_owned_staging(&staging, &published_identity);
            return Ok(TrialBackup {
                backup,
                reused: true,
                #[cfg(unix)]
                database,
            });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }

    match fs::remove_file(&staging) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    let (backup, staged_identity) = source.db.storage_backup(staging.clone()).await?;
    let published = (|| {
        owner.verify_native()?;
        source.db.verify_identity()?;
        if path_identity(&staging)? != staged_identity {
            return Err(Error::IncompatibleStore);
        }
        #[cfg(unix)]
        {
            let verified = TrialBackupReceipt {
                database: database.clone(),
                snapshot: TrialSnapshot {
                    catalog_sha256: identity.catalog_sha256,
                    rows: backup.rows,
                    checksum: backup.checksum.clone(),
                },
            };
            if let Some(saved) = &receipt {
                if saved != &verified {
                    return Err(Error::IncompatibleStore);
                }
            } else {
                write_trial_receipt(&receipt_path, &directory, &verified)?;
            }
            // Bind the update ID to this stopped file before making the backup visible.
            sync_publication(&directory, &runtime).map_err(|_| Error::UnknownCommit)?;
        }
        // A hard link publishes the verified file without replacing a prior backup.
        fs::hard_link(&staging, &destination).map_err(io_error)?;
        sync_publication(&directory, &runtime).map_err(|_| Error::UnknownCommit)?;
        owner.verify_native().map_err(|_| Error::UnknownCommit)?;
        source
            .db
            .verify_identity()
            .map_err(|_| Error::UnknownCommit)?;
        if path_identity(&destination).map_err(|_| Error::UnknownCommit)? != staged_identity {
            return Err(Error::UnknownCommit);
        }
        Ok(TrialBackup {
            backup,
            reused: false,
            #[cfg(unix)]
            database,
        })
    })();
    remove_owned_staging(&staging, &staged_identity);
    published
}

/// Prepare a separately verified replacement file. Keep both original database
/// files intact and leave live publication to the launcher's recovery protocol.
pub async fn prepare_service_trial_restore(
    home: PathBuf,
    update_id: String,
    request: TrialRestoreRequest,
) -> Result<TrialRestorePreparation> {
    validate_trial_restore_request(&home, &update_id, &request)?;
    #[cfg(unix)]
    {
        // Keep the ownership leases alive if the request future is cancelled
        // while a blocking storage worker is verifying or writing the stage.
        tokio::spawn(prepare_trial_restore(home, request))
            .await
            .map_err(|_| Error::UnknownCommit)?
    }
    #[cfg(not(unix))]
    Err(Error::Invalid(
        "trial restore preparation is unsupported on this platform".into(),
    ))
}

fn validate_trial_restore_request(
    home: &Path,
    update_id: &str,
    request: &TrialRestoreRequest,
) -> Result<()> {
    if !home.is_absolute()
        || !valid_update_id(update_id)
        || update_id != request.update_id
        || [&request.checkpoint, &request.target]
            .iter()
            .any(|snapshot| {
                !valid_digest(&snapshot.catalog_sha256) || !valid_digest(&snapshot.checksum)
            })
    {
        return Err(Error::Invalid("invalid trial restore identity".into()));
    }
    if request.database.created.is_none() {
        return Err(Error::Invalid(
            "trial restore requires a recorded file creation time".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
async fn verify_restore_snapshot(path: &Path, expected: &TrialSnapshot) -> Result<Store> {
    let store = Store {
        db: Backend::open_bounded_offline_snapshot(path, MAX_TRIAL_FILE_BYTES).await?,
    };
    let actual = store.db.bounded_storage_fingerprint().await?;
    let catalog = checked_generation(&store).await?;
    if catalog.catalog_sha256 != expected.catalog_sha256
        || actual.rows != expected.rows
        || actual.checksum != expected.checksum
    {
        return Err(Error::IncompatibleStore);
    }
    Ok(store)
}

#[cfg(unix)]
async fn verify_generic_restore_snapshot(path: &Path, expected: &TrialSnapshot) -> Result<Store> {
    let store = verify_restore_snapshot(path, expected).await?;
    // A generic restore cannot consume an isolated trial or forward catalog.
    ApplicationTransactions::new(store.clone()).schema().await?;
    Ok(store)
}

#[cfg(unix)]
async fn prepare_trial_restore(
    home: PathBuf,
    request: TrialRestoreRequest,
) -> Result<TrialRestorePreparation> {
    let TrialRestorePhase::FailedBeforeActivation = request.phase;
    let home = checked_directory(home)?;
    let state = checked_directory(home.join("userdata"))?;
    let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
    let backups = checked_directory(home.join("runtime").join("native-db-backup"))?;
    let checkpoint_path = backups.join(format!("{}.omdb", request.update_id));
    let checkpoint = verify_generic_restore_snapshot(&checkpoint_path, &request.checkpoint).await?;
    let live_path = state.join("statev2.omdb");
    let live = verify_generic_restore_snapshot(&live_path, &request.target).await?;
    if trial_file_identity(&live.db.open_verified_offline_file(&live_path)?)?
        != (request.database, 1)
    {
        return Err(Error::IncompatibleStore);
    }

    let verify_inputs = || {
        owner.verify_native()?;
        checkpoint.db.verify_identity()?;
        live.db.verify_identity()
    };
    let stage = state.join(format!(".statev2-restore-{}.omdb", request.update_id));
    let draft = stage.with_extension("staging");
    match fs::symlink_metadata(&stage) {
        Ok(_) => {
            let existing = verify_restore_snapshot(&stage, &request.checkpoint).await?;
            let staged_file = existing.db.open_verified_offline_file(&stage)?;
            let (staged_database, links) = trial_file_identity(&staged_file)?;
            if staged_database.created.is_none() {
                return Err(Error::IncompatibleStore);
            }
            let staged_file_sha256 = trial_file_digest(&staged_file)?;
            verify_inputs()?;
            existing.db.verify_identity()?;
            if links == 2 && path_identity(&draft)? == path_identity(&stage)? {
                fs::remove_file(&draft).map_err(|_| Error::UnknownCommit)?;
            } else if links != 1 {
                return Err(Error::IncompatibleStore);
            }
            sync_publication(&state, &home).map_err(|_| Error::UnknownCommit)?;
            existing
                .db
                .verify_identity()
                .map_err(|_| Error::UnknownCommit)?;
            if trial_file_identity(&staged_file).map_err(|_| Error::UnknownCommit)?
                != (staged_database.clone(), 1)
            {
                return Err(Error::UnknownCommit);
            }
            verify_inputs().map_err(|_| Error::UnknownCommit)?;
            return Ok(TrialRestorePreparation {
                staged_database,
                staged_file_sha256,
                reused: true,
            });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }

    verify_inputs()?;
    match fs::symlink_metadata(&draft) {
        Ok(_) => {} // A prior attempt left this name. Validate it before using it.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            checkpoint.db.storage_backup(draft.clone()).await?;
        }
        Err(error) => return Err(io_error(error)),
    }
    let restored = verify_restore_snapshot(&draft, &request.checkpoint).await?;
    let staged_file = restored.db.open_verified_offline_file(&draft)?;
    let (staged_database, links) = trial_file_identity(&staged_file)?;
    if links != 1 || staged_database.created.is_none() {
        return Err(Error::IncompatibleStore);
    }
    let staged_file_sha256 = trial_file_digest(&staged_file)?;
    verify_inputs()?;
    restored.db.verify_identity()?;
    fs::hard_link(&draft, &stage).map_err(io_error)?;
    // Remove the scratch name before returning a single-link stage for normal retry.
    fs::remove_file(&draft).map_err(|_| Error::UnknownCommit)?;
    sync_publication(&state, &home).map_err(|_| Error::UnknownCommit)?;
    verify_inputs().map_err(|_| Error::UnknownCommit)?;
    let published = restored
        .db
        .open_verified_offline_file(&stage)
        .map_err(|_| Error::UnknownCommit)?;
    if trial_file_identity(&published).map_err(|_| Error::UnknownCommit)?
        != (staged_database.clone(), 1)
    {
        return Err(Error::UnknownCommit);
    }
    Ok(TrialRestorePreparation {
        staged_database,
        staged_file_sha256,
        reused: false,
    })
}

/// Publish a prepared restore during an offline, independently witnessed failed trial.
/// The caller must retain the original witness and preparation receipt across retries.
/// Launcher integration requires a separate trusted pre-activation witness protocol.
pub async fn publish_service_trial_restore(
    home: PathBuf,
    update_id: String,
    request: TrialRestorePublicationRequest,
) -> Result<TrialRestorePublication> {
    validate_trial_restore_request(&home, &update_id, &request.restore)?;
    let TrialRestoreWitness::OfflinePreActivation { target_file_sha256 } = &request.witness;
    if request.preparation.staged_database.created.is_none()
        || request.preparation.staged_database == request.restore.database
        || !valid_digest(&request.preparation.staged_file_sha256)
        || !valid_digest(target_file_sha256)
    {
        return Err(Error::Invalid("invalid trial publication identity".into()));
    }
    #[cfg(target_os = "linux")]
    {
        tokio::spawn(publish_trial_restore(home, request))
            .await
            .map_err(|_| Error::UnknownCommit)?
    }
    #[cfg(not(target_os = "linux"))]
    Err(Error::Invalid(
        "trial restore publication is unsupported on this platform".into(),
    ))
}

#[cfg(target_os = "linux")]
struct TrialRestoreDirectories {
    state: fs::File,
    runtime: fs::File,
    backups: fs::File,
}

#[cfg(target_os = "linux")]
impl TrialRestoreDirectories {
    fn open(home: &Path) -> Result<Self> {
        use std::path::Component;

        let mut directory = Self::open_directory(Path::new("/"))?;
        for component in home.components().skip(1) {
            let Component::Normal(name) = component else {
                return Err(Error::IncompatibleStore);
            };
            directory = Self::open_directory(&Self::pinned(&directory).join(name))?;
        }
        let home = Self::pinned(&directory);
        let state = Self::open_directory(&home.join("userdata"))?;
        let runtime = Self::open_directory(&home.join("runtime"))?;
        let backups = Self::open_directory(&Self::pinned(&runtime).join("native-db-backup"))?;
        Ok(Self {
            state,
            runtime,
            backups,
        })
    }

    fn open_directory(path: &Path) -> Result<fs::File> {
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| match error.raw_os_error() {
                Some(libc::ELOOP | libc::ENOTDIR) => Error::IncompatibleStore,
                _ => io_error(error),
            })
    }

    fn pinned(directory: &fs::File) -> PathBuf {
        // Each real path component is opened separately with O_NOFOLLOW. Use the
        // held directory for all database opens, link, rename and directory sync.
        PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
    }

    fn verify(&self, home: &Path) -> Result<()> {
        let current = Self::open(home)?;
        for (pinned, current) in [
            (&self.state, &current.state),
            (&self.runtime, &current.runtime),
            (&self.backups, &current.backups),
        ] {
            let before = pinned.metadata().map_err(io_error)?;
            let now = current.metadata().map_err(io_error)?;
            if (before.dev(), before.ino()) != (now.dev(), now.ino()) {
                return Err(Error::IncompatibleStore);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn trial_entry_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

#[cfg(target_os = "linux")]
fn verify_trial_file(
    store: &Store,
    path: &Path,
    expected: &TrialFileIdentity,
    links: u64,
) -> Result<fs::File> {
    let file = store.db.open_verified_offline_file(path)?;
    let (actual, actual_links) = trial_file_identity(&file)?;
    if &actual != expected || actual_links != links {
        return Err(Error::IncompatibleStore);
    }
    Ok(file)
}

#[cfg(target_os = "linux")]
async fn publish_trial_restore(
    home: PathBuf,
    request: TrialRestorePublicationRequest,
) -> Result<TrialRestorePublication> {
    let TrialRestorePublicationRequest {
        restore,
        preparation,
        witness,
    } = request;
    let TrialRestorePhase::FailedBeforeActivation = restore.phase;
    let TrialRestoreWitness::OfflinePreActivation { target_file_sha256 } = witness;
    let directories = TrialRestoreDirectories::open(&home)?;
    let state = TrialRestoreDirectories::pinned(&directories.state);
    let backups = TrialRestoreDirectories::pinned(&directories.backups);
    let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
    let live = state.join("statev2.omdb");
    let stage = state.join(format!(".statev2-restore-{}.omdb", restore.update_id));
    let preserved = state.join(format!(".statev2-failed-{}.omdb", restore.update_id));
    let checkpoint_path = backups.join(format!("{}.omdb", restore.update_id));
    let reused = !trial_entry_exists(&stage)?;

    let result = async {
        let checkpoint = verify_restore_snapshot(&checkpoint_path, &restore.checkpoint).await?;
        let has_preserved = trial_entry_exists(&preserved)?;
        let (failed_path, prepared_path) = if reused {
            (&preserved, &live)
        } else {
            (&live, &stage)
        };
        let failed = verify_generic_restore_snapshot(failed_path, &restore.target).await?;
        // A rename retry reads the canonical file as the prepared image.
        let prepared = verify_generic_restore_snapshot(prepared_path, &restore.checkpoint).await?;
        let failed_links = if !reused && has_preserved { 2 } else { 1 };
        let failed_file = verify_trial_file(&failed, failed_path, &restore.database, failed_links)?;
        let prepared_file =
            verify_trial_file(&prepared, prepared_path, &preparation.staged_database, 1)?;
        if trial_file_digest(&failed_file)? != target_file_sha256
            || trial_file_digest(&prepared_file)? != preparation.staged_file_sha256
        {
            return Err(Error::IncompatibleStore);
        }

        let verify_inputs = || {
            directories.verify(&home)?;
            owner.verify_native()?;
            checkpoint.db.verify_identity()
        };
        verify_inputs()?;
        if !reused {
            if has_preserved {
                verify_trial_file(&failed, &preserved, &restore.database, 2)?;
            }
            prepared_file.sync_all().map_err(io_error)?;
            failed.db.verify_identity()?;
            prepared.db.verify_identity()?;
            verify_inputs()?;
            if !has_preserved {
                fs::hard_link(&live, &preserved).map_err(io_error)?;
            }
            // Commit preservation of the old inode before replacing its live name.
            // Hold both exclusive engine locks across the replacement and final sync.
            failed_file.sync_all().map_err(|_| Error::UnknownCommit)?;
            directories
                .state
                .sync_all()
                .map_err(|_| Error::UnknownCommit)?;
            #[cfg(test)]
            tests::interrupt_trial_publication("preserved");
            verify_inputs().map_err(|_| Error::UnknownCommit)?;
            failed
                .db
                .verify_identity()
                .map_err(|_| Error::UnknownCommit)?;
            prepared
                .db
                .verify_identity()
                .map_err(|_| Error::UnknownCommit)?;
            verify_trial_file(&failed, &preserved, &restore.database, 2)
                .map_err(|_| Error::UnknownCommit)?;
            fs::rename(&stage, &live).map_err(|_| Error::UnknownCommit)?;
            #[cfg(test)]
            tests::interrupt_trial_publication("renamed");
        }

        directories
            .state
            .sync_all()
            .map_err(|_| Error::UnknownCommit)?;
        verify_inputs().map_err(|_| Error::UnknownCommit)?;
        verify_trial_file(&failed, &preserved, &restore.database, 1)
            .map_err(|_| Error::UnknownCommit)?;
        verify_trial_file(&prepared, &live, &preparation.staged_database, 1)
            .map_err(|_| Error::UnknownCommit)?;
        if trial_entry_exists(&stage).map_err(|_| Error::UnknownCommit)? {
            return Err(Error::UnknownCommit);
        }
        Ok(TrialRestorePublication {
            database: preparation.staged_database,
            preserved_database: restore.database,
            reused,
        })
    }
    .await;
    if reused {
        result.map_err(|_| Error::UnknownCommit)
    } else {
        result
    }
}

fn remove_owned_staging(path: &Path, expected: &same_file::Handle) {
    if path_identity(path).is_ok_and(|identity| identity == *expected) {
        let _ = fs::remove_file(path);
    }
}

impl Store {
    pub async fn open_exclusive(path: impl AsRef<Path>) -> Result<Self> {
        let store = Self {
            db: crate::backend::Backend::open_exclusive(path).await?,
        };
        store.metadata().await?;
        Ok(store)
    }
    pub async fn storage_statistics(&self) -> Result<StorageStatistics> {
        self.db.storage_statistics().await
    }
    pub async fn storage_backup(&self, destination: PathBuf) -> Result<StorageBackup> {
        self.db
            .storage_backup(destination)
            .await
            .map(|(backup, _)| backup)
    }
    pub async fn storage_compact(&self) -> Result<StorageCompaction> {
        self.db.storage_compact().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestFixture;

    const UPDATE: &str = "aa212c2b-63d4-4b28-97e4-1c1d6dc6d281";

    #[cfg(unix)]
    #[test]
    fn service_trial_executable_hash_has_an_independent_bound() {
        use std::io::Seek;

        let mut file = tempfile::tempfile().unwrap();
        file.set_len(MAX_TRIAL_FILE_BYTES + 1).unwrap();
        assert!(matches!(
            trial_file_digest(&file),
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(trial_executable_digest(&file).unwrap().len(), 64);
        file.rewind().unwrap();
        file.set_len(MAX_TRIAL_EXECUTABLE_BYTES + 1).unwrap();
        assert!(matches!(
            trial_executable_digest(&file),
            Err(Error::IncompatibleStore)
        ));

        let file = tempfile::tempfile().unwrap();
        file.set_len(8).unwrap();
        assert!(bounded_trial_digest(&file, 8).is_ok());
        file.set_len(9).unwrap();
        assert!(matches!(
            bounded_trial_digest(&file, 8),
            Err(Error::IncompatibleStore)
        ));
    }

    struct TrialFixture {
        _temp: TestFixture,
        home: PathBuf,
        owner: PathBuf,
        database: PathBuf,
        backups: PathBuf,
        catalog: String,
    }

    impl TrialFixture {
        async fn start() -> Self {
            let temp = TestFixture::start().await;
            let home = fs::canonicalize(temp.path().parent().unwrap()).unwrap();
            let state = home.join("userdata");
            let runtime = home.join("runtime");
            fs::create_dir(&state).unwrap();
            fs::create_dir(&runtime).unwrap();
            let owner = state.join("server-owner.sqlite");
            let database = state.join("statev2.omdb");
            let lock = OwnerLock::acquire(&owner).unwrap();
            let store = Store::initialize_local(&database).await.unwrap();
            store.bootstrap_application().await.unwrap();
            let catalog = ApplicationTransactions::new(store.clone())
                .generation_identity()
                .await
                .unwrap()
                .unwrap()
                .catalog_sha256;
            store.shutdown().await.unwrap();
            lock.activate_native().unwrap();
            Self {
                _temp: temp,
                home,
                owner,
                database,
                backups: runtime.join("native-db-backup"),
                catalog,
            }
        }

        async fn backup(&self) -> Result<TrialBackup> {
            backup_service_trial(self.home.clone(), UPDATE.into(), self.catalog.clone()).await
        }

        #[cfg(unix)]
        async fn restore_request(&self) -> TrialRestoreRequest {
            let original = self.backup().await.unwrap();
            let store = Store::open_local(&self.database).await.unwrap();
            let mut transaction = store.db.begin().await.unwrap();
            transaction
                .insert(
                    crate::store_key("fixture/trial-only"),
                    b"migration".to_vec(),
                )
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            store.shutdown().await.unwrap();
            let (live, _) = checked_checkpoint(&self.database).await.unwrap();
            let target = live.db.storage_fingerprint().await.unwrap();
            TrialRestoreRequest {
                update_id: UPDATE.into(),
                phase: TrialRestorePhase::FailedBeforeActivation,
                database: original.database,
                checkpoint: TrialSnapshot {
                    catalog_sha256: self.catalog.clone(),
                    rows: original.backup.rows,
                    checksum: original.backup.checksum,
                },
                target: TrialSnapshot {
                    catalog_sha256: self.catalog.clone(),
                    rows: target.rows,
                    checksum: target.checksum,
                },
            }
        }

        #[cfg(unix)]
        async fn prepare(&self, request: TrialRestoreRequest) -> Result<TrialRestorePreparation> {
            prepare_service_trial_restore(self.home.clone(), UPDATE.into(), request).await
        }

        #[cfg(unix)]
        fn restore_stage(&self) -> PathBuf {
            self.database
                .with_file_name(format!(".statev2-restore-{UPDATE}.omdb"))
        }

        #[cfg(target_os = "linux")]
        async fn publication_request(&self) -> TrialRestorePublicationRequest {
            let restore = self.restore_request().await;
            let preparation = self.prepare(restore.clone()).await.unwrap();
            let target_file_sha256 =
                trial_file_digest(&fs::File::open(&self.database).unwrap()).unwrap();
            TrialRestorePublicationRequest {
                restore,
                preparation,
                witness: TrialRestoreWitness::OfflinePreActivation { target_file_sha256 },
            }
        }

        #[cfg(target_os = "linux")]
        async fn publish(
            &self,
            request: &TrialRestorePublicationRequest,
        ) -> Result<TrialRestorePublication> {
            let replay = serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
            publish_service_trial_restore(self.home.clone(), UPDATE.into(), replay).await
        }

        #[cfg(target_os = "linux")]
        fn failed_trial(&self) -> PathBuf {
            self.database
                .with_file_name(format!(".statev2-failed-{UPDATE}.omdb"))
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn interrupt_trial_publication(boundary: &str) {
        if std::env::var("T3_TEST_INTERRUPT_TRIAL_PUBLICATION").as_deref() == Ok(boundary) {
            // Exit the fixture process without unwinding or dropping the lock handles.
            std::process::exit(73);
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn trial_publication_interrupt_fixture() {
        let Some(home) = std::env::var_os("T3_TEST_TRIAL_PUBLICATION_HOME").map(PathBuf::from)
        else {
            return;
        };
        assert!(
            home.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("t3-redb-test-"))
        );
        let request =
            serde_json::from_slice(&fs::read(home.join("witness.json")).unwrap()).unwrap();
        publish_service_trial_restore(home, UPDATE.into(), request)
            .await
            .unwrap();
        panic!("fixture did not interrupt publication");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn isolated_trial_refuses_generic_pre_activation_restore() {
        let fixture = TrialFixture::start().await;
        let mut request = fixture.publication_request().await;
        let stage = fixture.restore_stage();
        let checkpoint = fixture.backups.join(format!("{UPDATE}.omdb"));
        let backup_receipt = fixture
            .backups
            .join(format!("{UPDATE}.backup-receipt-v1.json"));
        let checkpoint_bytes = fs::read(&checkpoint).unwrap();
        let backup_receipt_bytes = fs::read(&backup_receipt).unwrap();
        let stage_bytes = fs::read(&stage).unwrap();
        let stage_inode = path_identity(&stage).unwrap();
        let live_inode = path_identity(&fixture.database).unwrap();

        let candidate = Store::open_exclusive(&fixture.database).await.unwrap();
        let schema = crate::application_bootstrap::bootstrap_schema_sha256();
        // The generic restore update ID cannot stand in for the catalog seal.
        ApplicationTransactions::new(candidate.clone())
            .seal_service_trial(PreparedServiceActivation {
                update_id: "ba212c2b-63d4-4b28-97e4-1c1d6dc6d281".into(),
                from_version: "1.2.3".into(),
                target_version: "1.2.4".into(),
                target_entry_sha256: "a".repeat(64),
                target_helper_sha256: "b".repeat(64),
                target_schema_sha256: schema,
            })
            .await
            .unwrap();
        candidate.shutdown().await.unwrap();
        let (sealed, identity) = checked_checkpoint(&fixture.database).await.unwrap();
        let fingerprint = sealed.db.bounded_storage_fingerprint().await.unwrap();
        request.restore.target = TrialSnapshot {
            catalog_sha256: identity.catalog_sha256,
            rows: fingerprint.rows,
            checksum: fingerprint.checksum,
        };
        let file = sealed
            .db
            .open_verified_offline_file(&fixture.database)
            .unwrap();
        let target_file_sha256 = trial_file_digest(&file).unwrap();
        assert_eq!(
            trial_file_identity(&file).unwrap(),
            (request.restore.database.clone(), 1)
        );
        request.witness = TrialRestoreWitness::OfflinePreActivation { target_file_sha256 };
        drop(file);
        sealed.shutdown().await.unwrap();
        let sealed_bytes = fs::read(&fixture.database).unwrap();

        let saved_stage = stage.with_extension("saved");
        fs::rename(&stage, &saved_stage).unwrap();
        assert!(matches!(
            fixture.prepare(request.restore.clone()).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(!stage.exists());
        assert!(!stage.with_extension("staging").exists());
        fs::rename(&saved_stage, &stage).unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(!fixture.failed_trial().exists());
        assert_eq!(fs::read(&stage).unwrap(), stage_bytes);
        assert_eq!(path_identity(&stage).unwrap(), stage_inode);
        assert_eq!(fs::read(&fixture.database).unwrap(), sealed_bytes);
        assert_eq!(path_identity(&fixture.database).unwrap(), live_inode);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
        assert_eq!(fs::read(&backup_receipt).unwrap(), backup_receipt_bytes);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn service_trial_publication_retries_both_interrupted_boundaries() {
        let fixture = TrialFixture::start().await;
        let request = fixture.publication_request().await;
        let checkpoint = fixture.backups.join(format!("{UPDATE}.omdb"));
        let checkpoint_bytes = fs::read(&checkpoint).unwrap();
        let failed_bytes = fs::read(&fixture.database).unwrap();
        let staged_bytes = fs::read(fixture.restore_stage()).unwrap();
        assert_ne!(failed_bytes, staged_bytes);

        fs::write(
            fixture.home.join("witness.json"),
            serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        let interrupt = |boundary| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "application_storage::tests::trial_publication_interrupt_fixture",
                ])
                .env("T3_TEST_TRIAL_PUBLICATION_HOME", &fixture.home)
                .env("T3_TEST_INTERRUPT_TRIAL_PUBLICATION", boundary)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(73), "{output:?}");
        };

        interrupt("preserved");
        assert_eq!(fs::read(&fixture.database).unwrap(), failed_bytes);
        assert_eq!(
            path_identity(&fixture.database).unwrap(),
            path_identity(&fixture.failed_trial()).unwrap()
        );
        assert_eq!(fs::read(fixture.restore_stage()).unwrap(), staged_bytes);
        interrupt("renamed");
        assert_eq!(fs::read(&fixture.database).unwrap(), staged_bytes);
        assert!(!fixture.restore_stage().exists());

        let completed = fixture.publish(&request).await.unwrap();
        assert!(completed.reused);
        assert_eq!(completed.database, request.preparation.staged_database);
        assert_eq!(completed.preserved_database, request.restore.database);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
        assert_eq!(fs::read(fixture.failed_trial()).unwrap(), failed_bytes);
        let live = Store::open_local(&fixture.database).await.unwrap();
        assert!(
            live.db
                .read(&crate::store_key("fixture/trial-only"))
                .await
                .unwrap()
                .is_none()
        );
        let mut transaction = live.db.begin().await.unwrap();
        transaction
            .insert(crate::store_key("fixture/new-commit"), b"keep".to_vec())
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        live.shutdown().await.unwrap();
        let newer_bytes = fs::read(&fixture.database).unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::UnknownCommit)
        ));
        assert_eq!(fs::read(&fixture.database).unwrap(), newer_bytes);
        assert_eq!(fs::read(fixture.failed_trial()).unwrap(), failed_bytes);
        assert_eq!(fs::read(checkpoint).unwrap(), checkpoint_bytes);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn service_trial_publication_refuses_busy_redirected_or_changed_inputs() {
        let fixture = TrialFixture::start().await;
        let mut request = fixture.publication_request().await;
        let stage = fixture.restore_stage();
        let original_bytes = fs::read(&fixture.database).unwrap();
        let hold = OwnerLock::acquire(&fixture.owner).unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::WriterBusy)
        ));
        drop(hold);
        for path in [&fixture.database, &stage] {
            let reader = Store::open_read_only(path).await.unwrap();
            assert!(matches!(
                fixture.publish(&request).await,
                Err(Error::WriterBusy)
            ));
            reader.shutdown().await.unwrap();
        }

        let redirected_state = fixture.home.join("redirected-state");
        let state = fixture.database.parent().unwrap();
        fs::rename(state, &redirected_state).unwrap();
        std::os::unix::fs::symlink(&redirected_state, state).unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        fs::remove_file(state).unwrap();
        fs::rename(&redirected_state, state).unwrap();

        let alternate = stage.with_extension("alternate");
        fs::rename(&stage, &alternate).unwrap();
        fs::copy(&alternate, &stage).unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        fs::rename(&alternate, &stage).unwrap();
        let stage_digest =
            std::mem::replace(&mut request.preparation.staged_file_sha256, "0".repeat(64));
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        request.preparation.staged_file_sha256 = stage_digest;
        let TrialRestoreWitness::OfflinePreActivation { target_file_sha256 } = &mut request.witness;
        let target_digest = std::mem::replace(target_file_sha256, "0".repeat(64));
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        request.witness = TrialRestoreWitness::OfflinePreActivation {
            target_file_sha256: target_digest,
        };
        fs::write(fixture.failed_trial(), b"unrelated data").unwrap();
        assert!(matches!(
            fixture.publish(&request).await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(fs::read(fixture.failed_trial()).unwrap(), b"unrelated data");
        assert_eq!(fs::read(&fixture.database).unwrap(), original_bytes);
        assert!(stage.is_file());
    }

    #[tokio::test]
    async fn service_trial_backup_refuses_home_and_database_owners_without_writes() {
        let fixture = TrialFixture::start().await;
        let database_bytes = fs::read(&fixture.database).unwrap();
        let owner_bytes = fs::read(&fixture.owner).unwrap();

        let owner = OwnerLock::acquire(&fixture.owner).unwrap();
        assert!(matches!(fixture.backup().await, Err(Error::WriterBusy)));
        drop(owner);
        let reader = Store::open_read_only(&fixture.database).await.unwrap();
        assert!(matches!(fixture.backup().await, Err(Error::WriterBusy)));
        reader.shutdown().await.unwrap();
        let mismatched =
            backup_service_trial(fixture.home.clone(), UPDATE.into(), "0".repeat(64)).await;
        assert!(matches!(mismatched, Err(Error::IncompatibleStore)));

        assert!(!fixture.backups.exists());
        assert_eq!(fs::read(&fixture.database).unwrap(), database_bytes);
        assert_eq!(fs::read(&fixture.owner).unwrap(), owner_bytes);
    }

    #[tokio::test]
    async fn service_trial_backup_reuses_the_original_and_refuses_diverged_source() {
        let fixture = TrialFixture::start().await;
        let database_bytes = fs::read(&fixture.database).unwrap();
        let destination = fixture.backups.join(format!("{UPDATE}.omdb"));
        let staging = fixture.backups.join(format!("{UPDATE}.staging"));
        fs::create_dir(&fixture.backups).unwrap();
        fs::write(&staging, b"interrupted pre-publication write").unwrap();

        let original = fixture.backup().await.unwrap();
        assert!(!original.reused);
        assert!(!staging.exists());
        let backup_bytes = fs::read(&destination).unwrap();
        assert_eq!(fs::read(&fixture.database).unwrap(), database_bytes);

        fs::hard_link(&destination, &staging).unwrap();
        let replay = fixture.backup().await.unwrap();
        assert!(replay.reused);
        assert_eq!(replay.backup.rows, original.backup.rows);
        assert_eq!(replay.backup.checksum, original.backup.checksum);
        assert!(!staging.exists());
        assert_eq!(fs::read(&destination).unwrap(), backup_bytes);

        let store = Store::open_local(&fixture.database).await.unwrap();
        let mut transaction = store.db.begin().await.unwrap();
        transaction
            .insert(
                crate::store_key("fixture/trial-write"),
                b"new state".to_vec(),
            )
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        store.shutdown().await.unwrap();
        let diverged = fs::read(&fixture.database).unwrap();
        assert_ne!(diverged, database_bytes);
        assert!(matches!(
            fixture.backup().await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(fs::read(&destination).unwrap(), backup_bytes);
        assert_eq!(fs::read(&fixture.database).unwrap(), diverged);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_trial_backup_binds_the_update_to_the_original_database_file() {
        let fixture = TrialFixture::start().await;
        let original = fixture.backup().await.unwrap();
        let destination = fixture.backups.join(format!("{UPDATE}.omdb"));
        let staging = fixture.backups.join(format!("{UPDATE}.staging"));
        let receipt = fixture
            .backups
            .join(format!("{UPDATE}.backup-receipt-v1.json"));
        let receipt_bytes = fs::read(&receipt).unwrap();

        // Model a stop after the receipt is durable and before the backup link is published.
        fs::rename(&destination, &staging).unwrap();
        let completed = fixture.backup().await.unwrap();
        assert!(!completed.reused);
        assert_eq!(completed.database, original.database);
        assert_eq!(completed.backup.checksum, original.backup.checksum);
        assert_eq!(fs::read(&receipt).unwrap(), receipt_bytes);

        let displaced = fixture.database.with_extension("original");
        fs::rename(&fixture.database, &displaced).unwrap();
        fs::copy(&displaced, &fixture.database).unwrap();
        let checkpoint = fs::read(&destination).unwrap();
        assert!(matches!(
            fixture.backup().await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(fs::read(&destination).unwrap(), checkpoint);
        assert_eq!(fs::read(&receipt).unwrap(), receipt_bytes);
        assert_eq!(
            fs::read(&fixture.database).unwrap(),
            fs::read(&displaced).unwrap()
        );

        fs::rename(&displaced, &fixture.database).unwrap();
        fs::remove_file(&receipt).unwrap();
        assert!(matches!(
            fixture.backup().await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(fs::read(&destination).unwrap(), checkpoint);
        assert!(!receipt.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_trial_backup_refuses_a_redirected_database() {
        let fixture = TrialFixture::start().await;
        let target = fixture.database.with_file_name("other.omdb");
        fs::rename(&fixture.database, &target).unwrap();
        std::os::unix::fs::symlink(&target, &fixture.database).unwrap();
        let bytes = fs::read(&target).unwrap();

        assert!(matches!(
            fixture.backup().await,
            Err(Error::IncompatibleStore)
        ));
        assert!(!fixture.backups.exists());
        assert_eq!(fs::read_link(&fixture.database).unwrap(), target);
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_trial_restore_prepares_reopenable_database_and_reuses_after_publication_crash()
    {
        let fixture = TrialFixture::start().await;
        let request = fixture.restore_request().await;
        let original = fixture.backups.join(format!("{UPDATE}.omdb"));
        let stage = fixture.restore_stage();
        let original_bytes = fs::read(&original).unwrap();
        let live_bytes = fs::read(&fixture.database).unwrap();

        let staged = fixture.prepare(request.clone()).await.unwrap();
        assert!(!staged.reused);
        assert_ne!(staged.staged_database, request.database);
        let reopened = Store::open_read_only(&stage).await.unwrap();
        assert_eq!(
            reopened.db.storage_fingerprint().await.unwrap().checksum,
            request.checkpoint.checksum
        );
        assert!(
            reopened
                .db
                .read(&crate::store_key("fixture/trial-only"))
                .await
                .unwrap()
                .is_none()
        );
        reopened.shutdown().await.unwrap();

        let draft = stage.with_extension("staging");
        fs::hard_link(&stage, &draft).unwrap();
        let replay = fixture.prepare(request).await.unwrap();
        assert!(replay.reused);
        assert_eq!(replay.staged_database, staged.staged_database);
        assert!(!draft.exists());
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        assert_eq!(fs::read(&fixture.database).unwrap(), live_bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_trial_restore_refuses_unverified_or_owned_inputs_before_staging() {
        let fixture = TrialFixture::start().await;
        let request = fixture.restore_request().await;
        let original = fixture.backups.join(format!("{UPDATE}.omdb"));
        let original_bytes = fs::read(&original).unwrap();
        let live_bytes = fs::read(&fixture.database).unwrap();

        let mut incorrect = request.clone();
        incorrect.update_id = "ba212c2b-63d4-4b28-97e4-1c1d6dc6d281".into();
        assert!(matches!(
            fixture.prepare(incorrect).await,
            Err(Error::Invalid(_))
        ));
        let mut incorrect = request.clone();
        incorrect.checkpoint.checksum = "0".repeat(64);
        assert!(matches!(
            fixture.prepare(incorrect).await,
            Err(Error::IncompatibleStore)
        ));
        let mut incorrect = request.clone();
        incorrect.target.checksum = "0".repeat(64);
        assert!(matches!(
            fixture.prepare(incorrect).await,
            Err(Error::IncompatibleStore)
        ));
        let mut incorrect = request.clone();
        incorrect.database.inode = "0".repeat(16);
        assert!(matches!(
            fixture.prepare(incorrect).await,
            Err(Error::IncompatibleStore)
        ));

        let owner = OwnerLock::acquire(&fixture.owner).unwrap();
        assert!(matches!(
            fixture.prepare(request.clone()).await,
            Err(Error::WriterBusy)
        ));
        drop(owner);
        let reader = Store::open_read_only(&fixture.database).await.unwrap();
        assert!(matches!(
            fixture.prepare(request.clone()).await,
            Err(Error::WriterBusy)
        ));
        reader.shutdown().await.unwrap();

        let moved_owner = fixture.owner.with_extension("saved");
        fs::rename(&fixture.owner, &moved_owner).unwrap();
        assert!(fixture.prepare(request.clone()).await.is_err());
        assert!(!fixture.owner.exists());
        fs::rename(moved_owner, &fixture.owner).unwrap();

        let different_file = fixture.database.with_file_name("other.omdb");
        fs::copy(&fixture.database, &different_file).unwrap();
        fs::rename(&different_file, &fixture.database).unwrap();
        assert!(matches!(
            fixture.prepare(request.clone()).await,
            Err(Error::IncompatibleStore)
        ));
        fs::rename(&fixture.database, &different_file).unwrap();
        std::os::unix::fs::symlink(&different_file, &fixture.database).unwrap();
        assert!(matches!(
            fixture.prepare(request).await,
            Err(Error::IncompatibleStore)
        ));

        let stage = fixture.restore_stage();
        assert!(!stage.exists());
        assert!(!stage.with_extension("staging").exists());
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        assert_eq!(fs::read(&different_file).unwrap(), live_bytes);
        assert_eq!(fs::read_link(&fixture.database).unwrap(), different_file);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_trial_restore_preserves_later_writes_and_corrupt_checkpoint() {
        let fixture = TrialFixture::start().await;
        let request = fixture.restore_request().await;
        let original = fixture.backups.join(format!("{UPDATE}.omdb"));
        let original_bytes = fs::read(&original).unwrap();
        let store = Store::open_local(&fixture.database).await.unwrap();
        let mut transaction = store.db.begin().await.unwrap();
        transaction
            .insert(crate::store_key("fixture/later-write"), b"keep".to_vec())
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        store.shutdown().await.unwrap();
        let live_bytes = fs::read(&fixture.database).unwrap();

        assert!(matches!(
            fixture.prepare(request.clone()).await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        fs::write(&original, b"corrupt checkpoint").unwrap();
        assert!(fixture.prepare(request).await.is_err());
        assert_eq!(fs::read(&fixture.database).unwrap(), live_bytes);
        assert_eq!(fs::read(&original).unwrap(), b"corrupt checkpoint");
        let stage = fixture.restore_stage();
        assert!(!stage.exists());
        assert!(!stage.with_extension("staging").exists());
    }
}
