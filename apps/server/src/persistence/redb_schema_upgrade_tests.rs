use super::*;
use crate::application::{ApplicationTransactionMode, ApplicationTransactions};
use crate::application_rows::nullable;
use crate::test_support::TestFixture;

const NOW: &str = "2026-11-13T00:00:00.000Z";
const QUOTE: &str = "[Assistant quote](t3-citation://v1/env/thread/message?text=searchable+quoted+words&start=0&end=22&prefix=&suffix=&comment=review+this)";

async fn fixture_80() -> (TestFixture, Store, ApplicationCatalog) {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let previous: Definition = serde_json::from_str(include_str!("omdb-schema-80.json")).unwrap();
    let source = ApplicationCatalog {
        event_layout: None,
        prepared_service_activation_v1: None,
        forward_service_activation_v1: None,
        schema: previous.schema,
        generation: "native".into(),
    };
    let mut tx = store.db.begin().await.unwrap();
    tx.put(schema_key(), encode_catalog(&source).unwrap())
        .await
        .unwrap();
    for migration in previous.migrations {
        write_row(
            &mut tx,
            &source,
            "effect_sql_migrations",
            Map::from_iter([
                (
                    "migration_id".into(),
                    int_cell(migration.id.parse().unwrap()),
                ),
                ("name".into(), text_cell(&migration.name)),
                ("created_at".into(), text_cell(NOW)),
            ]),
        )
        .await
        .unwrap();
    }
    let mut project: Map<String, Value> = table(&source, PROJECTS)
        .unwrap()
        .columns
        .iter()
        .map(|column| (column.clone(), nullable_cell(None)))
        .collect();
    for (column, value) in [
        ("project_id", "project"),
        ("title", "User title"),
        ("workspace_root", "/fixture"),
        ("scripts_json", "[]"),
        ("created_at", NOW),
        ("updated_at", NOW),
    ] {
        project.insert(column.into(), text_cell(value));
    }
    project.insert("auto_pull".into(), int_cell(0));
    write_row(&mut tx, &source, PROJECTS, project)
        .await
        .unwrap();
    let mut event: Map<String, Value> = table(&source, EVENTS)
        .unwrap()
        .columns
        .iter()
        .map(|column| (column.clone(), nullable_cell(None)))
        .collect();
    for (column, value) in [
        ("sequence", 1),
        ("stream_version", 1),
        ("application_event_version", 1),
    ] {
        event.insert(column.into(), int_cell(value));
    }
    for (column, value) in [
        ("event_id", "project-title"),
        ("aggregate_kind", "project"),
        ("stream_id", "project"),
        ("event_type", "project.meta-updated"),
        ("occurred_at", NOW),
        ("actor_kind", "user"),
        ("payload_json", "{\"title\":\"User title\"}"),
        ("metadata_json", "{}"),
    ] {
        event.insert(column.into(), text_cell(value));
    }
    write_row(&mut tx, &source, EVENTS, event).await.unwrap();
    let mut message: Map<String, Value> = table(&source, MESSAGES)
        .unwrap()
        .columns
        .iter()
        .map(|column| (column.clone(), nullable_cell(None)))
        .collect();
    for (column, value) in [
        ("message_id", "message"),
        ("thread_id", "thread"),
        ("role", "assistant"),
        ("created_at", NOW),
        ("updated_at", NOW),
    ] {
        message.insert(column.into(), text_cell(value));
    }
    message.insert("streaming".into(), int_cell(0));
    message.insert("payload_json".into(), text_cell(&json!({"id":"message","threadId":"thread","text":QUOTE,"role":"assistant","streaming":false}).to_string()));
    write_row(&mut tx, &source, MESSAGES, message)
        .await
        .unwrap();
    for (index, run) in [(1, Some("run")), (2, Some("run")), (3, None)] {
        let mut item: Map<String, Value> = table(&source, ITEMS)
            .unwrap()
            .columns
            .iter()
            .map(|column| (column.clone(), nullable_cell(None)))
            .collect();
        for (column, value) in [
            ("turn_item_id", format!("item-{index}")),
            ("thread_id", "thread".into()),
            ("type", "assistant_message".into()),
            ("status", "completed".into()),
            ("updated_at", NOW.into()),
            (
                "payload_json",
                json!({"id":format!("item-{index}"),"text":"output"}).to_string(),
            ),
        ] {
            item.insert(column.into(), text_cell(&value));
        }
        item.insert("run_id".into(), nullable_cell(run));
        item.insert("ordinal".into(), int_cell(index));
        write_row(&mut tx, &source, ITEMS, item).await.unwrap();
    }
    tx.put(
        store_key("application/generation/native/metadata/header"),
        encode(&json!({"version":2,"searchIndex":true,"searchDeleteWitness":true})).unwrap(),
    )
    .await
    .unwrap();
    tx.put(
        store_key("application/generation/native/message-rowids/v1/preparation"),
        encode(&json!({"after":null,"indexed_rows":1,"ready":true})).unwrap(),
    )
    .await
    .unwrap();
    let identity = encode(&json!({"message_id":"message","rowid":1})).unwrap();
    tx.put(
        store_key(&format!(
            "application/generation/native/message-rowids/v1/identity/{}",
            request_digest(&json!("message"))
        )),
        identity.clone(),
    )
    .await
    .unwrap();
    tx.put(
        store_key("application/generation/native/message-rowids/v1/rows/7ffffffffffffffe"),
        identity,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (fixture, store, source)
}

#[tokio::test]
async fn populated_80_upgrade_is_exclusive_atomic_and_preserves_original_rows() {
    let (fixture, store, source) = fixture_80().await;
    assert!(store.bootstrap_application().await.is_err());
    assert!(matches!(
        Store::open_exclusive(fixture.path()).await,
        Err(Error::WriterBusy)
    ));
    let original = store
        .db
        .read(&row_key("native", MESSAGES, &[text_cell("message")]).unwrap())
        .await
        .unwrap()
        .unwrap();
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    assert_eq!(
        store
            .bootstrap_application()
            .await
            .unwrap()
            .migrations
            .len(),
        89
    );
    let mut tx = store.db.begin_read_only().await.unwrap();
    let target = decode_catalog(&tx.get(&schema_key()).await.unwrap().unwrap()).unwrap();
    assert_ne!(target.generation, source.generation);
    assert_eq!(
        tx.get(&row_key("native", MESSAGES, &[text_cell("message")]).unwrap())
            .await
            .unwrap()
            .unwrap(),
        original
    );
    let message = read_row(&mut tx, &target, MESSAGES, &[text_cell("message")])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        nullable(&message.row, "search_text").unwrap().as_deref(),
        Some("searchable quoted words\nComment: review this")
    );
    assert!(
        text(&message.row, "payload_json")
            .unwrap()
            .contains("t3-citation://")
    );
    let project = read_row(&mut tx, &target, PROJECTS, &[text_cell("project")])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(integer(&project.row, "has_custom_title").unwrap(), 1);
    for (run, expected) in [("run", 2), ("", 1)] {
        let count = read_row(
            &mut tx,
            &target,
            crate::application_turn_item_counts::TABLE,
            &[text_cell("thread"), text_cell(run)],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(integer(&count.row, "item_count").unwrap(), expected);
    }
    tx.rollback().await.unwrap();
    assert!(!store.bootstrap_application().await.unwrap().initialized);
    store.shutdown().await.unwrap();
    let reopened = fixture.connect().await;
    assert_eq!(reopened.application_migrations().await.unwrap().len(), 89);
    assert!(!reopened.bootstrap_application().await.unwrap().initialized);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn interrupted_staging_retries_from_current_source_and_removes_stale_candidate_rows() {
    let (fixture, store, source) = fixture_80().await;
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    let current = definition().unwrap();
    let target = ApplicationCatalog {
        event_layout: None,
        prepared_service_activation_v1: None,
        forward_service_activation_v1: None,
        generation: request_digest(&json!([
            "native-schema-upgrade",
            source.generation,
            current.schema
        ])),
        schema: current.schema,
    };
    store
        .upgrade_stage(&source, &target, Stage::Copy)
        .await
        .unwrap();
    store
        .upgrade_stage(&source, &target, Stage::Messages)
        .await
        .unwrap();
    assert_eq!(store.application_migrations().await.unwrap().len(), 80);
    store.shutdown().await.unwrap();
    // A previous build can write the unchanged original after interruption.
    let store = fixture.connect().await;
    let mut tx = store.db.begin().await.unwrap();
    let mut project = read_row(&mut tx, &source, PROJECTS, &[text_cell("project")])
        .await
        .unwrap()
        .unwrap();
    project
        .row
        .insert("title".into(), text_cell("Newer original title"));
    write_row(&mut tx, &source, PROJECTS, project.row)
        .await
        .unwrap();
    crate::application_rows::delete_row(&mut tx, &source, ITEMS, &[text_cell("item-2")])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    store.bootstrap_application().await.unwrap();
    let mut tx = store.db.begin_read_only().await.unwrap();
    let target = decode_catalog(&tx.get(&schema_key()).await.unwrap().unwrap()).unwrap();
    assert!(
        read_row(&mut tx, &target, ITEMS, &[text_cell("item-2")])
            .await
            .unwrap()
            .is_none()
    );
    let project = read_row(&mut tx, &target, PROJECTS, &[text_cell("project")])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&project.row, "title").unwrap(), "Newer original title");
    let count = read_row(
        &mut tx,
        &target,
        crate::application_turn_item_counts::TABLE,
        &[text_cell("thread"), text_cell("run")],
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(integer(&count.row, "item_count").unwrap(), 1);
    tx.rollback().await.unwrap();
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn read_only_and_future_migration_history_fail_without_changing_the_original() {
    let (fixture, store, source) = fixture_80().await;
    store.shutdown().await.unwrap();
    let before = std::fs::read(fixture.path()).unwrap();
    let store = Store::open_read_only(fixture.path()).await.unwrap();
    assert!(store.bootstrap_application().await.is_err());
    store.shutdown().await.unwrap();
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    let mut tx = store.db.begin().await.unwrap();
    write_row(
        &mut tx,
        &source,
        "effect_sql_migrations",
        Map::from_iter([
            ("migration_id".into(), int_cell(90)),
            ("name".into(), text_cell("UnknownFutureMigration")),
            ("created_at".into(), text_cell(NOW)),
        ]),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(store.bootstrap_application().await.is_err());
    let app = ApplicationTransactions::new(store.clone());
    assert_eq!(app.schema().await.unwrap(), Some(source.schema));
    let mut app = app;
    app.begin_mode("readonly", ApplicationTransactionMode::Read, Some(5000))
        .await
        .unwrap();
    app.rollback("readonly").await.unwrap();
    drop(app);
    store.shutdown().await.unwrap();
}

/// A real validated archive with the exact predecessor catalog. The populated
/// upgrade tests above cover data conversion; this archive isolates activation
/// proof and retry without substituting a hand-written import receipt.
fn write_empty_80_archive(path: &std::path::Path) {
    write_empty_archive(path, previous_definition().unwrap());
}

fn write_empty_archive(path: &std::path::Path, previous: Definition) {
    use sha2::{Digest, Sha256};
    let hash = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    let append = |bytes: &mut Vec<u8>, value: Value| {
        bytes.extend(serde_json::to_vec(&value).unwrap());
        bytes.push(b'\n');
    };
    let sql = |name: &str| format!("CREATE TABLE {name} (fixture)");
    let mut bytes = Vec::new();
    append(
        &mut bytes,
        json!({
            "type":"header","format":"t3-code-ls/sqlite-export","version":1,
            "sqliteVersion":"fixture","userVersion":0,"schemaVersion":1,"applicationId":0,
            "tableCount":previous.schema.tables.len(),"excludedDerivedTables":[],"sequences":[],
            "migrations":previous.migrations,
            "schema":previous.schema.tables.iter().map(|table|json!({
                "type":"table","name":table.name,"tableName":table.name,"sql":sql(&table.name)
            })).collect::<Vec<_>>()
        }),
    );
    let mut manifests = Vec::new();
    for table in &previous.schema.tables {
        let migrations = table.name == "effect_sql_migrations";
        let count = if migrations {
            previous.migrations.len()
        } else {
            0
        };
        let columns: Vec<_> = table.columns.iter().map(|name|json!({
            "name":name,"declaredType":"TEXT","notNull":false,"defaultSql":null,"hidden":0,
            "primaryKeyOrder":table.primary_key.iter().position(|column|column==name).map_or(0,|index|index+1)
        })).collect();
        append(
            &mut bytes,
            json!({"type":"table","name":table.name,"sql":sql(&table.name),"columns":columns,"rowCount":count}),
        );
        let mut rows = Vec::new();
        if migrations {
            for (ordinal, migration) in previous.migrations.iter().enumerate() {
                let values: Vec<_> = table
                    .columns
                    .iter()
                    .map(|name| match name.as_str() {
                        "migration_id" => int_cell(migration.id.parse().unwrap()),
                        "name" => text_cell(&migration.name),
                        "created_at" => text_cell(NOW),
                        _ => panic!("unexpected migration column"),
                    })
                    .collect();
                append(
                    &mut rows,
                    json!({"type":"row","table":table.name,"ordinal":ordinal,"values":values}),
                );
            }
        }
        bytes.extend_from_slice(&rows);
        manifests.push(json!({"name":table.name,"rowCount":count,"sha256":hash(&rows)}));
    }
    let digest = hash(&bytes);
    append(
        &mut bytes,
        json!({"type":"manifest","tableCount":previous.schema.tables.len(),"rowCount":previous.migrations.len(),"tables":manifests,"sha256":digest}),
    );
    std::fs::write(path, bytes).unwrap();
}

#[tokio::test]
async fn imported_upgrade_retains_receipt_and_requires_exact_durable_lineage_on_retry() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let archive = fixture.path().with_extension("schema-80.ndjson");
    write_empty_80_archive(&archive);
    let imported = store
        .import_sqlite_application(&archive, crate::sqlite_import::ImportLimits::default())
        .await
        .unwrap();
    let receipt_key = store_key("application/import/active");
    let receipt_bytes = store.db.read(&receipt_key).await.unwrap().unwrap();
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    store.bootstrap_application().await.unwrap();
    assert_eq!(
        store.db.read(&receipt_key).await.unwrap().unwrap(),
        receipt_bytes
    );
    let receipt = store.application_import().await.unwrap().unwrap();
    assert_eq!(receipt.generation, imported.generation);
    assert_eq!(receipt.summary, imported.summary);
    assert!(receipt.replayed);
    store.shutdown().await.unwrap();

    // This is the crash boundary before the outer startup activates its marker.
    let store = fixture.connect().await;
    let replayed = store
        .import_sqlite_application(&archive, crate::sqlite_import::ImportLimits::default())
        .await
        .unwrap();
    assert_eq!(replayed, receipt);
    let target = decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
    let key = lineage_key(&target);
    let original = store.db.read(&key).await.unwrap().unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["source"]["generation"] = json!("unrelated");
    for damaged in [
        None,
        Some(b"invalid json".to_vec()),
        Some(encode(&changed).unwrap()),
    ] {
        let mut tx = store.db.begin().await.unwrap();
        match damaged {
            Some(bytes) => tx.put(key.clone(), bytes).await.unwrap(),
            None => {
                tx.delete(key.clone()).await.unwrap();
            }
        }
        tx.commit().await.unwrap();
        assert!(matches!(
            store.application_import().await,
            Err(Error::IncompatibleStore)
        ));
        assert_eq!(
            store.db.read(&receipt_key).await.unwrap().unwrap(),
            receipt_bytes
        );
    }
    let mut tx = store.db.begin().await.unwrap();
    tx.put(key, original).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(store.application_import().await.unwrap().unwrap(), receipt);
    assert_eq!(store.application_migrations().await.unwrap().len(), 89);
    store.shutdown().await.unwrap();
}

const THREADS: &str = "orchestration_v2_projection_threads";

fn indexed_thread(id: &str, root: &str, worktree: &str) -> Value {
    json!({
        "id":id,"projectId":"project","title":"Thread","providerInstanceId":"instance",
        "runtimeMode":"full-access","interactionMode":"default","activeProviderThreadId":null,
        "createdAt":NOW,"updatedAt":NOW,"archivedAt":null,"deletedAt":null,
        "worktreePath":worktree,
        "lineage":{"rootThreadId":root,"parentThreadId":null,"relationshipToParent":null}
    })
}

async fn put_thread(tx: &mut Transaction, catalog: &ApplicationCatalog, payload: Value) {
    let row = Map::from_iter([
        (
            "thread_id".into(),
            text_cell(payload["id"].as_str().unwrap()),
        ),
        ("project_id".into(), text_cell("project")),
        ("title".into(), text_cell("Thread")),
        ("default_provider".into(), text_cell("instance")),
        ("provider_instance_id".into(), text_cell("instance")),
        ("runtime_mode".into(), text_cell("full-access")),
        ("interaction_mode".into(), text_cell("default")),
        ("active_provider_thread_id".into(), nullable_cell(None)),
        ("created_at".into(), text_cell(NOW)),
        ("updated_at".into(), text_cell(NOW)),
        ("archived_at".into(), nullable_cell(None)),
        ("deleted_at".into(), nullable_cell(None)),
        ("payload_json".into(), text_cell(&payload.to_string())),
    ]);
    write_row(tx, catalog, THREADS, row).await.unwrap();
}

async fn generation_bytes(store: &Store, catalog: &ApplicationCatalog) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut tx = store.db.begin_read_only().await.unwrap();
    let prefix = prefix(&catalog.generation);
    let rows = tx.scan(&prefix, &end(&prefix), 4096).await.unwrap();
    assert!(rows.len() < 4096);
    tx.rollback().await.unwrap();
    rows
}

async fn remove_89_indexes(store: &Store, catalog: &ApplicationCatalog) {
    let mut tx = store.db.begin().await.unwrap();
    for kind in ["rows", "counts"] {
        for column in ["_root_thread", "_worktree_path"] {
            let prefix = store_key(&format!(
                "application/generation/{}/projection-reads/v1/{kind}/{THREADS}/{column}/",
                catalog.generation
            ));
            for (key, _) in tx.scan(&prefix, &end(&prefix), 4096).await.unwrap() {
                tx.delete(key).await.unwrap();
            }
        }
    }
    tx.commit().await.unwrap();
}

async fn fixture_88() -> (TestFixture, Store, ApplicationCatalog) {
    let (fixture, store, source) = fixture_80().await;
    let mut tx = store.db.begin().await.unwrap();
    for index in 0..35 {
        put_thread(
            &mut tx,
            &source,
            indexed_thread(&format!("thread-{index:02}"), "family", "/old"),
        )
        .await;
    }
    tx.commit().await.unwrap();
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    store
        .upgrade_application_80(source, definition_88().unwrap())
        .await
        .unwrap();
    while !store
        .prepare_application_projection_reads()
        .await
        .unwrap()
        .prepared
    {}
    let source = decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
    // Model an already prepared 88 store: its strict read-index witness has no
    // knowledge of the two new migration-89 JSON expressions.
    remove_89_indexes(&store, &source).await;
    (fixture, store, source)
}

#[cfg(target_os = "linux")]
const ISOLATED_UPDATE: &str = "aa212c2b-63d4-4b28-97e4-1c1d6dc6d281";

#[cfg(target_os = "linux")]
#[tokio::test]
async fn isolated_trial_publish_interrupt_fixture() {
    use crate::application_storage::{
        publish_isolated_service_trial, rollback_isolated_service_trial,
    };
    let Some(home) = std::env::var_os("T3_TEST_ISOLATED_TRIAL_HOME").map(std::path::PathBuf::from)
    else {
        return;
    };
    assert!(
        home.file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("t3-redb-test-"))
    );
    let boundary = std::env::var("T3_TEST_INTERRUPT_TRIAL_PUBLICATION").unwrap();
    if let Ok(action) = std::env::var("T3_TEST_INTENDED_MOVE") {
        if action == "publish" {
            crate::application_storage::publish_intended_isolated_service_trial(
                home,
                ISOLATED_UPDATE.into(),
            )
            .await
            .unwrap();
        } else {
            assert_eq!(action, "rollback");
            rollback_isolated_service_trial(home, ISOLATED_UPDATE.into())
                .await
                .unwrap();
        }
    } else if boundary.starts_with("forward-selection-") {
        crate::application_storage::record_fixture_forward_selection(home, ISOLATED_UPDATE.into())
            .await
            .unwrap();
    } else if boundary.starts_with("forward-commit-") {
        crate::application_storage::record_fixture_forward_commit(home, ISOLATED_UPDATE.into())
            .await
            .unwrap();
    } else if boundary.starts_with("promotion-intent-") {
        let intent =
            serde_json::from_slice(&std::fs::read(home.join("promotion-intent.json")).unwrap())
                .unwrap();
        crate::application_storage::record_native_promotion_intent(
            home,
            ISOLATED_UPDATE.into(),
            intent,
        )
        .await
        .unwrap();
    } else if boundary.starts_with("candidate-observation-") {
        let observation = serde_json::from_slice(
            &std::fs::read(home.join("candidate-observation.json")).unwrap(),
        )
        .unwrap();
        crate::application_storage::record_isolated_candidate_preparation(
            home,
            ISOLATED_UPDATE.into(),
            observation,
        )
        .await
        .unwrap();
    } else if boundary.starts_with("isolated-rollback-") {
        rollback_isolated_service_trial(home, ISOLATED_UPDATE.into())
            .await
            .unwrap();
    } else {
        publish_isolated_service_trial(home, ISOLATED_UPDATE.into())
            .await
            .unwrap();
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn isolated_trial_upgrades_88_without_changing_the_stopped_source() {
    use crate::application::PreparedServiceActivation;
    use crate::application_bootstrap::bootstrap_schema_sha256;
    use crate::application_server_ownership::OwnerLock;
    use crate::application_storage::{
        IsolatedTrialRequest, TrialSnapshot, backup_service_trial,
        inspect_isolated_service_trial_selection, prepare_isolated_service_trial,
        publish_isolated_service_trial, rollback_isolated_service_trial,
    };
    use sha2::{Digest, Sha256};
    use std::fs;

    const UPDATE: &str = ISOLATED_UPDATE;
    let hash = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    for (unsupported, bind_runtime) in [(false, false), (true, false), (false, true)] {
        let (fixture, store, catalog) = fixture_88().await;
        if unsupported {
            let mut tx = store.db.begin().await.unwrap();
            write_row(
                &mut tx,
                &catalog,
                "effect_sql_migrations",
                Map::from_iter([
                    ("migration_id".into(), int_cell(88)),
                    ("name".into(), text_cell("unsupported migration")),
                    ("created_at".into(), text_cell(NOW)),
                ]),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }
        let identity = ApplicationTransactions::new(store.clone())
            .generation_identity()
            .await
            .unwrap()
            .unwrap();
        let original_rows = generation_bytes(&store, &catalog).await;
        store.shutdown().await.unwrap();
        let home = fs::canonicalize(fixture.path().parent().unwrap()).unwrap();
        let state = home.join("userdata");
        let live = state.join("statev2.omdb");
        fs::create_dir(&state).unwrap();
        fs::create_dir(home.join("runtime")).unwrap();
        fs::rename(fixture.path(), &live).unwrap();
        OwnerLock::acquire(&state.join("server-owner.sqlite"))
            .unwrap()
            .activate_native()
            .unwrap();
        let backup =
            backup_service_trial(home.clone(), UPDATE.into(), identity.catalog_sha256.clone())
                .await
                .unwrap();
        let checkpoint = home.join(format!("runtime/native-db-backup/{UPDATE}.omdb"));
        let live_bytes = fs::read(&live).unwrap();
        let checkpoint_bytes = fs::read(&checkpoint).unwrap();
        let target_schema_sha256 = bootstrap_schema_sha256();
        let helper = home.join("runtime/versions/1.2.4/native-bin/t3-code-ls-db");
        let selection_file = home.join("runtime/service-state.json");
        let write_selection = |protocol| {
            let selection = json!({
                "protocol": protocol, "activeVersion": "1.2.3", "update": {
                    "id": UPDATE, "fromVersion": "1.2.3", "targetVersion": "1.2.4",
                    "dbPath": live, "status": "pending"
                }
            });
            fs::write(&selection_file, selection.to_string()).unwrap();
        };
        let activation = if bind_runtime {
            let version_dir = home.join("runtime/versions/1.2.4");
            fs::create_dir_all(helper.parent().unwrap()).unwrap();
            fs::write(&helper, b"fixture helper").unwrap();
            fs::write(version_dir.join("t3"), b"fixture runtime").unwrap();
            fs::write(version_dir.join(".install-complete"), b"1.2.4\n").unwrap();
            write_selection(4);
            Some(PreparedServiceActivation {
                update_id: UPDATE.into(),
                from_version: "1.2.3".into(),
                target_version: "1.2.4".into(),
                target_entry_sha256: hash(b"fixture runtime"),
                target_helper_sha256: hash(b"fixture helper"),
                target_schema_sha256: target_schema_sha256.clone(),
            })
        } else {
            None
        };
        let request = || IsolatedTrialRequest {
            update_id: UPDATE.into(),
            database: backup.database.clone(),
            checkpoint: TrialSnapshot {
                catalog_sha256: identity.catalog_sha256.clone(),
                rows: backup.backup.rows,
                checksum: backup.backup.checksum.clone(),
            },
            target_schema_sha256: target_schema_sha256.clone(),
            activation: activation.clone(),
        };
        let trial = state.join(format!(".statev2-trial-{UPDATE}.omdb"));
        if bind_runtime {
            assert!(matches!(
                prepare_isolated_service_trial(home.clone(), UPDATE.into(), request()).await,
                Err(Error::IncompatibleStore)
            ));
            assert!(!trial.exists());
            write_selection(5);
        }
        let result = prepare_isolated_service_trial(home.clone(), UPDATE.into(), request()).await;
        if unsupported {
            assert!(matches!(result, Err(Error::Invalid(_))), "{result:?}");
            assert!(!trial.exists());
        } else {
            let prepared = result.unwrap();
            let candidate = Store::open_read_only(&trial).await.unwrap();
            let upgraded =
                decode_catalog(&candidate.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
            let expected = definition().unwrap();
            let mut expected_catalog = target_89(&catalog, &expected);
            expected_catalog.prepared_service_activation_v1 = activation.clone();
            assert_eq!(upgraded, expected_catalog);
            assert_eq!(
                candidate.application_migrations().await.unwrap().len(),
                expected.migrations.len()
            );
            assert_eq!(generation_bytes(&candidate, &catalog).await, original_rows);
            if bind_runtime {
                assert!(matches!(
                    candidate.serving_startup_migrations().await,
                    Err(Error::IncompatibleStore)
                ));
                let mut application = ApplicationTransactions::new(candidate.clone());
                assert_eq!(
                    application.prepared_service_activation().await.unwrap(),
                    activation
                );
                assert!(matches!(
                    application.schema().await,
                    Err(Error::IncompatibleStore)
                ));
                assert!(matches!(
                    application.open_read_session().await,
                    Err(Error::IncompatibleStore)
                ));
            }
            assert_eq!(
                ApplicationTransactions::new(candidate.clone())
                    .generation_identity()
                    .await
                    .unwrap()
                    .unwrap()
                    .catalog_sha256,
                prepared.snapshot.catalog_sha256
            );
            candidate.shutdown().await.unwrap();
            if bind_runtime {
                assert_eq!(
                    prepare_isolated_service_trial(home.clone(), UPDATE.into(), request())
                        .await
                        .unwrap(),
                    prepared
                );
                let inspect = || {
                    inspect_isolated_service_trial_selection(
                        home.clone(),
                        UPDATE.into(),
                        "1.2.3".into(),
                        "1.2.4".into(),
                    )
                };
                assert_eq!(
                    inspect().await.unwrap().prepared_database,
                    prepared.database
                );
                let trial_bytes = fs::read(&trial).unwrap();
                fs::write(&helper, b"replacement helper").unwrap();
                assert!(matches!(inspect().await, Err(Error::IncompatibleStore)));
                assert!(matches!(
                    prepare_isolated_service_trial(home.clone(), UPDATE.into(), request()).await,
                    Err(Error::IncompatibleStore)
                ));
                assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
                assert!(matches!(
                    rollback_isolated_service_trial(home.clone(), UPDATE.into()).await,
                    Err(Error::IncompatibleStore)
                ));
                assert!(matches!(
                    publish_isolated_service_trial(home.clone(), UPDATE.into()).await,
                    Err(Error::IncompatibleStore)
                ));
                assert_eq!(fs::read(&live).unwrap(), live_bytes);
                fs::write(&helper, b"fixture helper").unwrap();
                let interrupt = |boundary: &str| {
                    let child = std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("isolated_trial_publish_interrupt_fixture")
                        .env("T3_TEST_ISOLATED_TRIAL_HOME", &home)
                        .env("T3_TEST_INTERRUPT_TRIAL_PUBLICATION", boundary)
                        .output()
                        .unwrap();
                    assert_eq!(
                        child.status.code(),
                        Some(73),
                        "{}",
                        String::from_utf8_lossy(&child.stdout)
                    );
                };
                let verification_json = serde_json::to_string(&serde_json::json!({
                    "request": request(), "preparation": prepared,
                }))
                .unwrap();
                let bound = activation.as_ref().unwrap();
                let observation = serde_json::json!({
                    "verification_json": verification_json,
                    "witness": {
                        "protocol": 1, "status": "prepared-isolated", "updateId": UPDATE,
                        "targetVersion": bound.target_version,
                        "entrySha256": bound.target_entry_sha256,
                        "helperSha256": bound.target_helper_sha256,
                        "verificationSha256": hash(verification_json.as_bytes()),
                    },
                });
                fs::write(
                    home.join("candidate-observation.json"),
                    serde_json::to_vec(&observation).unwrap(),
                )
                .unwrap();
                let receipt = trial.with_extension("receipt-v1.json");
                let original_receipt = fs::read(&receipt).unwrap();
                interrupt("candidate-observation-written");
                assert_eq!(fs::read(&receipt).unwrap(), original_receipt);
                assert_eq!(fs::read(&live).unwrap(), live_bytes);
                interrupt("candidate-observation-durable");
                let durable_receipt = fs::read(&receipt).unwrap();
                assert_ne!(durable_receipt, original_receipt);
                let record = || {
                    crate::application_storage::record_isolated_candidate_preparation(
                        home.clone(),
                        UPDATE.into(),
                        serde_json::from_value(observation.clone()).unwrap(),
                    )
                };
                assert_eq!(record().await.unwrap()["reused"], true);
                assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
                let mut stale = observation.clone();
                let alternate = format!(" {}", verification_json);
                stale["verification_json"] = serde_json::json!(alternate);
                stale["witness"]["verificationSha256"] =
                    serde_json::json!(hash(alternate.as_bytes()));
                assert!(matches!(
                    crate::application_storage::record_isolated_candidate_preparation(
                        home.clone(),
                        UPDATE.into(),
                        serde_json::from_value(stale).unwrap()
                    )
                    .await,
                    Err(Error::IncompatibleStore)
                ));
                assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
                let mut corrupt: serde_json::Value =
                    serde_json::from_slice(&durable_receipt).unwrap();
                corrupt["candidate_observation"]["witness"]["verificationSha256"] =
                    serde_json::json!("0".repeat(64));
                let corrupt_bytes = serde_json::to_vec(&corrupt).unwrap();
                fs::write(&receipt, &corrupt_bytes).unwrap();
                assert!(matches!(inspect().await, Err(Error::IncompatibleStore)));
                assert!(matches!(record().await, Err(Error::IncompatibleStore)));
                assert_eq!(fs::read(&receipt).unwrap(), corrupt_bytes);
                fs::write(&receipt, &durable_receipt).unwrap();
                fs::write(&helper, b"changed after observation").unwrap();
                assert!(matches!(record().await, Err(Error::IncompatibleStore)));
                assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
                fs::write(&helper, b"fixture helper").unwrap();
                assert_eq!(
                    inspect().await.unwrap().prepared_database,
                    prepared.database
                );
                assert_eq!(fs::read(&live).unwrap(), live_bytes);
                assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
                let preserved = state.join(format!(".statev2-source-{UPDATE}.omdb"));
                interrupt("isolated-preserved");
                assert_eq!(fs::read(&live).unwrap(), live_bytes);
                assert_eq!(fs::read(&preserved).unwrap(), live_bytes);
                assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
                interrupt("isolated-renamed");
                assert!(!trial.exists());
                assert_eq!(fs::read(&live).unwrap(), trial_bytes);
                let recovered = publish_isolated_service_trial(home.clone(), UPDATE.into())
                    .await
                    .unwrap();
                assert!(recovered.reused);
                assert_eq!(recovered.database, prepared.database);
                assert_eq!(recovered.preserved_database, backup.database);
                assert_eq!(Some(recovered.activation), activation);
                assert_eq!(fs::read(&preserved).unwrap(), live_bytes);
                let canonical = Store::open_read_only(&live).await.unwrap();
                let candidate = ApplicationTransactions::new(canonical);
                assert!(matches!(
                    candidate.schema().await,
                    Err(Error::IncompatibleStore)
                ));
                assert_eq!(
                    candidate.prepared_service_activation().await.unwrap(),
                    activation
                );
                drop(candidate);
                if let Some(helper) = std::env::var_os("T3_TEST_RETAINED_TRIAL_HELPER") {
                    use std::io::Write;
                    use std::process::{Command, Stdio};

                    let mut retained = Command::new(helper)
                        .arg("read-only-local")
                        .arg(&live)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .spawn()
                        .unwrap();
                    retained
                        .stdin
                        .take()
                        .unwrap()
                        .write_all(b"{\"operation\":\"application_schema\"}\n")
                        .unwrap();
                    let refused = retained.wait_with_output().unwrap();
                    assert!(refused.status.success());
                    let receipt: Value = serde_json::from_slice(&refused.stdout).unwrap();
                    assert_eq!(receipt["error"]["kind"], "incompatible_store", "{receipt}");
                    assert_eq!(fs::read(&live).unwrap(), trial_bytes);
                }
                let failed = state.join(format!(".statev2-failed-sealed-{UPDATE}.omdb"));
                fs::remove_file(&helper).unwrap();
                interrupt("isolated-rollback-preserved");
                assert_eq!(fs::read(&live).unwrap(), trial_bytes);
                assert_eq!(fs::read(&failed).unwrap(), trial_bytes);
                assert_eq!(fs::read(&preserved).unwrap(), live_bytes);
                interrupt("isolated-rollback-renamed");
                assert!(!preserved.exists());
                let rollback = rollback_isolated_service_trial(home.clone(), UPDATE.into())
                    .await
                    .unwrap();
                assert!(rollback.reused);
                assert_eq!(rollback.database, backup.database);
                assert_eq!(rollback.preserved_database, prepared.database);
                assert_eq!(fs::read(&failed).unwrap(), trial_bytes);
                let reopened = Store::open_read_only(&live).await.unwrap();
                let source = ApplicationTransactions::new(reopened);
                assert_eq!(source.schema().await.unwrap(), Some(catalog.schema.clone()));
                assert_eq!(source.prepared_service_activation().await.unwrap(), None);
            }
        }
        assert_eq!(fs::read(&live).unwrap(), live_bytes);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
    }
}

async fn selected_thread_ids(
    app: &mut ApplicationTransactions,
    transaction: &str,
    options: Value,
) -> Vec<String> {
    let query = serde_json::from_value(json!({"kind":"threads","options":options})).unwrap();
    app.projections_shell(transaction, query)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["thread_id"].as_str().unwrap().to_owned())
        .collect()
}

async fn replace_thread(app: &mut ApplicationTransactions, transaction: &str, payload: Value) {
    app.projections_apply(
        transaction,
        crate::application_projections::ProjectionApply {
            event_type: "thread.created".into(),
            thread_id: payload["id"].as_str().unwrap().into(),
            occurred_at: NOW.into(),
            payload_json: payload.to_string(),
            normalization: None,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn index_only_88_upgrade_rebuilds_after_interruption_preserves_counts_and_supports_live_writes()
 {
    let (fixture, store, source) = fixture_88().await;
    let current = definition().unwrap();
    let target = target_89(&source, &current);
    assert_ne!(source.generation, target.generation);
    assert!(
        store
            .upgrade_stage(&source, &source, Stage::Clear)
            .await
            .is_err()
    );
    store
        .upgrade_stage(&source, &target, Stage::Copy)
        .await
        .unwrap();
    store
        .prepare_projection_reads_for_catalog(&target)
        .await
        .unwrap();
    assert_eq!(store.application_migrations().await.unwrap().len(), 88);
    store.shutdown().await.unwrap();

    // The previous build can edit the still-active 88 rows before this retry.
    // Staged 89 indexes and payloads must not survive the recopy.
    let store = fixture.connect().await;
    let mut tx = store.db.begin().await.unwrap();
    put_thread(
        &mut tx,
        &source,
        indexed_thread("thread-00", "new-family", "/new"),
    )
    .await;
    put_thread(
        &mut tx,
        &source,
        indexed_thread("thread-new", "new-family", "/new"),
    )
    .await;
    crate::application_rows::delete_row(&mut tx, &source, THREADS, &[text_cell("thread-01")])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let before = generation_bytes(&store, &source).await;
    assert!(store.bootstrap_application().await.is_err());
    assert_eq!(generation_bytes(&store, &source).await, before);
    store.shutdown().await.unwrap();
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    assert_eq!(
        store
            .bootstrap_application()
            .await
            .unwrap()
            .migrations
            .len(),
        89
    );
    assert_eq!(generation_bytes(&store, &source).await, before);
    let active = decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
    assert_eq!(active, target);
    let mut tx = store.db.begin_read_only().await.unwrap();
    for (run, expected) in [("run", 2), ("", 1)] {
        let count = read_row(
            &mut tx,
            &active,
            crate::application_turn_item_counts::TABLE,
            &[text_cell("thread"), text_cell(run)],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(integer(&count.row, "item_count").unwrap(), expected);
    }
    tx.rollback().await.unwrap();

    let mut app = ApplicationTransactions::new(store.clone());
    app.begin("write").await.unwrap();
    let expected = vec!["thread-00".to_string(), "thread-new".to_string()];
    assert_eq!(
        selected_thread_ids(&mut app, "write", json!({"worktreePath":"/new"})).await,
        expected
    );
    assert_eq!(
        selected_thread_ids(&mut app, "write", json!({"familyOf":"thread-00"})).await,
        expected
    );
    assert!(
        selected_thread_ids(&mut app, "write", json!({"threadIds":["thread-01"]}))
            .await
            .is_empty()
    );
    app.savepoint("write", "inner").await.unwrap();
    replace_thread(
        &mut app,
        "write",
        indexed_thread("thread-00", "moved", "/moved"),
    )
    .await;
    assert_eq!(
        selected_thread_ids(&mut app, "write", json!({"worktreePath":"/moved"})).await,
        ["thread-00"]
    );
    app.rollback_to("write", "inner").await.unwrap();
    app.release("write", "inner").await.unwrap();
    assert!(
        selected_thread_ids(&mut app, "write", json!({"worktreePath":"/moved"}))
            .await
            .is_empty()
    );
    replace_thread(
        &mut app,
        "write",
        indexed_thread("thread-00", "moved", "/moved"),
    )
    .await;
    app.commit("write").await.unwrap();
    drop(app);
    store.shutdown().await.unwrap();
    let reopened = fixture.connect().await;
    assert!(!reopened.bootstrap_application().await.unwrap().initialized);
    let mut app = ApplicationTransactions::new(reopened.clone());
    app.begin("read").await.unwrap();
    assert_eq!(
        selected_thread_ids(
            &mut app,
            "read",
            json!({"worktreePath":"/moved","familyOf":"thread-00"})
        )
        .await,
        ["thread-00"]
    );
    app.rollback("read").await.unwrap();
    drop(app);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn direct_88_import_and_80_88_89_chain_retain_the_original_receipt_and_exact_lineage() {
    for original_version in [80, 88] {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let archive = fixture.path().with_extension("original.ndjson");
        write_empty_archive(
            &archive,
            if original_version == 80 {
                previous_definition().unwrap()
            } else {
                definition_88().unwrap()
            },
        );
        let original_archive = std::fs::read(&archive).unwrap();
        let imported = store
            .import_sqlite_application(&archive, crate::sqlite_import::ImportLimits::default())
            .await
            .unwrap();
        let receipt_key = store_key("application/import/active");
        let receipt_bytes = store.db.read(&receipt_key).await.unwrap().unwrap();
        let original =
            decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
        let original_rows = generation_bytes(&store, &original).await;
        store.shutdown().await.unwrap();
        let store = Store::open_exclusive(fixture.path()).await.unwrap();
        if original_version == 80 {
            store
                .upgrade_application_80(original.clone(), definition_88().unwrap())
                .await
                .unwrap();
            // Read-only startup inspects this old receipt before requesting89.
            assert_eq!(
                store.application_import().await.unwrap().unwrap().summary,
                imported.summary
            );
        }
        let intermediate =
            decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
        let intermediate_rows = generation_bytes(&store, &intermediate).await;
        store.bootstrap_application().await.unwrap();
        let active = decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
        assert_eq!(active, target_89(&intermediate, &definition().unwrap()));
        assert_eq!(generation_bytes(&store, &original).await, original_rows);
        assert_eq!(
            generation_bytes(&store, &intermediate).await,
            intermediate_rows
        );
        assert_eq!(std::fs::read(&archive).unwrap(), original_archive);
        assert_eq!(
            store.db.read(&receipt_key).await.unwrap().unwrap(),
            receipt_bytes
        );
        let receipt = store.application_import().await.unwrap().unwrap();
        assert_eq!(receipt.generation, imported.generation);
        assert_eq!(receipt.summary, imported.summary);
        let key = lineage_89_key(&active);
        let good = store.db.read(&key).await.unwrap().unwrap();
        let mut wrong: Value = serde_json::from_slice(&good).unwrap();
        wrong["source"]["generation"] = json!("unrelated");
        for damaged in [
            None,
            Some(b"invalid".to_vec()),
            Some(encode(&wrong).unwrap()),
        ] {
            let mut tx = store.db.begin().await.unwrap();
            if let Some(bytes) = damaged {
                tx.put(key.clone(), bytes).await.unwrap();
            } else {
                tx.delete(key.clone()).await.unwrap();
            }
            tx.commit().await.unwrap();
            assert!(matches!(
                store.application_import().await,
                Err(Error::IncompatibleStore)
            ));
            assert_eq!(
                store.db.read(&receipt_key).await.unwrap().unwrap(),
                receipt_bytes
            );
        }
        let mut tx = store.db.begin().await.unwrap();
        tx.put(key, good).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(store.application_import().await.unwrap().unwrap(), receipt);
        store.shutdown().await.unwrap();
        let reopened = fixture.connect().await;
        assert_eq!(
            reopened
                .import_sqlite_application(&archive, crate::sqlite_import::ImportLimits::default())
                .await
                .unwrap(),
            receipt
        );

        let mut marked = serde_json::to_value(&active).unwrap();
        marked["forward_service_activation_v1"] = json!({
            "update_id": "aa212c2b-63d4-4b28-97e4-1c1d6dc6d281",
            "forward_selection_sha256": "a".repeat(64),
        });
        let marked = encode(&marked).unwrap();
        let mut tx = reopened.db.begin().await.unwrap();
        tx.put(schema_key(), marked.clone()).await.unwrap();
        tx.commit().await.unwrap();
        assert!(matches!(
            reopened.application_import().await,
            Err(Error::IncompatibleStore)
        ));
        let mut tx = reopened.db.begin().await.unwrap();
        record_generation_identity(&mut tx, &active, &marked)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            reopened.application_import().await.unwrap().unwrap(),
            receipt
        );

        for (field, value) in [
            ("forward_selection_sha256", json!("b".repeat(64))),
            ("update_id", json!("ba212c2b-63d4-4b28-97e4-1c1d6dc6d281")),
        ] {
            let mut tampered: Value = serde_json::from_slice(&marked).unwrap();
            tampered["forward_service_activation_v1"][field] = value;
            let mut tx = reopened.db.begin().await.unwrap();
            tx.put(schema_key(), encode(&tampered).unwrap())
                .await
                .unwrap();
            tx.commit().await.unwrap();
            assert!(matches!(
                reopened.application_import().await,
                Err(Error::IncompatibleStore)
            ));
        }
        let mut tx = reopened.db.begin().await.unwrap();
        tx.put(schema_key(), marked).await.unwrap();
        tx.commit().await.unwrap();
        reopened.shutdown().await.unwrap();
        let readonly = Store::open_read_only(fixture.path()).await.unwrap();
        assert_eq!(
            readonly.application_import().await.unwrap().unwrap(),
            receipt
        );
        readonly.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn exact_88_history_is_required_and_read_only_future_or_damaged_histories_cannot_publish() {
    let (fixture, store, source) = fixture_88().await;
    store.shutdown().await.unwrap();
    let before = std::fs::read(fixture.path()).unwrap();
    let readonly = Store::open_read_only(fixture.path()).await.unwrap();
    assert!(readonly.bootstrap_application().await.is_err());
    readonly.shutdown().await.unwrap();
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    for (id, name) in [
        (88, "AlteredKnownMigration"),
        (90, "UnknownFutureMigration"),
    ] {
        let store = Store::open_exclusive(fixture.path()).await.unwrap();
        let mut tx = store.db.begin().await.unwrap();
        let previous = definition_88().unwrap();
        let known = previous.migrations.last().unwrap();
        write_row(
            &mut tx,
            &source,
            "effect_sql_migrations",
            Map::from_iter([
                ("migration_id".into(), int_cell(88)),
                ("name".into(), text_cell(&known.name)),
                ("created_at".into(), text_cell(NOW)),
            ]),
        )
        .await
        .unwrap();
        write_row(
            &mut tx,
            &source,
            "effect_sql_migrations",
            Map::from_iter([
                ("migration_id".into(), int_cell(id)),
                ("name".into(), text_cell(name)),
                ("created_at".into(), text_cell(NOW)),
            ]),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let before = generation_bytes(&store, &source).await;
        assert!(store.bootstrap_application().await.is_err());
        assert_eq!(generation_bytes(&store, &source).await, before);
        assert_eq!(
            decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap(),
            source
        );
        store.shutdown().await.unwrap();
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn service_promotion_intent_is_durable_exact_and_keeps_publication_fenced() {
    promotion_intent_fixture(PromotionFixture::Intent).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn service_intended_sealed_publication_recovers_without_activation() {
    for case in [
        ("sealed-phase-publishing-written", false),
        ("sealed-phase-publishing-durable", true),
        ("intended-preserved", true),
        ("intended-renamed", false),
        ("sealed-phase-published-durable", false),
    ] {
        println!("T05 checking sealed publication interruption at {}", case.0);
        promotion_intent_fixture(PromotionFixture::Publication(Some(case.0), case.1)).await;
        println!(
            "T05 recovered sealed publication interruption at {}",
            case.0
        );
    }
    println!(
        "T05 intended sealed publication recovered exact phases and rollback without selecting or serving"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn service_intent_only_cancellation_recovers_before_publication() {
    promotion_intent_fixture(PromotionFixture::Publication(None, true)).await;
    println!("T05 intent-only cancellation recovered without moving the source or the stage");
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum PromotionFixture {
    Intent,
    Publication(Option<&'static str>, bool),
    ForwardCommit(ForwardCommitCase),
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug)]
enum ForwardCommitCase {
    RefuseSourceWithoutFence,
    RefuseTargetWithoutFence,
    InterruptBeforeWrite,
    InterruptAfterDurable,
    CatalogFences,
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires the pinned Rust helper in T3_TEST_PROMOTION_HELPER"]
async fn service_forward_commit_refuses_rollback_without_unsealing() {
    assert!(std::env::var_os("T3_TEST_PROMOTION_HELPER").is_some());
    for case in [
        ForwardCommitCase::RefuseSourceWithoutFence,
        ForwardCommitCase::RefuseTargetWithoutFence,
        ForwardCommitCase::InterruptBeforeWrite,
        ForwardCommitCase::InterruptAfterDurable,
    ] {
        println!("T05 forward decision: {case:?}");
        promotion_intent_fixture(PromotionFixture::ForwardCommit(case)).await;
    }
    println!(
        "T05 forward decision interruption and rollback refusal verified with installed helpers"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires the exact-base and compatible pinned Rust helpers"]
async fn service_forward_catalog_fences_generic_restore() {
    assert!(std::env::var_os("T3_TEST_PROMOTION_HELPER").is_some());
    assert!(std::env::var_os("T3_TEST_PRIOR_PROMOTION_HELPER").is_some());
    promotion_intent_fixture(PromotionFixture::ForwardCommit(
        ForwardCommitCase::CatalogFences,
    ))
    .await;
}

#[cfg(target_os = "linux")]
async fn promotion_intent_fixture(case: PromotionFixture) {
    use crate::application::PreparedServiceActivation;
    use crate::application_bootstrap::bootstrap_schema_sha256;
    use crate::application_server_ownership::OwnerLock;
    use crate::application_storage::{
        CandidatePreparationObservation, IsolatedTrialRequest, NativePromotionIntent,
        TrialSnapshot, backup_service_trial, prepare_isolated_service_trial,
        publish_isolated_service_trial, record_isolated_candidate_preparation,
        record_native_promotion_intent,
    };
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    const UPDATE: &str = ISOLATED_UPDATE;
    let hash = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    assert!(store.bootstrap_application().await.unwrap().initialized);
    let identity = ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await
        .unwrap()
        .unwrap();
    store.shutdown().await.unwrap();
    let home = fs::canonicalize(fixture.path().parent().unwrap()).unwrap();
    let state = home.join("userdata");
    fs::create_dir(&state).unwrap();
    fs::create_dir(home.join("runtime")).unwrap();
    let live = state.join("statev2.omdb");
    fs::rename(fixture.path(), &live).unwrap();
    OwnerLock::acquire(&state.join("server-owner.sqlite"))
        .unwrap()
        .activate_native()
        .unwrap();
    let backup = backup_service_trial(home.clone(), UPDATE.into(), identity.catalog_sha256.clone())
        .await
        .unwrap();
    let source_bytes = fs::read(&live).unwrap();
    let checkpoint = home.join(format!("runtime/native-db-backup/{UPDATE}.omdb"));
    let checkpoint_bytes = fs::read(&checkpoint).unwrap();
    let capabilities = crate::application_storage::service_trial_capabilities().unwrap();
    let helper_bytes = if let Some(path) = std::env::var_os("T3_TEST_PROMOTION_HELPER") {
        let path = std::path::PathBuf::from(path);
        assert!(path.is_absolute());
        assert!(fs::metadata(&path).unwrap().len() <= 128 * 1024 * 1024);
        println!("T05 promotion intent uses the pinned built Rust helper");
        fs::read(path).unwrap()
    } else {
        println!("T05 promotion intent uses a controlled read-only capability peer");
        format!(
            "#!/bin/sh\n[ \"$1\" = trial-capabilities ] || exit 99\nprintf '%s\\n' '{}'\n",
            json!({"ok": true, "result": capabilities})
        )
        .into_bytes()
    };
    let mut predecessor_capabilities = capabilities.clone();
    predecessor_capabilities
        .as_object_mut()
        .unwrap()
        .remove("sealedGenericRestoreFence");
    let predecessor = format!(
        "#!/bin/sh\n[ \"$1\" = trial-capabilities ] || exit 99\nprintf '%s\\n' '{}'\n",
        json!({"ok": true, "result": predecessor_capabilities})
    );
    let prior_helper_bytes;
    let source_bytes_for_helper = match case {
        PromotionFixture::ForwardCommit(ForwardCommitCase::RefuseSourceWithoutFence) => {
            predecessor.as_bytes()
        }
        PromotionFixture::ForwardCommit(ForwardCommitCase::CatalogFences) => {
            let path = std::path::PathBuf::from(
                std::env::var_os("T3_TEST_PRIOR_PROMOTION_HELPER").unwrap(),
            );
            assert!(path.is_absolute());
            assert!(fs::metadata(&path).unwrap().len() <= 128 * 1024 * 1024);
            prior_helper_bytes = fs::read(path).unwrap();
            assert_ne!(hash(&prior_helper_bytes), hash(&helper_bytes));
            println!("T05 prior helper SHA-256 {}", hash(&prior_helper_bytes));
            println!("T05 compatible helper SHA-256 {}", hash(&helper_bytes));
            &prior_helper_bytes
        }
        _ => &helper_bytes,
    };
    let target_bytes_for_helper = if matches!(
        case,
        PromotionFixture::ForwardCommit(ForwardCommitCase::RefuseTargetWithoutFence)
    ) {
        predecessor.as_bytes()
    } else {
        &helper_bytes
    };
    let install = |version: &str, entry: &[u8], helper_bytes: &[u8]| {
        let directory = home.join("runtime/versions").join(version);
        fs::create_dir_all(directory.join("native-bin")).unwrap();
        fs::write(directory.join(".install-complete"), format!("{version}\n")).unwrap();
        fs::write(directory.join("t3"), entry).unwrap();
        fs::set_permissions(directory.join("t3"), fs::Permissions::from_mode(0o700)).unwrap();
        let helper = directory.join("native-bin/t3-code-ls-db");
        fs::write(&helper, helper_bytes).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        helper
    };
    let source_helper = install("1.2.3", b"synthetic source entry", source_bytes_for_helper);
    let target_helper = install(
        "1.2.4",
        b"synthetic candidate entry",
        target_bytes_for_helper,
    );
    let source_entry = home.join("runtime/versions/1.2.3/t3");
    let target_schema = bootstrap_schema_sha256();
    let activation = PreparedServiceActivation {
        update_id: UPDATE.into(),
        from_version: "1.2.3".into(),
        target_version: "1.2.4".into(),
        target_entry_sha256: hash(b"synthetic candidate entry"),
        target_helper_sha256: hash(target_bytes_for_helper),
        target_schema_sha256: target_schema.clone(),
    };
    let selection = home.join("runtime/service-state.json");
    let selection_bytes = serde_json::to_vec(&json!({ "protocol": 5, "activeVersion": "1.2.3", "update": {
        "id": UPDATE, "fromVersion": "1.2.3", "targetVersion": "1.2.4", "dbPath": live, "status": "pending",
    }})).unwrap();
    fs::write(&selection, &selection_bytes).unwrap();
    let request = IsolatedTrialRequest {
        update_id: UPDATE.into(),
        database: backup.database,
        checkpoint: TrialSnapshot {
            catalog_sha256: identity.catalog_sha256,
            rows: backup.backup.rows,
            checksum: backup.backup.checksum,
        },
        target_schema_sha256: target_schema.clone(),
        activation: Some(activation.clone()),
    };
    let prepared = prepare_isolated_service_trial(home.clone(), UPDATE.into(), request.clone())
        .await
        .unwrap();
    let verification_json =
        serde_json::to_string(&json!({"request": request, "preparation": prepared})).unwrap();
    let observation: CandidatePreparationObservation = serde_json::from_value(json!({
        "verification_json": verification_json, "witness": {
            "protocol": 1, "status": "prepared-isolated", "updateId": UPDATE, "targetVersion": "1.2.4",
            "entrySha256": activation.target_entry_sha256, "helperSha256": activation.target_helper_sha256,
            "verificationSha256": hash(verification_json.as_bytes()),
        },
    })).unwrap();
    let intent = NativePromotionIntent {
        version: 1,
        verification_sha256: hash(verification_json.as_bytes()),
        source_entry_sha256: hash(b"synthetic source entry"),
        source_helper_sha256: hash(source_bytes_for_helper),
        source_helper_schema_sha256: target_schema,
    };
    let record = || record_native_promotion_intent(home.clone(), UPDATE.into(), intent.clone());
    assert!(
        matches!(record().await, Err(Error::IncompatibleStore)),
        "no intent before earned observation"
    );
    record_isolated_candidate_preparation(home.clone(), UPDATE.into(), observation.clone())
        .await
        .unwrap();
    let receipt = state.join(format!(".statev2-trial-{UPDATE}.receipt-v1.json"));
    let trial = state.join(format!(".statev2-trial-{UPDATE}.omdb"));
    let prepared_receipt = fs::read(&receipt).unwrap();
    let trial_bytes = fs::read(&trial).unwrap();
    let trial_identity = fs::metadata(&trial).unwrap();
    let mut stale = intent.clone();
    stale.verification_sha256 = "0".repeat(64);
    assert!(matches!(
        record_native_promotion_intent(home.clone(), UPDATE.into(), stale).await,
        Err(Error::IncompatibleStore)
    ));
    let mut old_capabilities = capabilities.clone();
    old_capabilities
        .as_object_mut()
        .unwrap()
        .remove("promotionIntent");
    let old_helper = format!(
        "#!/bin/sh\nprintf '%s\\n' '{}'\n",
        json!({"ok": true, "result": old_capabilities})
    );
    fs::write(&source_helper, old_helper.as_bytes()).unwrap();
    let mut unsupported = intent.clone();
    unsupported.source_helper_sha256 = hash(old_helper.as_bytes());
    assert!(matches!(
        record_native_promotion_intent(home.clone(), UPDATE.into(), unsupported).await,
        Err(Error::IncompatibleStore)
    ));
    assert_eq!(fs::read(&receipt).unwrap(), prepared_receipt);
    fs::write(&source_helper, source_bytes_for_helper).unwrap();
    fs::write(
        home.join("promotion-intent.json"),
        serde_json::to_vec(&intent).unwrap(),
    )
    .unwrap();
    let interrupt = |boundary: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("isolated_trial_publish_interrupt_fixture")
            .env("T3_TEST_ISOLATED_TRIAL_HOME", &home)
            .env("T3_TEST_INTERRUPT_TRIAL_PUBLICATION", boundary)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    };
    interrupt("promotion-intent-written");
    assert_eq!(fs::read(&receipt).unwrap(), prepared_receipt);
    interrupt("promotion-intent-durable");
    let durable_receipt = fs::read(&receipt).unwrap();
    assert_ne!(durable_receipt, prepared_receipt);
    assert_eq!(record().await.unwrap()["reused"], true);
    assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
    if let Some(executable) = std::env::var_os("T3_TEST_PROMOTION_HELPER") {
        use std::io::Write;
        let mut child = std::process::Command::new(executable)
            .arg("trial-record-promotion")
            .arg(&home)
            .arg(UPDATE)
            .env_clear()
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&intent).unwrap())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let frame: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(frame["ok"], true);
        assert_eq!(frame["result"]["reused"], true);
        assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
    }
    if let PromotionFixture::ForwardCommit(case) = case {
        forward_commit_fixture(&home, case).await;
        return;
    }
    if let PromotionFixture::Publication(boundary, cancel_before_rename) = case {
        use crate::application_storage::{
            publish_intended_isolated_service_trial, rollback_isolated_service_trial,
        };
        use std::os::unix::fs::MetadataExt;
        let original = state.join(format!(".statev2-source-{UPDATE}.omdb"));
        let failed = state.join(format!(".statev2-failed-sealed-{UPDATE}.omdb"));
        let source_inode = fs::metadata(&live).unwrap().ino();
        let interrupt_move = |action: &str, boundary: &str| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("isolated_trial_publish_interrupt_fixture")
                .env("T3_TEST_ISOLATED_TRIAL_HOME", &home)
                .env("T3_TEST_INTENDED_MOVE", action)
                .env("T3_TEST_INTERRUPT_TRIAL_PUBLICATION", boundary)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(73),
                "{} {}",
                boundary,
                String::from_utf8_lossy(&output.stdout)
            );
        };
        if let Some(boundary) = boundary {
            interrupt_move("publish", boundary);
        }
        assert_eq!(fs::read(&selection).unwrap(), selection_bytes);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
        assert!(matches!(
            publish_isolated_service_trial(home.clone(), UPDATE.into()).await,
            Err(Error::IncompatibleStore)
        ));
        let phase_receipt = fs::read(&receipt).unwrap();
        if boundary.is_some_and(|value| value != "sealed-phase-publishing-written") {
            let mut alternate_selection = selection_bytes.clone();
            alternate_selection.push(b'\n');
            fs::write(&selection, &alternate_selection).unwrap();
            assert!(matches!(
                publish_intended_isolated_service_trial(home.clone(), UPDATE.into()).await,
                Err(Error::IncompatibleStore)
            ));
            assert_eq!(fs::read(&receipt).unwrap(), phase_receipt);
            fs::write(&selection, &selection_bytes).unwrap();
        }
        if boundary.is_some_and(|value| value != "sealed-phase-publishing-written") {
            let mut corrupted: Value = serde_json::from_slice(&phase_receipt).unwrap();
            corrupted["sealed_publication"]["version"] = json!(2);
            fs::write(&receipt, serde_json::to_vec(&corrupted).unwrap()).unwrap();
            assert!(matches!(
                publish_intended_isolated_service_trial(home.clone(), UPDATE.into()).await,
                Err(Error::IncompatibleStore)
            ));
            fs::write(&receipt, &phase_receipt).unwrap();
        }
        for path in [&source_entry, &source_helper, &target_helper] {
            let bytes = fs::read(path).unwrap();
            fs::write(path, b"changed installed package").unwrap();
            assert!(
                publish_intended_isolated_service_trial(home.clone(), UPDATE.into())
                    .await
                    .is_err()
            );
            assert_eq!(fs::read(&receipt).unwrap(), phase_receipt);
            fs::write(path, bytes).unwrap();
        }
        if cancel_before_rename {
            interrupt_move("rollback", "sealed-phase-rolling-back-durable");
            if boundary == Some("intended-preserved") {
                interrupt_move("rollback", "intended-rollback-unlinked");
            }
            interrupt_move("rollback", "sealed-phase-rolled-back-durable");
            assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
            assert_eq!(fs::metadata(&trial).unwrap().ino(), trial_identity.ino());
            assert!(!original.exists());
            assert!(!failed.exists());
        } else {
            let publication = publish_intended_isolated_service_trial(home.clone(), UPDATE.into())
                .await
                .unwrap();
            assert_eq!(publication.database, prepared.database);
            assert_eq!(fs::metadata(&live).unwrap().ino(), trial_identity.ino());
            assert_eq!(fs::read(&live).unwrap(), trial_bytes);
            assert_eq!(fs::read(&original).unwrap(), source_bytes);
            assert_eq!(fs::metadata(&original).unwrap().ino(), source_inode);
            let sealed = Store::open_read_only(&live).await.unwrap();
            assert!(matches!(
                ApplicationTransactions::new(sealed.clone()).schema().await,
                Err(Error::IncompatibleStore)
            ));
            sealed.shutdown().await.unwrap();
            assert!(
                publish_intended_isolated_service_trial(home.clone(), UPDATE.into())
                    .await
                    .unwrap()
                    .reused
            );
            if let Some(executable) = std::env::var_os("T3_TEST_PROMOTION_HELPER") {
                let output = std::process::Command::new(executable)
                    .arg("trial-publish-intended-sealed")
                    .arg(&home)
                    .arg(UPDATE)
                    .env_clear()
                    .output()
                    .unwrap();
                assert!(output.status.success());
                let frame: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(frame["ok"], true);
                assert_eq!(frame["result"]["reused"], true);
                assert!(output.stderr.is_empty());
            }
            interrupt_move("rollback", "isolated-rollback-preserved");
            interrupt_move("rollback", "isolated-rollback-renamed");
            interrupt_move("rollback", "sealed-phase-rolled-back-durable");
            assert_eq!(fs::read(&failed).unwrap(), trial_bytes);
            assert_eq!(fs::metadata(&failed).unwrap().ino(), trial_identity.ino());
        }
        assert!(
            rollback_isolated_service_trial(home.clone(), UPDATE.into())
                .await
                .unwrap()
                .reused
        );
        assert_eq!(fs::read(&live).unwrap(), source_bytes);
        assert_eq!(fs::metadata(&live).unwrap().ino(), source_inode);
        assert_eq!(fs::metadata(&live).unwrap().nlink(), 1);
        assert_eq!(fs::read(&selection).unwrap(), selection_bytes);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
        let terminal: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        assert_eq!(terminal["sealed_publication"]["phase"], "rolled_back");
        assert!(matches!(
            publish_intended_isolated_service_trial(home.clone(), UPDATE.into()).await,
            Err(Error::IncompatibleStore)
        ));
        assert!(matches!(
            publish_isolated_service_trial(home.clone(), UPDATE.into()).await,
            Err(Error::IncompatibleStore)
        ));
        return;
    }
    record_isolated_candidate_preparation(home.clone(), UPDATE.into(), observation)
        .await
        .unwrap();
    assert_eq!(
        fs::read(&receipt).unwrap(),
        durable_receipt,
        "observation retry must preserve the intent"
    );
    assert!(matches!(
        publish_isolated_service_trial(home.clone(), UPDATE.into()).await,
        Err(Error::IncompatibleStore)
    ));
    let mut wrong = intent.clone();
    wrong.source_helper_schema_sha256 = "0".repeat(64);
    assert!(matches!(
        record_native_promotion_intent(home.clone(), UPDATE.into(), wrong).await,
        Err(Error::IncompatibleStore)
    ));
    for path in [&source_entry, &source_helper, &target_helper] {
        let original = fs::read(path).unwrap();
        fs::write(path, b"changed artifact").unwrap();
        assert!(matches!(record().await, Err(Error::IncompatibleStore)));
        assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
        fs::write(path, original).unwrap();
    }
    fs::set_permissions(&source_entry, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(record().await, Err(Error::IncompatibleStore)));
    assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
    fs::set_permissions(&source_entry, fs::Permissions::from_mode(0o700)).unwrap();
    let mut corrupted: Value = serde_json::from_slice(&durable_receipt).unwrap();
    corrupted["promotion_intent"]["version"] = json!(2);
    let corrupted_bytes = serde_json::to_vec(&corrupted).unwrap();
    fs::write(&receipt, &corrupted_bytes).unwrap();
    assert!(matches!(record().await, Err(Error::IncompatibleStore)));
    assert_eq!(fs::read(&receipt).unwrap(), corrupted_bytes);
    fs::write(&receipt, &durable_receipt).unwrap();
    let moved = state.join("held-stage.omdb");
    fs::rename(&trial, &moved).unwrap();
    assert!(record().await.is_err());
    fs::rename(&moved, &trial).unwrap();
    let mut changed_selection: Value = serde_json::from_slice(&selection_bytes).unwrap();
    changed_selection["update"]["status"] = json!("committed");
    fs::write(&selection, serde_json::to_vec(&changed_selection).unwrap()).unwrap();
    assert!(matches!(record().await, Err(Error::IncompatibleStore)));
    fs::write(&selection, &selection_bytes).unwrap();
    assert_eq!(record().await.unwrap()["reused"], true);
    assert_eq!(fs::read(&live).unwrap(), source_bytes);
    assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
    assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
    assert_eq!(fs::read(&selection).unwrap(), selection_bytes);
    assert_eq!(fs::read(&receipt).unwrap(), durable_receipt);
    use std::os::unix::fs::MetadataExt;
    assert_eq!(fs::metadata(&trial).unwrap().ino(), trial_identity.ino());
    let sealed = Store::open_read_only(&trial).await.unwrap();
    assert!(matches!(
        ApplicationTransactions::new(sealed.clone()).schema().await,
        Err(Error::IncompatibleStore)
    ));
    sealed.shutdown().await.unwrap();
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct PreviousReceipt {
        request: serde_json::Value,
        preparation: serde_json::Value,
        candidate_observation: serde_json::Value,
    }
    assert!(serde_json::from_slice::<PreviousReceipt>(&durable_receipt).is_err());
    println!(
        "T05 promotion intent durable retry preserved source, checkpoint, stage and selection without publication"
    );
}

#[cfg(target_os = "linux")]
async fn forward_commit_fixture(home: &std::path::Path, case: ForwardCommitCase) {
    use crate::application_storage::{
        IsolatedTrialVerification, TrialRestorePhase, TrialRestoreRequest, backup_service_trial,
        publish_intended_isolated_service_trial, record_fixture_forward_commit,
        record_fixture_forward_selection,
    };
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    let state = home.join("userdata");
    let receipt = state.join(format!(".statev2-trial-{ISOLATED_UPDATE}.receipt-v1.json"));
    let live = state.join("statev2.omdb");
    let original = state.join(format!(".statev2-source-{ISOLATED_UPDATE}.omdb"));
    let failed = state.join(format!(".statev2-failed-sealed-{ISOLATED_UPDATE}.omdb"));
    let checkpoint = home.join(format!("runtime/native-db-backup/{ISOLATED_UPDATE}.omdb"));
    let selection = home.join("runtime/service-state.json");
    let helper_path = |version| {
        home.join("runtime/versions")
            .join(version)
            .join("native-bin/t3-code-ls-db")
    };
    let source_helper = helper_path("1.2.3");
    let target_helper = helper_path("1.2.4");
    let catalog_case = matches!(case, ForwardCommitCase::CatalogFences);
    let generic_update = if catalog_case {
        "ba212c2b-63d4-4b28-97e4-1c1d6dc6d281"
    } else {
        ISOLATED_UPDATE
    };
    let run = |helper: &Path, mode: &str, input: Option<Value>| {
        let update = match mode {
            "trial-prepare-restore" | "trial-publish-restore-offline" => generic_update,
            _ => ISOLATED_UPDATE,
        };
        run_forward_helper(helper, home, update, mode, input.as_ref())
    };
    let capture = |path: &Path| capture_forward_file(path).unwrap();
    let source = capture(&live);
    let checkpoint_before = capture(&checkpoint);
    let selection_before = capture(&selection);
    let pending: IsolatedTrialVerification =
        serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    if catalog_case {
        backup_service_trial(
            home.to_owned(),
            generic_update.into(),
            pending.request.checkpoint.catalog_sha256.clone(),
        )
        .await
        .unwrap();
    }
    let mut legacy_request = TrialRestoreRequest {
        update_id: generic_update.into(),
        phase: TrialRestorePhase::FailedBeforeActivation,
        database: pending.request.database,
        target: pending.request.checkpoint.clone(),
        checkpoint: pending.request.checkpoint,
    };
    let stage = state.join(format!(".statev2-restore-{generic_update}.omdb"));
    let legacy_preparation = if matches!(
        case,
        ForwardCommitCase::InterruptAfterDurable | ForwardCommitCase::CatalogFences
    ) {
        let frame = run(
            &source_helper,
            "trial-prepare-restore",
            Some(json!(legacy_request)),
        );
        assert_eq!(frame["ok"], true, "{frame}");
        Some((frame["result"].clone(), capture(&stage)))
    } else {
        None
    };

    publish_intended_isolated_service_trial(home.to_owned(), ISOLATED_UPDATE.into())
        .await
        .unwrap();
    assert_eq!(capture(&original), source);
    let sealed = capture(&live);
    let published = capture(&receipt);
    let decide = || record_fixture_forward_commit(home.to_owned(), ISOLATED_UPDATE.into());
    let select = || record_fixture_forward_selection(home.to_owned(), ISOLATED_UPDATE.into());
    assert!(matches!(select().await, Err(Error::IncompatibleStore)));
    let boundary = match case {
        ForwardCommitCase::RefuseSourceWithoutFence
        | ForwardCommitCase::RefuseTargetWithoutFence => {
            assert!(matches!(decide().await, Err(Error::IncompatibleStore)));
            assert_eq!(capture(&receipt), published);
            assert_eq!(capture(&live), sealed);
            assert_eq!(capture(&original), source);
            assert_eq!(capture(&checkpoint), checkpoint_before);
            assert_eq!(capture(&selection), selection_before);
            assert!(!failed.exists());
            return;
        }
        ForwardCommitCase::InterruptBeforeWrite => "forward-commit-prewrite",
        ForwardCommitCase::InterruptAfterDurable | ForwardCommitCase::CatalogFences => {
            "forward-commit-durable"
        }
    };
    let interrupt = |boundary: &str, action: Option<&str>| {
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .arg("application_bootstrap::upgrade::tests::isolated_trial_publish_interrupt_fixture")
            .arg("--exact")
            .env("T3_TEST_ISOLATED_TRIAL_HOME", home)
            .env("T3_TEST_INTERRUPT_TRIAL_PUBLICATION", boundary)
            .env_remove("T3_TEST_INTENDED_MOVE");
        if let Some(action) = action {
            child.env("T3_TEST_INTENDED_MOVE", action);
        }
        let output = child.output().unwrap();
        assert_eq!(output.status.code(), Some(73), "{boundary}: {output:?}");
    };
    interrupt(boundary, None);
    if matches!(case, ForwardCommitCase::InterruptBeforeWrite) {
        assert_eq!(capture(&receipt), published);
        assert_eq!(capture(&live), sealed);
        interrupt("isolated-rollback-preserved", Some("rollback"));
        let rollback = run(&source_helper, "trial-rollback-sealed", None);
        assert_eq!(rollback["ok"], true, "{rollback}");
        assert_eq!(capture(&live), source);
        assert_eq!(capture(&failed), sealed);
        assert!(!original.exists());
        assert!(matches!(decide().await, Err(Error::IncompatibleStore)));
        assert_eq!(capture(&selection), selection_before);
    } else {
        let durable = capture(&receipt);
        let decoded: Value = serde_json::from_slice(&durable.3).unwrap();
        assert_eq!(decoded["sealed_publication"]["phase"], "forward_committed");
        assert!(
            decide().await.unwrap(),
            "retry must report the existing decision"
        );

        let (preparation, stage_before) = legacy_preparation.unwrap();
        legacy_request.database = pending.preparation.database;
        legacy_request.target = pending.preparation.snapshot;
        let generic_publication = json!({
            "restore": legacy_request,
            "preparation": preparation,
            "witness": { "kind": "offline-pre-activation", "target_file_sha256": pending.preparation.file_sha256 }
        });
        let assert_restore_refused = || {
            for helper in [&source_helper, &target_helper] {
                for (command, input) in [
                    ("trial-rollback-sealed", None),
                    ("trial-prepare-restore", Some(json!(legacy_request))),
                    (
                        "trial-publish-restore-offline",
                        Some(generic_publication.clone()),
                    ),
                    ("trial-publish-intended-sealed", None),
                ] {
                    let frame = run(helper, command, input);
                    assert_eq!(frame["ok"], false, "{command}: {frame}");
                    assert_eq!(
                        frame["error"]["kind"], "incompatible_store",
                        "{command}: {frame}"
                    );
                }
            }
        };
        assert_restore_refused();
        for helper in [&source_helper, &target_helper] {
            let bytes = fs::read(helper).unwrap();
            fs::write(helper, b"changed installed helper").unwrap();
            assert!(matches!(decide().await, Err(Error::IncompatibleStore)));
            assert!(matches!(select().await, Err(Error::IncompatibleStore)));
            fs::write(helper, bytes).unwrap();
        }
        let mut changed_selection = selection_before.3.clone();
        changed_selection.push(b'\n');
        fs::write(&selection, changed_selection).unwrap();
        assert!(matches!(decide().await, Err(Error::IncompatibleStore)));
        assert!(matches!(select().await, Err(Error::IncompatibleStore)));
        fs::write(&selection, &selection_before.3).unwrap();
        let moved = state.join("fixture-held-candidate.omdb");
        fs::rename(&live, &moved).unwrap();
        fs::write(&live, &sealed.3).unwrap();
        assert!(matches!(decide().await, Err(Error::IncompatibleStore)));
        assert!(matches!(select().await, Err(Error::IncompatibleStore)));
        fs::rename(moved, &live).unwrap();
        assert!(decide().await.unwrap());

        interrupt("forward-selection-written", None);
        assert_eq!(capture(&selection), selection_before);
        assert_eq!(capture(&receipt), durable);
        interrupt("forward-selection-renamed", None);
        let selected = capture(&selection);
        assert_ne!(selected.1, selection_before.1);
        let mut expected: Value = serde_json::from_slice(&selection_before.3).unwrap();
        expected["activeVersion"] = json!("1.2.4");
        expected["phase"] = json!("forward-selected");
        expected["forwardReceiptSha256"] = json!(forward_fixture_sha256(&durable.3));
        assert_eq!(
            serde_json::from_slice::<Value>(&selected.3).unwrap(),
            expected
        );
        interrupt("forward-selection-durable", None);
        assert!(select().await.unwrap());
        assert_eq!(capture(&selection), selected);
        assert_restore_refused();

        for changed in [
            b"{".to_vec(),
            [selected.3.as_slice(), b"\n"].concat(),
            serde_json::to_vec(&{
                let mut foreign = expected;
                foreign["forwardReceiptSha256"] = json!("0".repeat(64));
                foreign
            })
            .unwrap(),
        ] {
            fs::write(&selection, &changed).unwrap();
            assert!(matches!(select().await, Err(Error::IncompatibleStore)));
            assert_eq!(fs::read(&selection).unwrap(), changed);
        }
        fs::write(&selection, &selected.3).unwrap();
        assert!(select().await.unwrap());
        assert_eq!(capture(&selection), selected);

        let store = Store::open_read_only(&live).await.unwrap();
        assert!(matches!(
            ApplicationTransactions::new(store.clone()).schema().await,
            Err(Error::IncompatibleStore)
        ));
        store.shutdown().await.unwrap();
        assert_eq!(capture(&receipt), durable);
        assert_eq!(capture(&live), sealed);
        assert_eq!(capture(&original), source);
        assert_eq!(capture(&stage), stage_before);
        assert_eq!(capture(&selection), selected);
        assert!(!failed.exists());
        assert!(
            !state
                .join(format!(".statev2-failed-{ISOLATED_UPDATE}.omdb"))
                .exists()
        );
        println!("T05 forward selection recovered without unsealing or allowing restore");
        if catalog_case {
            forward_catalog_fixture(
                home,
                &selected.3,
                &legacy_request,
                &generic_publication["preparation"],
                [&source_helper, &target_helper],
            )
            .await;
            assert_eq!(capture(&receipt), durable);
            assert_eq!(capture(&original), source);
            assert_eq!(capture(&selection), selected);
            assert!(!failed.exists());
        }
    }
    assert_eq!(capture(&checkpoint), checkpoint_before);
}

#[cfg(target_os = "linux")]
fn run_forward_helper(
    helper: &std::path::Path,
    home: &std::path::Path,
    update: &str,
    mode: &str,
    input: Option<&Value>,
) -> Value {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new(helper)
        .arg(mode)
        .arg(home)
        .arg(update)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(input).unwrap())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{mode}: {:?}", output.status);
    assert!(output.stderr.is_empty(), "{mode}: {:?}", output.stderr);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[cfg(target_os = "linux")]
fn forward_fixture_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(target_os = "linux")]
fn capture_forward_file(path: &std::path::Path) -> Option<(u64, u64, u64, Vec<u8>)> {
    use std::{fs, io::ErrorKind, os::unix::fs::MetadataExt};

    match fs::metadata(path) {
        Ok(metadata) => Some((
            metadata.dev(),
            metadata.ino(),
            metadata.nlink(),
            fs::read(path).unwrap(),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => panic!("cannot capture {}: {error}", path.display()),
    }
}

#[cfg(target_os = "linux")]
async fn forward_catalog_fixture(
    home: &std::path::Path,
    selection: &[u8],
    request: &crate::application_storage::TrialRestoreRequest,
    preparation: &Value,
    helpers: [&std::path::Path; 2],
) {
    use crate::application_rows::text_cell;
    use crate::application_server_ownership::OwnerLock;
    use crate::application_storage::{TrialRestorePreparation, TrialSnapshot};
    use std::fs;

    let state = home.join("userdata");
    let live = state.join("statev2.omdb");
    let update = &request.update_id;
    let checkpoint = home.join(format!("runtime/native-db-backup/{update}.omdb"));
    let stage = state.join(format!(".statev2-restore-{update}.omdb"));
    let draft = stage.with_extension("staging");
    let parked = stage.with_extension("saved");
    let preserved = state.join(format!(".statev2-failed-{update}.omdb"));
    let paths = [&live, &stage, &draft, &parked, &preserved, &checkpoint];
    let capture = || paths.map(|path| capture_forward_file(path));
    let sha256 = forward_fixture_sha256(selection);

    // Only this disposable fixture changes the catalog. The actual transition
    // needs a writable handoff from the locked offline snapshot.
    let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite")).unwrap();
    let store = Store::open_exclusive(&live).await.unwrap();
    let mut tx = store.db.begin().await.unwrap();
    let bytes = tx.get(&schema_key()).await.unwrap().unwrap();
    let sealed = decode_catalog(&bytes).unwrap();
    assert_eq!(
        sealed
            .prepared_service_activation_v1
            .as_ref()
            .unwrap()
            .update_id,
        ISOLATED_UPDATE
    );
    let mut marked = serde_json::to_value(&sealed).unwrap();
    marked
        .as_object_mut()
        .unwrap()
        .remove("prepared_service_activation_v1");
    marked["forward_service_activation_v1"] = json!({
        "update_id": ISOLATED_UPDATE,
        "forward_selection_sha256": sha256,
    });
    let bytes = serde_json::to_vec(&marked).unwrap();
    record_generation_identity(&mut tx, &sealed, &bytes)
        .await
        .unwrap();
    tx.put(schema_key(), bytes.clone()).await.unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(
        store.bootstrap_application().await,
        Err(Error::IncompatibleStore)
    ));
    let mut transactions = ApplicationTransactions::new(store.clone());
    assert!(matches!(
        transactions.begin("serving").await,
        Err(Error::IncompatibleStore)
    ));
    drop(transactions);

    let table = "pull_request_review_guides";
    let guide = [
        text_cell("fixture.invalid"),
        text_cell("fixture/review"),
        int_cell(1),
    ];
    let key = row_key(&sealed.generation, table, &guide).unwrap();
    let mut later = store.db.begin().await.unwrap();
    write_row(
        &mut later,
        &sealed,
        table,
        Map::from_iter([
            ("host".into(), guide[0].clone()),
            ("repository".into(), guide[1].clone()),
            ("number".into(), guide[2].clone()),
            ("guide_json".into(), text_cell("{\"fixture\":\"later\"}")),
        ]),
    )
    .await
    .unwrap();
    later.commit().await.unwrap();
    owner.verify_native().unwrap();
    store.shutdown().await.unwrap();
    drop(owner);

    let read = Store::open_read_only(&live).await.unwrap();
    let (catalog, identity) = ApplicationTransactions::new(read.clone())
        .catalog_and_identity()
        .await
        .expect("the compatible reader must reopen the forward catalog")
        .unwrap();
    assert_eq!(serde_json::to_value(&catalog).unwrap(), marked);
    assert_eq!(
        serde_json::to_value(target_89(&catalog, &definition().unwrap())).unwrap()["forward_service_activation_v1"],
        marked["forward_service_activation_v1"]
    );
    let identity = identity.unwrap();
    assert_eq!(identity.catalog_sha256, forward_fixture_sha256(&bytes));
    assert!(catalog.ensure_serving().is_err());
    let later_guide = read.db.read(&key).await.unwrap().unwrap();
    let fingerprint = read.db.bounded_storage_fingerprint().await.unwrap();
    read.shutdown().await.unwrap();
    let marked_snapshot = TrialSnapshot {
        catalog_sha256: identity.catalog_sha256,
        rows: fingerprint.rows,
        checksum: fingerprint.checksum,
    };
    let marked_file = capture_forward_file(&live).unwrap();
    assert_eq!(format!("{:016x}", marked_file.0), request.database.device);
    assert_eq!(format!("{:016x}", marked_file.1), request.database.inode);
    assert_eq!(marked_file.2, 1);
    let marked_sha256 = forward_fixture_sha256(&marked_file.3);
    let mut marked_target = request.clone();
    marked_target.target = marked_snapshot.clone();
    let marked_target_publication = json!({
        "restore": marked_target,
        "preparation": preparation,
        "witness": { "kind": "offline-pre-activation", "target_file_sha256": marked_sha256 },
    });
    let assert_refused = |mode, update, error, input: Option<&Value>| {
        let before = capture();
        for helper in helpers {
            let frame = run_forward_helper(helper, home, update, mode, input);
            assert_eq!(frame["ok"], false, "{helper:?} {mode}: {frame}");
            assert_eq!(frame["error"]["kind"], error, "{helper:?} {mode}: {frame}");
            assert_eq!(capture(), before, "{helper:?} {mode} changed fixture files");
        }
    };
    let prepare = |input| {
        assert_refused(
            "trial-prepare-restore",
            update,
            "incompatible_store",
            Some(input),
        )
    };
    let publish =
        |input, error| assert_refused("trial-publish-restore-offline", update, error, Some(input));
    let prepare_request = json!(marked_target);
    assert_refused(
        "trial-rollback-sealed",
        ISOLATED_UPDATE,
        "incompatible_store",
        None,
    );
    prepare(&prepare_request);
    publish(&marked_target_publication, "incompatible_store");
    fs::rename(&stage, &parked).unwrap();
    prepare(&prepare_request);
    fs::rename(&parked, &stage).unwrap();

    // The first interrupted layout still has a stage and two links to the target.
    fs::hard_link(&live, &preserved).unwrap();
    publish(&marked_target_publication, "incompatible_store");
    fs::remove_file(&live).unwrap();
    fs::rename(&stage, &live).unwrap();
    // After rename the marked failed target is read under its preserved name.
    publish(&marked_target_publication, "unknown_commit");
    fs::rename(&live, &stage).unwrap();
    fs::rename(&preserved, &live).unwrap();

    // In the alternate retry layout the preserved target is plain. The canonical
    // prepared file and the independent checkpoint have the same marked snapshot.
    let plain_preparation: TrialRestorePreparation =
        serde_json::from_value(preparation.clone()).unwrap();
    let plain_stage = capture_forward_file(&stage).unwrap();
    assert_eq!(
        forward_fixture_sha256(&plain_stage.3),
        plain_preparation.staged_file_sha256
    );
    let plain_checkpoint = capture_forward_file(&checkpoint).unwrap();
    fs::write(&checkpoint, &marked_file.3).unwrap();
    let marked_prepared_publication = json!({
        "restore": {
            "update_id": update,
            "phase": "failed-before-activation",
            "database": plain_preparation.staged_database,
            "checkpoint": marked_snapshot,
            "target": request.checkpoint,
        },
        "preparation": {
            "staged_database": request.database,
            "staged_file_sha256": marked_sha256,
            "reused": false,
        },
        "witness": {
            "kind": "offline-pre-activation",
            "target_file_sha256": plain_preparation.staged_file_sha256,
        }
    });
    fs::rename(&stage, &preserved).unwrap();
    publish(&marked_prepared_publication, "unknown_commit");
    fs::rename(&live, &stage).unwrap();
    fs::rename(&preserved, &live).unwrap();
    publish(&marked_prepared_publication, "incompatible_store");
    fs::rename(&stage, &parked).unwrap();
    prepare(&marked_prepared_publication["restore"]);
    fs::rename(&parked, &stage).unwrap();

    // Restore the synthetic layout and confirm the later application row by key.
    fs::rename(&live, &parked).unwrap();
    fs::rename(&stage, &live).unwrap();
    fs::rename(&parked, &stage).unwrap();
    fs::write(&checkpoint, &plain_checkpoint.3).unwrap();
    assert_eq!(capture_forward_file(&checkpoint).unwrap(), plain_checkpoint);
    assert_eq!(capture_forward_file(&live).unwrap(), marked_file);
    let read = Store::open_read_only(&live).await.unwrap();
    assert_eq!(read.db.read(&key).await.unwrap().unwrap(), later_guide);
    read.shutdown().await.unwrap();
    println!("T05 forward catalog fenced both installed helpers across generic restore retries");
}
