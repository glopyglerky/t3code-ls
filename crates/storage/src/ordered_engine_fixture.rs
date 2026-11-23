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

fn comparison_error(error: Error) -> crate::Error {
    match error {
        Error::UnknownCommit(_) => crate::Error::UnknownCommit,
        _ => crate::Error::Database("ordered comparison operation failed".into()),
    }
}

impl From<Error> for crate::Error {
    fn from(error: Error) -> Self {
        comparison_error(error)
    }
}

impl crate::backend::CommitTable for redb_bench_compare::ordered::WriteTransaction {
    fn matches(&self, key: &[u8], expected: Option<&[u8]>) -> crate::Result<bool> {
        Ok(self.get(key).map_err(comparison_error)?.as_deref() == expected)
    }

    fn fingerprint(&self, key: &[u8]) -> crate::Result<Option<(usize, [u8; 32])>> {
        Ok(self
            .get(key)
            .map_err(comparison_error)?
            .as_deref()
            .map(crate::backend::fingerprint))
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> crate::Result<Vec<(Vec<u8>, Vec<u8>)>> {
        self.scan(start, end, limit).map_err(comparison_error)
    }

    fn put(&mut self, key: &[u8], value: &[u8]) -> crate::Result<()> {
        self.put(key, value).map_err(comparison_error)
    }

    fn delete(&mut self, key: &[u8]) -> crate::Result<()> {
        self.delete(key).map_err(comparison_error)
    }
}

#[tokio::test]
async fn ordered_engines_apply_an_uncommitted_application_command()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::backend::apply_staged;

    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    assert!(store.bootstrap_application().await?.initialized);
    assert!(store.prepare_application_events().await?.prepared);
    assert!(store.prepare_application_receipts().await?.prepared);
    let (start, end) = prefix_range("");
    let mut initial = store.db.begin_read_only().await?;
    let seed = initial.scan(&start, &end, MAX_FIXTURE_ROWS + 1).await?;
    assert!(seed.len() <= MAX_FIXTURE_ROWS);
    assert!(seed.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() < MAX_FIXTURE_BYTES);
    initial.rollback().await?;

    let mut app = ApplicationTransactions::new(store.clone());
    app.begin("prepare").await?;
    let receipt = ReceiptRow {
        command_id: COMMAND.into(),
        aggregate_kind: "thread".into(),
        aggregate_id: THREAD.into(),
        command_type: "fixture.command".into(),
        accepted_at: TIME.into(),
        result_sequence: 3,
        status: "accepted".into(),
        error: None,
    };
    assert!(app.receipts_insert("prepare", receipt).await?);
    for sequence in 1..=3 {
        app.events_append("prepare", event(sequence), None).await?;
    }
    let expected_receipt = app
        .get("prepare", RECEIPTS, &[text_cell(COMMAND)])
        .await?
        .unwrap();
    let mut expected_events = Vec::new();
    for sequence in 1..=3 {
        expected_events.push(
            app.get("prepare", EVENTS, &[int_cell(sequence)])
                .await?
                .unwrap(),
        );
    }
    // This consumes staged domain work and ABORTS the source reservation. It
    // exports no committed command and does not mirror a production commit.
    let staged = app.stage_for_comparison("prepare").await?;
    app.begin_mode("verify", ApplicationTransactionMode::Read, None)
        .await?;
    assert!(app.receipts_get("verify", COMMAND).await?.is_none());
    assert!(app.get("verify", EVENTS, &[int_cell(3)]).await?.is_none());
    app.rollback("verify").await?;
    drop(app);
    let mut unchanged = store.db.begin_read_only().await?;
    assert_eq!(
        unchanged.scan(&start, &end, MAX_FIXTURE_ROWS + 1).await?,
        seed
    );
    unchanged.rollback().await?;
    store.shutdown().await?;

    let catalog_bytes = seed
        .iter()
        .find(|(key, _)| *key == schema_key())
        .unwrap()
        .1
        .clone();
    let catalog = decode_catalog(&catalog_bytes)?;
    for (engine, name) in [
        (Engine::Fjall, "command.fjall"),
        (Engine::DirectRedb, "command.redb"),
    ] {
        let path = fixture.path().with_file_name(name);
        let comparison = Database::open(engine, &path)?;
        comparison.write(|transaction| {
            for (key, value) in &seed {
                transaction.put(key, value)?;
            }
            Ok::<_, Error>(())
        })?;
        // Abort after the application commit seam has staged the whole group.
        let aborted = comparison.write(|transaction| {
            apply_staged(transaction, staged.clone())?;
            Err::<(), _>(crate::Error::Invalid("injected abort after apply".into()))
        });
        assert!(matches!(aborted, Err(crate::Error::Invalid(_))));
        assert_eq!(
            comparison
                .snapshot()?
                .scan(&start, &end, MAX_FIXTURE_ROWS + 1)?,
            seed
        );
        let old = comparison.snapshot()?;
        // A separate writer commits while a real engine snapshot remains open.
        let command = staged.clone();
        let comparison = std::thread::spawn(move || {
            comparison.write(|transaction| apply_staged(transaction, command))?;
            Ok::<_, crate::Error>(comparison)
        })
        .join()
        .expect("comparison writer panicked")?;
        assert_eq!(old.scan(&start, &end, MAX_FIXTURE_ROWS + 1)?, seed);
        drop(old);
        // The unchanged old observations cannot commit against the new state.
        assert!(matches!(
            comparison.write(|transaction| apply_staged(transaction, staged.clone())),
            Err(crate::Error::TransactionConflict)
        ));
        drop(comparison);
        let reopened = Database::open(engine, &path)?;
        let snapshot = reopened.snapshot()?;
        assert_eq!(snapshot.get(&schema_key())?, Some(catalog_bytes.clone()));
        let expected_rows =
            std::iter::once((RECEIPTS, vec![text_cell(COMMAND)], &expected_receipt)).chain(
                expected_events
                    .iter()
                    .enumerate()
                    .map(|(index, row)| (EVENTS, vec![int_cell(index as i64 + 1)], row)),
            );
        for (name, key, expected) in expected_rows {
            let key_bytes = row_key(&catalog.generation, name, &key)?;
            let bytes = snapshot.get(&key_bytes)?.unwrap();
            let row = decode_row(&catalog, table(&catalog, name)?, &key_bytes, &bytes)?;
            assert_eq!(row.key, key);
            assert_eq!(&row.row, expected);
        }
        let history = snapshot.scan(&history_key(1), &history_key(4), 8)?;
        assert_eq!(
            history
                .iter()
                .map(|(_, value)| serde_json::from_slice::<u64>(value).unwrap())
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(snapshot.get(&history_key(4))?.is_none());
    }
    Ok(())
}

#[tokio::test]
async fn ordered_engines_decode_application_reads_from_a_held_candidate_snapshot()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    store.bootstrap_application().await?;
    store.prepare_application_events().await?;
    store.prepare_application_receipts().await?;
    let mut app = ApplicationTransactions::new(store.clone());
    let receipt = ReceiptRow {
        command_id: COMMAND.into(),
        aggregate_kind: "thread".into(),
        aggregate_id: THREAD.into(),
        command_type: "fixture.command".into(),
        accepted_at: TIME.into(),
        result_sequence: 3,
        status: "accepted".into(),
        error: None,
    };
    app.begin("seed").await?;
    assert!(app.receipts_insert("seed", receipt.clone()).await?);
    for sequence in 1..=3 {
        app.events_append("seed", event(sequence), None).await?;
    }
    app.commit("seed").await?;
    let (start, end) = prefix_range("");
    let mut source = store.db.begin_read_only().await?;
    let seed = source.scan(&start, &end, MAX_FIXTURE_ROWS + 1).await?;
    assert!(seed.len() <= MAX_FIXTURE_ROWS);
    assert!(seed.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() < MAX_FIXTURE_BYTES);
    source.rollback().await?;
    let catalog = decode_catalog(&seed.iter().find(|(k, _)| *k == schema_key()).unwrap().1)?;
    let receipt_key = row_key(&catalog.generation, RECEIPTS, &[text_cell(COMMAND)])?;
    let missing = store_key("comparison/missing");
    // Make the source differ from the candidate seed. Candidate reads must
    // return the seeded result, even while the helper retains a source handle.
    app.begin("source-only").await?;
    let mut source_receipt = receipt.clone();
    source_receipt.result_sequence = 99;
    app.receipts_upsert("source-only", source_receipt).await?;
    app.commit("source-only").await?;

    for (engine, name) in [
        (Engine::Fjall, "snapshot.fjall"),
        (Engine::DirectRedb, "snapshot.redb"),
    ] {
        let comparison = Database::open(engine, &fixture.path().with_file_name(name))?;
        comparison.write(|tx| {
            for (key, value) in &seed {
                tx.put(key, value)?;
            }
            Ok::<_, Error>(())
        })?;
        app.begin_comparison_read("held", comparison.snapshot()?)
            .await?;
        assert!(!app.has_active_writer());
        assert!(
            app.begin_comparison_read("held", comparison.snapshot()?)
                .await
                .is_err()
        );
        // No receipt/event read has occurred in this session yet. A later read
        // must use the held engine snapshot, rather than a fresh read or cache.
        let removed = receipt_key.clone();
        let comparison = std::thread::spawn(move || {
            comparison.write(|tx| tx.delete(&removed))?;
            Ok::<_, Error>(comparison)
        })
        .join()
        .expect("comparison writer panicked")?;
        assert_eq!(
            app.receipts_get("held", COMMAND).await?,
            Some(receipt.clone())
        );
        let history = app
            .events_read(
                "held",
                EventRead {
                    after_sequence: 0,
                    through_sequence: Some(3),
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
            [1, 2, 3]
        );
        for (index, row) in history.iter().enumerate() {
            assert_eq!(row.payload_json, event(index as i64 + 1).payload_json);
        }
        let mut session = app.take("held")?;
        assert_eq!(
            session
                .transaction
                .scan(&start, &end, MAX_FIXTURE_ROWS + 1)
                .await?,
            seed
        );
        let values = session
            .transaction
            .get_many(&[receipt_key.clone(), missing.clone(), receipt_key.clone()])
            .await?;
        assert!(values[0].is_some());
        assert_eq!(values[0], values[2]);
        assert_eq!(values[1], None);
        assert!(session.transaction.get_many(&[]).await?.is_empty());
        assert!(session.transaction.scan(&end, &start, 1).await.is_err());
        app.finish("held", session, Ok(())).await?;
        // Read-only savepoints use the same failure/rollback rules. No staged
        // write is admitted, so this does not claim candidate read-your-writes.
        app.savepoint("held", "nested").await?;
        assert!(matches!(
            app.receipts_upsert("held", receipt.clone()).await,
            Err(crate::Error::Invalid(_))
        ));
        assert!(app.receipts_get("held", COMMAND).await.is_err());
        app.rollback_to("held", "nested").await?;
        app.release("held", "nested").await?;
        assert_eq!(
            app.receipts_get("held", COMMAND).await?,
            Some(receipt.clone())
        );
        app.rollback("held").await?;
        assert!(app.receipts_get("held", COMMAND).await.is_err());
        app.begin_comparison_read("fresh", comparison.snapshot()?)
            .await?;
        assert_eq!(app.receipts_get("fresh", COMMAND).await?, None);
        app.commit("fresh").await?; // Read-only commit only releases the snapshot.
        assert_eq!(comparison.snapshot()?.get(&receipt_key)?, None);
        // Engine metadata is verified even on a catalog cache hit. These copied
        // bytes describe the source generation, never the comparison engine.
        let identity_key = store_key(&format!(
            "application/generation/{}/metadata/engine-layout",
            catalog.generation,
        ));
        comparison.write(|tx| tx.put(&identity_key, b"{}"))?;
        assert!(matches!(
            app.begin_comparison_read("bad-identity", comparison.snapshot()?)
                .await,
            Err(crate::Error::IncompatibleStore)
        ));
        let identity = &seed.iter().find(|(key, _)| *key == identity_key).unwrap().1;
        comparison.write(|tx| tx.put(&identity_key, identity))?;
        // Catalog decoding is shared too; a bad catalog cannot use the cache.
        comparison.write(|tx| tx.put(&schema_key(), b"invalid catalog"))?;
        assert!(matches!(
            app.begin_comparison_read("bad", comparison.snapshot()?)
                .await,
            Err(crate::Error::IncompatibleStore)
        ));
    }
    drop(app);
    store.shutdown().await?;
    Ok(())
}
