//! MIT. Read-only aggregate accounting for the stopped synthetic J02 omdb fixture.
use redb::{
    ConcurrencyMode, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    TableDefinition,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, fmt::Write, fs, io::Read, path::Path};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("t3_code_ls_v2");
const SCHEMA: &[u8] = b"t3-code-ls/v2/application/schema";

struct RecordPrefixes {
    generation: String,
    events: String,
    messages: String,
    projections: String,
}

impl RecordPrefixes {
    fn new(generation: &str) -> Result<Self> {
        if generation != "native"
            && !(generation.len() == 64
                && generation
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
        {
            return Err("invalid application generation".into());
        }
        Ok(Self {
            generation: format!("t3-code-ls/v2/application/generation/{generation}/"),
            events: row_prefix("orchestration_events", true),
            messages: row_prefix("orchestration_v2_projection_messages", true),
            projections: row_prefix("orchestration_v2_projection_", false),
        })
    }

    fn category(&self, key: &[u8]) -> &'static str {
        let Some(suffix) = key.strip_prefix(self.generation.as_bytes()) else {
            return "other";
        };
        if suffix.starts_with(self.events.as_bytes()) {
            "event_rows"
        } else if suffix.starts_with(self.messages.as_bytes()) {
            "message_projection_rows"
        } else if suffix.starts_with(self.projections.as_bytes()) {
            "other_projection_rows"
        } else if suffix.starts_with(b"events/v1/") {
            "event_indexes"
        } else if suffix.starts_with(b"projection-reads/v1/")
            || suffix.starts_with(b"projections/v1/")
        {
            "projection_indexes"
        } else if suffix.starts_with(b"metadata/search-") {
            "search_indexes"
        } else if suffix.starts_with(b"message-rowids/") {
            "message_row_id_indexes"
        } else {
            "other"
        }
    }
}

fn row_prefix(table: &str, exact: bool) -> String {
    // The application stores the table name as lowercase hexadecimal.
    let mut prefix = String::from("row/");
    for byte in table.bytes() {
        write!(prefix, "{byte:02x}").expect("writing to String cannot fail");
    }
    if exact {
        prefix.push('/');
    }
    prefix
}

#[derive(Default, Serialize)]
struct Bytes {
    keys: u64,
    key_bytes: u64,
    value_bytes: u64,
}

fn inspect(trial: &Path, sample: &Value, compact_copy: bool) -> Result<Value> {
    let trial = trial.canonicalize()?;
    if sample["journey"] != "J02"
        || sample["profile"] != "native"
        || sample["snapshot"]["valid"] != true
        || sample["fixture"]["total_messages"] != 6400
        || trial.join("reopen-fixture").canonicalize()?.to_str()
            != sample["fixture_workspace"].as_str()
    {
        return Err("expected a matching stopped native J02 fixture".into());
    }
    let path = trial.join(if compact_copy {
        "profile/userdata/compaction-fixture.omdb"
    } else {
        "profile/userdata/statev2.omdb"
    });
    if path.canonicalize()? != path || !path.symlink_metadata()?.is_file() {
        return Err("unexpected database path".into());
    }
    let mut builder = Database::builder();
    builder
        .set_concurrency_mode(ConcurrencyMode::MultiWriter)
        .set_check_integrity_on_open(true)
        .set_cache_size(32 * 1024 * 1024);
    let database = builder.open_read_only(path)?;
    let result = {
        let snapshot = database.begin_read()?;
        let table = snapshot.open_table(TABLE)?;
        let catalog: Value = serde_json::from_slice(
            table
                .get(SCHEMA)?
                .ok_or("missing application catalog")?
                .value(),
        )?;
        if catalog["schema"]["version"] != 1 {
            return Err("unexpected application schema version".into());
        }
        let prefixes = RecordPrefixes::new(
            catalog["generation"]
                .as_str()
                .ok_or("missing application generation")?,
        )?;
        let stats = table.stats()?;
        let mut groups: BTreeMap<&str, Bytes> = BTreeMap::new();
        let mut digest = Sha256::new();
        for row in table.iter()? {
            let (key, value) = row?;
            let bytes = groups.entry(prefixes.category(key.value())).or_default();
            bytes.keys += 1;
            bytes.key_bytes += key.value().len() as u64;
            bytes.value_bytes += value.value().len() as u64;
            for field in [key.value(), value.value()] {
                digest.update((field.len() as u64).to_be_bytes());
                digest.update(field);
            }
        }
        let event_rows = groups.get("event_rows").map_or(0, |bytes| bytes.keys);
        let message_rows = groups
            .get("message_projection_rows")
            .map_or(0, |bytes| bytes.keys);
        let counted = groups.values().map(|bytes| bytes.keys).sum::<u64>();
        let expected = sample["fixture"]["total_messages"]
            .as_u64()
            .unwrap_or_default();
        if event_rows < expected || message_rows != expected || counted != table.len()? {
            return Err(format!(
                "unexpected native fixture counts: {event_rows} events, {message_rows} messages, {counted} entries (expected {expected} messages)"
            ).into());
        }
        let live_records_sha256: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        json!({"journey":"J02","observation":"untimed read-only stopped fixture",
            "groups":groups,"live_records_sha256":live_records_sha256,
            "table":{"key_and_value_bytes":stats.stored_bytes(),
            "metadata_bytes":stats.metadata_bytes(),"fragmented_bytes":stats.fragmented_bytes(),
            "leaf_pages":stats.leaf_pages(),"branch_pages":stats.branch_pages()},
            "scope":"live entries in the application table; engine-wide free, retired or reserved pages use separate accounting",
            "compaction_qualified":false,"write_amplification_qualified":false})
    };
    database.close()?;
    Ok(result)
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let (trial, sample, compact_copy) = match args.as_slice() {
        [trial, sample] => (trial, sample, false),
        [trial, sample, mode] if mode == "compact-copy" => (trial, sample, true),
        _ => {
            return Err(
                "usage: t16-storage-accounting STOPPED_J02_TRIAL SAMPLE.json [compact-copy]".into(),
            );
        }
    };
    let mut input = Vec::new();
    fs::File::open(sample)?
        .take(4_194_305)
        .read_to_end(&mut input)?;
    if input.len() > 4_194_304 {
        return Err("sample exceeds bound".into());
    }
    println!(
        "{}",
        inspect(
            Path::new(trial),
            &serde_json::from_slice(&input)?,
            compact_copy
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_encoded_rows_only_for_the_active_generation() {
        let prefixes = RecordPrefixes::new("native").unwrap();
        let events = "row/6f726368657374726174696f6e5f6576656e7473/key";
        let messages =
            "row/6f726368657374726174696f6e5f76325f70726f6a656374696f6e5f6d65737361676573/key";
        for (suffix, category) in [
            (events, "event_rows"),
            (messages, "message_projection_rows"),
            ("row/orchestration_events/key", "other"),
            ("events/v1/index", "event_indexes"),
            ("projection-reads/v1/index", "projection_indexes"),
            ("metadata/search-live-posting/index", "search_indexes"),
            ("message-rowids/v1/rows/index", "message_row_id_indexes"),
        ] {
            assert_eq!(
                prefixes.category(format!("{}{suffix}", prefixes.generation).as_bytes()),
                category,
            );
        }
        let imported = RecordPrefixes::new(&"f".repeat(64)).unwrap();
        assert_eq!(
            imported.category(format!("{}{events}", imported.generation).as_bytes()),
            "event_rows"
        );
        assert_eq!(
            imported.category(format!("{}{events}", prefixes.generation).as_bytes()),
            "other"
        );
    }
}
