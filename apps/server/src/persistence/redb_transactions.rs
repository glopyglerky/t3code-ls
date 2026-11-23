//! Application rows and scoped transactions for the incremental redb migration.
//!
//! This preserves table and column identities without implementing a SQL interpreter.
//! Scan cursors order encoded storage keys; they do not imply SQL primary-key ordering.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::backend::{Transaction, TransactionCheckpoint};
use crate::{Error, MAX_BATCH_BYTES, Result, Store, request_digest, store_key};

const MAX_TABLES: usize = 4096;
const MAX_COLUMNS: usize = 2048;
const MAX_KEY_BYTES: usize = 64 * 1024;
const MAX_SESSIONS: usize = 16;
const MAX_PAGE_ROWS: u32 = 4096;
const MAX_IDLE: Duration = Duration::from_secs(300);
const MAX_SAVEPOINTS: usize = 64;
const DEFAULT_LOCK_TIMEOUT_MS: u64 = 5000;
pub(crate) const OMDB_REVISION: &str = "b2ff031398b1f0a793a352db7a699575b5d4d3d4";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationTransactionMode {
    Read,
    #[default]
    Write,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationTable {
    pub name: String,
    pub columns: Vec<String>,
    pub primary_key: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationSchema {
    pub version: u32,
    pub tables: Vec<ApplicationTable>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationRow {
    pub key: Vec<Value>,
    pub row: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationPage {
    pub rows: Vec<ApplicationRow>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApplicationCatalog {
    pub(crate) schema: ApplicationSchema,
    pub(crate) generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) event_layout: Option<ApplicationEventLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prepared_service_activation_v1: Option<PreparedServiceActivation>,
}

impl ApplicationCatalog {
    pub(crate) fn ensure_serving(&self) -> Result<()> {
        if self.prepared_service_activation_v1.is_some() {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }
}

/// Installed-runtime identity sealed into a private trial's native catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedServiceActivation {
    pub update_id: String,
    pub from_version: String,
    pub target_version: String,
    pub target_entry_sha256: String,
    pub target_helper_sha256: String,
    pub target_schema_sha256: String,
}

pub(crate) fn exact_service_version(value: &str) -> bool {
    static GRAMMAR: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
        )
        .expect("service version grammar")
    });
    value.len() <= 256 && GRAMMAR.is_match(value)
}

impl PreparedServiceActivation {
    pub(crate) fn validate(&self) -> Result<()> {
        if !crate::application_storage::valid_update_id(&self.update_id)
            || !exact_service_version(&self.from_version)
            || !exact_service_version(&self.target_version)
            || self.from_version == self.target_version
            || !digest(&self.target_entry_sha256)
            || !digest(&self.target_helper_sha256)
            || !digest(&self.target_schema_sha256)
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationEventLayout {
    AssistantTextRevisionsV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationGenerationIdentity {
    pub generation: String,
    pub engine: String,
    pub engine_version: String,
    pub engine_revision: String,
    pub layout: String,
    pub schema_version: u32,
    pub catalog_sha256: String,
}

fn generation_identity(
    catalog: &ApplicationCatalog,
    encoded_catalog: &[u8],
) -> ApplicationGenerationIdentity {
    ApplicationGenerationIdentity {
        generation: catalog.generation.clone(),
        engine: "omdb".into(),
        engine_version: "4.5.0".into(),
        engine_revision: OMDB_REVISION.into(),
        layout: match catalog.event_layout {
            None => "t3-application-keyspace-v1",
            Some(ApplicationEventLayout::AssistantTextRevisionsV1) => {
                "t3-application-keyspace-v1+assistant-text-revisions-v1"
            }
        }
        .into(),
        schema_version: catalog.schema.version,
        catalog_sha256: Sha256::digest(encoded_catalog)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

fn generation_identity_key(catalog: &ApplicationCatalog) -> Vec<u8> {
    store_key(&format!(
        "application/generation/{}/metadata/engine-layout",
        catalog.generation
    ))
}

pub(crate) async fn record_generation_identity(
    transaction: &mut Transaction,
    catalog: &ApplicationCatalog,
    encoded_catalog: &[u8],
) -> Result<()> {
    let bytes = bounded_encode(&generation_identity(catalog, encoded_catalog))?;
    transaction
        .put(generation_identity_key(catalog), bytes)
        .await
}

pub(crate) async fn read_generation_identity(
    transaction: &mut Transaction,
    catalog: &ApplicationCatalog,
    encoded_catalog: &[u8],
) -> Result<Option<ApplicationGenerationIdentity>> {
    verify_generation_identity(
        transaction,
        catalog,
        &generation_identity(catalog, encoded_catalog),
    )
    .await
}

async fn verify_generation_identity(
    transaction: &mut Transaction,
    catalog: &ApplicationCatalog,
    expected: &ApplicationGenerationIdentity,
) -> Result<Option<ApplicationGenerationIdentity>> {
    let Some(bytes) = transaction.get(&generation_identity_key(catalog)).await? else {
        if catalog.event_layout.is_some() || catalog.prepared_service_activation_v1.is_some() {
            return Err(Error::IncompatibleStore);
        }
        // Older generations have a validated catalog without an engine record.
        return Ok(None);
    };
    let identity: ApplicationGenerationIdentity =
        serde_json::from_slice(&bytes).map_err(|_| Error::IncompatibleStore)?;
    if &identity != expected {
        return Err(Error::IncompatibleStore);
    }
    Ok(Some(identity))
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn validate_schema(schema: &ApplicationSchema) -> Result<()> {
    if schema.version != 1 || schema.tables.is_empty() || schema.tables.len() > MAX_TABLES {
        return Err(invalid("unsupported application schema"));
    }
    let mut names = HashSet::new();
    for table in &schema.tables {
        if !identifier(&table.name) || !names.insert(&table.name) {
            return Err(invalid("invalid or duplicate application table"));
        }
        if table.columns.is_empty() || table.columns.len() > MAX_COLUMNS {
            return Err(invalid("invalid application columns"));
        }
        let mut columns = HashSet::new();
        if table
            .columns
            .iter()
            .any(|column| !identifier(column) || !columns.insert(column))
        {
            return Err(invalid("invalid or duplicate application column"));
        }
        let mut primary = HashSet::new();
        if table.primary_key.is_empty()
            || table
                .primary_key
                .iter()
                .any(|column| !columns.contains(column) || !primary.insert(column))
        {
            return Err(invalid("application table requires a declared primary key"));
        }
    }
    bounded_encode(schema)?;
    Ok(())
}

fn bounded_json(value: &Value) -> bool {
    let mut remaining = vec![(value, 0usize)];
    let mut values = 0usize;
    while let Some((value, depth)) = remaining.pop() {
        values += 1;
        if depth > 64 || values > 262_144 {
            return false;
        }
        match value {
            Value::Array(array) => remaining.extend(array.iter().map(|value| (value, depth + 1))),
            Value::Object(object) => {
                remaining.extend(object.values().map(|value| (value, depth + 1)));
            }
            _ => {}
        }
        if remaining.len() > 262_144 {
            return false;
        }
    }
    true
}

fn validate_key(key: &[Value]) -> Result<()> {
    if key.is_empty() || key.len() > MAX_COLUMNS || key.iter().any(|value| !bounded_json(value)) {
        return Err(invalid("invalid application row key"));
    }
    if serde_json::to_vec(key).map_err(crate::json_error)?.len() > MAX_KEY_BYTES {
        return Err(invalid("application row key exceeds 64 KiB"));
    }
    Ok(())
}

pub(crate) fn validate_row(
    table: &ApplicationTable,
    key: &[Value],
    row: &Map<String, Value>,
) -> Result<()> {
    validate_key(key)?;
    if row.len() != table.columns.len()
        || table.columns.iter().any(|column| !row.contains_key(column))
        || row.values().any(|value| !bounded_json(value))
        || key.len() != table.primary_key.len()
        || table
            .primary_key
            .iter()
            .zip(key)
            .any(|(column, value)| row.get(column) != Some(value))
    {
        return Err(invalid(
            "application row does not match its schema and primary key",
        ));
    }
    bounded_encode(row)?;
    Ok(())
}

fn bounded_encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(crate::json_error)?;
    if bytes.len() > MAX_BATCH_BYTES {
        return Err(invalid("application value exceeds 16 MiB"));
    }
    Ok(bytes)
}

pub(crate) fn schema_key() -> Vec<u8> {
    store_key("application/schema")
}

fn validate_catalog(catalog: &ApplicationCatalog) -> Result<()> {
    validate_schema(&catalog.schema)?;
    if catalog.generation != "native" && !digest(&catalog.generation) {
        return Err(invalid("invalid application generation"));
    }
    if catalog.event_layout.is_some() && catalog.generation != "native" {
        return Err(invalid("event layout requires a fresh native generation"));
    }
    if let Some(binding) = &catalog.prepared_service_activation_v1 {
        binding.validate()?;
    }
    Ok(())
}

pub(crate) fn encode_catalog(catalog: &ApplicationCatalog) -> Result<Vec<u8>> {
    validate_catalog(catalog)?;
    bounded_encode(catalog)
}

pub(crate) fn decode_catalog(bytes: &[u8]) -> Result<ApplicationCatalog> {
    let catalog: ApplicationCatalog =
        serde_json::from_slice(bytes).map_err(|_| Error::IncompatibleStore)?;
    validate_catalog(&catalog).map_err(|_| Error::IncompatibleStore)?;
    Ok(catalog)
}

pub(crate) fn row_prefix(generation: &str, table: &str) -> Result<Vec<u8>> {
    if (generation != "native" && !digest(generation)) || !identifier(table) {
        return Err(invalid("invalid application row location"));
    }
    let name: String = table.bytes().map(|byte| format!("{byte:02x}")).collect();
    Ok(store_key(&format!(
        "application/generation/{generation}/row/{name}/"
    )))
}

pub(crate) fn row_key(generation: &str, table: &str, key: &[Value]) -> Result<Vec<u8>> {
    validate_key(key)?;
    let mut encoded = row_prefix(generation, table)?;
    encoded.extend_from_slice(request_digest(&json!(key)).as_bytes());
    Ok(encoded)
}

pub(crate) fn encode_row(row: &ApplicationRow) -> Result<Vec<u8>> {
    bounded_encode(row)
}

pub(crate) fn table<'a>(
    catalog: &'a ApplicationCatalog,
    name: &str,
) -> Result<&'a ApplicationTable> {
    catalog
        .schema
        .tables
        .iter()
        .find(|table| table.name == name)
        .ok_or_else(|| invalid("unknown application table"))
}

pub(crate) fn decode_row(
    catalog: &ApplicationCatalog,
    table: &ApplicationTable,
    encoded_key: &[u8],
    bytes: &[u8],
) -> Result<ApplicationRow> {
    let value: ApplicationRow =
        serde_json::from_slice(bytes).map_err(|_| Error::IncompatibleStore)?;
    validate_row_identity(catalog, table, encoded_key, &value)?;
    Ok(value)
}

pub(crate) fn validate_row_identity(
    catalog: &ApplicationCatalog,
    table: &ApplicationTable,
    encoded_key: &[u8],
    value: &ApplicationRow,
) -> Result<()> {
    validate_row(table, &value.key, &value.row).map_err(|_| Error::IncompatibleStore)?;
    if row_key(&catalog.generation, &table.name, &value.key)? != encoded_key {
        return Err(Error::IncompatibleStore);
    }
    Ok(())
}

struct Savepoint {
    id: String,
    checkpoint: TransactionCheckpoint,
    bytes: usize,
    failed: bool,
}

pub(crate) struct Session {
    pub(crate) transaction: Transaction,
    pub(crate) catalog: Arc<ApplicationCatalog>,
    touched: Instant,
    savepoints: Vec<Savepoint>,
    savepoint_bytes: usize,
}

struct ValidatedCatalog {
    bytes: Vec<u8>,
    catalog: Arc<ApplicationCatalog>,
    identity: ApplicationGenerationIdentity,
}

/// A helper owns these sessions. Dropping the helper drops every uncommitted write.
/// A failed nested scope can roll back to its savepoint. Fatal failures discard the
/// whole session; commit never retries an uncertain write.
pub struct ApplicationTransactions {
    store: Store,
    sessions: BTreeMap<String, Session>,
    validated_catalog: Option<ValidatedCatalog>,
    #[cfg(feature = "ordered-engine-fixture")]
    ordered_fixture: Option<Arc<redb_bench_compare::ordered::Database>>,
}

impl ApplicationTransactions {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: BTreeMap::new(),
            validated_catalog: None,
            #[cfg(feature = "ordered-engine-fixture")]
            ordered_fixture: None,
        }
    }

    /// Isolated helper fixture only. This copies a bounded empty application
    /// schema, never an existing user's rows and never an engine migration.
    #[cfg(feature = "ordered-engine-fixture")]
    pub async fn select_ordered_fixture(
        &mut self,
        profile: &str,
        directory: &std::path::Path,
        initialize: bool,
    ) -> Result<()> {
        use redb_bench_compare::ordered::{Database, Engine};
        // Validate before touching either the candidate path or session state.
        if !directory.is_absolute() || !self.sessions.is_empty() || self.ordered_fixture.is_some() {
            return Err(invalid("ordered fixture selection rejected"));
        }
        let (engine, name, marker): (Engine, &str, &[u8]) = match profile {
            "t04-direct-redb-efaf649-v1" => (
                Engine::DirectRedb,
                "state.redb",
                b"t3-t04-isolated/1/direct-redb/efaf649fb270ce70257e53862295cc10e4bddab0/t3-application-keyspace-v1",
            ),
            "t04-fjall-efaf649-v1" => (
                Engine::Fjall,
                "state.fjall",
                b"t3-t04-isolated/1/fjall/efaf649fb270ce70257e53862295cc10e4bddab0/t3-application-keyspace-v1",
            ),
            _ => return Err(invalid("ordered fixture selection rejected")),
        };
        let path = directory.join(name);
        let profile_file = directory.join("profile");
        let marker_key = store_key("ordered-fixture/identity");
        let database = if initialize {
            let mut source = self.store.db.begin_read_only().await?;
            let catalog_bytes = source
                .get(&schema_key())
                .await?
                .ok_or(Error::IncompatibleStore)?;
            let catalog = decode_catalog(&catalog_bytes)?;
            catalog.ensure_serving()?;
            if catalog.generation != "native" || catalog.prepared_service_activation_v1.is_some() {
                return Err(Error::IncompatibleStore);
            }
            read_generation_identity(&mut source, &catalog, &catalog_bytes)
                .await?
                .ok_or(Error::IncompatibleStore)?;
            for table in &catalog.schema.tables {
                if table.name == "effect_sql_migrations" {
                    continue;
                }
                let prefix = row_prefix(&catalog.generation, &table.name)?;
                let mut end = prefix.clone();
                *end.last_mut().ok_or(Error::IncompatibleStore)? += 1;
                if !source.scan(&prefix, &end, 1).await?.is_empty() {
                    return Err(invalid("ordered fixture requires an empty application"));
                }
            }
            let (start, end) = crate::prefix_range("");
            let rows = source.scan(&start, &end, 4097).await?;
            if rows.len() > 4096
                || rows.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > MAX_BATCH_BYTES / 2
            {
                return Err(invalid("ordered fixture seed budget exceeded"));
            }
            source.rollback().await?;
            // Exclusive directory creation protects existing files/profiles.
            std::fs::create_dir(directory)
                .map_err(|_| invalid("ordered fixture directory must be new"))?;
            let database = Database::open(engine, &path)?;
            database.write(|tx| {
                for (key, value) in &rows {
                    tx.put(key, value)?;
                }
                tx.put(&marker_key, marker)?;
                Ok::<_, redb_bench_compare::ordered::Error>(())
            })?;
            // An interrupted initialization stays unselectable; no automatic retry.
            std::fs::write(&profile_file, marker)
                .map_err(|_| invalid("ordered fixture marker write failed"))?;
            database
        } else {
            let metadata = std::fs::symlink_metadata(directory)
                .map_err(|_| invalid("ordered fixture directory missing"))?;
            if !metadata.is_dir()
                || !std::fs::symlink_metadata(&profile_file)
                    .is_ok_and(|metadata| metadata.is_file())
                || std::fs::read(&profile_file).ok().as_deref() != Some(marker)
                || !std::fs::symlink_metadata(&path).is_ok_and(|metadata| match engine {
                    Engine::DirectRedb => metadata.is_file(),
                    _ => metadata.is_dir(),
                })
            {
                return Err(Error::IncompatibleStore);
            }
            Database::open(engine, &path)?
        };
        if database.snapshot()?.get(&marker_key)?.as_deref() != Some(marker) {
            return Err(Error::IncompatibleStore);
        }
        // Validate the copied catalog and generation before admitting sessions.
        let transaction = Transaction::comparison_read_only(database.snapshot()?);
        let session = self.session_from_transaction(transaction).await?;
        drop(session);
        self.ordered_fixture = Some(Arc::new(database));
        self.validated_catalog = None;
        Ok(())
    }

    #[cfg(feature = "ordered-engine-fixture")]
    pub fn has_ordered_fixture(&self) -> bool {
        self.ordered_fixture.is_some()
    }

    pub fn discard_all(&mut self) {
        self.sessions.clear();
    }

    pub fn has_active_writer(&mut self) -> bool {
        self.expire();
        self.sessions
            .values()
            .any(|session| session.transaction.owns_writer())
    }

    fn expire(&mut self) {
        self.sessions.retain(|_, session| {
            session.touched.elapsed() < MAX_IDLE && session.transaction.is_active()
        });
    }

    pub(crate) async fn catalog_and_identity(
        &self,
    ) -> Result<Option<(ApplicationCatalog, Option<ApplicationGenerationIdentity>)>> {
        let mut transaction = self.store.db.begin_read_only().await?;
        let found = if let Some(bytes) = transaction.get(&schema_key()).await? {
            let catalog = decode_catalog(&bytes)?;
            let identity = read_generation_identity(&mut transaction, &catalog, &bytes).await?;
            Some((catalog, identity))
        } else {
            None
        };
        transaction.rollback().await?;
        Ok(found)
    }

    pub async fn schema(&self) -> Result<Option<ApplicationSchema>> {
        let Some((catalog, _)) = self.catalog_and_identity().await? else {
            return Ok(None);
        };
        catalog.ensure_serving()?;
        Ok(Some(catalog.schema))
    }

    pub async fn generation_identity(&self) -> Result<Option<ApplicationGenerationIdentity>> {
        Ok(self
            .catalog_and_identity()
            .await?
            .and_then(|(_, identity)| identity))
    }

    pub async fn prepared_service_activation(&self) -> Result<Option<PreparedServiceActivation>> {
        Ok(self
            .catalog_and_identity()
            .await?
            .and_then(|(catalog, _)| catalog.prepared_service_activation_v1))
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn seal_service_trial(
        &self,
        binding: PreparedServiceActivation,
    ) -> Result<()> {
        self.store.db.require_exclusive()?;
        let mut transaction = self.store.db.begin().await?;
        let bytes = transaction
            .get(&schema_key())
            .await?
            .ok_or(Error::IncompatibleStore)?;
        let mut catalog = decode_catalog(&bytes)?;
        read_generation_identity(&mut transaction, &catalog, &bytes).await?;
        if catalog.prepared_service_activation_v1.is_some() {
            return Err(Error::IncompatibleStore);
        }
        catalog.prepared_service_activation_v1 = Some(binding);
        let bytes = encode_catalog(&catalog)?;
        record_generation_identity(&mut transaction, &catalog, &bytes).await?;
        transaction.put(schema_key(), bytes).await?;
        transaction.commit().await
    }

    pub async fn initialize(&mut self, schema: ApplicationSchema) -> Result<bool> {
        validate_schema(&schema)?;
        let mut transaction = self.store.db.begin().await?;
        if let Some(bytes) = transaction.get(&schema_key()).await? {
            let existing = decode_catalog(&bytes)?;
            read_generation_identity(&mut transaction, &existing, &bytes).await?;
            existing.ensure_serving()?;
            if existing.schema != schema {
                return Err(invalid(
                    "application schema is already initialized differently",
                ));
            }
            transaction.rollback().await?;
            return Ok(false);
        }
        let catalog = ApplicationCatalog {
            schema,
            generation: "native".into(),
            event_layout: None,
            prepared_service_activation_v1: None,
        };
        let bytes = encode_catalog(&catalog)?;
        record_generation_identity(&mut transaction, &catalog, &bytes).await?;
        transaction.insert(schema_key(), bytes).await?;
        transaction.commit().await?;
        Ok(true)
    }

    pub async fn begin(&mut self, transaction_id: &str) -> Result<()> {
        self.begin_mode(transaction_id, ApplicationTransactionMode::Write, None)
            .await
    }

    pub async fn begin_mode(
        &mut self,
        transaction_id: &str,
        mode: ApplicationTransactionMode,
        lock_timeout_ms: Option<u64>,
    ) -> Result<()> {
        validate_transaction_id(transaction_id)?;
        let lock_timeout_ms = lock_timeout_ms.unwrap_or(DEFAULT_LOCK_TIMEOUT_MS);
        if lock_timeout_ms == 0 || lock_timeout_ms > 30_000 {
            return Err(invalid(
                "writer acquisition timeout must be between 1 and 30000 milliseconds",
            ));
        }
        self.check_new_session(transaction_id)?;
        let session = self.open_session(mode, lock_timeout_ms).await?;
        self.sessions.insert(transaction_id.into(), session);
        Ok(())
    }

    fn check_new_session(&mut self, transaction_id: &str) -> Result<()> {
        validate_transaction_id(transaction_id)?;
        self.expire();
        if self.sessions.contains_key(transaction_id) {
            return Err(invalid("application transaction already exists"));
        }
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(invalid("too many application transactions"));
        }
        Ok(())
    }

    /// Decode comparison bytes with the real application read APIs. This does
    /// not validate or activate the candidate as a production storage engine.
    #[cfg(all(test, feature = "ordered-engine-fixture"))]
    pub(crate) async fn begin_comparison_read(
        &mut self,
        transaction_id: &str,
        snapshot: redb_bench_compare::ordered::Snapshot,
    ) -> Result<()> {
        self.check_new_session(transaction_id)?;
        let transaction = Transaction::comparison_read_only(snapshot);
        let session = self.session_from_transaction(transaction).await?;
        self.sessions.insert(transaction_id.into(), session);
        Ok(())
    }

    #[cfg(all(test, feature = "ordered-engine-fixture"))]
    pub(crate) async fn begin_comparison_write(
        &mut self,
        transaction_id: &str,
        database: Arc<redb_bench_compare::ordered::Database>,
        discard_commit_ack: bool,
    ) -> Result<()> {
        self.check_new_session(transaction_id)?;
        let transaction = Transaction::comparison_reserved(
            database,
            Duration::from_millis(DEFAULT_LOCK_TIMEOUT_MS),
            MAX_IDLE,
            discard_commit_ack,
        )
        .await?;
        let session = self.session_from_transaction(transaction).await?;
        self.sessions.insert(transaction_id.into(), session);
        Ok(())
    }

    pub(crate) async fn open_read_session(&mut self) -> Result<Session> {
        self.open_session(ApplicationTransactionMode::Read, DEFAULT_LOCK_TIMEOUT_MS)
            .await
    }

    async fn open_session(
        &mut self,
        mode: ApplicationTransactionMode,
        lock_timeout_ms: u64,
    ) -> Result<Session> {
        #[cfg(feature = "ordered-engine-fixture")]
        if let Some(database) = &self.ordered_fixture {
            let transaction = match mode {
                ApplicationTransactionMode::Read => {
                    Transaction::comparison_read_only(database.snapshot()?)
                }
                ApplicationTransactionMode::Write => {
                    Transaction::comparison_reserved(
                        Arc::clone(database),
                        Duration::from_millis(lock_timeout_ms),
                        MAX_IDLE,
                        false,
                    )
                    .await?
                }
            };
            return self.session_from_transaction(transaction).await;
        }
        let transaction = match mode {
            ApplicationTransactionMode::Read => self.store.db.begin_read_only().await?,
            ApplicationTransactionMode::Write => {
                self.store
                    .db
                    .begin_reserved(Duration::from_millis(lock_timeout_ms), MAX_IDLE)
                    .await?
            }
        };
        self.session_from_transaction(transaction).await
    }

    async fn session_from_transaction(&mut self, mut transaction: Transaction) -> Result<Session> {
        let bytes = transaction
            .get(&schema_key())
            .await?
            .ok_or_else(|| invalid("application schema is not initialized"))?;
        // Bind the cache to the exact catalog bytes visible to this snapshot.
        // The engine record is read from the transaction even on a cache hit.
        let cached = match &mut self.validated_catalog {
            Some(cached) if cached.bytes == bytes => cached,
            slot => {
                let catalog = Arc::new(decode_catalog(&bytes)?);
                catalog.ensure_serving()?;
                let identity = generation_identity(&catalog, &bytes);
                slot.insert(ValidatedCatalog {
                    bytes,
                    catalog,
                    identity,
                })
            }
        };
        verify_generation_identity(&mut transaction, &cached.catalog, &cached.identity).await?;
        Ok(Session {
            transaction,
            catalog: Arc::clone(&cached.catalog),
            touched: Instant::now(),
            savepoints: Vec::new(),
            savepoint_bytes: 0,
        })
    }

    fn take_control(&mut self, transaction_id: &str) -> Result<Session> {
        validate_transaction_id(transaction_id)?;
        let session = self
            .sessions
            .remove(transaction_id)
            .ok_or_else(|| invalid("application transaction does not exist"))?;
        if session.touched.elapsed() >= MAX_IDLE {
            return Err(invalid("application transaction expired"));
        }
        session.transaction.ensure_active()?;
        Ok(session)
    }

    pub(crate) fn take(&mut self, transaction_id: &str) -> Result<Session> {
        let session = self.take_control(transaction_id)?;
        if session
            .savepoints
            .last()
            .is_some_and(|savepoint| savepoint.failed)
        {
            self.sessions.insert(transaction_id.into(), session);
            return Err(invalid("failed application savepoint must be rolled back"));
        }
        Ok(session)
    }

    pub(crate) async fn finish<A>(
        &mut self,
        transaction_id: &str,
        mut session: Session,
        result: Result<A>,
    ) -> Result<A> {
        if let Err(error) = session.transaction.ensure_active() {
            let _ = session.transaction.rollback().await;
            return Err(error);
        }
        match result {
            Ok(value) => {
                session.touched = Instant::now();
                self.sessions.insert(transaction_id.into(), session);
                Ok(value)
            }
            Err(error @ (Error::Invalid(_) | Error::ResourceLimit(_) | Error::DuplicateRecord))
                if !session.savepoints.is_empty() =>
            {
                session
                    .savepoints
                    .last_mut()
                    .expect("savepoint exists")
                    .failed = true;
                session.touched = Instant::now();
                self.sessions.insert(transaction_id.into(), session);
                Err(error)
            }
            Err(error) => {
                let _ = session.transaction.rollback().await;
                Err(error)
            }
        }
    }

    pub async fn get(
        &mut self,
        transaction_id: &str,
        name: &str,
        key: &[Value],
    ) -> Result<Option<Map<String, Value>>> {
        let mut session = self.take(transaction_id)?;
        let result = async {
            let table = table(&session.catalog, name)?;
            if key.len() != table.primary_key.len() {
                return Err(invalid("application key does not match its schema"));
            }
            let encoded_key = row_key(&session.catalog.generation, name, key)?;
            let Some(bytes) = session.transaction.get(&encoded_key).await? else {
                return Ok(None);
            };
            let value = crate::application_events::decode_transaction_row(
                &mut session.transaction,
                &session.catalog,
                table,
                &encoded_key,
                &bytes,
            )
            .await?;
            if value.key != key {
                return Err(Error::IncompatibleStore);
            }
            Ok(Some(value.row))
        }
        .await;
        self.finish(transaction_id, session, result).await
    }

    pub async fn put(
        &mut self,
        transaction_id: &str,
        name: &str,
        key: Vec<Value>,
        row: Map<String, Value>,
    ) -> Result<()> {
        let mut session = self.take(transaction_id)?;
        let result = async {
            session.transaction.require_write()?;
            let table = table(&session.catalog, name)?;
            require_unmanaged(&mut session.transaction, &session.catalog.generation, name).await?;
            validate_row(table, &key, &row)?;
            let encoded_key = row_key(&session.catalog.generation, name, &key)?;
            if let Some(bytes) = session.transaction.get(&encoded_key).await? {
                let existing = decode_row(&session.catalog, table, &encoded_key, &bytes)?;
                if existing.key != key {
                    return Err(Error::IncompatibleStore);
                }
            }
            session
                .transaction
                .put(encoded_key, encode_row(&ApplicationRow { key, row })?)
                .await
        }
        .await;
        self.finish(transaction_id, session, result).await
    }

    pub async fn delete(
        &mut self,
        transaction_id: &str,
        name: &str,
        key: &[Value],
    ) -> Result<bool> {
        let mut session = self.take(transaction_id)?;
        let result = async {
            session.transaction.require_write()?;
            let table = table(&session.catalog, name)?;
            require_unmanaged(&mut session.transaction, &session.catalog.generation, name).await?;
            if key.len() != table.primary_key.len() {
                return Err(invalid("application key does not match its schema"));
            }
            let encoded_key = row_key(&session.catalog.generation, name, key)?;
            let Some(bytes) = session.transaction.get(&encoded_key).await? else {
                return Ok(false);
            };
            let existing = decode_row(&session.catalog, table, &encoded_key, &bytes)?;
            if existing.key != key {
                return Err(Error::IncompatibleStore);
            }
            session.transaction.delete(encoded_key).await?;
            Ok(true)
        }
        .await;
        self.finish(transaction_id, session, result).await
    }

    pub async fn scan(
        &mut self,
        transaction_id: &str,
        name: &str,
        after: Option<&str>,
        limit: u32,
    ) -> Result<ApplicationPage> {
        let mut session = self.take(transaction_id)?;
        let result = async {
            let table = table(&session.catalog, name)?;
            if limit == 0 || limit > MAX_PAGE_ROWS || after.is_some_and(|value| !digest(value)) {
                return Err(invalid("invalid application scan page"));
            }
            let prefix = row_prefix(&session.catalog.generation, name)?;
            let mut start = prefix.clone();
            if let Some(after) = after {
                start.extend_from_slice(after.as_bytes());
                start.push(0);
            }
            let mut end = prefix.clone();
            *end.last_mut().expect("row prefix ends in a slash") = b'0';
            let mut found = session
                .transaction
                .scan(&start, &end, limit as usize + 1)
                .await?;
            let more = found.len() > limit as usize;
            if more {
                found.pop();
            }
            let mut rows = Vec::with_capacity(found.len());
            let mut cursor = None;
            let mut payload_bytes = 0;
            for (encoded_key, bytes) in found {
                let row = crate::application_events::decode_transaction_row(
                    &mut session.transaction,
                    &session.catalog,
                    table,
                    &encoded_key,
                    &bytes,
                )
                .await?;
                if session.catalog.event_layout.is_some()
                    && name == crate::application_events::EVENTS
                    && let Some(payload) = row
                        .row
                        .get("payload_json")
                        .and_then(|cell| cell["value"].as_str())
                {
                    crate::application_events::account_payload_bytes(&mut payload_bytes, payload)?;
                }
                rows.push(row);
                let suffix = encoded_key
                    .strip_prefix(prefix.as_slice())
                    .and_then(|bytes| std::str::from_utf8(bytes).ok())
                    .filter(|value| digest(value))
                    .ok_or(Error::IncompatibleStore)?;
                cursor = Some(suffix.into());
            }
            let page = ApplicationPage {
                rows,
                next: if more { cursor } else { None },
            };
            crate::validate_response_bytes(&page)?;
            Ok(page)
        }
        .await;
        self.finish(transaction_id, session, result).await
    }

    #[cfg(all(test, feature = "ordered-engine-fixture"))]
    pub(crate) async fn stage_for_comparison(
        &mut self,
        transaction_id: &str,
    ) -> Result<crate::backend::StagedCommit> {
        let session = self.take(transaction_id)?;
        if !session.savepoints.is_empty() {
            return self
                .finish(
                    transaction_id,
                    session,
                    Err(invalid("unreleased savepoints")),
                )
                .await;
        }
        session.transaction.stage_for_comparison().await
    }

    pub async fn commit(&mut self, transaction_id: &str) -> Result<()> {
        let session = self.take(transaction_id)?;
        if !session.savepoints.is_empty() {
            return self
                .finish(
                    transaction_id,
                    session,
                    Err(invalid(
                        "application savepoints must be released before commit",
                    )),
                )
                .await;
        }
        session.transaction.commit().await
    }

    pub async fn rollback(&mut self, transaction_id: &str) -> Result<()> {
        self.take_control(transaction_id)?
            .transaction
            .rollback()
            .await
    }

    pub async fn savepoint(&mut self, transaction_id: &str, savepoint_id: &str) -> Result<()> {
        let mut session = self.take(transaction_id)?;
        let result = (|| {
            validate_transaction_id(savepoint_id)?;
            if session.savepoints.len() >= MAX_SAVEPOINTS
                || session
                    .savepoints
                    .iter()
                    .any(|savepoint| savepoint.id == savepoint_id)
            {
                return Err(invalid("invalid or excessive application savepoints"));
            }
            let bytes = session.transaction.checkpoint_bytes();
            if session.savepoint_bytes.saturating_add(bytes) > MAX_BATCH_BYTES {
                return Err(invalid("application savepoints exceed 16 MiB"));
            }
            session.savepoints.push(Savepoint {
                id: savepoint_id.into(),
                checkpoint: session.transaction.checkpoint(),
                bytes,
                failed: false,
            });
            session.savepoint_bytes += bytes;
            Ok(())
        })();
        self.finish(transaction_id, session, result).await
    }

    pub async fn release(&mut self, transaction_id: &str, savepoint_id: &str) -> Result<()> {
        let mut session = self.take(transaction_id)?;
        let result = (|| {
            if session
                .savepoints
                .last()
                .is_none_or(|savepoint| savepoint.id != savepoint_id)
            {
                return Err(invalid(
                    "application savepoints must be released in scope order",
                ));
            }
            let released = session.savepoints.pop().expect("savepoint exists");
            session.savepoint_bytes -= released.bytes;
            Ok(())
        })();
        self.finish(transaction_id, session, result).await
    }

    pub async fn rollback_to(&mut self, transaction_id: &str, savepoint_id: &str) -> Result<()> {
        let mut session = self.take_control(transaction_id)?;
        let result = (|| {
            let Some(savepoint) = session.savepoints.last_mut() else {
                return Err(invalid("application savepoint does not exist"));
            };
            if savepoint.id != savepoint_id {
                return Err(invalid(
                    "application savepoints must roll back in scope order",
                ));
            }
            session.transaction.restore(&savepoint.checkpoint);
            savepoint.failed = false;
            Ok(())
        })();
        self.finish(transaction_id, session, result).await
    }
}

async fn require_unmanaged(
    transaction: &mut Transaction,
    generation: &str,
    table: &str,
) -> Result<()> {
    let name: String = table.bytes().map(|byte| format!("{byte:02x}")).collect();
    let key = store_key(&format!(
        "application/generation/{generation}/managed/{name}"
    ));
    if transaction.get(&key).await?.is_some() {
        return Err(invalid("application table requires its domain operation"));
    }
    Ok(())
}

fn validate_transaction_id(transaction_id: &str) -> Result<()> {
    if transaction_id.is_empty()
        || transaction_id.len() > 128
        || !transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:.".contains(&byte))
    {
        return Err(invalid("invalid application transaction ID"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "redb_transactions_tests.rs"]
mod tests;
