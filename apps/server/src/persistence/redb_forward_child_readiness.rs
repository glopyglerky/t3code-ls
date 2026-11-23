//! Linux synthetic readiness adapter. It neither opens an engine nor serves.
//! The supervising fixture retains home, selection and database ownership.
use crate::application::PreparedServiceActivation;
use crate::application_storage::{
    IsolatedTrialVerification, SealedPromotionPhase, TrialFileIdentity, trial_document_sha256,
    trial_executable_digest, trial_file_digest,
};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

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

fn executable_digest(path: &Path) -> Result<String> {
    trial_executable_digest(&File::open(path).map_err(|_| Error::IncompatibleStore)?)
}

/// A successful return is only a synthetic observation. Caller-supplied hashes
/// do not grant ownership, authorize a database open, or permit seal release.
pub fn verify(home: &Path, encoded: &str) -> Result<()> {
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
    // /proc/self/exe binds the running image even if its original name changes.
    if executable_digest(Path::new("/proc/self/exe"))? != activation.target_helper_sha256 {
        return Err(Error::IncompatibleStore);
    }
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
    let marker: serde_json::Value = serde_json::from_slice(&bounded(
        &state.join(format!(".statev2-forward-{}.json", activation.update_id)),
        16 * 1024,
    )?)
    .map_err(|_| Error::IncompatibleStore)?;
    if marker["update_id"] != activation.update_id
        || marker["forward_selection_sha256"] != request.selection_sha256
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
    let inherited = File::open("/proc/self/fd/0").map_err(|_| Error::IncompatibleStore)?;
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
        || trial_file_digest(&inherited)? != request.database_sha256
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
    Ok(())
}
