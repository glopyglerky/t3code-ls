//! Linux synthetic catalog receiver. It adopts the inherited lease and never serves.
//! The supervising fixture retains home, selection and database ownership.
use crate::application::{
    ApplicationTransactions, ForwardServiceActivation, PreparedServiceActivation,
};
use crate::application_storage::{
    IsolatedTrialVerification, MAX_TRIAL_FILE_BYTES, SealedPromotionPhase, TrialFileIdentity,
    trial_document_sha256, trial_executable_digest,
};
use crate::{Error, Result, Store};
use rustix::fs::{SealFlags, fcntl_get_seals};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

// Linux 6.3+ executable-memfd policy is required explicitly. Unsupported or
// restricted hosts refuse; never retry without EXEC or adjust host policy.
fn image_seals() -> SealFlags {
    SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::EXEC | SealFlags::SEAL
}

pub(crate) fn verify_image(file: &File, expected: &str) -> Result<()> {
    let metadata = file.metadata().map_err(|_| Error::IncompatibleStore)?;
    if !fcntl_get_seals(file)
        .map_err(|_| Error::IncompatibleStore)?
        .contains(image_seals())
        || metadata.mode() & 0o111 == 0
    {
        return Err(Error::IncompatibleStore);
    }
    // Opening this live descriptor gives each verification its own file offset.
    let image = open_readonly_image(file)?;
    if trial_executable_digest(&image)? != expected {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

fn open_readonly_image(file: &File) -> Result<File> {
    File::open(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|_| Error::IncompatibleStore)
}

/// Require the actual executing helper to have the selected immutable identity.
pub(crate) fn verify_running_image(expected: &str) -> Result<()> {
    verify_image(
        &File::open("/proc/self/exe").map_err(|_| Error::IncompatibleStore)?,
        expected,
    )
}

/// Bounded immutable staging. The copy is private until seals and the exact
/// expected digest have been checked. No descriptor, path or digest transfers
/// authority, proves a package format or grants execution authority.
pub(crate) fn stage_image(source: &Path, expected: &str) -> Result<File> {
    use rustix::fs::{MemfdFlags, fcntl_add_seals, memfd_create};
    let source = crate::backend::open_regular_file(source, fs::OpenOptions::new().read(true))?;
    let limit = crate::application_storage::MAX_TRIAL_EXECUTABLE_BYTES;
    let metadata = source.metadata().map_err(|_| Error::IncompatibleStore)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(Error::IncompatibleStore);
    }
    let mut image = File::from(
        memfd_create(
            "t3-forward-image",
            MemfdFlags::EXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::CLOEXEC,
        )
        .map_err(|_| Error::IncompatibleStore)?,
    );
    let count = std::io::copy(&mut source.take(limit + 1), &mut image)
        .map_err(|_| Error::IncompatibleStore)?;
    if count == 0 || count > limit {
        return Err(Error::IncompatibleStore);
    }
    fcntl_add_seals(&image, image_seals()).map_err(|_| Error::IncompatibleStore)?;
    verify_image(&image, expected)?;
    // The writable description is closed when staging returns.
    open_readonly_image(&image)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessRequest {
    pub activation: PreparedServiceActivation,
    pub database: TrialFileIdentity,
    pub receipt_sha256: String,
    pub selection_sha256: String,
    pub database_sha256: String,
}

fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| Error::IncompatibleStore)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::IncompatibleStore)?;
    if bytes.len() as u64 > limit {
        return Err(Error::IncompatibleStore);
    }
    Ok(bytes)
}

// Positioned reads preserve the parent's shared OFD cursor across retries.
fn inherited_digest(file: &File) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::FileExt;
    let len = file.metadata().map_err(|_| Error::IncompatibleStore)?.len();
    if len == 0 || len > MAX_TRIAL_FILE_BYTES {
        return Err(Error::IncompatibleStore);
    }
    let mut hash = Sha256::new();
    let mut offset = 0;
    let mut buffer = [0; 32 * 1024];
    while offset < len {
        let count = (len - offset).min(buffer.len() as u64) as usize;
        file.read_exact_at(&mut buffer[..count], offset)
            .map_err(|_| Error::IncompatibleStore)?;
        hash.update(&buffer[..count]);
        offset += count as u64;
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn executable_digest(path: &Path) -> Result<String> {
    trial_executable_digest(&File::open(path).map_err(|_| Error::IncompatibleStore)?)
}

// Shared synthetic input checks. Neither hashes nor descriptors grant serving
// authority. The parent owns admission, engine serialization and reconciliation.
fn validate(
    home: &Path,
    encoded: &str,
    check_digest: bool,
) -> Result<(
    ReadinessRequest,
    IsolatedTrialVerification,
    ForwardServiceActivation,
    File,
)> {
    if encoded.len() > 16 * 1024
        || !home.is_absolute()
        || !home
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("t3-redb-test-"))
    {
        return Err(Error::IncompatibleStore);
    }
    let request: ReadinessRequest =
        serde_json::from_str(encoded).map_err(|_| Error::IncompatibleStore)?;
    let activation = &request.activation;
    // Never allow request-controlled path components outside the synthetic home.
    for component in [&activation.update_id, &activation.target_version] {
        if component.is_empty()
            || !component
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            || component == "."
            || component == ".."
        {
            return Err(Error::IncompatibleStore);
        }
    }
    // Inspect seals on the actual running image, not a caller-supplied fd or
    // the installed pathname. Hash only after immutable content is confirmed.
    verify_image(
        &File::open("/proc/self/exe").map_err(|_| Error::IncompatibleStore)?,
        &activation.target_helper_sha256,
    )?;
    let state = home.join("userdata");
    let receipt = bounded(
        &state.join(format!(
            ".statev2-trial-{}.receipt-v1.json",
            activation.update_id
        )),
        1024 * 1024,
    )?;
    let saved: IsolatedTrialVerification =
        serde_json::from_slice(&receipt).map_err(|_| Error::IncompatibleStore)?;
    if trial_document_sha256(&receipt) != request.receipt_sha256
        || saved.request.activation.as_ref() != Some(activation)
        || saved.preparation.database != request.database
        || saved.sealed_publication.as_ref().map(|p| p.phase)
            != Some(SealedPromotionPhase::ForwardCommitted)
        || trial_document_sha256(&bounded(
            &home.join("runtime/service-state.json"),
            1024 * 1024,
        )?) != request.selection_sha256
    {
        return Err(Error::IncompatibleStore);
    }
    let marker: ForwardServiceActivation = serde_json::from_slice(&bounded(
        &state.join(format!(".statev2-forward-{}.json", activation.update_id)),
        16 * 1024,
    )?)
    .map_err(|_| Error::IncompatibleStore)?;
    if marker.update_id != activation.update_id
        || marker.forward_selection_sha256 != request.selection_sha256
    {
        return Err(Error::IncompatibleStore);
    }
    let version = home
        .join("runtime/versions")
        .join(&activation.target_version);
    if executable_digest(&version.join("t3"))? != activation.target_entry_sha256
        || executable_digest(&version.join("native-bin/t3-code-ls-db"))?
            != activation.target_helper_sha256
    {
        return Err(Error::IncompatibleStore);
    }
    // fdinfo names locks held by fd 0's open file description. Reopening that
    // inode does not reproduce this OFD lock. Checking only inode/hash is weaker.
    let info = bounded(Path::new("/proc/self/fdinfo/0"), 16 * 1024)?;
    let info = std::str::from_utf8(&info).map_err(|_| Error::IncompatibleStore)?;
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
    // dup preserves the locked OFD. Opening /proc/self/fd/0 creates a new
    // description and cannot be used as the engine's lease.
    let inherited = File::from(
        std::io::stdin()
            .as_fd()
            .try_clone_to_owned()
            .map_err(|_| Error::IncompatibleStore)?,
    );
    let held = inherited.metadata().map_err(|_| Error::IncompatibleStore)?;
    let named = fs::metadata(state.join("statev2.omdb")).map_err(|_| Error::IncompatibleStore)?;
    let created = held
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_nanos().to_string());
    if !held.is_file()
        || held.nlink() != 1
        || held.dev() != named.dev()
        || held.ino() != named.ino()
        || format!("{:016x}", held.dev()) != request.database.device
        || format!("{:016x}", held.ino()) != request.database.inode
        || created != request.database.created
        || (check_digest && inherited_digest(&inherited)? != request.database_sha256)
    {
        return Err(Error::IncompatibleStore);
    }
    if !matches!(
        crate::application_server_ownership::OwnerLock::acquire_existing_native(
            &state.join("server-owner.sqlite")
        ),
        Err(Error::WriterBusy)
    ) {
        return Err(Error::IncompatibleStore);
    }
    Ok((request, saved, marker, inherited))
}

/// Read-only observation of the permanent marker. Never admits serving.
pub async fn verify(home: &Path, encoded: &str) -> Result<()> {
    let (request, saved, marker, inherited) = validate(home, encoded, true)?;
    let store = Store {
        db: crate::backend::Backend::inherited_trial_reader(inherited, MAX_TRIAL_FILE_BYTES)
            .await?,
    };
    let checked = ApplicationTransactions::new(store.clone())
        .verify_forward_catalog(&request.activation, &marker, &saved.preparation.snapshot)
        .await;
    store.db.shutdown_for_handoff().await?;
    if !checked? {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

/// Synthetic one-transaction receiver. The admitted fixture supervisor retains
/// the real owners and every engine handle is closed before it can reopen.
/// A request or inherited descriptor alone never permits ordinary serving.
pub async fn commit(home: &Path, encoded: &str) -> Result<()> {
    let (request, saved, marker, inherited) = validate(home, encoded, true)?;
    let preview = Store {
        db: crate::backend::Backend::inherited_trial_reader(inherited, MAX_TRIAL_FILE_BYTES)
            .await?,
    };
    let checked = ApplicationTransactions::new(preview.clone())
        .verify_forward_catalog(&request.activation, &marker, &saved.preparation.snapshot)
        .await;
    preview.db.shutdown_for_handoff().await?;
    // Recovery and already committed observations belong to the parent owner.
    // Never replay the writer after uncertain delivery.
    if checked? {
        return Err(Error::IncompatibleStore);
    }
    let (_, _, _, inherited) = validate(home, encoded, true)?;
    let owned_home = home.to_owned();
    let owned_encoded = encoded.to_owned();
    let store = Store {
        db: crate::backend::Backend::inherited_trial_checked_writer(
            inherited,
            MAX_TRIAL_FILE_BYTES,
            move |_| validate(&owned_home, &owned_encoded, true).map(|_| ()),
        )
        .await?,
    };
    let transactions = ApplicationTransactions::new(store.clone());
    let result = transactions
        .mark_forward_catalog(&request.activation, marker, || {
            validate(home, encoded, false).map(|_| ())
        })
        .await;
    drop(transactions);
    let closed = store.db.shutdown_for_handoff().await;
    // Any error after writable open has uncertain delivery; only the owning
    // parent may reconcile through its existing durable-state verifier.
    result.map_err(|_| Error::UnknownCommit)?;
    closed.map_err(|_| Error::UnknownCommit)
}

#[cfg(test)]
mod image_tests {
    use super::*;
    use rustix::fs::{MemfdFlags, fcntl_add_seals, memfd_create};
    use std::io::{Seek, SeekFrom, Write};
    use std::os::unix::fs::FileExt;

    #[test]
    fn sealed_image_checks_and_refusals() {
        let mut source = tempfile::NamedTempFile::new().unwrap();
        source.write_all(b"synthetic image bytes").unwrap();
        let digest = trial_document_sha256(b"synthetic image bytes");
        let mut image = stage_image(source.path(), &digest)
            .expect("qualification requires Linux 6.3+ executable memfd permission");
        verify_image(&image, &digest).unwrap();
        verify_image(&image, &digest).unwrap();
        image.seek(SeekFrom::Start(7)).unwrap();
        verify_image(&image, &digest).unwrap();
        assert_eq!(image.stream_position().unwrap(), 7);
        let path = format!("/proc/self/fd/{}", image.as_raw_fd());
        assert!(fcntl_get_seals(&image).unwrap().contains(image_seals()));
        let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert_eq!(
            writer.write_at(b"X", 0).unwrap_err().raw_os_error(),
            Some(libc::EPERM)
        );
        assert_eq!(
            writer.set_len(0).unwrap_err().raw_os_error(),
            Some(libc::EPERM)
        );
        assert_eq!(
            writer.set_len(999).unwrap_err().raw_os_error(),
            Some(libc::EPERM)
        );
        assert!(rustix::fs::fchmod(&writer, rustix::fs::Mode::RUSR).is_err());
        assert!(fcntl_add_seals(&writer, SealFlags::WRITE).is_err());
        assert!(verify_image(&File::open(source.path()).unwrap(), &digest).is_err());
        let mut mutable = File::from(
            memfd_create(
                "t3-mutable-image",
                MemfdFlags::EXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::CLOEXEC,
            )
            .unwrap(),
        );
        mutable.write_all(b"synthetic image bytes").unwrap();
        let mutable_path = format!("/proc/self/fd/{}", mutable.as_raw_fd());
        assert!(verify_image(&File::open(&mutable_path).unwrap(), &digest).is_err());
        fcntl_add_seals(
            &mutable,
            SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK,
        )
        .unwrap();
        assert!(verify_image(&File::open(&mutable_path).unwrap(), &digest).is_err());
        assert!(verify_image(&File::open(&path).unwrap(), &"0".repeat(64)).is_err());
        assert!(stage_image(source.path(), &"0".repeat(64)).is_err());
        let empty = tempfile::NamedTempFile::new().unwrap();
        assert!(stage_image(empty.path(), &digest).is_err());
        let directory = tempfile::tempdir().unwrap();
        assert!(stage_image(directory.path(), &digest).is_err());
        let link = directory.path().join("image-link");
        std::os::unix::fs::symlink(source.path(), &link).unwrap();
        assert!(stage_image(&link, &digest).is_err());
        // The source can change without changing the copied sealed content.
        source.as_file().write_at(b"X", 0).unwrap();
        assert!(stage_image(source.path(), &digest).is_err());
        verify_image(&File::open(&path).unwrap(), &digest).unwrap();
        println!(
            "T05 sealed image: seals, write/resize/mode refusal, mutable/bad digest refusal, source isolation"
        );
    }
}

// This proves only a synthetic direct child's running image while it awaits
// finish. It does not qualify a packaged SEA, serving, or caller cancellation.
#[cfg(test)]
mod running_image_tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::process::{Child, Command};

    const READY: &[u8] = b"t3-synthetic-image-ready-v1\n";
    const FINISH: &[u8] = b"finish\n";

    #[test]
    #[ignore = "synthetic subprocess selected only by running image tests"]
    fn running_image_fixture() {
        if std::env::var("T3_RUNNING_IMAGE_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        // Independent of the parent's Tokio deadline, including blocked stdin.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(5));
            std::process::exit(124);
        });
        // libtest writes its own stdout. Use stderr for the exact bounded frame.
        std::io::stderr().write_all(READY).unwrap();
        std::io::stderr().flush().unwrap();
        let mut finish = Vec::new();
        let read = std::io::stdin()
            .take(FINISH.len() as u64 + 1)
            .read_to_end(&mut finish);
        std::process::exit(if read.is_ok() && finish == FINISH {
            0
        } else {
            65
        });
    }

    fn spawn_fixture(executable: &Path) -> Child {
        let module = module_path!().split_once("::").unwrap().1;
        Command::new(executable)
            .args([
                "--exact",
                &format!("{module}::running_image_fixture"),
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("T3_RUNNING_IMAGE_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    // PID comes from the retained Child, never a request or readiness frame.
    // The trusted fixture cannot exec again and remains blocked until finish.
    fn verify_owned_image(child: &mut Child, pid: u32, image: &File, digest: &str) -> Result<()> {
        if child.id() != Some(pid)
            || child
                .try_wait()
                .map_err(|_| Error::IncompatibleStore)?
                .is_some()
        {
            return Err(Error::IncompatibleStore);
        }
        let running =
            File::open(format!("/proc/{pid}/exe")).map_err(|_| Error::IncompatibleStore)?;
        let held = image.metadata().map_err(|_| Error::IncompatibleStore)?;
        let actual = running.metadata().map_err(|_| Error::IncompatibleStore)?;
        if (actual.dev(), actual.ino()) != (held.dev(), held.ino())
            || fcntl_get_seals(&running).map_err(|_| Error::IncompatibleStore)?
                != fcntl_get_seals(image).map_err(|_| Error::IncompatibleStore)?
        {
            return Err(Error::IncompatibleStore);
        }
        verify_image(image, digest)?;
        verify_image(&running, digest)?;
        if child
            .try_wait()
            .map_err(|_| Error::IncompatibleStore)?
            .is_some()
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }

    // Child and image outlive the bounded exchange. Every returned error is
    // killed/reaped before either is released. Dropping this caller is unqualified.
    async fn exchange(
        child: &mut Child,
        image: &File,
        other_image: &File,
        digest: &str,
        matches_image: bool,
        finish: Option<&[u8]>,
    ) -> Result<std::process::ExitStatus> {
        let pid = child.id().ok_or(Error::IncompatibleStore)?;
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut ready = vec![0; READY.len()];
            let mut stderr = child.stderr.take().ok_or(Error::IncompatibleStore)?;
            stderr
                .read_exact(&mut ready)
                .await
                .map_err(|_| Error::IncompatibleStore)?;
            if ready != READY {
                return Err(Error::IncompatibleStore);
            }
            if verify_owned_image(child, std::process::id(), image, digest).is_ok()
                || verify_owned_image(child, pid, other_image, digest).is_ok()
                || verify_owned_image(child, pid, image, &"0".repeat(64)).is_ok()
                || verify_owned_image(child, pid, image, digest).is_ok() != matches_image
            {
                return Err(Error::IncompatibleStore);
            }
            // Check the retained fd cursor was not consumed by digest checks.
            if image
                .try_clone()
                .map_err(|_| Error::IncompatibleStore)?
                .stream_position()
                .map_err(|_| Error::IncompatibleStore)?
                != 7
            {
                return Err(Error::IncompatibleStore);
            }
            let mut stdin = child.stdin.take().ok_or(Error::IncompatibleStore)?;
            if let Some(finish) = finish {
                stdin
                    .write_all(finish)
                    .await
                    .map_err(|_| Error::IncompatibleStore)?;
            }
            drop(stdin); // Finish is accepted only with EOF.
            let mut extra = [0; 1];
            if stderr
                .read(&mut extra)
                .await
                .map_err(|_| Error::IncompatibleStore)?
                != 0
            {
                return Err(Error::IncompatibleStore);
            }
            child.wait().await.map_err(|_| Error::IncompatibleStore)
        })
        .await
        .unwrap_or(Err(Error::IncompatibleStore));
        if result.is_err() {
            let killed = child.start_kill();
            child.wait().await.map_err(|_| Error::IncompatibleStore)?;
            killed.map_err(|_| Error::IncompatibleStore)?;
        }
        result
    }

    #[tokio::test]
    async fn running_image_is_owned_sealed_and_reaped() {
        // No installed executable, application home, credentials or provider.
        let executable = std::env::current_exe().unwrap();
        let digest = executable_digest(&executable).unwrap();
        let mut image = stage_image(&executable, &digest)
            .expect("qualification requires Linux 6.3+ executable memfd permission");
        let other_image = stage_image(&executable, &digest).unwrap();
        image.seek(SeekFrom::Start(7)).unwrap();
        let pinned = std::path::PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            image.as_raw_fd()
        ));
        // Same bytes in another sealed inode must fail. The disk process also
        // emits READY, but its actual running image must fail identity checks.
        for (path, matches_image, finish, code) in [
            (pinned.as_path(), true, Some(FINISH), 0),
            (executable.as_path(), false, Some(FINISH), 0),
            (pinned.as_path(), true, None, 65),
            (pinned.as_path(), true, Some(b"wrong\n".as_slice()), 65),
        ] {
            let mut child = spawn_fixture(path);
            let pid = child.id().unwrap();
            let result = exchange(
                &mut child,
                &image,
                &other_image,
                &digest,
                matches_image,
                finish,
            )
            .await;
            // Check cleanup even when the exchange reports an error.
            assert_eq!(child.id(), None, "exchange returned before reaping");
            assert!(child.try_wait().unwrap().is_some(), "missing cached status");
            assert_eq!(result.unwrap().code(), Some(code));
            assert!(verify_owned_image(&mut child, pid, &image, &digest).is_err());
        }
    }
    // Opt-in real SEA composition. Expectations come from this build's retained
    // raw bundle/package metadata, never from the observed child's JSON.
    async fn sea_exchange(
        child: &mut Child,
        image: &File,
        digest: &str,
        expected: &serde_json::Value,
        finish: Option<&[u8]>,
    ) -> Result<std::process::ExitStatus> {
        let pid = child.id().ok_or(Error::IncompatibleStore)?;
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut stdout = child.stdout.take().ok_or(Error::IncompatibleStore)?;
            let mut stderr = child.stderr.take().ok_or(Error::IncompatibleStore)?;
            let mut frame = Vec::new();
            loop {
                if frame.len() >= 4096 {
                    return Err(Error::IncompatibleStore);
                }
                let byte = stdout
                    .read_u8()
                    .await
                    .map_err(|_| Error::IncompatibleStore)?;
                frame.push(byte);
                if byte == b'\n' {
                    break;
                }
            }
            // Compare every frame field against build evidence and the owned
            // PID. The strict decoder also refuses extra or duplicate fields.
            let mut expected = expected.clone();
            expected["pid"] = pid.into();
            let observed: serde_json::Value =
                serde_json::from_slice(&frame).map_err(|_| Error::IncompatibleStore)?;
            if observed != expected {
                return Err(Error::IncompatibleStore);
            }
            // Strict fields also reject duplicates and unknown fields.
            let strict: SeaFrame =
                serde_json::from_slice(&frame).map_err(|_| Error::IncompatibleStore)?;
            let mut encoded = serde_json::to_vec(&strict).map_err(|_| Error::IncompatibleStore)?;
            encoded.push(10);
            if encoded != frame {
                return Err(Error::IncompatibleStore);
            }
            verify_owned_image(child, pid, image, digest)?;
            let mut stdin = child.stdin.take().ok_or(Error::IncompatibleStore)?;
            if let Some(finish) = finish {
                stdin
                    .write_all(finish)
                    .await
                    .map_err(|_| Error::IncompatibleStore)?;
                // Finish alone cannot complete; verify the same live image
                // while EOF is still withheld. Child's own timer bounds this.
                if finish == FINISH {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    verify_owned_image(child, pid, image, digest)?;
                }
            }
            drop(stdin);
            let mut extra = [0; 1];
            let (out, err, status) = tokio::try_join!(
                async {
                    stdout
                        .read(&mut extra)
                        .await
                        .map_err(|_| Error::IncompatibleStore)
                },
                async {
                    let mut byte = [0; 1];
                    stderr
                        .read(&mut byte)
                        .await
                        .map_err(|_| Error::IncompatibleStore)
                },
                async { child.wait().await.map_err(|_| Error::IncompatibleStore) },
            )?;
            if out != 0 || err != 0 {
                return Err(Error::IncompatibleStore);
            }
            Ok(status)
        })
        .await
        .unwrap_or(Err(Error::IncompatibleStore));
        if result.is_err() {
            // Await reap even if the child independently exited before kill.
            let _ = child.start_kill();
            child.wait().await.map_err(|_| Error::IncompatibleStore)?;
        }
        result
    }

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SeaFrame {
        protocol: String,
        package_name: String,
        package_version: String,
        pid: u32,
        platform: String,
        arch: String,
        node_version: String,
        sea: bool,
        asset_name: String,
        asset_bytes: u64,
        asset_sha256: String,
        serving: bool,
    }

    #[tokio::test]
    #[ignore = "requires this build's isolated SEA and independently retained build artifacts"]
    async fn packaged_sea_is_owned_sealed_and_reaped() {
        let entry = std::path::PathBuf::from(std::env::var_os("T3_TEST_SEA_ENTRY").unwrap());
        let expected_path =
            std::path::PathBuf::from(std::env::var_os("T3_TEST_SEA_EXPECTED").unwrap());
        let proof: serde_json::Value =
            serde_json::from_slice(&bounded(&expected_path, 16384).unwrap()).unwrap();
        let digest = proof["entrySha256"].as_str().unwrap();
        let expected = &proof["frame"];
        assert!(stage_image(&entry, &"0".repeat(64)).is_err());
        let image = stage_image(&entry, digest).unwrap();
        let other = stage_image(&entry, digest).unwrap();
        let pinned = std::path::PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            image.as_raw_fd()
        ));
        for case in [
            "valid",
            "frame-mismatch",
            "inode-mismatch",
            "digest-mismatch",
            "missing-finish",
            "wrong-finish",
        ] {
            // Always launch the verified sealed descriptor. No disk fallback.
            let mut child = Command::new(&pinned)
                .arg("__sea-identity-observe")
                .env_clear()
                .current_dir(entry.parent().unwrap())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let pid = child.id().unwrap();
            let mut wanted = expected.clone();
            if case == "frame-mismatch" {
                wanted["assetSha256"] = "0".repeat(64).into();
            }
            let observed_image = if case == "inode-mismatch" {
                &other
            } else {
                &image
            };
            let bad_digest = "0".repeat(64);
            let observed_digest = if case == "digest-mismatch" {
                &bad_digest
            } else {
                digest
            };
            let finish = match case {
                "missing-finish" => None,
                "wrong-finish" => Some(b"wrong\n".as_slice()),
                _ => Some(FINISH),
            };
            let result =
                sea_exchange(&mut child, observed_image, observed_digest, &wanted, finish).await;
            assert_eq!(child.id(), None, "{case}: returned before reap");
            assert!(child.try_wait().unwrap().is_some());
            assert!(verify_owned_image(&mut child, pid, &image, digest).is_err());
            match case {
                "valid" => assert_eq!(result.unwrap().code(), Some(0)),
                "missing-finish" | "wrong-finish" => assert_eq!(result.unwrap().code(), Some(78)),
                _ => assert!(result.is_err(), "{case}: accepted mismatch"),
            }
            eprintln!("T05 SEA composition {case}: reaped");
        }
    }
}
