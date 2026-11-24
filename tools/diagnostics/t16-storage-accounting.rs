//! MIT. Read-only aggregate accounting for the stopped synthetic J02 omdb fixture.
use redb::{
    ConcurrencyMode, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    TableDefinition,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, fs, io::Read, path::Path};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("t3_code_ls_v2");
const GENERATION: &[u8] = b"t3-code-ls/v2/application/generation/native/";

#[derive(Default, Serialize)]
struct Bytes {
    keys: u64,
    key_bytes: u64,
    value_bytes: u64,
}

fn category(key: &[u8]) -> &'static str {
    let Some(suffix) = key.strip_prefix(GENERATION) else {
        return "other";
    };
    if suffix.starts_with(b"row/orchestration_events/") {
        "event_rows"
    } else if suffix.starts_with(b"row/orchestration_v2_projection_") {
        "projection_rows"
    } else if suffix.starts_with(b"events/v1/") {
        "event_indexes"
    } else if suffix.starts_with(b"projection-reads/v1/") || suffix.starts_with(b"projections/v1/")
    {
        "projection_indexes"
    } else {
        "other"
    }
}

fn inspect(trial: &Path, sample: &Value) -> Result<Value> {
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
    let path = trial.join("profile/userdata/statev2.omdb");
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
        let stats = table.stats()?;
        let mut groups: BTreeMap<&str, Bytes> = BTreeMap::new();
        for row in table.iter()? {
            let (key, value) = row?;
            let bytes = groups.entry(category(key.value())).or_default();
            bytes.keys += 1;
            bytes.key_bytes += key.value().len() as u64;
            bytes.value_bytes += value.value().len() as u64;
        }
        if !groups.contains_key("event_rows")
            || !groups.contains_key("projection_rows")
            || groups.values().map(|bytes| bytes.keys).sum::<u64>() != table.len()?
        {
            return Err("native table did not contain the expected fixture records".into());
        }
        json!({"journey":"J02","observation":"untimed read-only stopped fixture",
            "groups":groups,"table":{"key_and_value_bytes":stats.stored_bytes(),
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
    let [trial, sample] = args.as_slice() else {
        return Err("usage: t16-storage-accounting STOPPED_J02_TRIAL SAMPLE.json".into());
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
        inspect(Path::new(trial), &serde_json::from_slice(&input)?)?
    );
    Ok(())
}
