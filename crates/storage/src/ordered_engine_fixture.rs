use redb_bench_compare::ordered::{Database, Engine, Error, Snapshot};
use serde_json::json;

use crate::application::{
    ApplicationTransactionMode, ApplicationTransactions, decode_catalog, decode_row, row_key,
    schema_key, table,
};
use crate::application_events::{EVENTS, EventAppendRow, EventRead};
use crate::application_receipts::ReceiptRow;
use crate::application_rows::{int_cell, nullable_cell, text_cell};
use crate::test_support::TestFixture;
use crate::{prefix_range, request_digest, store_key};

const THREAD: &str = "thread:t04";
const COMMAND: &str = "command:t04";
const RECEIPTS: &str = "orchestration_command_receipts";
const TIME: &str = "2026-11-10T12:00:00.000Z";
const MAX_FIXTURE_ROWS: usize = 1024;
const MAX_FIXTURE_BYTES: usize = 1024 * 1024;

fn event(sequence: i64) -> EventAppendRow {
    EventAppendRow {
        event_id: format!("event:t04:{sequence}"),
        aggregate_kind: "thread".into(),
        stream_id: if sequence == 15 {
            "thread:other".into()
        } else {
            THREAD.into()
        },
        event_type: "provider-session.detached".into(),
        occurred_at: TIME.into(),
        command_id: (sequence != 15).then(|| COMMAND.into()),
        causation_event_id: None,
        correlation_id: None,
        actor_kind: "server".into(),
        payload_json: json!({
            "providerSessionId": format!("session:t04:{sequence}"),
            "detachedAt": TIME,
        })
        .to_string(),
        metadata_json: "{}".into(),
        application_event_version: 2,
    }
}

fn history_key(sequence: u64) -> Vec<u8> {
    let scope = request_digest(&json!([THREAD, COMMAND, null]));
    store_key(&format!(
        "application/generation/native/events/v1/index/application/3/{scope}/{sequence:016x}"
    ))
}

fn sequences(snapshot: &Snapshot, limit: usize) -> Vec<u64> {
    snapshot
        .scan(&history_key(14), &history_key(18), limit)
        .unwrap()
        .into_iter()
        .map(|(key, value)| {
            let sequence = serde_json::from_slice(&value).unwrap();
            assert_eq!(key, history_key(sequence));
            sequence
        })
        .collect()
}

#[tokio::test]
async fn ordered_engines_preserve_a_fresh_application_generation()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    assert!(store.bootstrap_application().await?.initialized);
    assert!(store.prepare_application_events().await?.prepared);
    assert!(store.prepare_application_receipts().await?.prepared);

    let mut app = ApplicationTransactions::new(store.clone());
    let identity = app.generation_identity().await?.unwrap();
    assert_eq!(identity.generation, "native");
    assert_eq!(identity.layout, "t3-application-keyspace-v1");
    let mut receipt = ReceiptRow {
        command_id: COMMAND.into(),
        aggregate_kind: "thread".into(),
        aggregate_id: THREAD.into(),
        command_type: "fixture.command".into(),
        accepted_at: TIME.into(),
        result_sequence: 0,
        status: "accepted".into(),
        error: None,
    };

    app.begin("write").await?;
    assert!(app.receipts_insert("write", receipt.clone()).await?);
    for sequence in 1..=18 {
        app.events_append("write", event(sequence), None).await?;
    }
    receipt.result_sequence = 18;
    app.receipts_upsert("write", receipt.clone()).await?;
    app.commit("write").await?;
    drop(app);
    store.shutdown().await?;

    // Sign off the fixture through the same domain APIs the database helper uses.
    let source = crate::Store::open_read_only(fixture.path()).await?;
    let mut app = ApplicationTransactions::new(source.clone());
    assert_eq!(app.generation_identity().await?, Some(identity));
    app.begin_mode("read", ApplicationTransactionMode::Read, None)
        .await?;
    assert_eq!(app.receipts_get("read", COMMAND).await?, Some(receipt));
    let history = app
        .events_read(
            "read",
            EventRead {
                after_sequence: 13,
                through_sequence: Some(17),
                thread_id: Some(THREAD.into()),
                command_id: Some(COMMAND.into()),
                event_type: None,
                only_agent_events: None,
                limit: 8,
            },
        )
        .await?;
    assert_eq!(
        history.iter().map(|row| row.sequence).collect::<Vec<_>>(),
        [14, 16, 17]
    );
    let mut typed_rows = Vec::new();
    for row in &history {
        let sequence = i64::try_from(row.sequence).unwrap();
        let input = event(sequence);
        assert_eq!(row.event_id, input.event_id);
        assert_eq!(row.payload_json, input.payload_json);
        assert_eq!(row.command_id.as_deref(), Some(COMMAND));
        typed_rows.push((EVENTS, vec![int_cell(sequence)]));
    }
    typed_rows.push((RECEIPTS, vec![text_cell(COMMAND)]));
    let mut expected_rows = Vec::new();
    for (name, key) in typed_rows {
        let row = app.get("read", name, &key).await?.unwrap();
        expected_rows.push((name, key, row));
    }
    let receipt_row = &expected_rows.last().unwrap().2;
    assert_eq!(receipt_row["result_sequence"], int_cell(18));
    assert_eq!(receipt_row["error"], nullable_cell(None));
    app.rollback("read").await?;
    drop(app);

    let (start, end) = prefix_range("");
    let mut snapshot = source.db.begin_read_only().await?;
    let rows = snapshot.scan(&start, &end, MAX_FIXTURE_ROWS + 1).await?;
    assert!(rows.len() <= MAX_FIXTURE_ROWS);
    assert_eq!(
        source.db.storage_fingerprint().await?.rows,
        rows.len() as u64
    );
    assert!(
        rows.iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            < MAX_FIXTURE_BYTES
    );
    let catalog_bytes = snapshot.get(&schema_key()).await?.unwrap();
    let catalog = decode_catalog(&catalog_bytes)?;
    let source_window = snapshot.scan(&history_key(14), &history_key(18), 8).await?;
    snapshot.rollback().await?;
    source.shutdown().await?;

    for (engine, name) in [
        (Engine::Fjall, "fjall"),
        (Engine::DirectRedb, "direct.redb"),
    ] {
        let path = fixture.path().with_file_name(name);
        let comparison = Database::open(engine, &path)?;
        let before = comparison.snapshot()?;
        assert!(before.scan(&start, &end, 1)?.is_empty());
        comparison.write(|transaction| {
            for (key, value) in &rows {
                transaction.put(key, value)?;
            }
            assert_eq!(
                transaction.scan(&history_key(14), &history_key(18), 8)?,
                source_window
            );
            assert!(before.scan(&start, &end, 1)?.is_empty());
            Ok::<_, Error>(())
        })?;
        assert!(before.scan(&start, &end, 1)?.is_empty());
        drop(before);
        drop(comparison);

        let reopened = Database::open(engine, &path)?;
        let snapshot = reopened.snapshot()?;
        assert_eq!(snapshot.scan(&start, &end, MAX_FIXTURE_ROWS + 1)?, rows);
        assert_eq!(snapshot.get(&schema_key())?, Some(catalog_bytes.clone()));
        assert_eq!(
            snapshot.scan(&history_key(14), &history_key(18), 8)?,
            source_window
        );
        assert_eq!(sequences(&snapshot, 8), [14, 16, 17]);
        assert_eq!(sequences(&snapshot, 2), [14, 16]);
        for (name, key, expected) in &expected_rows {
            let encoded_key = row_key(&catalog.generation, name, key)?;
            let value = snapshot.get(&encoded_key)?.unwrap();
            let decoded = decode_row(&catalog, table(&catalog, name)?, &encoded_key, &value)?;
            assert_eq!(&decoded.key, key);
            assert_eq!(&decoded.row, expected);
        }
        assert!(snapshot.get(&history_key(15))?.is_none());
        let exclusive_end = snapshot.get(&history_key(18))?.unwrap();
        assert_eq!(serde_json::from_slice::<u64>(&exclusive_end)?, 18);
    }
    Ok(())
}
