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
        if !path.is_absolute() {
            return Err(Error::Invalid("ownership path must be absolute".into()));
        }
        let parent = path.parent().ok_or(Error::IncompatibleStore)?;
        std::fs::create_dir_all(parent)
            .map_err(|_| Error::Database("ownership directory unavailable".into()))?;
        let before = same_file::Handle::from_path(path).ok();
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| Error::Database("ownership lock unavailable".into()))?;
        let identity = same_file::Handle::from_file(
            file.try_clone()
                .map_err(|_| Error::Database("ownership identity unavailable".into()))?,
        )
        .map_err(|_| Error::Database("ownership identity unavailable".into()))?;
        let file = redb::backends::FileBackend::new(file)
            .map_err(|_| Error::Database("ownership lock unavailable".into()))?;
        // Pinned omdb uses F_OFD_SETLK on Linux/Apple and LockFileEx on Windows.
        // Cover pending, reserved, and all shared bytes; these conflict with SQLite's fcntl/LockFileEx locks.
        if !try_lock(&file)? {
            return Err(Error::WriterBusy);
        }
        let current = same_file::Handle::from_path(path).map_err(|_| Error::IncompatibleStore)?;
        let replaced_during_acquire =
            current != identity || before.as_ref().is_some_and(|before| *before != identity);
        Ok(Self {
            file,
            identity,
            path: path.into(),
            replaced_during_acquire,
        })
    }
    pub fn held(path: &Path) -> Result<bool> {
        if !path.is_absolute() {
            return Err(Error::Invalid("ownership path must be absolute".into()));
        }
        let existing = match OpenOptions::new().read(true).write(true).open(path) {
            Ok(existing) => existing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(Error::Database("ownership lock unavailable".into())),
        };
        let file = redb::backends::FileBackend::new(existing)
            .map_err(|_| Error::Database("ownership lock unavailable".into()))?;
        Ok(!try_lock(&file)?)
    }

    pub fn owned(&self) -> Result<bool> {
        match same_file::Handle::from_path(&self.path) {
            Ok(identity) => Ok(identity == self.identity),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(Error::Database("ownership identity unavailable".into())),
        }
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
        if length != 0 {
            if length != NATIVE_OWNER_MARKER.len() as u64 {
                return Err(Error::IncompatibleStore);
            }
            let mut bytes = vec![0; NATIVE_OWNER_MARKER.len()];
            self.file
                .read(0, &mut bytes)
                .map_err(|_| Error::Database("ownership marker unreadable".into()))?;
            if bytes != NATIVE_OWNER_MARKER {
                return Err(Error::IncompatibleStore);
            }
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

fn try_lock(file: &redb::backends::FileBackend) -> Result<bool> {
    file.try_lock_range(
        Bound::Included(SQLITE_PENDING_BYTE),
        Bound::Excluded(SQLITE_PENDING_BYTE + 512),
    )
    .map_err(|_| Error::Database("ownership byte-range lock unsupported".into()))
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    OwnerAcquire,
    OwnerCheck,
    OwnerProbe,
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
pub fn run(path: &Path) -> io::Result<()> {
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
            reply(request.and_then(|request| match request {
                Request::OwnerAcquire=>{
                    if owner.is_some() { return Err(Error::Invalid("ownership already acquired".into())); }
                    let acquired=OwnerLock::acquire(path)?;
                    let result=json!({"owned":acquired.owned()?,"replaced_during_acquire":acquired.replaced_during_acquire});
                    owner=Some(acquired); Ok(result)
                },
                Request::OwnerProbe=>Ok(json!({"owned":OwnerLock::held(path)?})),
                Request::OwnerCheck=>Ok(json!({"owned":owner.as_ref().ok_or_else(||Error::Invalid("ownership not acquired".into()))?.owned()?})),
                Request::OwnerActivate=>{
                    owner.as_ref().ok_or_else(||Error::Invalid("ownership not acquired".into()))?.activate_native()?;
                    Ok(json!({"activated":true}))
                },
            }))
        };
        serde_json::to_writer(&mut output, &response)?;
        writeln!(output)?;
        output.flush()?;
        if count > 4096 {
            return Ok(());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn probes_existing_lock_without_creating_or_updating_the_file() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("server-owner.sqlite");
        assert!(!OwnerLock::held(&path).unwrap());
        assert!(!path.exists());

        let owner = OwnerLock::acquire(&path).unwrap();
        owner.activate_native().unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(OwnerLock::held(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);

        drop(owner);
        assert!(!OwnerLock::held(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let owner = OwnerLock::acquire(&path).unwrap();
        assert!(owner.owned().unwrap());
    }
}
