//! Native file accounting, snapshot backups and offline compaction.

use crate::application::{ApplicationGenerationIdentity, ApplicationTransactions};
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
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
    if !valid_update_id(&update_id)
        || catalog_sha256.len() != 64
        || !catalog_sha256.bytes().all(lower_hex)
    {
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
    store.metadata().await?;
    let identity = ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await?
        .ok_or(Error::IncompatibleStore)?;
    Ok((store, identity))
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
        })
    })();
    remove_owned_staging(&staging, &staged_identity);
    published
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
            let home = temp.path().parent().unwrap().to_owned();
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
}
