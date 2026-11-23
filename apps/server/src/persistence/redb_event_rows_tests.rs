use super::*;
use crate::application::{ApplicationSchema, ApplicationTable};
use crate::test_support::TestFixture;

fn schema() -> ApplicationSchema {
    ApplicationSchema {
        version: 1,
        tables: vec![
            ApplicationTable {
                name: EVENTS.into(),
                columns: COLUMNS.iter().map(|value| (*value).into()).collect(),
                primary_key: vec!["sequence".into()],
            },
            ApplicationTable {
                name: METADATA.into(),
                columns: [
                    "projection_name",
                    "schema_version",
                    "last_sequence",
                    "updated_at",
                ]
                .map(str::to_owned)
                .to_vec(),
                primary_key: vec!["projection_name".into()],
            },
        ],
    }
}

fn row(id: &str, stream: &str) -> EventAppendRow {
    EventAppendRow {
        event_id: id.into(),
        aggregate_kind: "thread".into(),
        stream_id: stream.into(),
        event_type: "thread.created".into(),
        occurred_at: "2026-11-10T00:00:00.000Z".into(),
        command_id: Some("command".into()),
        causation_event_id: None,
        correlation_id: Some("command".into()),
        actor_kind: "server".into(),
        payload_json: "{\"title\":\"hello\"}".into(),
        metadata_json: "{}".into(),
        application_event_version: 2,
    }
}

async fn initialize(store: &Store) -> ApplicationTransactions {
    let mut transactions = ApplicationTransactions::new(store.clone());
    transactions.initialize(schema()).await.unwrap();
    transactions
}

async fn prepare(store: &Store) -> PreparationResult {
    loop {
        let result = store.prepare_application_events().await.unwrap();
        if result.prepared {
            return result;
        }
    }
}

fn read_all() -> EventRead {
    EventRead {
        after_sequence: 0,
        through_sequence: None,
        thread_id: None,
        command_id: None,
        event_type: None,
        only_agent_events: None,
        limit: 4096,
    }
}

fn stats(
    kind: &str,
    thread: Option<&str>,
    after: u64,
    through: u64,
    max: Option<u64>,
) -> EventStats {
    EventStats {
        kind: kind.into(),
        after_sequence: after,
        through_sequence: through,
        thread_id: thread.map(str::to_owned),
        max_events: max,
    }
}

#[tokio::test]
async fn event_append_joins_savepoint_rollback_and_preserves_typed_row_identity() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    prepare(&store).await;
    app.begin("write").await.unwrap();
    assert_eq!(
        app.events_append("write", row("one", "thread"), None)
            .await
            .unwrap()
            .sequence,
        1
    );
    app.savepoint("write", "inner").await.unwrap();
    assert!(matches!(
        app.events_append("write", row("one", "thread"), None).await,
        Err(Error::DuplicateRecord)
    ));
    assert!(app.events_read("write", read_all()).await.is_err());
    app.rollback_to("write", "inner").await.unwrap();
    app.release("write", "inner").await.unwrap();
    assert_eq!(
        app.events_append("write", row("two", "thread"), None)
            .await
            .unwrap()
            .sequence,
        2
    );
    assert_eq!(
        app.events_stats("write", stats("application", None, 0, MAX_SEQUENCE, None))
            .await
            .unwrap()
            .event_count,
        2
    );
    app.commit("write").await.unwrap();
    app.begin("read").await.unwrap();
    let stored = app
        .get("read", EVENTS, &[int_cell(2)])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["event_id"], text_cell("two"));
    assert_eq!(stored["stream_version"], int_cell(1));
    app.rollback("read").await.unwrap();
    app.begin("bypass").await.unwrap();
    assert!(matches!(
        app.delete("bypass", EVENTS, &[int_cell(1)]).await,
        Err(Error::Invalid(_))
    ));
    assert!(app.commit("bypass").await.is_err());
}

#[tokio::test]
async fn preparation_resumes_after_reopen_and_does_not_rebuild_live_events() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    app.begin("seed").await.unwrap();
    for sequence in 1..=70 {
        let event = EventRecord {
            sequence,
            stream_version: (sequence - 1) as i64,
            row: row(&format!("seed-{sequence}"), "thread"),
        }
        .stored();
        app.put("seed", EVENTS, event.key, event.row).await.unwrap();
    }
    app.commit("seed").await.unwrap();
    let first = store.prepare_application_events().await.unwrap();
    assert!(!first.prepared);
    assert_eq!(first.indexed_rows, PREPARE_ROWS as u64);
    app.begin("unready").await.unwrap();
    assert!(app.events_read("unready", read_all()).await.is_err());
    drop(app);
    store.shutdown().await.unwrap();
    let reopened = fixture.connect().await;
    assert_eq!(prepare(&reopened).await.indexed_rows, 70);
    let mut app = ApplicationTransactions::new(reopened.clone());
    app.begin("live").await.unwrap();
    assert_eq!(
        app.events_append("live", row("live", "thread"), None)
            .await
            .unwrap()
            .sequence,
        71
    );
    app.commit("live").await.unwrap();
    assert_eq!(prepare(&reopened).await.indexed_rows, 70);
    app.begin("verify").await.unwrap();
    assert_eq!(
        app.events_read("verify", read_all()).await.unwrap().len(),
        71
    );
    assert_eq!(
        app.events_stats("verify", stats("application", None, 0, MAX_SEQUENCE, None))
            .await
            .unwrap()
            .event_count,
        71
    );
    app.rollback("verify").await.unwrap();
}

#[tokio::test]
async fn sparse_replay_statistics_respect_ranges_limits_and_malformed_ordinary_payloads() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    app.begin("seed").await.unwrap();
    let sequences = [1, 255, 256, 1024, 1_000_000, MAX_SEQUENCE - 1];
    let mut payload_bytes = Vec::new();
    for (ordinal, sequence) in sequences.into_iter().enumerate() {
        let mut input = row(&format!("sparse-{ordinal}"), "thread");
        input.event_type = if ordinal == 1 {
            "thread.created"
        } else {
            "thread.metadata-updated"
        }
        .into();
        input.payload_json = format!("{{malformed:{}é", "x".repeat(ordinal * 13));
        payload_bytes.push(input.payload_json.len() as u64);
        let event = EventRecord {
            sequence,
            stream_version: ordinal as i64,
            row: input,
        }
        .stored();
        app.put("seed", EVENTS, event.key, event.row).await.unwrap();
    }
    app.commit("seed").await.unwrap();
    prepare(&store).await;
    app.begin("stats").await.unwrap();
    for (after, through, max) in [
        (0, MAX_SEQUENCE, 0),
        (0, MAX_SEQUENCE, 3),
        (1, 1_000_000, 1),
        (255, MAX_SEQUENCE, 100),
        (256, 1024, 0),
    ] {
        let expected: Vec<_> = sequences
            .iter()
            .enumerate()
            .filter(|(_, sequence)| **sequence > after && **sequence <= through)
            .take(max as usize + 1)
            .collect();
        let actual = app
            .events_stats(
                "stats",
                stats("agent", Some("thread"), after, through, Some(max)),
            )
            .await
            .unwrap();
        assert_eq!(
            actual,
            StatsResult {
                event_count: expected.len() as u64,
                raw_payload_bytes: expected
                    .iter()
                    .map(|(index, _)| payload_bytes[*index])
                    .sum(),
                has_create_event: expected.iter().any(|(index, _)| *index == 1),
            }
        );
    }
    assert_eq!(
        app.events_stats("stats", stats("application", None, 0, MAX_SEQUENCE, None))
            .await
            .unwrap()
            .raw_payload_bytes,
        payload_bytes.iter().sum::<u64>()
    );
    app.rollback("stats").await.unwrap();
}

#[tokio::test]
async fn all_filter_combinations_return_sequence_order_without_unrelated_rows() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    prepare(&store).await;
    app.begin("write").await.unwrap();
    let mut expected = Vec::new();
    for index in 0..24 {
        let mut input = row(
            &format!("event-{index}"),
            if index % 2 == 0 { "a" } else { "b" },
        );
        input.command_id = Some(if index % 3 == 0 { "x" } else { "y" }.into());
        input.event_type = if index % 4 == 0 {
            "thread.created"
        } else {
            "thread.metadata-updated"
        }
        .into();
        expected.push(input.clone());
        app.events_append("write", input, None).await.unwrap();
    }
    app.commit("write").await.unwrap();
    app.begin("query").await.unwrap();
    for mask in 0..8 {
        let mut query = read_all();
        query.only_agent_events = Some(true);
        query.thread_id = (mask & 1 != 0).then(|| "a".into());
        query.command_id = (mask & 2 != 0).then(|| "x".into());
        query.event_type = (mask & 4 != 0).then(|| "thread.created".into());
        let rows = app.events_read("query", query.clone()).await.unwrap();
        let expected_ids: Vec<_> = expected
            .iter()
            .filter(|row| {
                query
                    .thread_id
                    .as_ref()
                    .is_none_or(|value| value == &row.stream_id)
                    && query
                        .command_id
                        .as_ref()
                        .is_none_or(|value| Some(value) == row.command_id.as_ref())
                    && query
                        .event_type
                        .as_ref()
                        .is_none_or(|value| value == &row.event_type)
            })
            .map(|row| row.event_id.as_str())
            .collect();
        assert_eq!(
            rows.iter()
                .map(|row| row.event_id.as_str())
                .collect::<Vec<_>>(),
            expected_ids
        );
    }
    app.rollback("query").await.unwrap();
}

#[tokio::test]
async fn prompt_restoration_preserves_unrelated_json_lexemes_and_byte_budgets() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    prepare(&store).await;
    app.begin("write").await.unwrap();
    let payload = r#"{"id":"sub","prompt":"héllo\nworld","number":1e+21,"encoded":"\u0061"}"#;
    let mut anchor = row("anchor", "thread");
    anchor.event_type = "subagent.updated".into();
    anchor.payload_json = payload.into();
    app.events_append("write", anchor.clone(), None)
        .await
        .unwrap();
    anchor.event_id = "compact".into();
    let compact = app.events_append("write", anchor, Some(1)).await.unwrap();
    assert!(!compact.stores_full_prompt);
    let rows = app.events_read("write", read_all()).await.unwrap();
    assert_eq!(rows[0].payload_json, payload);
    assert_eq!(rows[1].payload_json, payload);
    assert_eq!(
        app.events_stats("write", stats("application", None, 0, MAX_SEQUENCE, None))
            .await
            .unwrap()
            .raw_payload_bytes,
        payload.len() as u64 * 2
    );
    app.commit("write").await.unwrap();
}

#[tokio::test]
async fn event_preparation_rejects_encoded_text_without_changing_imported_values() {
    for column in ["event_id", "stream_id", "payload_json"] {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let mut app = initialize(&store).await;
        let mut stored = EventRecord {
            sequence: 1,
            stream_version: 0,
            row: row("one", "thread"),
        }
        .stored();
        let encoded_text = json!({"type":"text","encoding":"base64","value":"gA=="});
        stored.row.insert(column.into(), encoded_text.clone());
        app.begin("seed").await.unwrap();
        app.put("seed", EVENTS, stored.key, stored.row)
            .await
            .unwrap();
        app.commit("seed").await.unwrap();
        assert!(matches!(
            store.prepare_application_events().await,
            Err(Error::IncompatibleStore)
        ));
        app.begin("read-original").await.unwrap();
        assert_eq!(
            app.get("read-original", EVENTS, &[int_cell(1)])
                .await
                .unwrap()
                .unwrap()[column],
            encoded_text
        );
        assert!(app.events_read("read-original", read_all()).await.is_err());
    }
}

#[tokio::test]
async fn index_preparation_and_statistics_do_not_require_a_whole_history_snapshot() {
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    let payload = "x".repeat(800_000);
    for chunk in 0..3 {
        app.begin("seed").await.unwrap();
        for offset in 1..=8 {
            let sequence = chunk * 8 + offset;
            let mut input = row(&format!("large-{sequence}"), "thread");
            input.event_type = "thread.metadata-updated".into();
            input.payload_json = payload.clone();
            let stored = EventRecord {
                sequence,
                stream_version: (sequence - 1) as i64,
                row: input,
            }
            .stored();
            app.put("seed", EVENTS, stored.key, stored.row)
                .await
                .unwrap();
        }
        app.commit("seed").await.unwrap();
    }
    assert!(payload.len() * 24 > MAX_BATCH_BYTES);
    assert_eq!(prepare(&store).await.indexed_rows, 24);
    app.begin("stats").await.unwrap();
    let actual = app
        .events_stats("stats", stats("application", None, 0, MAX_SEQUENCE, None))
        .await
        .unwrap();
    assert_eq!(actual.event_count, 24);
    assert_eq!(actual.raw_payload_bytes, payload.len() as u64 * 24);
    assert_eq!(
        app.events_stats("stats", stats("agent", Some("thread"), 5, 23, Some(1)))
            .await
            .unwrap()
            .raw_payload_bytes,
        payload.len() as u64 * 2
    );
    app.rollback("stats").await.unwrap();
}

#[tokio::test]
async fn restored_non_string_prompts_keep_sqlite_types_or_fail_without_coercing_to_text() {
    for (value, expected) in [
        ("[1, 2]", "[1,2]"),
        ("{\"x\": 1}", "{\"x\":1}"),
        ("true", "1"),
        ("false", "0"),
        ("null", "null"),
        ("-17", "-17"),
    ] {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        let mut app = initialize(&store).await;
        app.begin("seed").await.unwrap();
        for (sequence, payload) in [
            (1, format!("{{\"prompt\":{value}}}")),
            (2, "{\"prompt\":\"\",\"promptSequence\":1}".into()),
        ] {
            let mut input = row(&format!("prompt-{sequence}"), "thread");
            input.event_type = "subagent.updated".into();
            input.payload_json = payload;
            let event = EventRecord {
                sequence,
                stream_version: (sequence - 1) as i64,
                row: input,
            }
            .stored();
            app.put("seed", EVENTS, event.key, event.row).await.unwrap();
        }
        app.commit("seed").await.unwrap();
        prepare(&store).await;
        app.begin("read").await.unwrap();
        let rows = app.events_read("read", read_all()).await.unwrap();
        assert_eq!(rows[1].payload_json, format!("{{\"prompt\":{expected}}}"));
        app.rollback("read").await.unwrap();
    }
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut app = initialize(&store).await;
    app.begin("real-prompt").await.unwrap();
    for (sequence, payload) in [(1, "{\"prompt\":1e+21}"), (2, "{\"promptSequence\":1}")] {
        let mut input = row(&format!("real-{sequence}"), "thread");
        input.event_type = "subagent.updated".into();
        input.payload_json = payload.into();
        let stored = EventRecord {
            sequence,
            stream_version: (sequence - 1) as i64,
            row: input,
        }
        .stored();
        app.put("real-prompt", EVENTS, stored.key, stored.row)
            .await
            .unwrap();
    }
    app.commit("real-prompt").await.unwrap();
    assert!(matches!(
        store.prepare_application_events().await,
        Err(Error::IncompatibleStore)
    ));
}

#[tokio::test]
async fn assistant_text_revisions_store_suffixes_and_replay_exactly_after_rollback_reopen_and_prune()
 {
    use crate::application::{ApplicationEventLayout, ApplicationTransactionMode};

    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    let layout = Some(ApplicationEventLayout::AssistantTextRevisionsV1);
    assert!(
        store
            .bootstrap_application_with_event_layout(layout)
            .await
            .unwrap()
            .initialized
    );
    let mut app = ApplicationTransactions::new(store.clone());
    let identity = app.generation_identity().await.unwrap().unwrap();
    assert_eq!(
        identity.layout,
        "t3-application-keyspace-v1+assistant-text-revisions-v1"
    );
    prepare(&store).await;
    while !store
        .prepare_application_maintenance()
        .await
        .unwrap()
        .prepared
    {}

    let marker = "synthetic checkpoint prefix".repeat(48);
    let token = format!(r"{marker}\u0061");
    let message = |id: &str, text_token: &str, streaming: bool| {
        let mut event = row(id, "thread");
        event.event_type = "message.updated".into();
        event.actor_kind = "provider".into();
        event.payload_json = format!(
            r#"{{"threadId":"thread","id":"message","text":"{text_token}","context":{{"variant":1e+21}},"role":"assistant","createdBy":"agent","creationSource":"provider","streaming":{streaming},"runId":"run","nodeId":"node","createdAt":"2026-11-10T00:00:00.000Z","updatedAt":"2026-11-10T00:00:01.000Z","attachments":[]}}"#
        );
        event
    };
    let first = message("first", &token, true);
    let second = message("second", &format!(r"{token}雪\n"), true);
    let third = message("third", &format!(r"{token}雪\nmore"), true);
    let rewrite = message("rewrite", &format!("new {token}"), true);
    let completion = message("completion", &format!("new {token} done"), false);

    app.begin("write").await.unwrap();
    app.events_append("write", first.clone(), None)
        .await
        .unwrap();
    app.savepoint("write", "attempt").await.unwrap();
    app.events_append(
        "write",
        message("discarded", &format!("{token} discarded"), true),
        None,
    )
    .await
    .unwrap();
    app.rollback_to("write", "attempt").await.unwrap();
    app.release("write", "attempt").await.unwrap();
    for event in [&second, &third, &rewrite, &completion] {
        app.events_append("write", event.clone(), None)
            .await
            .unwrap();
    }
    app.commit("write").await.unwrap();
    drop(app);
    store.shutdown().await.unwrap();

    let store = fixture.connect().await;
    assert!(!store.bootstrap_application().await.unwrap().initialized);
    let mut raw = store.db.begin_read_only().await.unwrap();
    let catalog = decode_catalog(&raw.get(&schema_key()).await.unwrap().unwrap()).unwrap();
    let plain_catalog: Value =
        serde_json::from_slice(&raw.get(&schema_key()).await.unwrap().unwrap()).unwrap();
    assert_eq!(plain_catalog["event_layout"], "assistant_text_revisions_v1");
    let mut physical = Vec::new();
    for sequence in 1..=5 {
        physical.push(
            raw.get(&event_key(&catalog, sequence).unwrap())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    raw.rollback().await.unwrap();
    for (index, (predecessor, suffix)) in [(1, r"雪\n"), (2, "more")].into_iter().enumerate() {
        let bytes = &physical[index + 1];
        let stored: Value = serde_json::from_slice(bytes).unwrap();
        let revision = &stored["text_revision"];
        assert_eq!(revision["previous"]["sequence"], predecessor);
        assert_eq!(revision["suffix"], suffix);
        assert!(!std::str::from_utf8(bytes).unwrap().contains(&marker));
    }
    for index in [0, 3, 4] {
        let stored: ApplicationRow = serde_json::from_slice(&physical[index]).unwrap();
        assert!(text(&stored.row, "payload_json").unwrap().contains(&marker));
    }

    let mut app = ApplicationTransactions::new(store.clone());
    app.begin_mode("read", ApplicationTransactionMode::Read, None)
        .await
        .unwrap();
    let expected =
        [&first, &second, &third, &rewrite, &completion].map(|r| r.payload_json.as_str());
    let replay = app.events_read("read", read_all()).await.unwrap();
    assert_eq!(
        replay
            .iter()
            .map(|r| r.payload_json.as_str())
            .collect::<Vec<_>>(),
        expected
    );
    let page = app.scan("read", EVENTS, None, 10).await.unwrap();
    for (index, payload) in expected.into_iter().enumerate() {
        let key = [int_cell(index + 1)];
        let row = app.get("read", EVENTS, &key).await.unwrap().unwrap();
        assert_eq!(text(&row, "payload_json").unwrap(), payload);
        assert!(
            page.rows
                .iter()
                .any(|found| found.key == key && found.row == row)
        );
    }
    assert_eq!(
        app.events_stats("read", stats("application", None, 0, 5, None))
            .await
            .unwrap()
            .raw_payload_bytes,
        expected
            .iter()
            .map(|payload| payload.len() as u64)
            .sum::<u64>()
    );
    app.rollback("read").await.unwrap();

    let base_key = event_key(&catalog, 1).unwrap();
    let suffix_key = event_key(&catalog, 2).unwrap();
    let mut wrong_base: ApplicationRow = serde_json::from_slice(&physical[0]).unwrap();
    wrong_base.row.insert(
        "payload_json".into(),
        text_cell(
            &first
                .payload_json
                .replace(r#""id":"message""#, r#""id":"another""#),
        ),
    );
    let mut forward: Value = serde_json::from_slice(&physical[1]).unwrap();
    forward["text_revision"]["previous"]["sequence"] = json!(3);
    for (key, replacement) in [
        (base_key.clone(), None),
        (base_key, Some(encode_row(&wrong_base).unwrap())),
        (suffix_key, Some(encode(&forward).unwrap())),
    ] {
        for through_replay in [false, true] {
            // Inject a fault inside a disposable transaction. An incompatible
            // row must abort the read and leave the committed witness untouched.
            app.begin("damaged").await.unwrap();
            let mut session = app.take("damaged").unwrap();
            if let Some(bytes) = &replacement {
                session
                    .transaction
                    .put(key.clone(), bytes.clone())
                    .await
                    .unwrap();
            } else {
                session.transaction.delete(key.clone()).await.unwrap();
            }
            app.finish("damaged", session, Ok(())).await.unwrap();
            let read = if through_replay {
                app.events_read(
                    "damaged",
                    EventRead {
                        after_sequence: 1,
                        ..read_all()
                    },
                )
                .await
                .map(|_| ())
            } else {
                app.get("damaged", EVENTS, &[int_cell(2)]).await.map(|_| ())
            };
            assert!(matches!(read, Err(Error::IncompatibleStore)), "{read:?}");
        }
    }

    app.begin("prune").await.unwrap();
    app.maintenance_write(
        "prune",
        MaintenanceWrite::DeleteEvents { sequences: vec![1] },
    )
    .await
    .unwrap();
    app.commit("prune").await.unwrap();
    let mut raw = store.db.begin_read_only().await.unwrap();
    let key = event_key(&catalog, 1).unwrap();
    assert!(raw.get(&key).await.unwrap().is_none());
    let key = event_key(&catalog, 2).unwrap();
    let bytes = raw.get(&key).await.unwrap().unwrap();
    let reanchored: ApplicationRow = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        text(&reanchored.row, "payload_json").unwrap(),
        second.payload_json
    );
    raw.rollback().await.unwrap();
    app.begin_mode("after-prune", ApplicationTransactionMode::Read, None)
        .await
        .unwrap();
    let replay = app.events_read("after-prune", read_all()).await.unwrap();
    assert_eq!(
        replay
            .iter()
            .map(|r| r.payload_json.as_str())
            .collect::<Vec<_>>(),
        expected[1..]
    );
    app.rollback("after-prune").await.unwrap();
    store.shutdown().await.unwrap();
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
struct LayoutByteCount {
    records: u64,
    key_bytes: u64,
    value_bytes: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct LayoutFootprint {
    categories: std::collections::BTreeMap<&'static str, LayoutByteCount>,
    total_key_value_bytes: u64,
    checkpoint_rows: u64,
    suffix_rows: u64,
    key_value_sha256: String,
}

async fn layout_footprint(store: &Store) -> LayoutFootprint {
    use sha2::{Digest, Sha256};
    let mut tx = store.db.begin_read_only().await.unwrap();
    let catalog = decode_catalog(&tx.get(&schema_key()).await.unwrap().unwrap()).unwrap();
    let rows = row_prefix(&catalog.generation, EVENTS).unwrap();
    let indexes = key(&catalog, "");
    let heads = key(&catalog, "text-v1/head/");
    let dependents = key(&catalog, "text-v1/dependent/");
    let mut result = LayoutFootprint {
        categories: [
            "event_rows",
            "event_indexes_and_metadata",
            "text_heads",
            "text_dependents",
            "other_store_keys",
        ]
        .into_iter()
        .map(|name| (name, LayoutByteCount::default()))
        .collect(),
        total_key_value_bytes: 0,
        checkpoint_rows: 0,
        suffix_rows: 0,
        key_value_sha256: String::new(),
    };
    let mut digest = Sha256::new();
    let mut start = Vec::new();
    loop {
        // Scan the actual backend table, not a logical row API which reconstructs text.
        let page = tx.scan(&start, &[255], 32).await.unwrap();
        if page.is_empty() {
            break;
        }
        for (key, value) in &page {
            let category = if key.starts_with(&rows) {
                let physical: Value = serde_json::from_slice(value).unwrap();
                if physical.get("text_revision").is_some() {
                    result.suffix_rows += 1;
                } else {
                    result.checkpoint_rows += 1;
                }
                "event_rows"
            } else if key.starts_with(&heads) {
                "text_heads"
            } else if key.starts_with(&dependents) {
                "text_dependents"
            } else if key.starts_with(&indexes) {
                "event_indexes_and_metadata"
            } else {
                "other_store_keys"
            };
            let count = result.categories.get_mut(category).unwrap();
            count.records += 1;
            count.key_bytes += key.len() as u64;
            count.value_bytes += value.len() as u64;
            result.total_key_value_bytes += (key.len() + value.len()) as u64;
            digest.update((key.len() as u64).to_le_bytes());
            digest.update(key);
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value);
        }
        start = page.last().unwrap().0.clone();
        start.push(0);
    }
    tx.rollback().await.unwrap();
    result.key_value_sha256 = format!("{:x}", digest.finalize());
    result
}

fn layout_file_size(path: &std::path::Path) -> Value {
    let metadata = std::fs::metadata(path).unwrap();
    #[cfg(unix)]
    let allocated = {
        use std::os::unix::fs::MetadataExt;
        Some(metadata.blocks() * 512)
    };
    #[cfg(not(unix))]
    let allocated: Option<u64> = None;
    json!({ "file_bytes": metadata.len(), "allocated_file_bytes": allocated })
}

async fn layout_exact_replay(store: &Store, events: &[EventAppendRow]) -> Vec<EventResultRow> {
    use crate::application::ApplicationTransactionMode;
    let mut app = ApplicationTransactions::new(store.clone());
    app.begin_mode("measure-read", ApplicationTransactionMode::Read, None)
        .await
        .unwrap();
    let mut replay = Vec::new();
    loop {
        let page = app
            .events_read(
                "measure-read",
                EventRead {
                    after_sequence: replay.len() as u64,
                    limit: 8,
                    ..read_all()
                },
            )
            .await
            .unwrap();
        if page.is_empty() {
            break;
        }
        replay.extend(page);
    }
    assert_eq!(replay.len(), events.len());
    for (index, (actual, expected)) in replay.iter().zip(events).enumerate() {
        assert_eq!(actual.sequence, index as u64 + 1);
        assert_eq!(actual.event_id, expected.event_id);
        assert_eq!(actual.payload_json, expected.payload_json);
        assert_eq!(actual.metadata_json, expected.metadata_json);
    }
    let statistics = app
        .events_stats(
            "measure-read",
            stats("application", None, 0, events.len() as u64, None),
        )
        .await
        .unwrap();
    assert_eq!(
        statistics.raw_payload_bytes,
        events
            .iter()
            .map(|event| event.payload_json.len() as u64)
            .sum::<u64>()
    );
    app.rollback("measure-read").await.unwrap();
    replay
}

async fn layout_storage_run(
    revisions: bool,
    events: &[EventAppendRow],
) -> (Value, Vec<EventResultRow>) {
    use crate::application::ApplicationEventLayout;
    let fixture = TestFixture::start().await;
    let store = fixture.initialize().await;
    assert!(
        store
            .bootstrap_application_with_event_layout(
                revisions.then_some(ApplicationEventLayout::AssistantTextRevisionsV1),
            )
            .await
            .unwrap()
            .initialized
    );
    prepare(&store).await;
    let initial = layout_footprint(&store).await;
    assert_eq!(initial.checkpoint_rows + initial.suffix_rows, 0);
    let identity = ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await
        .unwrap()
        .unwrap();
    store.shutdown().await.unwrap();
    let initial_file = layout_file_size(fixture.path());
    let store = fixture.connect().await;
    let mut app = ApplicationTransactions::new(store.clone());
    let mut streaming = None;
    for (index, event) in events.iter().enumerate() {
        app.begin("measure-write").await.unwrap();
        let appended = app
            .events_append("measure-write", event.clone(), None)
            .await
            .unwrap();
        assert_eq!(appended.sequence, index as u64 + 1);
        app.commit("measure-write").await.unwrap();
        if index + 1 == events.len() - 1 {
            streaming = Some(layout_footprint(&store).await);
        }
    }
    drop(app);
    let streaming = streaming.unwrap();
    assert_eq!(
        streaming.categories["text_heads"].records,
        if revisions { 1 } else { 0 }
    );
    let completed = layout_footprint(&store).await;
    assert_eq!(completed.categories["text_heads"].records, 0);
    assert_eq!(
        completed.checkpoint_rows + completed.suffix_rows,
        events.len() as u64
    );
    if revisions {
        assert!(completed.suffix_rows > 8);
        assert!(
            completed.checkpoint_rows > 2,
            "the workload must cross multiple bounded chains"
        );
        assert_eq!(
            completed.categories["text_dependents"].records,
            completed.suffix_rows
        );
    } else {
        assert_eq!(completed.suffix_rows, 0);
        assert_eq!(completed.categories["text_dependents"].records, 0);
    }
    store.shutdown().await.unwrap();
    let store = fixture.connect().await;
    let replay = layout_exact_replay(&store, events).await;
    let reopened = layout_footprint(&store).await;
    assert_eq!(reopened, completed);
    let before_statistics = store.storage_statistics().await.unwrap();
    store.shutdown().await.unwrap();
    let before_compaction = layout_file_size(fixture.path());
    let store = Store::open_exclusive(fixture.path()).await.unwrap();
    let compaction = store.storage_compact().await.unwrap();
    let compacted = layout_footprint(&store).await;
    assert_eq!(
        compacted, completed,
        "compaction must preserve every actual key/value byte"
    );
    let after_statistics = store.storage_statistics().await.unwrap();
    store.shutdown().await.unwrap();
    let after_compaction = layout_file_size(fixture.path());
    let store = fixture.connect().await;
    assert_eq!(layout_exact_replay(&store, events).await, replay);
    store.shutdown().await.unwrap();
    (
        json!({
            "layout": if revisions { "assistant_text_revisions_v1" } else { "full_event" },
            "identity": identity, "initial": initial, "initial_file": initial_file,
            "streaming": streaming, "completed": completed,
            "before_compaction": before_compaction, "after_compaction": after_compaction,
            "compaction": compaction, "before_statistics": before_statistics, "after_statistics": after_statistics,
        }),
        replay,
    )
}

#[tokio::test]
async fn assistant_text_revisions_compare_event_owner_storage_bytes() {
    use sha2::{Digest, Sha256};
    const UPDATES: usize = 128;
    let mut events = Vec::new();
    let mut text = "起点 café e\u{301} 👩‍💻\n".repeat(160);
    let suffix = "追加 雪🙂 e\u{301} café\n".repeat(48);
    for index in 0..=UPDATES {
        if index < UPDATES {
            text.push_str(&format!("[{index:03}] {suffix}"));
        }
        let mut event = row(&format!("layout-{index:03}"), "thread");
        event.event_type = "message.updated".into();
        event.actor_kind = "provider".into();
        event.payload_json = serde_json::to_string(&json!({
            "threadId": "thread", "id": "message", "text": text, "role": "assistant",
            "createdBy": "agent", "creationSource": "provider", "streaming": index < UPDATES,
            "runId": "run", "nodeId": "node", "createdAt": "2026-11-10T00:00:00.000Z",
            "updatedAt": "2026-11-10T00:00:01.000Z", "attachments": [],
        }))
        .unwrap();
        assert!(event.payload_json.len() < 256 * 1024);
        events.push(event);
    }
    let mut logical_digest = Sha256::new();
    for event in &events {
        logical_digest.update((event.payload_json.len() as u64).to_le_bytes());
        logical_digest.update(event.payload_json.as_bytes());
    }
    let mut runs = Vec::new();
    for pair in 0..5 {
        let order = if pair % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        };
        let (first, first_replay) = layout_storage_run(order[0], &events).await;
        let (second, second_replay) = layout_storage_run(order[1], &events).await;
        assert_eq!(
            first_replay, second_replay,
            "both layouts must complete identical logical work"
        );
        assert_eq!(
            first["completed"]["categories"]["event_indexes_and_metadata"],
            second["completed"]["categories"]["event_indexes_and_metadata"],
            "both layouts must pay for the same logical event indexes and statistics"
        );
        runs.extend([first, second]);
    }
    let summary = |layout: &str, field: &str| {
        let mut values: Vec<u64> = runs
            .iter()
            .filter(|run| run["layout"] == layout)
            .map(|run| {
                if field == "key_value_bytes" {
                    run["completed"]["total_key_value_bytes"].as_u64().unwrap()
                } else {
                    run["after_compaction"]["file_bytes"].as_u64().unwrap()
                }
            })
            .collect();
        values.sort_unstable();
        json!({ "runs": values.len(), "minimum": values[0], "median": values[2], "maximum": values[4] })
    };
    let full = summary("full_event", "file_bytes");
    let revisions = summary("assistant_text_revisions_v1", "file_bytes");
    let settled = if revisions["maximum"].as_u64().unwrap() < full["minimum"].as_u64().unwrap() {
        "smaller-in-all-observed-runs"
    } else if revisions["minimum"].as_u64().unwrap() > full["maximum"].as_u64().unwrap() {
        "larger-in-all-observed-runs"
    } else if revisions["minimum"] == full["maximum"] && revisions["maximum"] == full["minimum"] {
        "equal-no-settled-file-reduction"
    } else {
        "overlapping-ranges-no-settled-reduction-established"
    };
    let mut executable_digest = Sha256::new();
    {
        use std::io::Read;
        let mut file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        let mut buffer = [0; 32 * 1024];
        loop {
            let count = file.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            executable_digest.update(&buffer[..count]);
        }
    }
    let report = json!({
        "schema": 1, "scope": "native-event-owner-only-no-projection-provider-or-client-workload",
        "stock_product_denominator": "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f",
        "streaming_updates": UPDATES, "completion_events": 1,
        "workload_commits_per_run": events.len(),
        "maximum_payload_bytes": events.iter().map(|event| event.payload_json.len()).max().unwrap(),
        "platform": { "os": std::env::consts::OS, "architecture": std::env::consts::ARCH },
        "test_executable_sha256": format!("{:x}", executable_digest.finalize()),
        "codec_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("redb_event_text_revisions.rs"))),
        "workload_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("redb_event_rows_tests.rs"))),
        "logical_payload_bytes": events.iter().map(|e| e.payload_json.len() as u64).sum::<u64>(),
        "logical_payload_sha256": format!("{:x}", logical_digest.finalize()),
        "durability": "same pinned omdb Immediate profile for both layouts",
        "method": "five paired runs with first layout reversed each pair; actual backend keys and values; closed file lengths and exclusive offline compaction",
        "key_value_bytes": { "full_event": summary("full_event", "key_value_bytes"), "assistant_text_revisions_v1": summary("assistant_text_revisions_v1", "key_value_bytes") },
        "compacted_file_bytes": { "full_event": full, "assistant_text_revisions_v1": revisions, "result": settled },
        "runs": runs,
    });
    println!(
        "T3_EVENT_LAYOUT_MEASUREMENT {}",
        serde_json::to_string(&report).unwrap()
    );
    if let Some(path) = std::env::var_os("T3_CODE_LS_EVENT_LAYOUT_PROOF") {
        use std::io::Write;
        let path = std::path::PathBuf::from(path);
        assert!(path.is_absolute());
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        serde_json::to_writer_pretty(&mut file, &report).unwrap();
        file.write_all(b"\n").unwrap();
        file.sync_all().unwrap();
    }
}
