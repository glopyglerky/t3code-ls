//! Native file accounting, snapshot backups and offline compaction.

use crate::application::{ApplicationGenerationIdentity, ApplicationTransactions};
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrialSnapshot {
    pub catalog_sha256: String,
    pub rows: u64,
    pub checksum: String,
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

#[derive(Debug, Serialize)]
pub struct TrialRestorePreparation {
    pub staged_database: TrialFileIdentity,
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

fn valid_update_id(id: &str) -> bool {
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
fn trial_file_identity(store: &Store) -> Result<(TrialFileIdentity, u64)> {
    let metadata = store.db.offline_file_metadata()?;
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

async fn backup_trial(home: PathBuf, update_id: String, expected: String) -> Result<TrialBackup> {
    let home = fs::canonicalize(home).map_err(io_error)?;
    let state = checked_directory(home.join("userdata"))?;
    let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
    let (source, identity) = checked_checkpoint(&state.join("statev2.omdb")).await?;
    if identity.catalog_sha256 != expected {
        return Err(Error::IncompatibleStore);
    }
    owner.verify_native()?;
    source.db.verify_identity()?;
    #[cfg(unix)]
    let (database, _) = trial_file_identity(&source)?;

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
    if !home.is_absolute()
        || !valid_update_id(&update_id)
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

#[cfg(unix)]
async fn verify_restore_snapshot(path: &Path, expected: &TrialSnapshot) -> Result<Store> {
    const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
    let store = Store {
        db: Backend::open_bounded_offline_snapshot(path, MAX_FILE_BYTES).await?,
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
    let checkpoint = verify_restore_snapshot(&checkpoint_path, &request.checkpoint).await?;
    let live = verify_restore_snapshot(&state.join("statev2.omdb"), &request.target).await?;
    if trial_file_identity(&live)? != (request.database, 1) {
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
            let (staged_database, links) = trial_file_identity(&existing)?;
            if staged_database.created.is_none() {
                return Err(Error::IncompatibleStore);
            }
            verify_inputs()?;
            existing.db.verify_identity()?;
            if links == 2 && path_identity(&draft)? == path_identity(&stage)? {
                fs::remove_file(&draft).map_err(|_| Error::UnknownCommit)?;
            } else if links != 1 {
                return Err(Error::IncompatibleStore);
            }
            sync_publication(&state, &home).map_err(|_| Error::UnknownCommit)?;
            if trial_file_identity(&existing).map_err(|_| Error::UnknownCommit)?
                != (staged_database.clone(), 1)
            {
                return Err(Error::UnknownCommit);
            }
            verify_inputs().map_err(|_| Error::UnknownCommit)?;
            return Ok(TrialRestorePreparation {
                staged_database,
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
    let (staged_database, links) = trial_file_identity(&restored)?;
    if links != 1 || staged_database.created.is_none() {
        return Err(Error::IncompatibleStore);
    }
    let draft_file = path_identity(&draft)?;
    verify_inputs()?;
    restored.db.verify_identity()?;
    fs::hard_link(&draft, &stage).map_err(io_error)?;
    // Remove the scratch name before returning a single-link stage for normal retry.
    fs::remove_file(&draft).map_err(|_| Error::UnknownCommit)?;
    sync_publication(&state, &home).map_err(|_| Error::UnknownCommit)?;
    verify_inputs().map_err(|_| Error::UnknownCommit)?;
    if path_identity(&stage).map_err(|_| Error::UnknownCommit)? != draft_file {
        return Err(Error::UnknownCommit);
    }
    Ok(TrialRestorePreparation {
        staged_database,
        reused: false,
    })
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
