//! Lifetime state-directory ownership using the pinned engine's native byte-range locks.
//! The historical lock filename is retained so old SQLite owners exclude native owners.
//! Acquiring/checking never changes bytes. Activation writes a durable marker
//! only after the caller has committed the native database transition.

use crate::{Error, Result};
use redb::StorageBackend;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::{self, BufRead, Read, Write};
use std::ops::Bound;
use std::path::{Path, PathBuf};

const SQLITE_PENDING_BYTE: u64 = 0x4000_0000;
const NATIVE_OWNER_MARKER: &[u8] = b"t3code-omdb-owner-v1\n";

pub struct OwnerLock {
    file: redb::backends::FileBackend,
    identity: same_file::Handle,
    path: PathBuf,
    replaced_during_acquire: bool,
}

impl OwnerLock {
    pub fn acquire(path: &Path) -> Result<Self> {
        Self::acquire_with(path, true)
    }

    pub(crate) fn acquire_existing_native(path: &Path) -> Result<Self> {
        let owner = Self::acquire_with(path, false)?;
        owner.verify_native()?;
        Ok(owner)
    }

    fn acquire_with(path: &Path, create: bool) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::Invalid("ownership path must be absolute".into()));
        }
        if create {
            let parent = path.parent().ok_or(Error::IncompatibleStore)?;
            std::fs::create_dir_all(parent)
                .map_err(|_| Error::Database("ownership directory unavailable".into()))?;
        }
        let identity_at_path = || {
            if create {
                same_file::Handle::from_path(path).map_err(|_| Error::IncompatibleStore)
            } else {
                crate::backend::path_identity(path)
            }
        };
        let before = identity_at_path().ok();
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(create)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = if create {
            options
                .open(path)
                .map_err(|_| Error::Database("ownership lock unavailable".into()))?
        } else {
            crate::backend::open_regular_file(path, &mut options)?
        };
        let identity = same_file::Handle::from_file(
            file.try_clone()
                .map_err(|_| Error::Database("ownership identity unavailable".into()))?,
        )
        .map_err(|_| Error::Database("ownership identity unavailable".into()))?;
        let file = redb::backends::FileBackend::new(file)
            .map_err(|_| Error::Database("ownership lock unavailable".into()))?;
        // Pinned omdb uses F_OFD_SETLK on Linux/Apple and LockFileEx on Windows.
        // Cover pending, reserved, and all shared bytes; these conflict with SQLite's fcntl/LockFileEx locks.
        if !file
            .try_lock_range(
                Bound::Included(SQLITE_PENDING_BYTE),
                Bound::Excluded(SQLITE_PENDING_BYTE + 512),
            )
            .map_err(|_| Error::Database("ownership byte-range lock unsupported".into()))?
        {
            return Err(Error::WriterBusy);
        }
        let current = identity_at_path()?;
        let replaced_during_acquire =
            current != identity || before.as_ref().is_some_and(|before| *before != identity);
        Ok(Self {
            file,
            identity,
            path: path.into(),
            replaced_during_acquire,
        })
    }
    pub fn owned(&self) -> Result<bool> {
        match same_file::Handle::from_path(&self.path) {
            Ok(identity) => Ok(identity == self.identity),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(Error::Database("ownership identity unavailable".into())),
        }
    }

    pub(crate) fn verify_native(&self) -> Result<()> {
        if self.replaced_during_acquire
            || crate::backend::path_identity(&self.path)? != self.identity
            || !self.matches_native_marker()?
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }

    fn matches_native_marker(&self) -> Result<bool> {
        let length = self
            .file
            .len()
            .map_err(|_| Error::Database("ownership file unavailable".into()))?;
        if length != NATIVE_OWNER_MARKER.len() as u64 {
            return Ok(false);
        }
        let mut bytes = [0; NATIVE_OWNER_MARKER.len()];
        self.file
            .read(0, &mut bytes)
            .map_err(|_| Error::Database("ownership marker unreadable".into()))?;
        Ok(bytes.as_slice() == NATIVE_OWNER_MARKER)
    }

    /// Production preflight while the ordinary server owner is held. This is
    /// a refusal boundary, not authority to consume a prepared/forward catalog.
    /// Keep the catalog's permanent fence and all trial receipts unchanged.
    /// The caller must finish legacy PID/boot-service exclusion before invoking.
    pub async fn check_server_startup(&self) -> Result<()> {
        if self.path.file_name().and_then(|name| name.to_str()) != Some("server-owner.sqlite")
            || self.replaced_during_acquire
            || !self.owned()?
        {
            return Err(Error::IncompatibleStore);
        }
        let database = self
            .path
            .parent()
            .ok_or(Error::IncompatibleStore)?
            .join("statev2.omdb");
        match std::fs::symlink_metadata(&database) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(Error::IncompatibleStore),
            Ok(metadata) if !metadata.is_file() => return Err(Error::IncompatibleStore),
            Ok(_) => {}
        }
        let store = match crate::Store::open_read_only(&database).await {
            Ok(store) => store,
            // Preserve ordinary crash recovery under this exclusive application
            // owner. Only an explicit recovery-required result permits it. A
            // busy, foreign or incompatible file never selects another route.
            Err(Error::RecoveryRequired) => crate::Store::open_exclusive(&database).await?,
            Err(error) => return Err(error),
        };
        let inspected = store.serving_startup_migrations().await;
        // Close every engine before the server can construct its storage layers.
        // Failed completion never grants startup, even after a valid inspection.
        let closed = store.shutdown().await;
        inspected?;
        closed?;
        if !self.owned()? {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }

    pub fn activate_native(&self) -> Result<()> {
        if self.path.file_name().and_then(|name| name.to_str()) != Some("server-owner.sqlite")
            || !self.owned()?
        {
            return Err(Error::IncompatibleStore);
        }
        let length = self
            .file
            .len()
            .map_err(|_| Error::Database("ownership file unavailable".into()))?;
        // Historical ownership never writes database content. Refuse to truncate
        // unexpected nonempty data even if someone placed it at the lock path.
        if length != 0 && !self.matches_native_marker()? {
            return Err(Error::IncompatibleStore);
        }
        self.file
            .write(0, NATIVE_OWNER_MARKER)
            .map_err(|_| Error::UnknownCommit)?;
        self.file
            .set_len(NATIVE_OWNER_MARKER.len() as u64)
            .map_err(|_| Error::UnknownCommit)?;
        self.file.sync_data().map_err(|_| Error::UnknownCommit)?;
        #[cfg(unix)]
        {
            std::fs::File::open(self.path.parent().ok_or(Error::UnknownCommit)?)
                .and_then(|parent| parent.sync_all())
                .map_err(|_| Error::UnknownCommit)?;
        }
        if !self.owned().map_err(|_| Error::UnknownCommit)? {
            return Err(Error::UnknownCommit);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    OwnerAcquire,
    OwnerCheckStartup,
    OwnerCheck,
    OwnerActivate,
}

fn reply(result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => {
            json!({"ok":false,"error":{"kind":match error {Error::WriterBusy=>"writer_busy",Error::IncompatibleStore=>"incompatible_store",Error::Invalid(_)=>"invalid_request",Error::UnknownCommit=>"unknown_commit",_=>"database_error"},"message":"native ownership request rejected"}})
        }
    }
}

/// Dedicated process: dropping stdin or killing the process releases the OS lock.
pub async fn run(path: &Path) -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut owner: Option<OwnerLock> = None;
    loop {
        let mut frame = Vec::new();
        let count = input.by_ref().take(4097).read_until(b'\n', &mut frame)?;
        if count == 0 {
            return Ok(());
        }
        let response = if count > 4096 {
            reply(Err(Error::Invalid("ownership frame too large".into())))
        } else {
            let request = serde_json::from_slice::<Request>(&frame)
                .map_err(|_| Error::Invalid("invalid ownership request".into()));
            let result = async {
                match request? {
                    Request::OwnerAcquire => {
                        if owner.is_some() {
                            return Err(Error::Invalid("ownership already acquired".into()));
                        }
                        let acquired = OwnerLock::acquire(path)?;
                        let result = json!({"owned": acquired.owned()?,
                            "replaced_during_acquire": acquired.replaced_during_acquire});
                        owner = Some(acquired);
                        Ok(result)
                    }
                    Request::OwnerCheckStartup => {
                        owner.as_ref().ok_or_else(|| Error::Invalid("ownership not acquired".into()))?
                            .check_server_startup().await?;
                        Ok(json!({"checked": true}))
                    }
                    Request::OwnerCheck => Ok(json!({"owned": owner.as_ref()
                        .ok_or_else(|| Error::Invalid("ownership not acquired".into()))?.owned()?})),
                    Request::OwnerActivate => {
                        owner.as_ref().ok_or_else(|| Error::Invalid("ownership not acquired".into()))?
                            .activate_native()?;
                        Ok(json!({"activated": true}))
                    }
                }
            }.await;
            reply(result)
        };
        serde_json::to_writer(&mut output, &response)?;
        writeln!(output)?;
        output.flush()?;
        if count > 4096 {
            return Ok(());
        }
    }
}
