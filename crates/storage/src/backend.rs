use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError, mpsc};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
};

use redb::{
    BackendError, ConcurrencyMode, Database, Durability, ReadOnlyDatabase, ReadTransaction,
    ReadableDatabase, ReadableTable, StorageBackend, TableDefinition, TableHandle,
    WriteTransaction,
};
#[cfg(feature = "ordered-engine-fixture")]
use redb_bench_compare::ordered as comparison;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::application_storage::StorageBackup;
use crate::{Error, MAX_BATCH_BYTES, MAX_BATCH_RECORDS, ResourceLimit, Result};

const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("t3_code_ls_v2");
type Pair = (Vec<u8>, Vec<u8>);

fn storage_error(_: impl std::fmt::Display) -> Error {
    // Database errors may contain file names or stored keys. Keep them out of IPC/log output.
    Error::Database("redb storage operation failed".into())
}

fn worker_error(_: tokio::task::JoinError) -> Error {
    Error::Database("database worker failed".into())
}

#[derive(Clone)]
pub(crate) struct Backend {
    handles: Arc<DatabaseHandles>,
}

struct DatabaseHandles {
    path: PathBuf,
    exclusive: bool,
    read_only: bool,
    identity: Option<same_file::Handle>,
    reader: Option<ReadOnlyDatabase>,
    writer: Mutex<Option<Arc<Database>>>,
    opening: Mutex<()>,
}

impl DatabaseHandles {
    fn verify_identity(&self) -> Result<()> {
        if let Some(expected) = &self.identity {
            let actual = path_identity(&self.path)?;
            if actual != *expected {
                return Err(Error::IncompatibleStore);
            }
        }
        Ok(())
    }

    fn begin_read(&self) -> Result<ReadTransaction> {
        self.verify_identity()?;
        if let Some(writer) = self.writer.lock().map_err(storage_error)?.clone() {
            return writer.begin_read().map_err(storage_error);
        }
        self.reader
            .as_ref()
            .ok_or(Error::IncompatibleStore)?
            .begin_read()
            .map_err(storage_error)
    }

    fn try_writer(&self) -> Result<Arc<Database>> {
        if self.read_only {
            return Err(Error::Invalid(
                "read-only database handle cannot acquire a writer".into(),
            ));
        }
        self.verify_identity()?;
        if let Some(writer) = self.writer.lock().map_err(storage_error)?.clone() {
            return Ok(writer);
        }
        let _opening = match self.opening.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => return Err(Error::WriterBusy),
            Err(error) => return Err(storage_error(error)),
        };
        if let Some(writer) = self.writer.lock().map_err(storage_error)?.clone() {
            return Ok(writer);
        }
        let expected = self.identity.as_ref().ok_or(Error::IncompatibleStore)?;
        let writer = Arc::new(checked_open(&self.path, expected)?);
        self.verify_identity()?;
        validate_tables(&writer.begin_read().map_err(storage_error)?)?;
        *self.writer.lock().map_err(storage_error)? = Some(writer.clone());
        Ok(writer)
    }

    fn wait_for_writer(&self) -> Result<Arc<Database>> {
        loop {
            match self.try_writer() {
                Err(Error::WriterBusy) => std::thread::sleep(Duration::from_millis(5)),
                result => return result,
            }
        }
    }
}

fn builder() -> redb::Builder {
    let mut builder = Database::builder();
    builder
        .set_concurrency_mode(ConcurrencyMode::MultiWriter)
        .set_check_integrity_on_open(true)
        .set_cache_size(32 * 1024 * 1024);
    builder
}

fn validate_tables(transaction: &ReadTransaction) -> Result<()> {
    let names = transaction
        .list_tables()
        .map_err(storage_error)?
        .map(|table| table.name().to_owned())
        .collect::<Vec<_>>();
    if names != [TABLE.name()]
        || transaction
            .list_multimap_tables()
            .map_err(storage_error)?
            .next()
            .is_some()
    {
        return Err(Error::IncompatibleStore);
    }
    transaction
        .open_table(TABLE)
        .map_err(|_| Error::IncompatibleStore)?;
    Ok(())
}

#[derive(Debug)]
struct OpenLocks {
    opening: AtomicBool,
    writer_acquired: AtomicBool,
    busy: AtomicBool,
    mutated: AtomicBool,
}

/// redb takes the writer lock while opening a writable multi-process handle.
/// Only the initial writer acquisition is nonblocking. Once owned, redb's
/// header, recovery and consistency locks retain their normal wait behavior.
#[derive(Debug)]
struct NonblockingOpen {
    file: redb::backends::FileBackend,
    locks: Arc<OpenLocks>,
}

impl NonblockingOpen {
    fn lock(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
        shared: bool,
    ) -> std::result::Result<(), BackendError> {
        if !self.locks.opening.load(Ordering::Acquire)
            || self.locks.writer_acquired.load(Ordering::Acquire)
        {
            return if shared {
                self.file.lock_shared_range(start, end)
            } else {
                self.file.lock_range(start, end)
            };
        }
        let acquired = if shared {
            self.file.try_lock_shared_range(start, end)?
        } else {
            self.file.try_lock_range(start, end)?
        };
        if acquired {
            // In pinned redb 4.5 MultiWriter open, mode locks use try_lock_*,
            // then the first blocking exclusive acquisition is the writer lock.
            // Keep this phase separate from `opening`, which also prevents the
            // custom-backend create entry point from initializing an empty file.
            if !shared {
                self.locks.writer_acquired.store(true, Ordering::Release);
            }
            Ok(())
        } else {
            self.locks.busy.store(true, Ordering::Release);
            Err(BackendError::Io(io::Error::new(
                io::ErrorKind::WouldBlock,
                "database open lock is busy",
            )))
        }
    }
}

impl StorageBackend for NonblockingOpen {
    fn len(&self) -> io::Result<u64> {
        let length = self.file.len()?;
        // create_with_backend is redb's only writable custom-backend entry point.
        // Refuse empty files under its own open lock so this remains an open,
        // never implicit initialization of a missing or empty store.
        if self.locks.opening.load(Ordering::Acquire) && length == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "database file is empty",
            ));
        }
        Ok(length)
    }
    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.file.read(offset, out)
    }
    fn set_len(&self, length: u64) -> io::Result<()> {
        self.locks.mutated.store(true, Ordering::Release);
        self.file.set_len(length)
    }
    fn sync_data(&self) -> io::Result<()> {
        self.file.sync_data()
    }
    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.locks.mutated.store(true, Ordering::Release);
        self.file.write(offset, data)
    }
    fn close(&self) -> io::Result<()> {
        self.file.close()
    }
    fn try_lock_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        self.file.try_lock_range(start, end)
    }
    fn try_lock_shared_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        self.file.try_lock_shared_range(start, end)
    }
    fn lock_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<(), BackendError> {
        self.lock(start, end, false)
    }
    fn lock_shared_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<(), BackendError> {
        self.lock(start, end, true)
    }
    fn unlock_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<(), BackendError> {
        self.file.unlock_range(start, end)
    }
    fn query_lock_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        self.file.query_lock_range(start, end)
    }
}

#[derive(Debug)]
struct ExclusiveSnapshot(redb::backends::FileBackend);

impl StorageBackend for ExclusiveSnapshot {
    fn len(&self) -> io::Result<u64> {
        self.0.len()
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.0.read(offset, out)
    }

    fn set_len(&self, _: u64) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn write(&self, _: u64, _: &[u8]) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn sync_data(&self) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn close(&self) -> io::Result<()> {
        self.0.close()
    }

    fn try_lock_shared_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        // redb's whole-storage fallback uses the exclusive lock already held by this backend.
        match (start, end) {
            (Bound::Unbounded | Bound::Included(0), Bound::Unbounded) => Ok(true),
            _ => Err(BackendError::Unsupported),
        }
    }
}

// This adapter borrows the parent's OFD lease through a safe descriptor
// duplicate. It must never acquire, release or downgrade a physical lock.
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct InheritedTrialReader(File);

#[cfg(target_os = "linux")]
impl StorageBackend for InheritedTrialReader {
    fn len(&self) -> io::Result<u64> {
        Ok(self.0.metadata()?.len())
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        use std::os::unix::fs::FileExt;
        self.0.read_exact_at(out, offset)
    }

    fn set_len(&self, _: u64) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn write(&self, _: u64, _: &[u8]) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn sync_data(&self) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn try_lock_shared_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        match (start, end) {
            (Bound::Unbounded | Bound::Included(0), Bound::Unbounded) => Ok(true),
            _ => Err(BackendError::Unsupported),
        }
    }
}

#[cfg(target_os = "linux")]
impl Backend {
    // The readiness owner has verified the inherited whole-file write OFD lock,
    // identity and byte bound. Keep that same OFD alive through engine shutdown.
    pub(crate) async fn inherited_trial_reader(file: File, max_bytes: u64) -> Result<Self> {
        use std::os::fd::AsRawFd;
        tokio::task::spawn_blocking(move || {
            let metadata = file.metadata().map_err(storage_error)?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
                return Err(Error::IncompatibleStore);
            }
            // Fingerprint byte accounting stats this descriptor, never a database path.
            let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
            let mut options = builder();
            options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
            let reader = options
                .open_read_only_with_backend(InheritedTrialReader(file))
                .map_err(storage_error)?;
            let handles = Arc::new(DatabaseHandles {
                path,
                exclusive: false,
                read_only: true,
                identity: None,
                reader: Some(reader),
                writer: Mutex::new(None),
                opening: Mutex::new(()),
            });
            validate_tables(&handles.begin_read()?)?;
            Ok(Self { handles })
        })
        .await
        .map_err(worker_error)?
    }
}

/// Owns the physical lock independently of redb's read and write handles.
#[cfg(all(test, target_os = "linux"))]
pub(crate) struct ExclusiveTrialFile {
    inherited: File,
    file: Arc<redb::backends::FileBackend>,
    path: PathBuf,
    identity: same_file::Handle,
    max_bytes: u64,
}

#[cfg(all(test, target_os = "linux"))]
#[derive(Debug)]
struct LeasedTrialBackend {
    file: Arc<redb::backends::FileBackend>,
    writable: bool,
}

#[cfg(all(test, target_os = "linux"))]
type VerifyTrialOpen = Box<dyn FnOnce(&File) -> Result<()> + Send>;

#[cfg(all(test, target_os = "linux"))]
enum TrialOpen {
    Snapshot,
    RecoveryCopy(PathBuf),
    Writer(VerifyTrialOpen),
}

#[cfg(all(test, target_os = "linux"))]
impl StorageBackend for LeasedTrialBackend {
    fn len(&self) -> io::Result<u64> {
        self.file.len()
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.file.read(offset, out)
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        if !self.writable {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.file.set_len(len)
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        if !self.writable {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.file.write(offset, data)
    }

    fn sync_data(&self) -> io::Result<()> {
        if !self.writable {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.file.sync_data()
    }

    // Only the whole-storage fallback is supported. The engine takes and
    // releases no physical locks here, so close cannot puncture the lease.
    fn try_lock_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        if !self.writable {
            return Err(BackendError::Unsupported);
        }
        self.try_lock_shared_range(start, end)
    }

    fn try_lock_shared_range(
        &self,
        start: Bound<u64>,
        end: Bound<u64>,
    ) -> std::result::Result<bool, BackendError> {
        match (start, end) {
            (Bound::Unbounded | Bound::Included(0), Bound::Unbounded) => Ok(true),
            _ => Err(BackendError::Unsupported),
        }
    }
}

// Both fixture owners use the same native engine open. The adapter deliberately
// never forwards close/unlock to the physical lease owner.
#[cfg(all(test, target_os = "linux"))]
fn open_leased_trial_writer(file: Arc<redb::backends::FileBackend>) -> Result<Database> {
    let mut options = builder();
    options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
    options
        .create_with_backend(LeasedTrialBackend {
            file,
            writable: true,
        })
        .map_err(storage_error)
}

#[cfg(all(test, target_os = "linux"))]
fn verify_inherited_trial_lease(file: &File, max_bytes: u64) -> Result<()> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata().map_err(storage_error)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > max_bytes
    {
        return Err(Error::IncompatibleStore);
    }
    // Inspect this exact description. F_GETLK cannot identify its own OFD lock,
    // and reopening /proc/self/fd would create a different description.
    let info =
        File::open(format!("/proc/self/fdinfo/{}", file.as_raw_fd())).map_err(storage_error)?;
    let mut bytes = Vec::new();
    info.take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    if bytes.len() > 16 * 1024 {
        return Err(Error::IncompatibleStore);
    }
    let info = std::str::from_utf8(&bytes).map_err(storage_error)?;
    if !info.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() == 9
            && fields[0] == "lock:"
            && fields[2] == "OFDLCK"
            && fields[3] == "ADVISORY"
            && fields[4] == "WRITE"
            && fields[5] == "-1"
            && fields[7] == "0"
            && fields[8] == "EOF"
    }) {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
impl Backend {
    /// Synthetic writer-open seam, not an activation or serving authority.
    /// The supervisor must retain its owners and serialize ALL engine handles
    /// sharing this OFD, including snapshots, until this handle shuts down.
    /// `verify` must bind the exact file to current parent authority, receipt,
    /// selection and catalog. Possession of a locked descriptor is insufficient.
    pub(crate) async fn inherited_trial_checked_writer(
        file: File,
        max_bytes: u64,
        verify: impl FnOnce(&File) -> Result<()> + Send + 'static,
    ) -> Result<Self> {
        use std::os::fd::AsRawFd;

        tokio::task::spawn_blocking(move || {
            verify_inherited_trial_lease(&file, max_bytes)?;
            // Reject malformed/repair-required stores without permitting an
            // engine-open repair write before the authority callback.
            let preview = Self::inherited_trial_snapshot(&file)?;
            validate_tables(&preview.begin_read().map_err(storage_error)?)?;
            preview.close().map_err(storage_error)?;
            verify(&file)?;
            verify_inherited_trial_lease(&file, max_bytes)?;
            let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
            // FileBackend::new only adopts the File at the pinned revision;
            // no lock methods or close are forwarded to it by the adapter.
            let file = Arc::new(redb::backends::FileBackend::new(file).map_err(storage_error)?);
            let writer = Arc::new(open_leased_trial_writer(file)?);
            let handles = Arc::new(DatabaseHandles {
                path,
                exclusive: true,
                read_only: false,
                identity: None,
                reader: None,
                writer: Mutex::new(Some(writer)),
                opening: Mutex::new(()),
            });
            validate_tables(&handles.begin_read()?)?;
            Ok(Self { handles })
        })
        .await
        .map_err(worker_error)?
    }

    fn inherited_trial_snapshot(file: &File) -> Result<ReadOnlyDatabase> {
        let mut options = builder();
        options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
        options
            .open_read_only_with_backend(InheritedTrialReader(
                file.try_clone().map_err(storage_error)?,
            ))
            .map_err(|error| match error {
                redb::DatabaseError::RepairAborted => Error::RecoveryRequired,
                other => storage_error(other),
            })
    }
}

#[cfg(all(test, target_os = "linux"))]
impl ExclusiveTrialFile {
    pub(crate) fn acquire(path: PathBuf, max_bytes: u64) -> Result<Self> {
        // Keep the identity handle on an independent file description. The
        // last lease/backend drop must close the locked description.
        let identity = path_identity(&path)?;
        let file = open_regular_file(&path, OpenOptions::new().read(true).write(true))?;
        if file_identity(&file)? != identity {
            return Err(Error::IncompatibleStore);
        }
        // Keep flock compatibility with engines that predate the OFD ranges.
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(Error::WriterBusy),
            Err(error) => return Err(storage_error(error)),
        }
        let inherited = file.try_clone().map_err(storage_error)?;
        let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
        if !file
            .try_lock_range(Bound::Unbounded, Bound::Unbounded)
            .map_err(storage_error)?
        {
            return Err(Error::WriterBusy);
        }
        let lease = Self {
            inherited,
            file: Arc::new(file),
            path,
            identity,
            max_bytes,
        };
        lease.verified_file()?;
        Ok(lease)
    }

    // Duplicate the locked open file description, never reopen the pathname.
    pub(crate) fn inherited_file(&self) -> Result<File> {
        self.verified_file()?;
        self.inherited.try_clone().map_err(storage_error)
    }

    pub(crate) fn verified_file(&self) -> Result<File> {
        use std::os::unix::fs::MetadataExt;

        let file = open_regular_file(&self.path, OpenOptions::new().read(true))?;
        let metadata = file.metadata().map_err(storage_error)?;
        if self.identity != file_identity(&file)?
            || metadata.nlink() != 1
            || metadata.len() == 0
            || metadata.len() > self.max_bytes
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(file)
    }

    pub(crate) async fn snapshot(&self) -> Result<Backend> {
        self.open_handle(TrialOpen::Snapshot).await
    }

    pub(crate) async fn recover_copy(&self, directory: PathBuf) -> Result<Backend> {
        self.open_handle(TrialOpen::RecoveryCopy(directory)).await
    }

    pub(crate) async fn open_checked_writer(
        &self,
        verify: impl FnOnce(&File) -> Result<()> + Send + 'static,
    ) -> Result<Backend> {
        self.open_handle(TrialOpen::Writer(Box::new(verify))).await
    }

    async fn open_handle(&self, mode: TrialOpen) -> Result<Backend> {
        if Arc::strong_count(&self.file) != 1 {
            return Err(Error::WriterBusy);
        }
        let lease = Self {
            inherited: self.inherited.try_clone().map_err(storage_error)?,
            file: self.file.clone(),
            path: self.path.clone(),
            identity: path_identity(&self.path)?,
            max_bytes: self.max_bytes,
        };
        if lease.identity != self.identity {
            return Err(Error::IncompatibleStore);
        }
        tokio::task::spawn_blocking(move || {
            let mut file = lease.verified_file()?;
            let mut options = builder();
            options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
            let writable = matches!(&mode, TrialOpen::Writer(_));
            let exclusive = !matches!(&mode, TrialOpen::RecoveryCopy(_));
            let (reader, writer) = match mode {
                TrialOpen::Snapshot => {
                    let reader = options
                        .open_read_only_with_backend(LeasedTrialBackend {
                            file: lease.file,
                            writable: false,
                        })
                        .map_err(|error| match error {
                            redb::DatabaseError::RepairAborted => Error::RecoveryRequired,
                            other => storage_error(other),
                        })?;
                    (Some(reader), None)
                }
                TrialOpen::RecoveryCopy(directory) => {
                    // Repair may write during open. Inspect an unlinked copy
                    // before admitting those writes on the canonical file.
                    let mut scratch = tempfile::tempfile_in(directory).map_err(storage_error)?;
                    let mut input = io::Read::take(&mut file, lease.max_bytes.saturating_add(1));
                    let bytes = io::copy(&mut input, &mut scratch).map_err(storage_error)?;
                    if bytes == 0 || bytes > lease.max_bytes {
                        return Err(Error::IncompatibleStore);
                    }
                    let scratch =
                        redb::backends::FileBackend::new(scratch).map_err(storage_error)?;
                    let database = options
                        .create_with_backend(scratch)
                        .map_err(storage_error)?;
                    (None, Some(Arc::new(database)))
                }
                TrialOpen::Writer(verify) => {
                    verify(&file)?;
                    lease.verified_file()?;
                    let database = open_leased_trial_writer(lease.file)?;
                    (None, Some(Arc::new(database)))
                }
            };
            let handles = Arc::new(DatabaseHandles {
                path: lease.path,
                exclusive,
                read_only: !writable,
                identity: Some(lease.identity),
                reader,
                writer: Mutex::new(writer),
                opening: Mutex::new(()),
            });
            validate_tables(&handles.begin_read()?)?;
            Ok(Backend { handles })
        })
        .await
        .map_err(worker_error)?
    }
}

pub(crate) fn open_regular_file(path: &Path, options: &mut OpenOptions) -> Result<File> {
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    #[cfg(not(any(unix, windows)))]
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| !metadata.is_file())
    {
        return Err(Error::IncompatibleStore);
    }
    let file = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Error::IncompatibleStore;
        }
        storage_error(error)
    })?;
    let metadata = file.metadata().map_err(storage_error)?;
    if !metadata.is_file() {
        return Err(Error::IncompatibleStore);
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::IncompatibleStore);
    }
    Ok(file)
}

pub(crate) fn path_identity(path: &Path) -> Result<same_file::Handle> {
    let file = open_regular_file(path, OpenOptions::new().read(true))?;
    same_file::Handle::from_file(file).map_err(storage_error)
}

fn file_identity(file: &File) -> Result<same_file::Handle> {
    same_file::Handle::from_file(file.try_clone().map_err(storage_error)?).map_err(storage_error)
}

fn checked_open(path: &Path, identity: &same_file::Handle) -> Result<Database> {
    let file = open_regular_file(path, OpenOptions::new().read(true).write(true))?;
    if file_identity(&file)? != *identity {
        return Err(Error::IncompatibleStore);
    }
    let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
    let locks = Arc::new(OpenLocks {
        opening: AtomicBool::new(true),
        writer_acquired: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        mutated: AtomicBool::new(false),
    });
    let result = builder().create_with_backend(NonblockingOpen {
        file,
        locks: locks.clone(),
    });
    locks.opening.store(false, Ordering::Release);
    result.map_err(|error| {
        if locks.busy.load(Ordering::Acquire) && !locks.mutated.load(Ordering::Acquire) {
            Error::WriterBusy
        } else {
            storage_error(error)
        }
    })
}

impl Backend {
    pub(crate) async fn open(path: impl AsRef<Path>, initialize: bool) -> Result<Self> {
        let path = path.as_ref().to_owned();
        if path.as_os_str().is_empty() {
            return Err(Error::Invalid("database file path is empty".into()));
        }
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir().map_err(storage_error)?.join(path)
        };
        let handles = tokio::task::spawn_blocking(move || {
            let identity;
            let database = if initialize {
                let mut options = OpenOptions::new();
                options.read(true).write(true).create(true).truncate(false);
                #[cfg(unix)]
                options.mode(0o600);
                let file = open_regular_file(&path, &mut options)?;
                identity = file_identity(&file)?;
                let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
                builder().create_with_backend(file).map_err(storage_error)?
            } else {
                identity = path_identity(&path)?;
                let started = Instant::now();
                loop {
                    match checked_open(&path, &identity) {
                        Ok(database) => break database,
                        Err(Error::WriterBusy) => {
                            // A live writer prevents a checked writable open. Readers
                            // still observe the last committed snapshot. A later writer
                            // promotion must finish the integrity check before begin.
                            let file = open_regular_file(&path, OpenOptions::new().read(true))?;
                            if file_identity(&file)? != identity {
                                return Err(Error::IncompatibleStore);
                            }
                            let file =
                                redb::backends::FileBackend::new(file).map_err(storage_error)?;
                            let reader = match builder().open_read_only_with_backend(file) {
                                Ok(reader) => reader,
                                // A peer can own the writer while recovering a crashed
                                // file, before redb publishes its consistency marker.
                                // This read-only attempt wrote nothing. Rejoin checked
                                // open instead of treating unready recovery as corruption.
                                Err(redb::DatabaseError::RepairAborted) => {
                                    if started.elapsed() >= Duration::from_secs(5) {
                                        return Err(Error::WriterBusy);
                                    }
                                    std::thread::sleep(Duration::from_millis(5));
                                    continue;
                                }
                                Err(error) => return Err(storage_error(error)),
                            };
                            validate_tables(&reader.begin_read().map_err(storage_error)?)?;
                            return Ok(Arc::new(DatabaseHandles {
                                path,
                                exclusive: false,
                                read_only: false,
                                identity: Some(identity),
                                reader: Some(reader),
                                writer: Mutex::new(None),
                                opening: Mutex::new(()),
                            }));
                        }
                        Err(error) => return Err(error),
                    }
                }
            };
            if initialize {
                let mut transaction = database.begin_write().map_err(storage_error)?;
                transaction
                    .set_durability(Durability::Immediate)
                    .map_err(storage_error)?;
                let names = transaction
                    .list_tables()
                    .map_err(storage_error)?
                    .map(|table| table.name().to_owned())
                    .collect::<Vec<_>>();
                if transaction
                    .list_multimap_tables()
                    .map_err(storage_error)?
                    .next()
                    .is_some()
                    || names.iter().any(|name| name != TABLE.name())
                {
                    return Err(Error::IncompatibleStore);
                }
                {
                    let table = transaction.open_table(TABLE).map_err(storage_error)?;
                    if table
                        .iter()
                        .map_err(storage_error)?
                        .next()
                        .transpose()
                        .map_err(storage_error)?
                        .is_some()
                        && table
                            .get(crate::store_key("meta/state").as_slice())
                            .map_err(storage_error)?
                            .is_none()
                    {
                        return Err(Error::IncompatibleStore);
                    }
                }
                transaction.commit().map_err(commit_error)?;
                // A durable new database also needs its directory entry persisted.
                #[cfg(unix)]
                {
                    let parent = path
                        .parent()
                        .filter(|value| !value.as_os_str().is_empty())
                        .unwrap_or_else(|| Path::new("."));
                    std::fs::File::open(parent)
                        .and_then(|directory| directory.sync_all())
                        .map_err(storage_error)?;
                }
            } else {
                validate_tables(&database.begin_read().map_err(storage_error)?)?;
            }
            Ok::<_, Error>(Arc::new(DatabaseHandles {
                path,
                exclusive: false,
                read_only: false,
                identity: Some(identity),
                reader: None,
                writer: Mutex::new(Some(Arc::new(database))),
                opening: Mutex::new(()),
            }))
        })
        .await
        .map_err(worker_error)??;
        Ok(Self { handles })
    }

    /// Inspect an existing store without a writable descriptor, integrity repair,
    /// schema initialization, or later promotion to a writer.
    pub(crate) async fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_snapshot(path.as_ref().to_owned(), false, u64::MAX).await
    }

    pub(crate) async fn open_current_reader(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_owned();
        if !path.is_absolute() {
            return Err(Error::Invalid("database path must be absolute".into()));
        }
        let handles = tokio::task::spawn_blocking(move || {
            let identity = path_identity(&path)?;
            // Use a live MultiWriter engine handle for fresh committed snapshots.
            // The application handle keeps transaction writes and writer acquisition disabled.
            let database = checked_open(&path, &identity)?;
            validate_tables(&database.begin_read().map_err(storage_error)?)?;
            let handles = DatabaseHandles {
                path,
                exclusive: false,
                read_only: true,
                identity: Some(identity),
                reader: None,
                writer: Mutex::new(Some(Arc::new(database))),
                opening: Mutex::new(()),
            };
            handles.verify_identity()?;
            Ok::<_, Error>(Arc::new(handles))
        })
        .await
        .map_err(worker_error)??;
        Ok(Self { handles })
    }

    pub(crate) async fn open_offline_snapshot(path: &Path) -> Result<Self> {
        Self::open_snapshot(path.to_owned(), true, u64::MAX).await
    }

    #[cfg(unix)]
    pub(crate) async fn open_bounded_offline_snapshot(path: &Path, max_bytes: u64) -> Result<Self> {
        Self::open_snapshot(path.to_owned(), true, max_bytes).await
    }

    async fn open_snapshot(path: PathBuf, exclusive: bool, max_bytes: u64) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::Invalid("database path must be absolute".into()));
        }
        let handles = tokio::task::spawn_blocking(move || {
            let file = open_regular_file(&path, OpenOptions::new().read(true).write(exclusive))?;
            let identity = file_identity(&file)?;
            let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
            let reader = if exclusive {
                if !file
                    .try_lock_range(Bound::Unbounded, Bound::Unbounded)
                    .map_err(storage_error)?
                {
                    return Err(Error::WriterBusy);
                }
                if file.len().map_err(storage_error)? > max_bytes {
                    return Err(Error::Invalid(
                        "trial restore database exceeds file size limit".into(),
                    ));
                }
                let mut options = builder();
                options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
                options.open_read_only_with_backend(ExclusiveSnapshot(file))
            } else {
                builder().open_read_only_with_backend(file)
            }
            .map_err(|error| match error {
                redb::DatabaseError::RepairAborted => Error::RecoveryRequired,
                other => storage_error(other),
            })?;
            if path_identity(&path)? != identity {
                return Err(Error::IncompatibleStore);
            }
            validate_tables(&reader.begin_read().map_err(storage_error)?)?;
            Ok::<_, Error>(Arc::new(DatabaseHandles {
                path,
                exclusive,
                read_only: true,
                identity: Some(identity),
                reader: Some(reader),
                writer: Mutex::new(None),
                opening: Mutex::new(()),
            }))
        })
        .await
        .map_err(worker_error)??;
        Ok(Self { handles })
    }

    /// An offline owner excludes every open omdb handle, including idle readers.
    pub(crate) async fn open_exclusive(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_exclusive_checked(path.as_ref().to_owned(), |_, _| Ok(())).await
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn open_exclusive_trial(
        path: PathBuf,
        expected_identity: same_file::Handle,
    ) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;

        Self::open_exclusive_checked(path, move |file, identity| {
            if *identity != expected_identity
                || file.metadata().map_err(storage_error)?.nlink() != 1
            {
                return Err(Error::IncompatibleStore);
            }
            Ok(())
        })
        .await
    }

    async fn open_exclusive_checked(
        path: PathBuf,
        check: impl FnOnce(&File, &same_file::Handle) -> Result<()> + Send + 'static,
    ) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::Invalid("database path must be absolute".into()));
        }
        let handles = tokio::task::spawn_blocking(move || {
            let file = open_regular_file(&path, OpenOptions::new().read(true).write(true))?;
            if file.metadata().map_err(storage_error)?.len() == 0 {
                return Err(Error::IncompatibleStore);
            }
            let identity = file_identity(&file)?;
            check(&file, &identity)?;
            let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
            let mut options = builder();
            options.set_concurrency_mode(ConcurrencyMode::ExclusiveWriter);
            let database = options
                .create_with_backend(file)
                .map_err(|error| match error {
                    redb::DatabaseError::DatabaseAlreadyOpen => Error::WriterBusy,
                    other => storage_error(other),
                })?;
            if path_identity(&path)? != identity {
                return Err(Error::IncompatibleStore);
            }
            validate_tables(&database.begin_read().map_err(storage_error)?)?;
            Ok::<_, Error>(Arc::new(DatabaseHandles {
                path,
                exclusive: true,
                read_only: false,
                identity: Some(identity),
                reader: None,
                writer: Mutex::new(Some(Arc::new(database))),
                opening: Mutex::new(()),
            }))
        })
        .await
        .map_err(worker_error)??;
        Ok(Self { handles })
    }

    pub(crate) async fn storage_statistics(
        &self,
    ) -> Result<crate::application_storage::StorageStatistics> {
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || {
            let writer = handles.try_writer()?;
            let transaction = writer.try_begin_write().map_err(|error| match error {
                redb::TransactionError::WouldBlock => Error::WriterBusy,
                other => storage_error(other),
            })?;
            let stats = transaction.stats().map_err(storage_error)?;
            let database_bytes = std::fs::metadata(&handles.path)
                .map_err(storage_error)?
                .len();
            let allocated_bytes = stats
                .allocated_pages()
                .checked_mul(stats.page_size() as u64)
                .ok_or(Error::IncompatibleStore)?;
            let accounted_bytes = stats
                .stored_bytes()
                .checked_add(stats.metadata_bytes())
                .ok_or(Error::IncompatibleStore)?;
            // The engine includes both free pages and within-page slack in fragmentation.
            // Subtract all unaccounted allocated capacity, a conservative upper bound on
            // within-page slack. This is reusable capacity, not removable file bytes:
            // the allocator may retain empty regions even after offline compaction.
            let reusable_bytes = stats
                .fragmented_bytes()
                .saturating_sub(allocated_bytes.saturating_sub(accounted_bytes))
                .min(database_bytes);
            let result = crate::application_storage::StorageStatistics {
                database_bytes,
                // Pinned omdb has no guaranteed physical-shrink prediction API.
                reclaimable_bytes: 0,
                reusable_bytes,
                fragmented_bytes: stats.fragmented_bytes(),
                allocated_bytes,
            };
            handles.verify_identity()?;
            transaction.abort().map_err(storage_error)?;
            Ok(result)
        })
        .await
        .map_err(worker_error)?
    }

    /// A verified logical snapshot, never a copy of a live, mutating file.
    pub(crate) async fn storage_backup(
        &self,
        destination: PathBuf,
    ) -> Result<(StorageBackup, same_file::Handle)> {
        if !destination.is_absolute() {
            return Err(Error::Invalid("backup path must be absolute".into()));
        }
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || {
            let source = handles.begin_read()?;
            validate_tables(&source)?;
            let directory = destination.parent().ok_or(Error::IncompatibleStore)?;
            match destination.symlink_metadata() {
                Ok(_) => return Err(Error::Database("backup destination already exists".into())),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
            }
            #[cfg(unix)]
            let directory_handle = std::fs::File::open(directory).map_err(storage_error)?;
            let staged = tempfile::Builder::new()
                .prefix(".t3-backup-")
                .suffix(".partial")
                .tempfile_in(directory)
                .map_err(storage_error)?;
            let backup_identity = file_identity(staged.as_file())?;
            let file = staged.reopen().map_err(storage_error)?;
            let file = redb::backends::FileBackend::new(file).map_err(storage_error)?;
            let mut builder = redb::Database::builder();
            builder
                .set_cache_size(32 * 1024 * 1024)
                .set_check_integrity_on_open(true);
            let backup = builder.create_with_backend(file).map_err(storage_error)?;
            let mut write = backup.begin_write().map_err(storage_error)?;
            write
                .set_durability(Durability::Immediate)
                .map_err(storage_error)?;
            let (rows, checksum) = {
                let mut output = write.open_table(TABLE).map_err(storage_error)?;
                snapshot_digest(&source, &[], |key, value| {
                    output.insert(key, value).map_err(storage_error)?;
                    Ok(())
                })?
            };
            write.commit().map_err(storage_error)?;
            backup.close().map_err(storage_error)?;
            let verified_file = open_regular_file(staged.path(), OpenOptions::new().read(true))?;
            if file_identity(&verified_file)? != backup_identity {
                return Err(Error::IncompatibleStore);
            }
            let backup = builder
                .open_read_only_with_backend(
                    redb::backends::FileBackend::new(verified_file).map_err(storage_error)?,
                )
                .map_err(storage_error)?;
            let verify = backup.begin_read().map_err(storage_error)?;
            validate_tables(&verify)?;
            let (verified_rows, verified_checksum) = snapshot_digest(&verify, &[], |_, _| Ok(()))?;
            if rows != verified_rows || checksum != verified_checksum {
                return Err(Error::IncompatibleStore);
            }
            drop(verify);
            backup.close().map_err(storage_error)?;
            staged.as_file().sync_all().map_err(storage_error)?;
            let bytes = staged.as_file().metadata().map_err(storage_error)?.len();
            handles.verify_identity()?;
            if path_identity(staged.path())? != backup_identity {
                return Err(Error::IncompatibleStore);
            }
            staged
                .persist_noclobber(&destination)
                .map_err(storage_error)?;
            #[cfg(unix)]
            directory_handle
                .sync_all()
                .map_err(|_| Error::UnknownCommit)?;
            handles
                .verify_identity()
                .map_err(|_| Error::UnknownCommit)?;
            if path_identity(&destination).map_err(|_| Error::UnknownCommit)? != backup_identity {
                return Err(Error::UnknownCommit);
            }
            Ok((
                StorageBackup {
                    rows,
                    bytes,
                    checksum,
                },
                backup_identity,
            ))
        })
        .await
        .map_err(worker_error)?
    }

    pub(crate) async fn storage_fingerprint(&self) -> Result<StorageBackup> {
        self.fingerprint(Vec::new(), |_, _| Ok(())).await
    }

    #[cfg(unix)]
    pub(crate) async fn bounded_storage_fingerprint(&self) -> Result<StorageBackup> {
        self.bounded_storage_fingerprint_with(Vec::new()).await
    }

    #[cfg(unix)]
    pub(crate) async fn bounded_storage_fingerprint_with(
        &self,
        replacements: Vec<Pair>,
    ) -> Result<StorageBackup> {
        let mut rows_left = MAX_BATCH_RECORDS;
        let mut bytes_left = MAX_BATCH_BYTES;
        self.fingerprint(replacements, move |key, value| {
            rows_left = rows_left
                .checked_sub(1)
                .ok_or_else(|| Error::Invalid("trial restore database exceeds row limit".into()))?;
            bytes_left = bytes_left
                .checked_sub(key.len())
                .and_then(|remaining| remaining.checked_sub(value.len()))
                .ok_or(Error::ResourceLimit(ResourceLimit::ScanBytes))?;
            Ok(())
        })
        .await
    }

    async fn fingerprint(
        &self,
        replacements: Vec<Pair>,
        meter: impl FnMut(&[u8], &[u8]) -> Result<()> + Send + 'static,
    ) -> Result<StorageBackup> {
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || {
            let (rows, checksum) = snapshot_digest(&handles.begin_read()?, &replacements, meter)?;
            let bytes = std::fs::metadata(&handles.path)
                .map_err(storage_error)?
                .len();
            handles.verify_identity()?;
            Ok(StorageBackup {
                rows,
                bytes,
                checksum,
            })
        })
        .await
        .map_err(worker_error)?
    }

    #[cfg(unix)]
    pub(crate) fn open_verified_offline_file(&self, path: &Path) -> Result<File> {
        if !self.handles.exclusive || !self.handles.read_only {
            return Err(Error::IncompatibleStore);
        }
        let file = open_regular_file(path, OpenOptions::new().read(true))?;
        if self.handles.identity.as_ref() != Some(&file_identity(&file)?) {
            return Err(Error::IncompatibleStore);
        }
        Ok(file)
    }

    pub(crate) fn verify_identity(&self) -> Result<()> {
        self.handles.verify_identity()
    }

    pub(crate) async fn storage_compact(
        &self,
    ) -> Result<crate::application_storage::StorageCompaction> {
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || {
            handles.verify_identity()?;
            if !handles.exclusive {
                return Err(Error::Invalid(
                    "physical compaction requires an exclusive offline handle".into(),
                ));
            }
            let mut writer = handles.writer.lock().map_err(storage_error)?;
            let database = Arc::get_mut(writer.as_mut().ok_or(Error::IncompatibleStore)?)
                .ok_or(Error::WriterBusy)?;
            let before_bytes = std::fs::metadata(&handles.path)
                .map_err(storage_error)?
                .len();
            database.compact().map_err(storage_error)?;
            handles.verify_identity()?;
            Ok(crate::application_storage::StorageCompaction {
                before_bytes,
                after_bytes: std::fs::metadata(&handles.path)
                    .map_err(storage_error)?
                    .len(),
            })
        })
        .await
        .map_err(worker_error)?
    }

    pub(crate) fn require_exclusive(&self) -> Result<()> {
        if !self.handles.exclusive || self.handles.read_only {
            return Err(Error::Invalid(
                "native schema upgrade requires an exclusive offline handle".into(),
            ));
        }
        self.handles.verify_identity()
    }

    pub(crate) async fn begin(&self) -> Result<Transaction> {
        let handles = self.handles.clone();
        let snapshot = tokio::task::spawn_blocking(move || handles.begin_read())
            .await
            .map_err(worker_error)??;
        Ok(Transaction::new(
            Some(self.clone()),
            TransactionSnapshot::Omdb(Arc::new(snapshot)),
            None,
            self.handles.read_only,
        ))
    }

    pub(crate) async fn begin_read_only(&self) -> Result<Transaction> {
        let mut transaction = self.begin().await?;
        transaction.read_only = true;
        Ok(transaction)
    }

    /// Acquire the database's cross-process writer before the caller starts work.
    /// A blocking worker owns the redb writer until commit, cancellation, or expiry.
    pub(crate) async fn begin_reserved(
        &self,
        lock_timeout: Duration,
        idle_timeout: Duration,
    ) -> Result<Transaction> {
        let handles = Arc::clone(&self.handles);
        let (snapshot, reserved) =
            ReservedWriter::start(idle_timeout, move |state, commands, ready| {
                reserved_worker(handles, state, commands, ready, lock_timeout);
            })
            .await?;
        Ok(Transaction::new(
            Some(self.clone()),
            snapshot,
            Some(reserved),
            false,
        ))
    }

    pub(crate) async fn read(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let mut transaction = self.begin().await?;
        let result = transaction.get(key).await;
        transaction.rollback().await?;
        result
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) async fn shutdown_for_handoff(self) -> Result<()> {
        self.shutdown_owned(true).await
    }

    pub(crate) async fn shutdown(self) -> Result<()> {
        self.shutdown_owned(false).await
    }

    async fn shutdown_owned(self, require_unique: bool) -> Result<()> {
        tokio::task::spawn_blocking(move || match Arc::try_unwrap(self.handles) {
            Ok(handles) => {
                if let Some(writer) = handles.writer.into_inner().map_err(storage_error)? {
                    match Arc::try_unwrap(writer) {
                        Ok(writer) => writer.close().map_err(storage_error)?,
                        Err(writer) => {
                            drop(writer);
                            if require_unique {
                                return Err(Error::WriterBusy);
                            }
                        }
                    }
                }
                if let Some(reader) = handles.reader {
                    reader.close().map_err(storage_error)?;
                }
                Ok(())
            }
            Err(handles) => {
                drop(handles);
                if require_unique {
                    Err(Error::WriterBusy)
                } else {
                    Ok(())
                }
            }
        })
        .await
        .map_err(worker_error)?
    }
}

fn snapshot_digest(
    snapshot: &ReadTransaction,
    replacements: &[Pair],
    mut copy: impl FnMut(&[u8], &[u8]) -> Result<()>,
) -> Result<(u64, String)> {
    let mut rows = 0u64;
    let mut digest = Sha256::new();
    for entry in snapshot
        .open_table(TABLE)
        .map_err(storage_error)?
        .iter()
        .map_err(storage_error)?
    {
        let (key, value) = entry.map_err(storage_error)?;
        let (key, value) = (key.value(), value.value());
        copy(key, value)?;
        let value = replacements
            .iter()
            .find(|(candidate, _)| candidate.as_slice() == key)
            .map_or(value, |(_, replacement)| replacement.as_slice());
        digest.update((key.len() as u64).to_le_bytes());
        digest.update(key);
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
        rows = rows.checked_add(1).ok_or(Error::IncompatibleStore)?;
    }
    let checksum = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((rows, checksum))
}

#[derive(Clone)]
struct ObservedRange {
    start: Vec<u8>,
    end: Vec<u8>,
    limit: usize,
    rows: Vec<Pair>,
}

#[derive(Clone)]
enum TransactionSnapshot {
    Omdb(Arc<ReadTransaction>),
    #[cfg(feature = "ordered-engine-fixture")]
    Comparison(Arc<comparison::Snapshot>),
}

impl TransactionSnapshot {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Omdb(snapshot) => {
                let table = snapshot.open_table(TABLE).map_err(storage_error)?;
                let value = table.get(key).map_err(storage_error)?;
                value.map(|value| bounded_copy(value.value())).transpose()
            }
            #[cfg(feature = "ordered-engine-fixture")]
            Self::Comparison(snapshot) => snapshot.get(key).map_err(Error::from),
        }
    }

    fn fingerprint(&self, key: &[u8]) -> Result<Option<(usize, [u8; 32])>> {
        match self {
            Self::Omdb(snapshot) => {
                let table = snapshot.open_table(TABLE).map_err(storage_error)?;
                let value = table.get(key).map_err(storage_error)?;
                Ok(value.map(|value| fingerprint(value.value())))
            }
            #[cfg(feature = "ordered-engine-fixture")]
            Self::Comparison(snapshot) => Ok(snapshot.get(key)?.as_deref().map(fingerprint)),
        }
    }

    fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> Result<Vec<Pair>> {
        match self {
            Self::Omdb(snapshot) => {
                let table = snapshot.open_table(TABLE).map_err(storage_error)?;
                scan_table(&table, start, end, limit)
            }
            #[cfg(feature = "ordered-engine-fixture")]
            Self::Comparison(snapshot) => snapshot.scan(start, end, limit).map_err(Error::from),
        }
    }

    fn read_many<T>(
        &self,
        keys: impl IntoIterator<Item = Vec<u8>>,
        mut entry: impl FnMut(Vec<u8>, Option<Vec<u8>>) -> T,
    ) -> Result<Vec<T>> {
        let mut total = 0usize;
        let mut account = |bytes| {
            total = total.saturating_add(bytes);
            if total > MAX_BATCH_BYTES {
                return Err(Error::ResourceLimit(ResourceLimit::ReadBytes));
            }
            Ok(())
        };
        match self {
            Self::Omdb(snapshot) => {
                let table = snapshot.open_table(TABLE).map_err(storage_error)?;
                keys.into_iter()
                    .map(|key| {
                        let value = table.get(key.as_slice()).map_err(storage_error)?;
                        if let Some(value) = &value {
                            account(value.value().len())?;
                        }
                        Ok(entry(key, value.map(|value| value.value().to_vec())))
                    })
                    .collect()
            }
            #[cfg(feature = "ordered-engine-fixture")]
            Self::Comparison(snapshot) => keys
                .into_iter()
                .map(|key| {
                    let value = snapshot.get(&key)?;
                    account(value.as_ref().map_or(0, Vec::len))?;
                    Ok(entry(key, value))
                })
                .collect(),
        }
    }
}

pub(crate) struct Transaction {
    backend: Option<Backend>,
    snapshot: TransactionSnapshot,
    reads: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    mutation_reads: BTreeMap<Vec<u8>, Option<(usize, [u8; 32])>>,
    writes: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    staged_bytes: usize,
    observed_bytes: usize,
    observed_records: usize,
    ranges: Vec<ObservedRange>,
    reserved: Option<ReservedWriter>,
    read_only: bool,
}

/// Only staged state changes at savepoints. The reserved writer has not applied
/// any mutation yet, so restoring this state cannot publish or undo a commit.
#[derive(Clone)]
pub(crate) struct TransactionCheckpoint {
    reads: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    mutation_reads: BTreeMap<Vec<u8>, Option<(usize, [u8; 32])>>,
    writes: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    staged_bytes: usize,
    observed_bytes: usize,
    observed_records: usize,
    ranges: Vec<ObservedRange>,
}

impl Transaction {
    fn new(
        backend: Option<Backend>,
        snapshot: TransactionSnapshot,
        reserved: Option<ReservedWriter>,
        read_only: bool,
    ) -> Self {
        Self {
            backend,
            snapshot,
            reads: BTreeMap::new(),
            mutation_reads: BTreeMap::new(),
            writes: BTreeMap::new(),
            staged_bytes: 0,
            observed_bytes: 0,
            observed_records: 0,
            ranges: Vec::new(),
            reserved,
            read_only,
        }
    }

    #[cfg(feature = "ordered-engine-fixture")]
    pub(crate) fn comparison_read_only(snapshot: comparison::Snapshot) -> Self {
        Self::new(
            None,
            TransactionSnapshot::Comparison(Arc::new(snapshot)),
            None,
            true,
        )
    }

    #[cfg(feature = "ordered-engine-fixture")]
    pub(crate) async fn comparison_reserved(
        database: Arc<comparison::Database>,
        lock_timeout: Duration,
        idle_timeout: Duration,
        discard_commit_ack: bool,
    ) -> Result<Self> {
        let reservation = ReservedWriter::start(idle_timeout, move |state, commands, ready| {
            comparison_reserved_worker(database, state, commands, ready, discard_commit_ack);
        });
        // A timed-out waiter drops readiness. The native lock wait can finish
        // later, but the worker exits before admitting application work.
        let (snapshot, reserved) = tokio::time::timeout(lock_timeout, reservation)
            .await
            .map_err(|_| Error::WriterBusy)??;
        Ok(Self::new(None, snapshot, Some(reserved), false))
    }

    pub(crate) fn is_active(&self) -> bool {
        self.reserved.as_ref().is_none_or(|reserved| {
            !reserved
                .worker
                .as_ref()
                .is_some_and(|worker| worker.is_finished())
                && reserved.state.lock().is_ok_and(|state| {
                    !state.closed && state.touched.elapsed() < state.idle_timeout
                })
        })
    }

    pub(crate) fn owns_writer(&self) -> bool {
        self.reserved.is_some()
    }

    pub(crate) fn ensure_active(&self) -> Result<()> {
        if let Some(reserved) = &self.reserved {
            reserved.touch()?;
        }
        Ok(())
    }

    pub(crate) fn checkpoint_bytes(&self) -> usize {
        self.staged_bytes.saturating_add(self.observed_bytes)
    }

    pub(crate) fn checkpoint(&self) -> TransactionCheckpoint {
        TransactionCheckpoint {
            reads: self.reads.clone(),
            mutation_reads: self.mutation_reads.clone(),
            writes: self.writes.clone(),
            staged_bytes: self.staged_bytes,
            observed_bytes: self.observed_bytes,
            observed_records: self.observed_records,
            ranges: self.ranges.clone(),
        }
    }

    pub(crate) fn restore(&mut self, checkpoint: &TransactionCheckpoint) {
        self.reads.clone_from(&checkpoint.reads);
        self.mutation_reads.clone_from(&checkpoint.mutation_reads);
        self.writes.clone_from(&checkpoint.writes);
        self.staged_bytes = checkpoint.staged_bytes;
        self.observed_bytes = checkpoint.observed_bytes;
        self.observed_records = checkpoint.observed_records;
        self.ranges.clone_from(&checkpoint.ranges);
    }

    pub(crate) fn require_write(&self) -> Result<()> {
        self.ensure_active()?;
        if self.read_only {
            return Err(Error::Invalid(
                "application transaction is read-only".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.ensure_active()?;
        if let Some(value) = self.writes.get(key).or_else(|| self.reads.get(key)) {
            return Ok(value.clone());
        }
        let snapshot = self.snapshot.clone();
        let owned_key = key.to_vec();
        let value = tokio::task::spawn_blocking(move || snapshot.get(&owned_key))
            .await
            .map_err(worker_error)??;
        // A read-only transaction owns one immutable engine snapshot and cannot
        // commit mutations. Retaining every read as conflict evidence only
        // duplicates that snapshot and makes bounded paged queries exhaust a
        // write-transaction observation budget. Each returned value stays capped.
        if self.read_only {
            return Ok(value);
        }
        self.observe_size(
            key.len().saturating_add(value.as_ref().map_or(0, Vec::len)),
            1,
        )?;
        self.reads.insert(key.to_vec(), value.clone());
        Ok(value)
    }

    pub(crate) async fn put(&mut self, key: Vec<u8>, value: Vec<u8>) -> Result<()> {
        self.require_write()?;
        if value.len() > MAX_BATCH_BYTES {
            return Err(Error::Invalid("stored value exceeds 16 MiB".into()));
        }
        let staged_bytes = self.staged_size(&key, value.len())?;
        self.observe_mutation(&key).await?;
        self.writes.insert(key, Some(value));
        self.staged_bytes = staged_bytes;
        Ok(())
    }

    pub(crate) async fn insert(&mut self, key: Vec<u8>, value: Vec<u8>) -> Result<()> {
        if self.get(&key).await?.is_some() {
            return Err(Error::DuplicateRecord);
        }
        self.put(key, value).await
    }

    pub(crate) async fn delete(&mut self, key: Vec<u8>) -> Result<()> {
        self.require_write()?;
        let staged_bytes = self.staged_size(&key, 0)?;
        self.observe_mutation(&key).await?;
        self.writes.insert(key, None);
        self.staged_bytes = staged_bytes;
        Ok(())
    }

    fn staged_size(&self, key: &[u8], value_bytes: usize) -> Result<usize> {
        let previous = self
            .writes
            .get(key)
            .map_or(0, |value| key.len() + value.as_ref().map_or(0, Vec::len));
        let total = self
            .staged_bytes
            .saturating_sub(previous)
            .saturating_add(key.len())
            .saturating_add(value_bytes);
        if total > MAX_BATCH_BYTES {
            return Err(Error::ResourceLimit(ResourceLimit::MutationBytes));
        }
        Ok(total)
    }

    fn observe_size(&mut self, bytes: usize, records: usize) -> Result<()> {
        let total_bytes = self.observed_bytes.saturating_add(bytes);
        let total_records = self.observed_records.saturating_add(records);
        if total_bytes > MAX_BATCH_BYTES || total_records > MAX_BATCH_RECORDS {
            return Err(Error::ResourceLimit(ResourceLimit::ObservationBudget));
        }
        self.observed_bytes = total_bytes;
        self.observed_records = total_records;
        Ok(())
    }

    async fn observe_mutation(&mut self, key: &[u8]) -> Result<()> {
        if self.reads.contains_key(key) || self.mutation_reads.contains_key(key) {
            return Ok(());
        }
        let snapshot = self.snapshot.clone();
        let owned_key = key.to_vec();
        let observed = tokio::task::spawn_blocking(move || snapshot.fingerprint(&owned_key))
            .await
            .map_err(worker_error)??;
        self.observe_size(
            key.len()
                .saturating_add(observed.as_ref().map_or(0, |_| 40)),
            1,
        )?;
        self.mutation_reads.insert(key.to_vec(), observed);
        Ok(())
    }

    /// Fetch a previously size-checked set of values in one blocking operation.
    pub(crate) async fn get_many(&mut self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        self.ensure_active()?;
        if self.read_only {
            if keys.len() > MAX_BATCH_RECORDS {
                return Err(Error::ResourceLimit(ResourceLimit::ReadBytes));
            }
            let snapshot = self.snapshot.clone();
            let keys = keys.to_vec();
            return tokio::task::spawn_blocking(move || snapshot.read_many(keys, |_, value| value))
                .await
                .map_err(worker_error)?;
        }
        let missing: std::collections::BTreeSet<_> = keys
            .iter()
            .filter(|key| !self.writes.contains_key(*key) && !self.reads.contains_key(*key))
            .cloned()
            .collect();
        if !missing.is_empty() {
            let snapshot = self.snapshot.clone();
            let loaded = tokio::task::spawn_blocking(move || {
                snapshot.read_many(missing, |key, value| (key, value))
            })
            .await
            .map_err(worker_error)??;
            let bytes = loaded.iter().fold(0usize, |total, (key, value)| {
                total
                    .saturating_add(key.len())
                    .saturating_add(value.as_ref().map_or(0, Vec::len))
            });
            self.observe_size(bytes, loaded.len())?;
            self.reads.extend(loaded);
        }
        let mut total = 0usize;
        let mut result = Vec::with_capacity(keys.len());
        for key in keys {
            let value = self
                .writes
                .get(key)
                .or_else(|| self.reads.get(key))
                .ok_or(Error::IncompatibleStore)?;
            total = total.saturating_add(value.as_ref().map_or(0, Vec::len));
            if total > MAX_BATCH_BYTES {
                return Err(Error::ResourceLimit(ResourceLimit::ReadBytes));
            }
            result.push(value.clone());
        }
        Ok(result)
    }

    pub(crate) async fn scan(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<Pair>> {
        self.ensure_active()?;
        if start >= end || limit == 0 {
            return Err(Error::Invalid("invalid database scan".into()));
        }
        let pending = self.writes.range(start.to_vec()..end.to_vec()).count();
        let fetch_limit = limit
            .checked_add(pending)
            .ok_or_else(|| Error::Invalid("database scan limit overflow".into()))?;
        let owned_start = start.to_vec();
        let owned_end = end.to_vec();
        let snapshot = self.snapshot.clone();
        let rows = tokio::task::spawn_blocking(move || {
            snapshot.scan(&owned_start, &owned_end, fetch_limit)
        })
        .await
        .map_err(worker_error)??;
        if self.read_only {
            // No overlay is possible: require_write rejects every mutation.
            // scan_table still bounds this page's bytes and requested row count.
            debug_assert!(self.writes.is_empty());
            return Ok(rows);
        }
        let observed_bytes = rows.iter().fold(
            start.len().saturating_add(end.len()),
            |total, (key, value)| total.saturating_add(key.len()).saturating_add(value.len()),
        );
        self.observe_size(observed_bytes, rows.len().saturating_add(1))?;
        self.ranges.push(ObservedRange {
            start: start.to_vec(),
            end: end.to_vec(),
            limit: fetch_limit,
            rows: rows.clone(),
        });
        let mut merged: BTreeMap<_, _> = rows.into_iter().collect();
        for (key, value) in self.writes.range(start.to_vec()..end.to_vec()) {
            match value {
                Some(value) => {
                    merged.insert(key.clone(), value.clone());
                }
                None => {
                    merged.remove(key);
                }
            }
        }
        Ok(merged.into_iter().take(limit).collect())
    }

    pub(crate) async fn commit(self) -> Result<()> {
        self.ensure_active()?;
        if self.writes.is_empty() {
            return self.rollback().await;
        }
        let Self {
            backend,
            snapshot,
            reads,
            mutation_reads,
            writes,
            ranges,
            reserved,
            ..
        } = self;
        let staged = StagedCommit {
            reads,
            mutation_reads,
            writes,
            ranges,
        };
        if let Some(reserved) = reserved {
            drop(snapshot);
            return reserved.commit(staged).await;
        }
        // Component transactions retain their optimistic commit behavior. Application
        // sessions use the writer acquired before their callback, on its owning worker.
        tokio::task::spawn_blocking(move || {
            drop(snapshot);
            let backend = backend.ok_or(Error::IncompatibleStore)?;
            let database = backend.handles.wait_for_writer()?;
            let mut transaction = database.begin_write().map_err(storage_error)?;
            backend.handles.verify_identity()?;
            transaction
                .set_durability(Durability::Immediate)
                .map_err(storage_error)?;
            commit_staged(transaction, staged)
        })
        .await
        // A worker panic can happen after durable commit but before its result is returned.
        .map_err(|_| Error::UnknownCommit)?
    }

    #[cfg(all(test, feature = "ordered-engine-fixture"))]
    pub(crate) async fn stage_for_comparison(mut self) -> Result<StagedCommit> {
        self.require_write()?;
        let staged = StagedCommit {
            reads: std::mem::take(&mut self.reads),
            mutation_reads: std::mem::take(&mut self.mutation_reads),
            writes: std::mem::take(&mut self.writes),
            ranges: std::mem::take(&mut self.ranges),
        };
        // Release the source reservation without committing any command rows.
        self.rollback().await?;
        Ok(staged)
    }

    pub(crate) async fn rollback(mut self) -> Result<()> {
        let reserved = self.reserved.take();
        tokio::task::spawn_blocking(move || drop(self))
            .await
            .map_err(worker_error)?;
        if let Some(reserved) = reserved {
            reserved.abort().await?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct StagedCommit {
    reads: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    mutation_reads: BTreeMap<Vec<u8>, Option<(usize, [u8; 32])>>,
    writes: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    ranges: Vec<ObservedRange>,
}

/// The caller owns one atomic engine transaction and must abort it on error.
/// Validation completes before any mutation is applied. Publication belongs to
/// the caller after the engine acknowledges commit.
pub(crate) trait CommitTable {
    fn matches(&self, key: &[u8], expected: Option<&[u8]>) -> Result<bool>;
    fn fingerprint(&self, key: &[u8]) -> Result<Option<(usize, [u8; 32])>>;
    fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> Result<Vec<Pair>>;
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()>;
    fn delete(&mut self, key: &[u8]) -> Result<()>;
}

impl CommitTable for redb::Table<'_, &'static [u8], &'static [u8]> {
    fn matches(&self, key: &[u8], expected: Option<&[u8]>) -> Result<bool> {
        let value = ReadableTable::get(self, key).map_err(storage_error)?;
        Ok(value.as_ref().map(|value| value.value()) == expected)
    }

    fn fingerprint(&self, key: &[u8]) -> Result<Option<(usize, [u8; 32])>> {
        let value = ReadableTable::get(self, key).map_err(storage_error)?;
        Ok(value.as_ref().map(|value| fingerprint(value.value())))
    }

    fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> Result<Vec<Pair>> {
        scan_table(self, start, end, limit)
    }

    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.insert(key, value).map_err(storage_error)?;
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.remove(key).map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(feature = "ordered-engine-fixture")]
impl From<comparison::Error> for Error {
    fn from(error: comparison::Error) -> Self {
        match error {
            comparison::Error::UnknownCommit(_) => Error::UnknownCommit,
            _ => Error::Database("ordered comparison operation failed".into()),
        }
    }
}

#[cfg(feature = "ordered-engine-fixture")]
impl CommitTable for comparison::WriteTransaction {
    fn matches(&self, key: &[u8], expected: Option<&[u8]>) -> Result<bool> {
        Ok(self.get(key)?.as_deref() == expected)
    }

    fn fingerprint(&self, key: &[u8]) -> Result<Option<(usize, [u8; 32])>> {
        Ok(self.get(key)?.as_deref().map(fingerprint))
    }

    fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> Result<Vec<Pair>> {
        self.scan(start, end, limit).map_err(Error::from)
    }

    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.put(key, value).map_err(Error::from)
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.delete(key).map_err(Error::from)
    }
}

fn commit_staged(transaction: WriteTransaction, staged: StagedCommit) -> Result<()> {
    {
        let mut table = transaction.open_table(TABLE).map_err(storage_error)?;
        apply_staged(&mut table, staged)?;
    }
    transaction.commit().map_err(commit_error)
}

pub(crate) fn apply_staged(table: &mut impl CommitTable, staged: StagedCommit) -> Result<()> {
    for (key, observed) in staged.reads {
        if !table.matches(&key, observed.as_deref())? {
            return Err(Error::TransactionConflict);
        }
    }
    for (key, observed) in staged.mutation_reads {
        if table.fingerprint(&key)? != observed {
            return Err(Error::TransactionConflict);
        }
    }
    for range in staged.ranges {
        if table.scan(&range.start, &range.end, range.limit)? != range.rows {
            return Err(Error::TransactionConflict);
        }
    }
    for (key, value) in staged.writes {
        match value {
            Some(value) => table.put(&key, &value)?,
            None => table.delete(&key)?,
        }
    }
    Ok(())
}

struct ReservationState {
    touched: Instant,
    closed: bool,
    idle_timeout: Duration,
}

enum ReservationCommand {
    Commit(StagedCommit, oneshot::Sender<Result<()>>),
    Abort(oneshot::Sender<Result<()>>),
}

type ReservationReady = oneshot::Sender<Result<TransactionSnapshot>>;

struct ReservedWriter {
    commands: Option<mpsc::SyncSender<ReservationCommand>>,
    worker: Option<tokio::task::JoinHandle<()>>,
    state: Arc<Mutex<ReservationState>>,
}

fn expired_writer() -> Error {
    Error::Invalid("application writer reservation is no longer active".into())
}

fn worker_error_from_channel(_: oneshot::error::RecvError) -> Error {
    Error::Database("database reservation worker failed".into())
}

impl ReservedWriter {
    async fn start(
        idle_timeout: Duration,
        run: impl FnOnce(
            Arc<Mutex<ReservationState>>,
            mpsc::Receiver<ReservationCommand>,
            ReservationReady,
        ) + Send
        + 'static,
    ) -> Result<(TransactionSnapshot, Self)> {
        let (commands, receive) = mpsc::sync_channel(1);
        let (ready, snapshot) = oneshot::channel();
        let state = Arc::new(Mutex::new(ReservationState {
            touched: Instant::now(),
            closed: false,
            idle_timeout,
        }));
        let worker_state = Arc::clone(&state);
        let worker = tokio::task::spawn_blocking(move || run(worker_state, receive, ready));
        let reserved = Self {
            commands: Some(commands),
            worker: Some(worker),
            state,
        };
        Ok((
            snapshot.await.map_err(worker_error_from_channel)??,
            reserved,
        ))
    }

    fn touch(&self) -> Result<()> {
        let mut state = self.state.lock().map_err(storage_error)?;
        if state.closed || state.touched.elapsed() >= state.idle_timeout {
            state.closed = true;
            return Err(expired_writer());
        }
        if self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            state.closed = true;
            return Err(Error::Database("database reservation worker failed".into()));
        }
        state.touched = Instant::now();
        Ok(())
    }

    async fn commit(mut self, staged: StagedCommit) -> Result<()> {
        self.touch()?;
        let (reply, receive) = oneshot::channel();
        self.commands
            .take()
            .ok_or_else(expired_writer)?
            .send(ReservationCommand::Commit(staged, reply))
            .map_err(|_| expired_writer())?;
        let result = receive.await.map_err(|_| Error::UnknownCommit)?;
        if let Some(worker) = self.worker.take() {
            worker.await.map_err(|_| Error::UnknownCommit)?;
        }
        result
    }

    async fn abort(mut self) -> Result<()> {
        let (reply, receive) = oneshot::channel();
        let sent = self
            .commands
            .take()
            .is_some_and(|commands| commands.send(ReservationCommand::Abort(reply)).is_ok());
        let result = if sent {
            receive.await.map_err(worker_error_from_channel)?
        } else {
            Ok(())
        };
        if let Some(worker) = self.worker.take() {
            worker.await.map_err(worker_error)?;
        }
        result
    }
}

impl Drop for ReservedWriter {
    fn drop(&mut self) {
        // The worker observes disconnection and aborts. It never needs an async
        // task to be scheduled to release a cancelled session's writer lock.
        self.commands.take();
    }
}

fn close_reservation(state: &Mutex<ReservationState>) {
    if let Ok(mut state) = state.lock() {
        state.closed = true;
    }
}

fn reserved_worker(
    handles: Arc<DatabaseHandles>,
    state: Arc<Mutex<ReservationState>>,
    commands: mpsc::Receiver<ReservationCommand>,
    ready: ReservationReady,
    lock_timeout: Duration,
) {
    let started = Instant::now();
    let acquired = loop {
        if ready.is_closed() {
            close_reservation(&state);
            return;
        }
        let acquired = handles.try_writer().and_then(|database| {
            if ready.is_closed() {
                return Err(expired_writer());
            }
            database
                .try_begin_write()
                .map(|transaction| (database, transaction))
                .map_err(|error| match error {
                    redb::TransactionError::WouldBlock => Error::WriterBusy,
                    error => storage_error(error),
                })
        });
        match acquired {
            Ok(acquired) => break Ok(acquired),
            Err(Error::WriterBusy) if started.elapsed() < lock_timeout => {
                std::thread::sleep(
                    Duration::from_millis(5)
                        .min(lock_timeout - started.elapsed().min(lock_timeout)),
                );
            }
            Err(error) => break Err(error),
        }
    };
    let prepared = acquired.and_then(|(database, mut transaction)| {
        transaction
            .set_durability(Durability::Immediate)
            .map_err(storage_error)?;
        // The snapshot is taken after acquiring the writer, never before a peer's commit.
        let snapshot = Arc::new(database.begin_read().map_err(storage_error)?);
        Ok((transaction, snapshot))
    });
    let (transaction, snapshot) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            close_reservation(&state);
            let _ = ready.send(Err(error));
            return;
        }
    };
    let snapshot = TransactionSnapshot::Omdb(snapshot);
    match await_reservation_command(&state, &commands, ready, snapshot) {
        Some(ReservationCommand::Commit(staged, reply)) => {
            let result = if claim_reservation_commit(&state) {
                handles
                    .verify_identity()
                    .and_then(|()| commit_staged(transaction, staged))
            } else {
                transaction
                    .abort()
                    .map_err(storage_error)
                    .and(Err(expired_writer()))
            };
            let _ = reply.send(result);
        }
        Some(ReservationCommand::Abort(reply)) => {
            close_reservation(&state);
            let _ = reply.send(transaction.abort().map_err(storage_error));
        }
        None => {
            let _ = transaction.abort();
        }
    }
}

fn await_reservation_command(
    state: &Mutex<ReservationState>,
    commands: &mpsc::Receiver<ReservationCommand>,
    ready: ReservationReady,
    snapshot: TransactionSnapshot,
) -> Option<ReservationCommand> {
    if let Ok(mut state) = state.lock() {
        state.touched = Instant::now();
    }
    if ready.send(Ok(snapshot)).is_ok() {
        loop {
            let remaining = match state.lock() {
                Ok(state) if !state.closed => {
                    state.idle_timeout.saturating_sub(state.touched.elapsed())
                }
                _ => Duration::ZERO,
            };
            if remaining.is_zero() {
                break;
            }
            match commands.recv_timeout(remaining) {
                Ok(command) => return Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    close_reservation(state);
    None
}

fn claim_reservation_commit(state: &Mutex<ReservationState>) -> bool {
    state.lock().is_ok_and(|mut state| {
        let live = !state.closed && state.touched.elapsed() < state.idle_timeout;
        state.closed = true;
        live
    })
}

#[cfg(feature = "ordered-engine-fixture")]
fn comparison_reserved_worker(
    database: Arc<comparison::Database>,
    state: Arc<Mutex<ReservationState>>,
    commands: mpsc::Receiver<ReservationCommand>,
    ready: ReservationReady,
    discard_commit_ack: bool,
) {
    if ready.is_closed() {
        close_reservation(&state);
        return;
    }
    let mut ready = Some(ready);
    let mut reply = None;
    let result = database.write(|transaction| -> Result<()> {
        let sender = ready.as_ref().expect("callback runs once");
        if sender.is_closed() {
            return Err(expired_writer());
        }
        // The ordered API has acquired the engine's writer. Take an owned
        // snapshot here so app reads need not borrow the callback's writer.
        let snapshot = TransactionSnapshot::Comparison(Arc::new(database.snapshot()?));
        let sender = ready.take().expect("callback runs once");
        match await_reservation_command(&state, &commands, sender, snapshot) {
            Some(ReservationCommand::Commit(staged, sender)) => {
                reply = Some((sender, discard_commit_ack));
                if !claim_reservation_commit(&state) {
                    return Err(expired_writer());
                }
                apply_staged(transaction, staged)
            }
            Some(ReservationCommand::Abort(sender)) => {
                close_reservation(&state);
                reply = Some((sender, false));
                Ok(())
            }
            None => Ok(()),
        }
    });
    drop(database);
    if let Some(sender) = ready {
        close_reservation(&state);
        let _ = sender.send(result.and(Err(expired_writer())));
    } else if let Some((sender, discard_ack)) = reply {
        // Inject loss only after the engine has acknowledged a successful commit.
        if !discard_ack || result.is_err() {
            let _ = sender.send(result);
        }
    }
}

fn bounded_copy(value: &[u8]) -> Result<Vec<u8>> {
    if value.len() > MAX_BATCH_BYTES {
        return Err(Error::IncompatibleStore);
    }
    Ok(value.to_vec())
}

pub(crate) fn fingerprint(value: &[u8]) -> (usize, [u8; 32]) {
    let mut digest = [0; 32];
    digest.copy_from_slice(&Sha256::digest(value));
    (value.len(), digest)
}

fn scan_table(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    start: &[u8],
    end: &[u8],
    limit: usize,
) -> Result<Vec<Pair>> {
    let mut bytes = 0usize;
    let mut rows = Vec::new();
    for row in table.range(start..end).map_err(storage_error)?.take(limit) {
        let (key, value) = row.map_err(storage_error)?;
        bytes = bytes
            .saturating_add(key.value().len())
            .saturating_add(value.value().len());
        if bytes > MAX_BATCH_BYTES {
            return Err(Error::ResourceLimit(ResourceLimit::ScanBytes));
        }
        rows.push((key.value().to_vec(), value.value().to_vec()));
    }
    Ok(rows)
}

fn commit_error(error: redb::CommitError) -> Error {
    match error {
        redb::CommitError::TransactionPoisoned => {
            Error::Database("redb transaction was poisoned".into())
        }
        _ => Error::UnknownCommit,
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::atomic::{AtomicBool, Ordering};

    use redb::StorageBackend;

    use super::*;
    use crate::{
        CommitBatch, ProjectionMutation, Store, request_digest, store_key,
        test_support::TestFixture,
    };

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn exclusive_trial_keeps_peer_locks_across_engine_handles() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("candidate.omdb");
        let backend = Backend::open(&path, true).await.unwrap();
        let mut tx = backend.begin().await.unwrap();
        let key = store_key("test/trial-lease");
        tx.put(key.clone(), b"sealed".to_vec()).await.unwrap();
        tx.commit().await.unwrap();
        backend.shutdown().await.unwrap();
        let before = std::fs::read(&path).unwrap();

        let lease = ExclusiveTrialFile::acquire(path.clone(), 128 * 1024 * 1024).unwrap();
        let peer_excluded = || {
            assert!(matches!(
                builder().open_read_only(&path),
                Err(redb::DatabaseError::DatabaseAlreadyOpen)
            ));
            let legacy = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap();
            assert!(matches!(
                legacy.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
        };
        peer_excluded();
        let reader = lease.snapshot().await.unwrap();
        assert_eq!(
            reader.read(&key).await.unwrap().as_deref(),
            Some(&b"sealed"[..])
        );
        assert!(matches!(
            lease.open_checked_writer(|_| Ok(())).await,
            Err(Error::WriterBusy)
        ));
        reader.shutdown().await.unwrap();
        peer_excluded();
        assert!(matches!(
            lease
                .open_checked_writer(|_| Err(Error::IncompatibleStore))
                .await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        peer_excluded();

        let writer = lease.open_checked_writer(|_| Ok(())).await.unwrap();
        peer_excluded();
        writer.shutdown().await.unwrap();
        peer_excluded();
        let inherited = lease.inherited_file().unwrap();
        drop(lease);
        peer_excluded();
        drop(inherited);
        Backend::open_read_only(&path)
            .await
            .unwrap()
            .shutdown()
            .await
            .unwrap();
    }

    #[cfg(target_os = "linux")]
    fn assert_trial_peers_excluded(path: &Path) {
        assert!(matches!(
            builder().open_read_only(path),
            Err(redb::DatabaseError::DatabaseAlreadyOpen)
        ));
        let peer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(matches!(
            peer.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn handoff_shutdown_refuses_retained_engine_handles() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("handoff.omdb");
        let backend = Backend::open(&path, true).await.unwrap();
        let retained = backend.clone();
        assert!(matches!(
            backend.shutdown_for_handoff().await,
            Err(Error::WriterBusy)
        ));
        retained.shutdown_for_handoff().await.unwrap();
        let lease = ExclusiveTrialFile::acquire(path.clone(), 128 * 1024 * 1024).unwrap();
        let reader = lease.snapshot().await.unwrap();
        let retained = reader.clone();
        assert!(matches!(
            reader.shutdown_for_handoff().await,
            Err(Error::WriterBusy)
        ));
        assert_trial_peers_excluded(&path);
        retained.shutdown_for_handoff().await.unwrap();
        assert_trial_peers_excluded(&path);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn inherited_trial_writer_preserves_parent_lease_cursor_and_restart() {
        use std::io::{Seek, SeekFrom};

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("candidate.omdb");
        let backend = Backend::open(&path, true).await.unwrap();
        let key = store_key("test/inherited-writer");
        let mut tx = backend.begin().await.unwrap();
        tx.put(key.clone(), b"before".to_vec()).await.unwrap();
        tx.commit().await.unwrap();
        backend.shutdown().await.unwrap();
        let lease = ExclusiveTrialFile::acquire(path.clone(), 128 * 1024 * 1024).unwrap();
        let mut cursor = lease.inherited_file().unwrap();
        cursor.seek(SeekFrom::Start(173)).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_trial_peers_excluded(&path);

        // Neither a pathname reopen nor a failed admission may change bytes.
        let reopened = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(matches!(
            Backend::inherited_trial_checked_writer(reopened, 128 * 1024 * 1024, |_| Ok(())).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            Backend::inherited_trial_checked_writer(
                lease.inherited_file().unwrap(),
                128 * 1024 * 1024,
                |_| Err(Error::IncompatibleStore),
            )
            .await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(cursor.stream_position().unwrap(), 173);
        assert_trial_peers_excluded(&path);

        let expected = path_identity(&path).unwrap();
        let writer = Backend::inherited_trial_checked_writer(
            lease.inherited_file().unwrap(),
            128 * 1024 * 1024,
            move |file| {
                if file_identity(file)? != expected {
                    return Err(Error::IncompatibleStore);
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_trial_peers_excluded(&path);
        let mut tx = writer.begin().await.unwrap();
        tx.put(key.clone(), b"committed".to_vec()).await.unwrap();
        tx.commit().await.unwrap();
        let mut tx = writer.begin().await.unwrap();
        tx.put(key.clone(), b"rolled-back".to_vec()).await.unwrap();
        tx.rollback().await.unwrap();
        writer.shutdown().await.unwrap();
        assert_trial_peers_excluded(&path);
        assert_eq!(cursor.stream_position().unwrap(), 173);

        // Restart the real engine under the same lease, then verify durability
        // again after the supervisor's final description is gone.
        let writer = Backend::inherited_trial_checked_writer(
            lease.inherited_file().unwrap(),
            128 * 1024 * 1024,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(
            writer.read(&key).await.unwrap(),
            Some(b"committed".to_vec())
        );
        writer.shutdown().await.unwrap();
        assert_trial_peers_excluded(&path);
        assert_eq!(cursor.stream_position().unwrap(), 173);
        drop(cursor);
        drop(lease);
        let reader = Backend::open_read_only(&path).await.unwrap();
        assert_eq!(
            reader.read(&key).await.unwrap(),
            Some(b"committed".to_vec())
        );
        reader.shutdown().await.unwrap();
        println!(
            "T05 inherited writer: admission refusal, commit, rollback, engine restart, parent locks and cursor"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn inherited_trial_writer_refuses_foreign_oversize_and_corrupt_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("foreign.omdb");
        Backend::open(&path, true)
            .await
            .unwrap()
            .shutdown()
            .await
            .unwrap();
        let lease = ExclusiveTrialFile::acquire(path.clone(), 128 * 1024 * 1024).unwrap();
        let before = std::fs::read(&path).unwrap();
        let foreign_identity = path_identity(&path).unwrap();
        let other = directory.path().join("expected.omdb");
        Backend::open(&other, true)
            .await
            .unwrap()
            .shutdown()
            .await
            .unwrap();
        let expected = path_identity(&other).unwrap();
        assert_ne!(foreign_identity, expected);
        assert!(matches!(
            Backend::inherited_trial_checked_writer(
                lease.inherited_file().unwrap(),
                128 * 1024 * 1024,
                move |file| {
                    if file_identity(file)? != expected {
                        return Err(Error::IncompatibleStore);
                    }
                    Ok(())
                },
            )
            .await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            Backend::inherited_trial_checked_writer(
                lease.inherited_file().unwrap(),
                1,
                |_| panic!("oversize reached admission"),
            )
            .await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_trial_peers_excluded(&path);
        drop(lease);

        let path = directory.path().join("corrupt.omdb");
        let before = vec![0x5a; 8192];
        std::fs::write(&path, &before).unwrap();
        let lease = ExclusiveTrialFile::acquire(path.clone(), 128 * 1024 * 1024).unwrap();
        let reached_admission = Arc::new(AtomicBool::new(false));
        let observed = reached_admission.clone();
        assert!(
            Backend::inherited_trial_checked_writer(
                lease.inherited_file().unwrap(),
                128 * 1024 * 1024,
                move |_| {
                    observed.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
            .is_err()
        );
        assert!(!reached_admission.load(Ordering::Acquire));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // A failed engine open must not release either parent lock.
        let peer = redb::backends::FileBackend::new(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
        )
        .unwrap();
        assert!(
            !peer
                .try_lock_range(Bound::Unbounded, Bound::Unbounded)
                .unwrap()
        );
        assert!(matches!(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
                .try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        println!(
            "T05 inherited writer: foreign, oversize and corrupt refusals preserve bytes and locks"
        );
    }

    #[test]
    fn checked_open_preserves_internal_lock_waits_after_writer_acquisition() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let open_file = || {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(temporary.path())
                .unwrap()
        };
        let backend = NonblockingOpen {
            file: redb::backends::FileBackend::new(open_file()).unwrap(),
            locks: Arc::new(OpenLocks {
                opening: AtomicBool::new(true),
                writer_acquired: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                mutated: AtomicBool::new(false),
            }),
        };
        let peer = redb::backends::FileBackend::new(open_file()).unwrap();
        let writer = (Bound::Included(2048), Bound::Included(2048));
        let header = (Bound::Included(4096), Bound::Included(4096));
        backend.lock_range(writer.0, writer.1).unwrap();
        peer.lock_shared_range(header.0, header.1).unwrap();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = backend.lock_range(header.0, header.1);
            let acquired = result.is_ok();
            send.send(result).unwrap();
            if acquired {
                backend.unlock_range(header.0, header.1).unwrap();
            }
            backend.unlock_range(writer.0, writer.1).unwrap();
        });
        let early = receive.recv_timeout(Duration::from_millis(20));
        let waited = matches!(early, Err(mpsc::RecvTimeoutError::Timeout));
        peer.unlock_range(header.0, header.1).unwrap();
        let outcome = match early {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                receive.recv_timeout(Duration::from_secs(1)).unwrap()
            }
            Err(error) => panic!("internal lock worker disconnected: {error}"),
        };
        worker.join().unwrap();
        assert!(
            waited,
            "an internal header wait was rejected after writer acquisition: {outcome:?}"
        );
        outcome.unwrap();
    }

    #[tokio::test]
    async fn stale_key_and_range_observations_cannot_commit() {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let peer = fixture.connect().await;
        let first = store_key("test/range/a");
        let second = store_key("test/range/b");
        let outcome = store_key("test/outcome");
        let mut seed = store.db.begin().await.unwrap();
        seed.put(first.clone(), b"old".to_vec()).await.unwrap();
        seed.commit().await.unwrap();

        let mut stale = store.db.begin().await.unwrap();
        assert_eq!(stale.get(&first).await.unwrap(), Some(b"old".to_vec()));
        let mut fresh = peer.db.begin().await.unwrap();
        fresh.put(first.clone(), b"new".to_vec()).await.unwrap();
        fresh.commit().await.unwrap();
        stale
            .put(outcome.clone(), b"stale decision".to_vec())
            .await
            .unwrap();
        assert!(matches!(
            stale.commit().await,
            Err(Error::TransactionConflict)
        ));
        assert!(store.db.read(&outcome).await.unwrap().is_none());

        let mut stale = store.db.begin().await.unwrap();
        let start = store_key("test/range/");
        let end = store_key("test/range0");
        assert_eq!(
            stale.scan(&start, &end, 2).await.unwrap(),
            [(first.clone(), b"new".to_vec())]
        );
        let mut fresh = peer.db.begin().await.unwrap();
        fresh
            .insert(second.clone(), b"phantom".to_vec())
            .await
            .unwrap();
        fresh.commit().await.unwrap();
        stale
            .put(outcome.clone(), b"stale range decision".to_vec())
            .await
            .unwrap();
        assert!(matches!(
            stale.commit().await,
            Err(Error::TransactionConflict)
        ));
        assert!(store.db.read(&outcome).await.unwrap().is_none());

        let mut buffered = store.db.begin().await.unwrap();
        buffered.delete(first).await.unwrap();
        buffered
            .put(second.clone(), b"buffered".to_vec())
            .await
            .unwrap();
        assert_eq!(
            buffered.scan(&start, &end, 1).await.unwrap(),
            [(second, b"buffered".to_vec())]
        );
        buffered.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn immutable_read_snapshots_page_without_retaining_write_observations() {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let peer = fixture.connect().await;
        let start = store_key("test/readonly/");
        let end = store_key("test/readonly0");
        let keys = (0..1024)
            .map(|index| store_key(&format!("test/readonly/{index:04}")))
            .collect::<Vec<_>>();
        let mut seed = store.db.begin().await.unwrap();
        for key in &keys {
            seed.put(key.clone(), b"original".to_vec()).await.unwrap();
        }
        seed.commit().await.unwrap();

        let mut snapshot = store.db.begin_read_only().await.unwrap();
        assert_eq!(
            snapshot.get(&keys[0]).await.unwrap(),
            Some(b"original".to_vec())
        );
        let mut fresh = peer.db.begin().await.unwrap();
        fresh
            .put(keys[0].clone(), b"updated".to_vec())
            .await
            .unwrap();
        fresh.commit().await.unwrap();
        // Repeated pages cross the writable observation limit without retaining
        // their keys or bodies, while the actual engine snapshot stays stable.
        for _ in 0..70 {
            let page = snapshot.scan(&start, &end, 1024).await.unwrap();
            assert_eq!(page.len(), 1024);
            assert_eq!(page[0].1, b"original");
        }
        assert_eq!(
            snapshot.get_many(&keys).await.unwrap(),
            vec![Some(b"original".to_vec()); 1024]
        );
        assert!(snapshot.reads.is_empty());
        assert!(snapshot.mutation_reads.is_empty());
        assert!(snapshot.ranges.is_empty());
        assert_eq!(snapshot.observed_bytes, 0);
        assert_eq!(snapshot.observed_records, 0);
        assert!(matches!(
            snapshot.put(keys[0].clone(), b"forbidden".to_vec()).await,
            Err(Error::Invalid(_))
        ));
        snapshot.rollback().await.unwrap();

        // Writable snapshots retain the original range/conflict resource caps.
        let mut writable = store.db.begin().await.unwrap();
        let mut bounded = false;
        for _ in 0..70 {
            match writable.scan(&start, &end, 1024).await {
                Ok(_) => {}
                Err(Error::ResourceLimit(ResourceLimit::ObservationBudget)) => {
                    bounded = true;
                    break;
                }
                Err(error) => panic!("unexpected writable scan error: {error:?}"),
            }
        }
        assert!(bounded);
        writable.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn opening_and_initializing_preserve_missing_or_incompatible_files() {
        let fixture = TestFixture::start().await;
        assert!(Store::open_local(fixture.path()).await.is_err());
        assert!(!fixture.path().exists());

        let original = b"an existing unrelated file";
        std::fs::write(fixture.path(), original).unwrap();
        assert!(Store::initialize_local(fixture.path()).await.is_err());
        assert_eq!(std::fs::read(fixture.path()).unwrap(), original);
        std::fs::remove_file(fixture.path()).unwrap();

        let store = fixture.initialize().await;
        let again = Store::initialize_local(fixture.path()).await.unwrap();
        assert_eq!(
            store.snapshot().await.unwrap(),
            again.snapshot().await.unwrap()
        );
        store.shutdown().await.unwrap();
        again.shutdown().await.unwrap();

        let foreign = fixture.path().with_file_name("foreign.redb");
        let path = foreign.clone();
        tokio::task::spawn_blocking(move || {
            let database = Database::create(path).unwrap();
            let transaction = database.begin_write().unwrap();
            {
                let mut table = transaction
                    .open_table(TableDefinition::<u64, u64>::new("foreign"))
                    .unwrap();
                table.insert(1, 77).unwrap();
            }
            transaction.commit().unwrap();
        })
        .await
        .unwrap();
        assert!(matches!(
            Store::initialize_local(&foreign).await,
            Err(Error::IncompatibleStore)
        ));
        tokio::task::spawn_blocking(move || {
            let database = Database::open(foreign).unwrap();
            let transaction = database.begin_read().unwrap();
            let table = transaction
                .open_table(TableDefinition::<u64, u64>::new("foreign"))
                .unwrap();
            assert_eq!(table.get(1).unwrap().unwrap().value(), 77);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn initialization_rejects_data_without_a_store_identity() {
        let fixture = TestFixture::start().await;
        let backend = Backend::open(fixture.path(), true).await.unwrap();
        let mut transaction = backend.begin().await.unwrap();
        transaction
            .put(b"unrelated-key".to_vec(), b"preserve this".to_vec())
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        assert!(matches!(
            Store::initialize_local(fixture.path()).await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(
            backend.read(b"unrelated-key").await.unwrap(),
            Some(b"preserve this".to_vec())
        );
        assert!(
            backend
                .read(&store_key("meta/state"))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn store_modes_refuse_a_symlink_and_preserve_its_target() {
        let fixture = TestFixture::start().await;
        fixture.initialize().await.shutdown().await.unwrap();
        let original = std::fs::read(fixture.path()).unwrap();
        let link = fixture.path().with_file_name("linked.redb");
        std::os::unix::fs::symlink(fixture.path(), &link).unwrap();

        assert!(matches!(
            Store::open_read_only(&link).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            Store::open_local(&link).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            Store::open_exclusive(&link).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            Store::initialize_local(&link).await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(std::fs::read(fixture.path()).unwrap(), original);

        let dangling = fixture.path().with_file_name("dangling.redb");
        let absent = fixture.path().with_file_name("absent.redb");
        std::os::unix::fs::symlink(&absent, &dangling).unwrap();
        assert!(matches!(
            Store::initialize_local(&dangling).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(!absent.exists());
    }

    #[tokio::test]
    async fn clean_file_payload_corruption_is_rejected_on_open_and_initialize() {
        const ORIGINAL: &[u8] = b"UNIQUE_PROJECTION_PAYLOAD_ORIGINAL";
        const CORRUPTED: &[u8] = b"UNIQUE_PROJECTION_PAYLOAD_CORRUPTD";
        assert_eq!(ORIGINAL.len(), CORRUPTED.len());
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let payload = serde_json::json!({"marker": std::str::from_utf8(ORIGINAL).unwrap()});
        let command = CommitBatch {
            command_id: "corruption-command".into(),
            request_digest: request_digest(&payload),
            expected_revision: 0,
            events: Vec::new(),
            projections: vec![ProjectionMutation::Put {
                key: "project/corruption".into(),
                payload,
            }],
            effects: Vec::new(),
            result: serde_json::Value::Null,
        };
        store.commit(&command).await.unwrap();
        store.shutdown().await.unwrap();

        // Alter valid JSON without changing its length, after the clean-close marker was saved.
        // Application-level JSON and payload-size validation alone cannot detect this damage.
        let mut bytes = std::fs::read(fixture.path()).unwrap();
        let positions = bytes
            .windows(ORIGINAL.len())
            .enumerate()
            .filter_map(|(position, value)| (value == ORIGINAL).then_some(position))
            .collect::<Vec<_>>();
        assert_eq!(
            positions.len(),
            1,
            "fixture must contain one payload marker"
        );
        bytes[positions[0]..positions[0] + CORRUPTED.len()].copy_from_slice(CORRUPTED);
        for initialize in [false, true] {
            let path = fixture.path().with_file_name(if initialize {
                "corrupt-initialize.redb"
            } else {
                "corrupt-open.redb"
            });
            std::fs::write(&path, &bytes).unwrap();
            let opened = if initialize {
                Store::initialize_local(&path).await
            } else {
                Store::open_local(&path).await
            };
            if let Ok(store) = opened {
                let observed = store.snapshot().await.unwrap();
                store.shutdown().await.unwrap();
                panic!(
                    "checksum-corrupt database was accepted (initialize={initialize}), returning {:?}",
                    observed.projections
                );
            }
        }
    }

    #[derive(Debug)]
    struct FailingSync {
        inner: redb::backends::InMemoryBackend,
        fail: Arc<AtomicBool>,
    }

    impl StorageBackend for FailingSync {
        fn len(&self) -> io::Result<u64> {
            self.inner.len()
        }
        fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
            StorageBackend::read(&self.inner, offset, out)
        }
        fn set_len(&self, len: u64) -> io::Result<()> {
            self.inner.set_len(len)
        }
        fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
            StorageBackend::write(&self.inner, offset, data)
        }
        fn sync_data(&self) -> io::Result<()> {
            if self.fail.load(Ordering::SeqCst) {
                Err(io::Error::other("injected durable flush failure"))
            } else {
                self.inner.sync_data()
            }
        }
    }

    #[tokio::test]
    async fn real_engine_flush_failure_has_an_unknown_commit_outcome() {
        let fail = Arc::new(AtomicBool::new(false));
        let control = fail.clone();
        let database = tokio::task::spawn_blocking(move || {
            let database = Database::builder()
                .create_with_backend(FailingSync {
                    inner: redb::backends::InMemoryBackend::new(),
                    fail: control,
                })
                .unwrap();
            let transaction = database.begin_write().unwrap();
            transaction.open_table(TABLE).unwrap();
            transaction.commit().unwrap();
            database
        })
        .await
        .unwrap();
        let backend = Backend {
            handles: Arc::new(DatabaseHandles {
                path: PathBuf::new(),
                exclusive: false,
                read_only: false,
                identity: None,
                reader: None,
                writer: Mutex::new(Some(Arc::new(database))),
                opening: Mutex::new(()),
            }),
        };
        let mut transaction = backend.begin().await.unwrap();
        transaction
            .put(b"receipt".to_vec(), b"possibly committed".to_vec())
            .await
            .unwrap();
        fail.store(true, Ordering::SeqCst);
        assert!(matches!(
            transaction.commit().await,
            Err(Error::UnknownCommit)
        ));
        fail.store(false, Ordering::SeqCst);
        // redb retains the earlier I/O failure; explicit close must report it too.
        assert!(matches!(backend.shutdown().await, Err(Error::Database(_))));
    }
}
