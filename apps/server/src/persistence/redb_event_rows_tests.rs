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
#[ignore = "records physical storage use for a fixed assistant stream"]
async fn assistant_text_layout_preserves_logical_replay_with_less_retained_storage() {
    use crate::application::{ApplicationEventLayout, ApplicationTransactionMode};

    async fn measure(
        expected: &[EventAppendRow],
        layout: Option<ApplicationEventLayout>,
    ) -> (u64, usize, usize) {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        assert!(
            store
                .bootstrap_application_with_event_layout(layout)
                .await
                .unwrap()
                .initialized
        );
        prepare(&store).await;
        let mut app = ApplicationTransactions::new(store.clone());
        for (index, event) in expected.iter().enumerate() {
            app.begin("append").await.unwrap();
            assert_eq!(
                app.events_append("append", event.clone(), None)
                    .await
                    .unwrap()
                    .sequence,
                index as u64 + 1,
            );
            app.commit("append").await.unwrap();
        }
        drop(app);
        store.shutdown().await.unwrap();
        let file_bytes = std::fs::metadata(fixture.path()).unwrap().len();

        let store = fixture.connect().await;
        let mut app = ApplicationTransactions::new(store.clone());
        app.begin_mode("read", ApplicationTransactionMode::Read, None)
            .await
            .unwrap();
        let replay = app.events_read("read", read_all()).await.unwrap();
        assert_eq!(replay.len(), expected.len());
        for (decoded, original) in replay.iter().zip(expected) {
            assert_eq!(decoded.event_id, original.event_id);
            assert_eq!(decoded.payload_json, original.payload_json);
        }
        app.rollback("read").await.unwrap();
        drop(app);

        // Count all keys and values in the physical table, including indexes and revision witnesses.
        let mut raw = store.db.begin_read_only().await.unwrap();
        let mut start = Vec::new();
        let mut key_count = 0;
        let mut key_value_bytes = 0;
        loop {
            let page = raw.scan(&start, &[u8::MAX], 64).await.unwrap();
            let Some((last, _)) = page.last() else { break };
            key_count += page.len();
            key_value_bytes += page
                .iter()
                .map(|(key, value)| key.len() + value.len())
                .sum::<usize>();
            start.clone_from(last);
            start.push(0);
        }
        raw.rollback().await.unwrap();
        store.shutdown().await.unwrap();
        (file_bytes, key_count, key_value_bytes)
    }

    let mut events = Vec::new();
    for turn in 0..6 {
        let thread = format!("thread-{turn}");
        let mut text = "Synthetic opening paragraph café. ".repeat(280);
        for revision in 0..64 {
            text.push_str("追加 🐟 bounded stream update\n");
            let mut event = row(&format!("assistant-{turn}-{revision}"), &thread);
            event.actor_kind = "provider".into();
            event.event_type = "message.updated".into();
            event.payload_json = json!({
                "threadId": thread, "id": "assistant-message", "text": text,
                "role": "assistant", "createdBy": "agent", "creationSource": "provider",
                "streaming": revision != 63, "runId": "run", "nodeId": "node",
                "createdAt": "2026-11-10T00:00:00.000Z", "updatedAt": "2026-11-10T00:00:01.000Z",
                "attachments": [],
            })
            .to_string();
            events.push(event);
        }
    }
    let full = measure(&events, None).await;
    let revisions = measure(
        &events,
        Some(ApplicationEventLayout::AssistantTextRevisionsV1),
    )
    .await;
    let sample = |(file_bytes, key_count, key_value_bytes)| {
        json!({
            "fileBytesAfterShutdown": file_bytes,
            "keyCount": key_count,
            "keyValueBytes": key_value_bytes,
        })
    };
    println!(
        "{}",
        json!({
            "scope": "assistant event log and indexes",
            "durability": "omdb Immediate",
            "rootCommits": events.len(),
            "logicalPayloadBytes": events.iter().map(|row| row.payload_json.len()).sum::<usize>(),
            "fullLayout": sample(full),
            "revisionLayout": sample(revisions),
        })
    );
    assert!(revisions.2 < full.2);
    assert!(revisions.0 < full.0);
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
        (key(&catalog, "text-v1/dependent/1"), None),
    ] {
        for after_sequence in [None, Some(0), Some(1)] {
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
            let read = if let Some(after_sequence) = after_sequence {
                app.events_read(
                    "damaged",
                    EventRead {
                        after_sequence,
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
