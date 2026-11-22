//! Compact projection metadata: select a bounded history window before loading
//! message bodies, plan markdown, and potentially megabytes of tool output.

use super::*;

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Metadata {
    table: String,
    primary: Vec<Value>,
    order: RowOrder,
    row: Map<String, Value>,
}

pub(crate) fn inline_work_output(type_name: &str, raw: &str) -> bool {
    if type_name != "dynamic_tool" {
        return false;
    }
    let lower = raw.to_ascii_lowercase();
    let delegate = lower.find("\"toolname\":\"").is_some_and(|offset| {
        let suffix = &lower[offset + "\"toolname\":\"".len()..];
        // The upstream LIKE pattern leaves '_' unescaped, so it
        // matches one Unicode character, not only an underscore.
        suffix.match_indices("delegate").any(|(offset, prefix)| {
            let tail = &suffix[offset + prefix.len()..];
            tail.chars()
                .next()
                .is_some_and(|character| tail[character.len_utf8()..].starts_with("task\""))
        })
    });
    let send_to_user = lower.find("\"toolname\":\"").is_some_and(|offset| {
        let suffix = &lower[offset + "\"toolname\":\"".len()..];
        suffix.match_indices("send").any(|(offset, prefix)| {
            let tail = &suffix[offset + prefix.len()..];
            tail.chars().next().is_some_and(|first| {
                let tail = &tail[first.len_utf8()..];
                tail.strip_prefix("to").is_some_and(|tail| {
                    tail.chars()
                        .next()
                        .is_some_and(|second| tail[second.len_utf8()..].starts_with("user\""))
                })
            })
        })
    });
    lower.contains("htmlrender")
        || lower.contains("t3mcpapp")
        || lower.contains("\"viewedimagepath\"")
        || delegate
        || send_to_user
        || lower.contains("sentmessage")
}

fn key(catalog: &ApplicationCatalog, name: &str, primary: &[Value]) -> Vec<u8> {
    location(
        catalog,
        &format!("window-meta/{name}/{}", request_digest(&json!(primary))),
    )
}

pub(super) fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
                | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn compact(name: &str, row: &Map<String, Value>, order: RowOrder) -> Result<Metadata> {
    let mut slim = row.clone();
    if let Some(cell) = row.get("payload_json") {
        let raw = cell
            .get("value")
            .and_then(Value::as_str)
            .ok_or(Error::IncompatibleStore)?;
        if name == ITEMS {
            slim.insert(
                "_native_payload_bytes".into(),
                int_cell(raw.len().try_into().map_err(|_| Error::IncompatibleStore)?),
            );
            // This selection is SQL LIKE over raw bytes, not json_extract.
            // Keep it even if JSON is unreadable so matching corrupt render
            // rows reach the original decoder instead of disappearing.
            let lower = raw.to_ascii_lowercase();
            let recording = lower.match_indices("preview").any(|(offset, prefix)| {
                let tail = &lower[offset + prefix.len()..];
                tail.chars().next().is_some_and(|first| {
                    let tail = &tail[first.len_utf8()..];
                    tail.strip_prefix("recording").is_some_and(|tail| {
                        tail.chars()
                            .next()
                            .is_some_and(|second| tail[second.len_utf8()..].starts_with("stop"))
                    })
                })
            });
            slim.insert(
                "_native_attachment_render".into(),
                int_cell(i64::from(
                    lower.contains("htmlrender") || lower.contains("t3mcpapp") || recording,
                )),
            );
        }
        let payload: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => {
                // Preparation must leave historical corruption discoverable by
                // the unreadable-row audit. A compact query touching it fails,
                // and full row reads still use the original stored bytes.
                slim.insert("payload_json".into(), text_cell("{unreadable"));
                return Ok(Metadata {
                    table: name.into(),
                    primary: primary(name, row)?,
                    order,
                    row: slim,
                });
            }
        };
        let mut retained = Map::new();
        for field in [
            "rootNodeId",
            "freshContext",
            "startedAt",
            "inputIntent",
            "createdBy",
            "messageId",
            "planId",
            "checkpointId",
            "contextHandoffId",
            "requestId",
            "historyOrigin",
            "forkedFrom",
            "queueHeld",
            "userMessageId",
            "workStartedAt",
            "activeAttemptId",
            "creationSource",
            "archivedAt",
            "settledAt",
            "settledOverride",
            "pinnedAt",
            "pinOrderKey",
            "autoSettleDisabledAt",
            "snoozedUntil",
            "worktreePath",
            "lineage",
            "updatedAt",
            "delegatedTaskId",
            "subagentId",
            "restartContinuationOfRunId",
        ] {
            if let Some(value) = payload.get(field) {
                retained.insert(field.into(), value.clone());
            }
        }
        if name == ITEMS && text(row, "type")? == "user_message" {
            let compact = payload
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    value
                        .trim_matches(whitespace)
                        .eq_ignore_ascii_case("/compact")
                })
                && payload["attachments"].as_array().is_none_or(Vec::is_empty);
            retained.insert("nativeCompactionPrompt".into(), json!(compact));
        }
        if name == MESSAGES {
            retained.insert(
                "nativeBackgroundWake".into(),
                json!(
                    payload["notification"]["source"]["kind"]
                        .as_str()
                        .is_some_and(|kind| [
                            "background_task",
                            "background_command",
                            "command",
                            "monitor"
                        ]
                        .contains(&kind))
                        && payload["notification"]["source"]["work"].is_null()
                        && payload["notification"]["outcome"] == "updated"
                        && payload["delegatedCompletion"].is_null()
                ),
            );
            retained.insert(
                "nativeMonitorNotification".into(),
                json!(payload["notification"]["source"]["kind"] == "monitor"),
            );
            retained.insert(
                "nativeDelegatedTaskMessage".into(),
                json!(
                    payload["notification"]["source"]["kind"] == "monitor"
                        || !payload["delegatedCompletion"].is_null()
                ),
            );
            let idle = text(row, "role")? == "user"
                && payload
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| {
                        text.trim_matches(whitespace)
                            .eq_ignore_ascii_case("/compact")
                    })
                && payload
                    .get("attachments")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
                && (payload
                    .get("idleCompaction")
                    .is_some_and(|value| !value.is_null())
                    || (payload.get("createdBy").and_then(Value::as_str) == Some("agent")
                        && payload.get("creationSource").and_then(Value::as_str)
                            == Some("server")));
            retained.insert("nativeIdleCompactionMessage".into(), json!(idle));
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.trim_matches(whitespace));
            let compact = text.is_some_and(|text| text.eq_ignore_ascii_case("/compact"));
            let attachments = payload.get("attachments").and_then(Value::as_array);
            retained.insert("nativeCompactCommand".into(), json!(compact));
            retained.insert(
                "nativeGoalCommand".into(),
                json!(text.is_some_and(|text| text.starts_with("/goal"))),
            );
            retained.insert(
                "nativeConversationUser".into(),
                json!(
                    text.is_some_and(|_| !compact)
                        || attachments.is_some_and(|items| !items.is_empty())
                ),
            );
            retained.insert(
                "nativeContextAttachmentIds".into(),
                json!(
                    attachments
                        .into_iter()
                        .flatten()
                        .map(|item| item.get("id").cloned().unwrap_or(Value::Null))
                        .collect::<Vec<_>>()
                ),
            );
        }
        if name == TURNS {
            retained.insert(
                "nativeHasTokenUsage".into(),
                json!(
                    payload
                        .get("tokenUsage")
                        .is_some_and(|value| !value.is_null())
                ),
            );
            if let Some(value) = payload
                .get("tokenUsage")
                .and_then(|usage| usage.get("updatedAt"))
            {
                retained.insert("nativeTokenUsageUpdatedAt".into(), value.clone());
            }
        }
        if name == SESSIONS {
            retained.insert(
                "nativeHasExtensionStatuses".into(),
                json!(
                    payload
                        .get("extensionStatuses")
                        .and_then(Value::as_array)
                        .is_some_and(|values| !values.is_empty())
                ),
            );
        }
        if name == SCOPES {
            if let Some(value) = payload.get("cwd") {
                retained.insert("cwd".into(), value.clone());
            }
        }
        if name == CHECKPOINTS {
            if let Some(value) = payload.get("ref") {
                retained.insert("ref".into(), value.clone());
            }
        }
        if name == THREADS {
            let files = payload
                .get("guestShare")
                .and_then(|share| share.get("messages"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|message| message.get("status").and_then(Value::as_str) == Some("pending"))
                .flat_map(|message| {
                    message
                        .get("attachments")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .map(|item| item.get("id").cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>();
            retained.insert("nativeGuestAttachmentIds".into(), json!(files));
            for (field, source) in [
                ("nativeLimitRecoveryRunId", "runId"),
                ("nativeLimitRecoveryResetAt", "resetAt"),
                ("nativeLimitRecoveryAutoResume", "autoResume"),
            ] {
                if let Some(value) = payload
                    .get("limitRecovery")
                    .and_then(|recovery| recovery.get(source))
                {
                    retained.insert(field.into(), value.clone());
                }
            }
            if let Some(id) = payload.get("guestShare").and_then(|share| share.get("id")) {
                retained.insert("nativeGuestShareId".into(), id.clone());
            }
            let links = payload.get("pullRequests").and_then(Value::as_array);
            retained.insert(
                "nativeHasPullRequests".into(),
                json!(links.is_some_and(|links| !links.is_empty())),
            );
            retained.insert(
                "nativeHasPullRequestWatch".into(),
                json!(
                    links.is_some_and(|links| links.iter().any(|link| link.get("watch").is_some()))
                ),
            );
        }
        if name == PROVIDER_THREADS {
            retained.insert(
                "nativeHasPendingBackgroundTasks".into(),
                json!(
                    payload
                        .get("pendingBackgroundTasks")
                        .and_then(Value::as_array)
                        .is_some_and(|tasks| !tasks.is_empty())
                ),
            );
        }
        if name == SUBAGENTS {
            retained.insert(
                "nativeAppOwnedPendingResult".into(),
                json!(
                    payload.get("origin").and_then(Value::as_str) == Some("app_owned")
                        && payload.get("result").is_none_or(Value::is_null)
                ),
            );
            let remote = payload.get("remoteChild").filter(|value| value.is_object());
            let open = remote.is_some_and(|remote| {
                payload.get("result") == Some(&Value::Null)
                    || ([Some("cancelled"), Some("interrupted")]
                        .contains(&payload.get("status").and_then(Value::as_str))
                        && remote.get("stoppedThere") != Some(&Value::Bool(true)))
                    || remote.get("stoppedThere") == Some(&Value::Bool(false))
            });
            retained.insert("nativeOpenRemoteDelegatedTask".into(), json!(open));
        }
        if name == ITEMS {
            let mut files = Vec::new();
            if text(row, "type")? == "user_input_request" {
                // Preserve JSON question-key insertion order, as json_each does.
                if let Some(fields) = object_fields(raw)? {
                    if let Some(answer) = field(&fields, "questionAnswer")
                        .map(object_fields)
                        .transpose()?
                        .flatten()
                    {
                        if let Some(questions) = field(&answer, "attachmentsByQuestionId")
                            .map(object_fields)
                            .transpose()?
                            .flatten()
                        {
                            for question in &questions {
                                let values: Value = serde_json::from_str(
                                    field(&questions, &question.name)
                                        .ok_or(Error::IncompatibleStore)?,
                                )
                                .map_err(|_| Error::IncompatibleStore)?;
                                for item in values.as_array().into_iter().flatten() {
                                    files.push(item.get("id").cloned().unwrap_or(Value::Null));
                                }
                            }
                        }
                    }
                }
            }
            retained.insert("nativeAnswerAttachmentIds".into(), json!(files));
            for (field, source) in [
                ("nativeFailureClass", "class"),
                ("nativeFailureResetAt", "resetAt"),
            ] {
                if let Some(value) = payload
                    .get("failure")
                    .and_then(|failure| failure.get(source))
                {
                    retained.insert(field.into(), value.clone());
                }
            }
            if text(row, "type")? == "user_message" {
                retained.insert(
                    "nativeAttachmentIds".into(),
                    json!(
                        payload
                            .get("attachments")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|attachment| attachment.get("id").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            let lower = raw.to_ascii_lowercase();
            retained.insert(
                "nativeAttachmentRender".into(),
                json!(
                    lower.contains("htmlrender")
                        || lower.contains("t3mcpapp")
                        || lower.contains("preview_recording_stop")
                ),
            );
            let inline = if row.contains_key("inline_work_output") {
                integer(row, "inline_work_output")? == 1
            } else {
                inline_work_output(&text(row, "type")?, raw)
            };
            retained.insert("nativeInlineWorkOutput".into(), json!(inline));
        }
        slim.insert(
            "payload_json".into(),
            text_cell(&serde_json::to_string(&retained).map_err(|_| Error::IncompatibleStore)?),
        );
    }
    Ok(Metadata {
        table: name.into(),
        primary: primary(name, row)?,
        order,
        row: slim,
    })
}

pub(super) async fn insert(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    name: &str,
    row: &Map<String, Value>,
    order: RowOrder,
) -> Result<()> {
    let metadata = compact(name, row, order)?;
    tx.put(key(catalog, name, &metadata.primary), encode(&metadata)?)
        .await
}

pub(super) async fn remove(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    name: &str,
    row: &Map<String, Value>,
    order: RowOrder,
    strict: bool,
) -> Result<()> {
    let expected = compact(name, row, order)?;
    let key = key(catalog, name, &expected.primary);
    match tx.get(&key).await? {
        Some(bytes) if decode::<Metadata>(&bytes)? == expected => tx.delete(key).await,
        None if !strict => Ok(()),
        _ => Err(Error::IncompatibleStore),
    }
}

pub(crate) async fn equal_metadata(
    session: &mut Session,
    name: &str,
    column: &str,
    value: &Value,
) -> Result<Vec<IndexedRow>> {
    ensure_ready(session).await?;
    if !SPECS.iter().any(|spec| spec.name == name)
        || !(column == "all"
            || RELATIONSHIPS.contains(&column)
            || derived::COLUMNS.contains(&column))
    {
        return Err(invalid("unsupported projection window relationship"));
    }
    let prefix = index_prefix(&session.catalog, name, column, value);
    let end = prefix_end(&prefix);
    let metadata_prefix = location(&session.catalog, &format!("window-meta/{name}/"));
    if session.read_snapshot_validation.is_some() {
        let name = name.to_owned();
        let column = column.to_owned();
        let value = value.clone();
        return session
            .transaction
            .read_snapshot(move |reader| {
                let mut cursor = prefix.clone();
                let mut result = Vec::new();
                loop {
                    let page = reader.scan(&cursor, &end, 128)?;
                    let count = page.len();
                    for (index, bytes) in page {
                        let (witness, digest) =
                            validated_witness(&prefix, &name, &column, &value, &index, &bytes)?;
                        let mut key = metadata_prefix.clone();
                        key.extend_from_slice(digest.as_bytes());
                        let metadata = reader
                            .decode(&key, decode)?
                            .ok_or(Error::IncompatibleStore)?;
                        result.push(validated_row(&witness, metadata)?);
                        cursor = index;
                        cursor.push(0);
                    }
                    if count < 128 {
                        return Ok(result);
                    }
                }
            })
            .await;
    }
    let mut cursor = prefix.clone();
    let mut result = Vec::new();
    loop {
        let page = session.transaction.scan(&cursor, &end, 128).await?;
        let count = page.len();
        for (index, bytes) in page {
            let (witness, digest) =
                validated_witness(&prefix, name, column, value, &index, &bytes)?;
            let mut key = metadata_prefix.clone();
            key.extend_from_slice(digest.as_bytes());
            let bytes = session
                .transaction
                .get(&key)
                .await?
                .ok_or(Error::IncompatibleStore)?;
            result.push(validated_row(&witness, decode(&bytes)?)?);
            cursor = index;
            cursor.push(0);
        }
        if count < 128 {
            return Ok(result);
        }
    }
}

fn validated_witness(
    prefix: &[u8],
    name: &str,
    column: &str,
    value: &Value,
    index: &[u8],
    bytes: &[u8],
) -> Result<(IndexRow, String)> {
    let witness: IndexRow = decode(bytes)?;
    if witness.table != name || witness.column != column || &witness.value != value {
        return Err(Error::IncompatibleStore);
    }
    let digest = request_digest(&json!(witness.primary));
    if index.strip_prefix(prefix) != Some(digest.as_bytes()) {
        return Err(Error::IncompatibleStore);
    }
    Ok((witness, digest))
}

fn validated_row(witness: &IndexRow, metadata: Metadata) -> Result<IndexedRow> {
    if metadata.table != witness.table
        || metadata.primary != witness.primary
        || metadata.order != witness.order
    {
        return Err(Error::IncompatibleStore);
    }
    Ok(IndexedRow {
        row: metadata.row,
        order: metadata.order,
    })
}

pub(crate) async fn read_metadata(
    session: &mut Session,
    name: &str,
    id: &str,
) -> Result<Option<IndexedRow>> {
    ensure_ready(session).await?;
    let primary = vec![text_cell(id)];
    let Some(bytes) = session
        .transaction
        .get(&key(&session.catalog, name, &primary))
        .await?
    else {
        return Ok(None);
    };
    let metadata: Metadata = decode(&bytes)?;
    if metadata.table != name || metadata.primary != primary {
        return Err(Error::IncompatibleStore);
    }
    Ok(Some(IndexedRow {
        row: metadata.row,
        order: metadata.order,
    }))
}

#[cfg(test)]
mod compact_tests {
    use super::*;

    #[tokio::test]
    async fn metadata_scan_preserves_page_order_and_snapshot_validation() {
        use crate::application::ApplicationTransactionMode;
        use crate::test_support::TestFixture;

        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        store.bootstrap_application().await.unwrap();
        while !store
            .prepare_application_projection_reads()
            .await
            .unwrap()
            .prepared
        {}
        let catalog =
            decode_catalog(&store.db.read(&schema_key()).await.unwrap().unwrap()).unwrap();
        let mut tx = store.db.begin().await.unwrap();
        let mut row = spec(ITEMS)
            .columns
            .iter()
            .map(|(name, kind)| {
                let cell = match kind {
                    T => text_cell("fixture"),
                    I => int_cell(1),
                    NT | NI => nullable_cell(None),
                };
                ((*name).to_owned(), cell)
            })
            .collect::<Map<String, Value>>();
        row.insert("type".into(), text_cell("user_message"));
        row.insert("payload_json".into(), text_cell("{}"));
        row.insert("thread_id".into(), text_cell("history-thread"));
        let selected = text_cell("history-thread");
        let mut last = None;
        for ordinal in 1..=129 {
            row.insert("turn_item_id".into(), text_cell(&format!("item-{ordinal}")));
            let order = RowOrder { epoch: 1, ordinal };
            insert_entries(&mut tx, &catalog, ITEMS, &row, order)
                .await
                .unwrap();
            let witness = entries(ITEMS, &row, order)
                .unwrap()
                .into_iter()
                .find(|entry| entry.column == "thread_id")
                .unwrap();
            let index = index_key(&catalog, &witness);
            if last.as_ref().is_none_or(|(key, _)| &index > key) {
                last = Some((index, witness));
            }
        }
        tx.commit().await.unwrap();

        let mut application = ApplicationTransactions::new(store.clone());
        application
            .begin_mode("reader", ApplicationTransactionMode::Read, None)
            .await
            .unwrap();
        let mut reader = application.take("reader").unwrap();
        application
            .begin_mode("writer", ApplicationTransactionMode::Write, None)
            .await
            .unwrap();
        let mut writer = application.take("writer").unwrap();

        let expected = equal_metadata(&mut writer, ITEMS, "thread_id", &selected)
            .await
            .unwrap();
        assert_eq!(expected.len(), 129);
        let (mut index, witness) = last.unwrap();
        writer.transaction.delete(index.clone()).await.unwrap();
        index.push(b'x');
        writer
            .transaction
            .put(index, encode(&witness).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            equal_metadata(&mut writer, ITEMS, "thread_id", &selected).await,
            Err(Error::IncompatibleStore)
        ));
        writer.transaction.commit().await.unwrap();

        let old = equal_metadata(&mut reader, ITEMS, "thread_id", &selected)
            .await
            .unwrap();
        assert_eq!(old.len(), expected.len());
        for (old, expected) in old.into_iter().zip(expected) {
            assert_eq!(old.order, expected.order);
            assert_eq!(old.row, expected.row);
        }
        reader.transaction.rollback().await.unwrap();

        application
            .begin_mode("fresh", ApplicationTransactionMode::Read, None)
            .await
            .unwrap();
        let mut fresh = application.take("fresh").unwrap();
        assert!(matches!(
            equal_metadata(&mut fresh, ITEMS, "thread_id", &selected).await,
            Err(Error::IncompatibleStore)
        ));
        fresh.transaction.rollback().await.unwrap();
    }

    #[test]
    fn shell_metadata_drops_bodies_and_keeps_idle_compaction_flags() {
        let row=Map::from_iter([
            ("message_id".into(),text_cell("message:compact")),
            ("role".into(),text_cell("user")),
            ("payload_json".into(),text_cell(&json!({
                "text":"\u{00a0}/COMPACT\u{feff}","attachments":[],"createdBy":"agent","creationSource":"server",
                "unrelatedBody":"private-body".repeat(10000)
            }).to_string())),
        ]);
        let compact = compact(
            MESSAGES,
            &row,
            RowOrder {
                epoch: 0,
                ordinal: 3,
            },
        )
        .expect("compact message");
        let encoded = text(&compact.row, "payload_json").expect("metadata");
        assert!(encoded.len() < 512);
        assert!(!encoded.contains("private-body"));
        let parsed: Value = serde_json::from_str(&encoded).expect("valid compact payload");
        assert_eq!(parsed["nativeIdleCompactionMessage"], true);
        assert!(parsed.get("text").is_none());
    }

    #[test]
    fn corrupt_payload_remains_auditable_without_copying_corrupt_bytes() {
        let row = Map::from_iter([
            ("message_id".into(), text_cell("message:corrupt")),
            ("role".into(), text_cell("user")),
            (
                "payload_json".into(),
                text_cell(&format!("{{{}", "private-body".repeat(10000))),
            ),
        ]);
        let compact = compact(
            MESSAGES,
            &row,
            RowOrder {
                epoch: 0,
                ordinal: 5,
            },
        )
        .expect("index malformed source without losing it");
        let encoded = text(&compact.row, "payload_json").expect("metadata");
        assert!(encoded.len() < 32);
        assert!(serde_json::from_str::<Value>(&encoded).is_err());
        assert_eq!(
            text(&row, "payload_json").expect("original remains").len(),
            120001
        );
    }
}
