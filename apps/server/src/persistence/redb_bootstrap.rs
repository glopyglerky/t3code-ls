//! Compile-time current schema: fresh application startup has no SQL dependency.
use crate::application::{
    ApplicationCatalog, ApplicationEventLayout, ApplicationSchema, decode_catalog, decode_row,
    encode_catalog, read_generation_identity, record_generation_identity, row_prefix, schema_key,
    table, validate_schema,
};
use crate::application_rows::{int_cell, integer, text, text_cell, write_row};
use crate::{Error, Result, Store, store_key};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const SCHEMA_DEFINITION: &str = include_str!("omdb-schema.json");

#[path = "redb_schema_upgrade.rs"]
mod upgrade;
pub(crate) use upgrade::validate_import_lineage;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Migration {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct Definition {
    format: u32,
    migrations: Vec<Migration>,
    schema: ApplicationSchema,
}

#[derive(Serialize)]
pub struct BootstrapResult {
    pub initialized: bool,
    pub migrations: Vec<Migration>,
    pub schema_version: u32,
}

fn definition() -> Result<Definition> {
    let definition: Definition =
        serde_json::from_str(SCHEMA_DEFINITION).map_err(|_| Error::IncompatibleStore)?;
    if definition.format != 1 {
        return Err(Error::IncompatibleStore);
    }
    validate_schema(&definition.schema)?;
    Ok(definition)
}

#[cfg(target_os = "linux")]
pub(crate) fn bootstrap_schema_sha256() -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(SCHEMA_DEFINITION.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Store {
    #[cfg(target_os = "linux")]
    pub(crate) async fn verify_bootstrap_schema(&self) -> Result<()> {
        let expected = definition()?;
        let (catalog, _) = crate::application::ApplicationTransactions::new(self.clone())
            .catalog_and_identity()
            .await?
            .ok_or(Error::IncompatibleStore)?;
        if catalog.schema != expected.schema
            || self.application_migrations().await? != expected.migrations
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }

    pub async fn application_migrations(&self) -> Result<Vec<Migration>> {
        Ok(self
            .read_application_migrations(false)
            .await?
            .unwrap_or_default())
    }

    /// Inspect the serving catalog and its migration rows on the same snapshot.
    pub async fn serving_startup_migrations(&self) -> Result<Option<Vec<Migration>>> {
        self.read_application_migrations(true).await
    }

    async fn read_application_migrations(
        &self,
        require_serving: bool,
    ) -> Result<Option<Vec<Migration>>> {
        let mut tx = self.db.begin_read_only().await?;
        let Some(bytes) = tx.get(&schema_key()).await? else {
            tx.rollback().await?;
            return Ok(None);
        };
        let catalog = decode_catalog(&bytes)?;
        read_generation_identity(&mut tx, &catalog, &bytes).await?;
        if require_serving {
            catalog.ensure_serving()?;
        }
        let prefix = row_prefix(&catalog.generation, "effect_sql_migrations")?;
        let mut end = prefix.clone();
        *end.last_mut().ok_or(Error::IncompatibleStore)? += 1;
        let mut cursor = prefix.clone();
        let mut result = Vec::new();
        loop {
            let page = tx.scan(&cursor, &end, 128).await?;
            let count = page.len();
            for (key, bytes) in page {
                let row = decode_row(
                    &catalog,
                    table(&catalog, "effect_sql_migrations")?,
                    &key,
                    &bytes,
                )?;
                result.push(Migration {
                    id: integer(&row.row, "migration_id")?.to_string(),
                    name: text(&row.row, "name")?,
                });
                cursor = key;
                cursor.push(0);
            }
            if count < 128 {
                break;
            }
            if result.len() > 4096 {
                return Err(Error::IncompatibleStore);
            }
        }
        result.sort_by_key(|entry| entry.id.parse::<i64>().unwrap_or(i64::MAX));
        tx.rollback().await?;
        Ok(Some(result))
    }

    /// New files are initialized atomically; an imported or existing file is
    /// verified, never overwritten or silently replaced by an empty database.
    pub async fn bootstrap_application(&self) -> Result<BootstrapResult> {
        self.bootstrap_application_with_event_layout(None).await
    }

    pub async fn bootstrap_application_with_event_layout(
        &self,
        event_layout: Option<ApplicationEventLayout>,
    ) -> Result<BootstrapResult> {
        let definition = definition()?;
        let mut tx = self
            .db
            .begin_reserved(Duration::from_secs(5), Duration::from_secs(300))
            .await?;
        if let Some(bytes) = tx.get(&schema_key()).await? {
            let catalog = decode_catalog(&bytes)?;
            read_generation_identity(&mut tx, &catalog, &bytes).await?;
            catalog.ensure_serving()?;
            tx.rollback().await?;
            if event_layout.is_some() && event_layout != catalog.event_layout {
                return Err(Error::Invalid(
                    "assistant text revisions require a fresh native application profile".into(),
                ));
            }
            if catalog.schema != definition.schema {
                if catalog.event_layout.is_some() {
                    return Err(Error::IncompatibleStore);
                }
                return self.upgrade_application_80(catalog, definition).await;
            }
            if self.application_migrations().await? != definition.migrations {
                if catalog.event_layout.is_some() {
                    return Err(Error::IncompatibleStore);
                }
                return self.upgrade_application_88(catalog, definition).await;
            }
            return Ok(BootstrapResult {
                initialized: false,
                migrations: definition.migrations,
                schema_version: 1,
            });
        }
        if event_layout.is_some()
            && !tx
                .scan(&store_key("application/"), &store_key("application0"), 1)
                .await?
                .is_empty()
        {
            return Err(Error::Invalid(
                "assistant text revisions require an empty application namespace".into(),
            ));
        }
        let catalog = ApplicationCatalog {
            schema: definition.schema,
            generation: "native".into(),
            event_layout,
            prepared_service_activation_v1: None,
            forward_service_activation_v1: None,
        };
        let bytes = encode_catalog(&catalog)?;
        record_generation_identity(&mut tx, &catalog, &bytes).await?;
        tx.put(schema_key(), bytes).await?;
        for migration in &definition.migrations {
            let id = migration
                .id
                .parse::<i64>()
                .map_err(|_| Error::IncompatibleStore)?;
            write_row(
                &mut tx,
                &catalog,
                "effect_sql_migrations",
                serde_json::Map::from_iter([
                    ("migration_id".into(), int_cell(id)),
                    ("name".into(), text_cell(&migration.name)),
                    ("created_at".into(), text_cell("1970-01-01 00:00:00")),
                ]),
            )
            .await?;
        }
        // Fresh stores have a complete empty source vocabulary and deletion
        // witness, so search can qualify before their first message.
        tx.put(crate::store_key("application/generation/native/metadata/header"),serde_json::to_vec(&json!({
            "version":2,"searchIndex":true,"searchDeleteWitness":true,"excludedDerivedTables":["orchestration_v2_message_search"],"sequences":[],"migrations":definition.migrations
        })).map_err(|_|Error::IncompatibleStore)?).await?;
        tx.commit().await?;
        Ok(BootstrapResult {
            initialized: true,
            migrations: definition.migrations,
            schema_version: 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestFixture;
    #[tokio::test]
    async fn migration_inspection_is_read_only_and_cannot_initialize_or_promote() {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        store.bootstrap_application().await.unwrap();
        store.shutdown().await.unwrap();
        let before = std::fs::read(fixture.path()).unwrap();
        let read_only = Store::open_read_only(fixture.path()).await.unwrap();
        assert_eq!(read_only.application_migrations().await.unwrap().len(), 89);
        assert!(read_only.bootstrap_application().await.is_err());
        read_only.shutdown().await.unwrap();
        assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
        let missing = fixture
            .path()
            .with_file_name("absent-migration-preflight.omdb");
        assert!(Store::open_read_only(&missing).await.is_err());
        assert!(!missing.exists());
    }
    #[tokio::test]
    async fn fresh_schema_boots_once_without_sqlite_and_retains_migrations() {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let first = store.bootstrap_application().await.unwrap();
        assert!(first.initialized);
        assert_eq!(first.migrations.len(), 89);
        assert!(matches!(
            store
                .bootstrap_application_with_event_layout(Some(
                    ApplicationEventLayout::AssistantTextRevisionsV1
                ))
                .await,
            Err(Error::Invalid(_))
        ));
        assert!(store.prepare_application_search().await.unwrap().prepared);
        assert!(!store.bootstrap_application().await.unwrap().initialized);
        assert_eq!(store.application_migrations().await.unwrap().len(), 89);
        while !store
            .prepare_application_message_rowids()
            .await
            .unwrap()
            .prepared
        {}
        store.shutdown().await.unwrap();
        let reopened = fixture.connect().await;
        assert!(!reopened.bootstrap_application().await.unwrap().initialized);
        assert!(
            reopened
                .prepare_application_search()
                .await
                .unwrap()
                .prepared
        );
        reopened.shutdown().await.unwrap();
    }
}
