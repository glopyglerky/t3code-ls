//! Linux synthetic readiness adapter. It reads the inherited lease and never serves.
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
use std::os::fd::AsFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

// Linux 6.3+ executable-memfd policy is required explicitly. Unsupported or
// restricted hosts refuse; never retry without EXEC or adjust host policy.
fn image_seals() -> SealFlags {
    SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::EXEC | SealFlags::SEAL
}

fn verify_image(file: &File, expected: &str) -> Result<()> {
    let metadata = file.metadata().map_err(|_| Error::IncompatibleStore)?;
    if !fcntl_get_seals(file)
        .map_err(|_| Error::IncompatibleStore)?
        .contains(image_seals())
        || metadata.mode() & 0o111 == 0
        || trial_executable_digest(file)? != expected
    {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

/// Fixture-only staging. The copy is private until seals and the exact expected
/// digest have been checked. No descriptor, path or digest transfers authority.
#[cfg(test)]
pub(crate) fn stage_image(source: &Path, expected: &str) -> Result<File> {
    use rustix::fs::{MemfdFlags, fcntl_add_seals, memfd_create};
    use std::io::Seek;
    use std::os::fd::AsRawFd;
    let source = File::open(source).map_err(|_| Error::IncompatibleStore)?;
    let limit = crate::application_storage::MAX_TRIAL_EXECUTABLE_BYTES;
    let metadata = source.metadata().map_err(|_| Error::IncompatibleStore)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(Error::IncompatibleStore);
    }
    let mut image = File::from(
        memfd_create(
            "t3-synthetic-readiness",
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
    image.rewind().map_err(|_| Error::IncompatibleStore)?;
    verify_image(&image, expected)?;
    // Return a fresh read-only description; the writable description is closed.
    File::open(format!("/proc/self/fd/{}", image.as_raw_fd())).map_err(|_| Error::IncompatibleStore)
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

/// A successful return is only a synthetic observation. Caller-supplied hashes
/// do not grant ownership, authorize a writer, or permit seal release.
pub async fn verify(home: &Path, encoded: &str) -> Result<()> {
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
        || inherited_digest(&inherited)? != request.database_sha256
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
    let store = Store {
        db: crate::backend::Backend::inherited_trial_reader(inherited, MAX_TRIAL_FILE_BYTES)
            .await?,
    };
    // Reuse the production decoder, generation validation and bounded full
    // record fingerprint. A prepared-only catalog cannot report readiness.
    let checked = ApplicationTransactions::new(store.clone())
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await;
    store.shutdown().await?;
    if !checked? {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

#[cfg(test)]
mod image_tests {
    use super::*;
    use rustix::fs::{MemfdFlags, fcntl_add_seals, memfd_create};
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::FileExt;

    #[test]
    fn sealed_image_checks_and_refusals() {
        let mut source = tempfile::NamedTempFile::new().unwrap();
        source.write_all(b"synthetic image bytes").unwrap();
        let digest = trial_document_sha256(b"synthetic image bytes");
        let image = stage_image(source.path(), &digest)
            .expect("qualification requires Linux 6.3+ executable memfd permission");
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
        // The source can change without changing the copied sealed content.
        source.as_file().write_at(b"X", 0).unwrap();
        assert!(stage_image(source.path(), &digest).is_err());
        verify_image(&File::open(&path).unwrap(), &digest).unwrap();
        println!(
            "T05 sealed image: seals, write/resize/mode refusal, mutable/bad digest refusal, source isolation"
        );
    }
}
