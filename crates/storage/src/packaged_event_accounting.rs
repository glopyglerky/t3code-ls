//! Test-only aggregate inspection of the closed synthetic packaged full/compact pair.
//! Reports stored bytes, never reconstructed payloads, keys or values.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Error, Result, Store, application::row_prefix, store_key};

const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_KEYS: u64 = 100_000;
const MAX_KV_BYTES: u64 = 256 * 1024 * 1024;

fn invalid() -> Error {
    Error::Invalid("packaged event accounting fixture refused".into())
}

fn digest(path: &Path) -> Result<String> {
    let mut input = std::fs::File::open(path).map_err(|_| invalid())?;
    if input.metadata().map_err(|_| invalid())?.len() > MAX_FILE_BYTES {
        return Err(invalid());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut remaining = MAX_FILE_BYTES + 1;
    loop {
        let n = input.read(&mut buffer).map_err(|_| invalid())?;
        if n == 0 {
            break;
        }
        remaining = remaining.checked_sub(n as u64).ok_or_else(invalid)?;
        if remaining == 0 {
            return Err(invalid());
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bytes {
    keys: u64,
    key_bytes: u64,
    value_bytes: u64,
}

fn category(key: &[u8], rows: &[u8], events: &[u8]) -> &'static str {
    if key.starts_with(rows) {
        return "eventRows";
    }
    if let Some(suffix) = key.strip_prefix(events) {
        if suffix.starts_with(b"text-v1/head/") {
            return "revisionHeads";
        }
        if suffix.starts_with(b"text-v1/dependent/") {
            return "revisionWitnesses";
        }
        return "eventIndexesAndMetadata";
    }
    "otherStoreRows"
}

/// Only the existing synthetic fixture root and its two fixed file locations are accepted.
/// The caller supplies the exact file hash after all browser/application processes exit.
pub async fn inspect(root: &Path, profile: &str, expected_sha256: &str) -> Result<Value> {
    if !matches!(profile, "full" | "compact")
        || !root.is_absolute()
        || !root
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("t3code-hybrid-client-"))
        || expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    let path = root.join(format!("native-{profile}/state/userdata/statev2.omdb"));
    // Reject symlinks anywhere in this exact path, including the supplied root.
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor)
            .map_err(|_| invalid())?
            .file_type()
            .is_symlink()
        {
            return Err(invalid());
        }
    }
    if !std::fs::metadata(&path).map_err(|_| invalid())?.is_file() {
        return Err(invalid());
    }
    let identity = same_file::Handle::from_path(&path).map_err(|_| invalid())?;
    if digest(&path)? != expected_sha256 {
        return Err(invalid());
    }
    let store = Store::open_read_only(&path).await?;
    let generation = store.generation_identity().await?.ok_or_else(invalid)?;
    let layout = if profile == "full" {
        "t3-application-keyspace-v1"
    } else {
        "t3-application-keyspace-v1+assistant-text-revisions-v1"
    };
    if generation.generation != "native"
        || generation.engine != "omdb"
        || generation.layout != layout
    {
        return Err(invalid());
    }
    let rows = row_prefix("native", "orchestration_events")?;
    let events = store_key("application/generation/native/events/v1/");
    let mut groups: BTreeMap<&str, Bytes> = [
        "eventRows",
        "revisionHeads",
        "revisionWitnesses",
        "eventIndexesAndMetadata",
        "otherStoreRows",
    ]
    .into_iter()
    .map(|name| (name, Bytes::default()))
    .collect();
    let mut raw = store.db.begin_read_only().await?;
    let mut start = Vec::new();
    let mut total = Bytes::default();
    loop {
        let page = raw.scan(&start, &[u8::MAX], 64).await?;
        let Some((last, _)) = page.last() else {
            break;
        };
        for (key, value) in &page {
            total.keys += 1;
            total.key_bytes += key.len() as u64;
            total.value_bytes += value.len() as u64;
            if total.keys > MAX_KEYS || total.key_bytes + total.value_bytes > MAX_KV_BYTES {
                return Err(invalid());
            }
            let group = groups
                .get_mut(category(key, &rows, &events))
                .ok_or_else(invalid)?;
            group.keys += 1;
            group.key_bytes += key.len() as u64;
            group.value_bytes += value.len() as u64;
        }
        start.clone_from(last);
        start.push(0);
    }
    raw.rollback().await?;
    store.shutdown().await?;
    if groups["eventRows"].keys == 0
        || same_file::Handle::from_path(&path).map_err(|_| invalid())? != identity
        || digest(&path)? != expected_sha256
    {
        return Err(invalid());
    }
    Ok(json!({
        "schemaVersion": 1, "profile": profile, "fixtureSha256": expected_sha256,
        "identity": generation, "groups": groups, "wholeStore": total,
        "fileBytesAfterShutdown": std::fs::metadata(&path).map_err(|_| invalid())?.len(),
        "boundary": "raw persisted key and value lengths in t3_code_ls_v2; disjoint groups sum to wholeStore",
        "excludes": "engine pages, free space, WAL, allocator and filesystem overhead; file length reported separately",
        "gainClaim": null, "isolatedResultPooled": false
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn refuses_non_fixture_roots_profiles_and_unbound_hashes() {
        for (root, profile, hash) in [
            ("relative", "full", "a".repeat(64)),
            ("/not-a-fixture", "full", "a".repeat(64)),
            ("/t3code-hybrid-client-test", "other", "a".repeat(64)),
            ("/t3code-hybrid-client-test", "full", "A".repeat(64)),
            ("/t3code-hybrid-client-test", "full", "a".repeat(63)),
        ] {
            assert!(inspect(Path::new(root), profile, &hash).await.is_err());
        }
    }

    #[test]
    fn categories_keep_revision_overhead_separate_and_cover_other_rows() {
        let rows = b"rows/";
        let events = b"events/";
        for (key, expected) in [
            (b"rows/1".as_slice(), "eventRows"),
            (b"events/text-v1/head/id".as_slice(), "revisionHeads"),
            (
                b"events/text-v1/dependent/1".as_slice(),
                "revisionWitnesses",
            ),
            (b"events/statistics/1".as_slice(), "eventIndexesAndMetadata"),
            (
                b"foreign/events/text-v1/head/id".as_slice(),
                "otherStoreRows",
            ),
        ] {
            assert_eq!(category(key, rows, events), expected);
        }
    }
}
