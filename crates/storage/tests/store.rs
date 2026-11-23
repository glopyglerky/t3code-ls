#[path = "../src/test_support.rs"]
mod test_support;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use t3_code_ls_storage::OutboxBatch;
use t3_code_ls_storage::outbox::{CancelUnsettled, Claim, EffectType, EnqueueEffect, Settle};
use t3_code_ls_storage::{CommitBatch, Error, ProjectionMutation, Record, Store, request_digest};

fn batch(command: &str, revision: u64) -> CommitBatch {
    CommitBatch {
        command_id: command.to_owned(),
        request_digest: request_digest(&json!({"command": command})),
        expected_revision: revision,
        events: vec![Record {
            id: format!("event:{command}"),
            payload: json!({"nested": {"null": null}, "number": 7}),
        }],
        projections: vec![ProjectionMutation::Put {
            key: "project:one".into(),
            payload: json!({"title": command, "optional": null}),
        }],
        effects: vec![Record {
            id: format!("effect:{command}"),
            payload: json!({"type": "cleanup"}),
        }],
        result: json!({"accepted": true}),
    }
}

#[tokio::test]
async fn atomic_batch_receipt_and_stale_snapshot() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    assert_eq!(store.snapshot().await.unwrap().revision, 0);
    let command = batch("one", 0);
    let result = store.commit(&command).await.unwrap();
    assert!(!result.replayed);
    assert_eq!(result.receipt.first_sequence, Some(1));
    assert_eq!(result.receipt.last_sequence, 1);
    assert_eq!(
        store.events(0, 100).await.unwrap()[0].payload,
        command.events[0].payload
    );
    assert_eq!(store.pending_effects(100).await.unwrap().len(), 1);
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.revision, 1);
    assert_eq!(
        snapshot.projections[0].payload,
        json!({"title":"one", "optional":null})
    );
    assert_eq!(
        store.read_receipt("one").await.unwrap(),
        Some(result.receipt.clone())
    );
    let replay = store.commit(&command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, result.receipt);
    assert_eq!(store.events(0, 100).await.unwrap().len(), 1);
    let mut wrong = command.clone();
    wrong.request_digest = request_digest(&json!({"other": "request"}));
    assert!(matches!(
        store.commit(&wrong).await,
        Err(Error::CommandConflict)
    ));
    assert!(matches!(
        store.commit(&batch("stale", 0)).await,
        Err(Error::StaleRevision {
            expected: 0,
            actual: 1
        })
    ));
    assert_eq!(store.snapshot().await.unwrap(), snapshot);
    assert!(store.read_receipt("stale").await.unwrap().is_none());
}

#[tokio::test]
async fn late_duplicate_rolls_back_every_part_of_batch() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    store.commit(&batch("first", 0)).await.unwrap();
    let before = store.snapshot().await.unwrap();
    let mut collision = batch("collision", 1);
    collision.effects[0].id = "effect:first".into();
    assert!(matches!(
        store.commit(&collision).await,
        Err(Error::DuplicateRecord)
    ));
    assert_eq!(store.snapshot().await.unwrap(), before);
    assert_eq!(store.events(0, 100).await.unwrap().len(), 1);
    assert_eq!(store.pending_effects(100).await.unwrap().len(), 1);
    assert!(store.read_receipt("collision").await.unwrap().is_none());
    let committed = store.commit(&batch("next", 1)).await.unwrap();
    assert_eq!(committed.receipt.first_sequence, Some(2));
}

fn worker_effect(id: &str, command: &str) -> EnqueueEffect {
    EnqueueEffect {
        id: id.into(),
        command_id: command.into(),
        thread_id: "thread-one".into(),
        request: json!({"type": "terminal.cleanup"}),
        available_at: None,
    }
}

#[tokio::test]
async fn outbox_commit_replays_enqueues_and_cancellations_without_reapplying_them() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    let now = "2026-11-08T12:00:00.000Z";
    store
        .outbox_enqueue(&[worker_effect("old", "before")], now)
        .await
        .unwrap();
    let old = store
        .outbox_claim_next(&Claim {
            worker_id: "worker-old".into(),
            now: now.into(),
            exclude_restart_continuations: false,
            max_running_title_generations: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old.id, "old");
    let command = batch("atomic-worker", 0);
    let envelope = OutboxBatch {
        enqueue: vec![EnqueueEffect {
            request: json!({"type": "preview.cleanup"}),
            ..worker_effect("new", "atomic-worker")
        }],
        enqueue_at: now.into(),
        cancel: vec![CancelUnsettled {
            thread_id: "thread-one".into(),
            effect_types: vec![EffectType::TerminalCleanup],
            reason: "Thread stopped".into(),
            now: now.into(),
        }],
    };
    let committed = store.commit_outbox(&command, &envelope).await.unwrap();
    assert!(!committed.commit.replayed);
    assert_eq!(committed.enqueued, 1);
    assert_eq!(committed.cancelled, ["old"]);
    assert_eq!(store.snapshot().await.unwrap().last_sequence, 1);
    assert!(
        !store
            .outbox_succeed(&Settle {
                effect_id: "old".into(),
                worker_id: "worker-old".into(),
                now: now.into(),
            })
            .await
            .unwrap()
    );
    let claimed = store
        .outbox_claim_next(&Claim {
            worker_id: "worker-new".into(),
            now: now.into(),
            exclude_restart_continuations: false,
            max_running_title_generations: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.id, "new");
    assert!(
        store
            .outbox_succeed(&Settle {
                effect_id: "new".into(),
                worker_id: "worker-new".into(),
                now: now.into(),
            })
            .await
            .unwrap()
    );
    let finished = store.outbox_get("new").await.unwrap().unwrap();
    store.shutdown().await.unwrap();
    let reopened = fixture.connect().await;
    let replay = reopened.commit_outbox(&command, &envelope).await.unwrap();
    assert!(replay.commit.replayed);
    assert_eq!(replay.commit.receipt, committed.commit.receipt);
    assert_eq!(replay.enqueued, 1);
    assert_eq!(replay.cancelled, ["old"]);
    assert_eq!(reopened.outbox_get("new").await.unwrap(), Some(finished));
    assert_eq!(reopened.events(0, 10).await.unwrap().len(), 1);
    assert_eq!(
        reopened.read_outbox_receipt("atomic-worker").await.unwrap(),
        Some(replay)
    );
}

#[tokio::test]
async fn outbox_envelope_identity_and_failures_leave_all_state_unchanged() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    let envelope = OutboxBatch {
        enqueue: vec![worker_effect("new", "atomic-worker")],
        enqueue_at: "2026-11-08T12:00:00.000Z".into(),
        cancel: vec![],
    };
    let command = batch("atomic-worker", 0);
    store.commit_outbox(&command, &envelope).await.unwrap();
    let before = store.snapshot().await.unwrap();
    let mut changed = envelope.clone();
    changed.enqueue[0].thread_id = "different-thread".into();
    assert!(matches!(
        store.commit_outbox(&command, &changed).await,
        Err(Error::CommandConflict)
    ));
    assert!(matches!(
        store.commit(&command).await,
        Err(Error::CommandConflict)
    ));
    assert!(matches!(
        store.commit_outbox(&batch("stale", 0), &envelope).await,
        Err(Error::StaleRevision { .. })
    ));
    let mut duplicate_event = batch("collision", 1);
    duplicate_event.events[0].id = "event:atomic-worker".into();
    let mut distinct = envelope.clone();
    distinct.enqueue[0].id = "must-not-exist".into();
    assert!(matches!(
        store.commit_outbox(&duplicate_event, &distinct).await,
        Err(Error::DuplicateRecord)
    ));
    assert!(store.outbox_get("must-not-exist").await.unwrap().is_none());
    assert!(
        store
            .read_outbox_receipt("collision")
            .await
            .unwrap()
            .is_none()
    );
    assert!(store.read_receipt("collision").await.unwrap().is_none());
    assert_eq!(store.snapshot().await.unwrap(), before);
    let plain = batch("plain", 1);
    store.commit(&plain).await.unwrap();
    assert!(matches!(
        store.commit_outbox(&plain, &envelope).await,
        Err(Error::CommandConflict)
    ));
    assert!(store.read_outbox_receipt("plain").await.unwrap().is_none());
}

#[tokio::test]
async fn concurrent_sessions_cannot_both_commit_a_stale_plan() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    let other = fixture.connect().await;
    let left = batch("left", 0);
    let mut right = batch("right", 0);
    right.projections = vec![ProjectionMutation::Put {
        key: "project:two".into(),
        payload: json!({"independent_project": true}),
    }];
    let (left, right) = tokio::join!(store.commit(&left), other.commit(&right));
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let rejected = if left.is_err() { left } else { right };
    assert!(matches!(
        rejected,
        Err(Error::TransactionConflict | Error::StaleRevision { .. })
    ));
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.last_sequence, 1);
    assert_eq!(store.events(0, 100).await.unwrap().len(), 1);
    assert_eq!(store.pending_effects(100).await.unwrap().len(), 1);
}

#[tokio::test]
async fn null_projection_and_delete_have_distinct_meanings() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut put = batch("put-null", 0);
    put.events.clear();
    put.effects.clear();
    put.projections = vec![ProjectionMutation::Put {
        key: "nullable".into(),
        payload: Value::Null,
    }];
    let outcome = store.commit(&put).await.unwrap();
    assert_eq!(outcome.receipt.first_sequence, None);
    assert_eq!(outcome.receipt.last_sequence, 0);
    assert_eq!(
        store.snapshot().await.unwrap().projections[0].payload,
        Value::Null
    );
    assert!(store.commit(&put).await.unwrap().replayed);
    let mut delete = batch("delete-null", 1);
    delete.events.clear();
    delete.effects.clear();
    delete.projections = vec![ProjectionMutation::Delete {
        key: "nullable".into(),
    }];
    store.commit(&delete).await.unwrap();
    assert!(store.snapshot().await.unwrap().projections.is_empty());
}

#[tokio::test]
async fn arbitrary_identifiers_and_invalid_batches_never_change_state() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    let mut valid = batch("x'); DELETE ls_meta; --", 0);
    valid.projections[0] = ProjectionMutation::Put {
        key: "复杂 / key:[]{}'".into(),
        payload: json!({"text": "NONE", "number": 9007199254740991_u64, "uint64": u64::MAX, "int64": i64::MIN}),
    };
    store.commit(&valid).await.unwrap();
    let before = store.snapshot().await.unwrap();
    assert_eq!(before.projections[0].key, "复杂 / key:[]{}'");
    assert_eq!(
        before.projections[0].payload["uint64"].as_u64(),
        Some(u64::MAX)
    );
    assert_eq!(
        before.projections[0].payload["int64"].as_i64(),
        Some(i64::MIN)
    );
    let mut invalid = batch("duplicate", 1);
    invalid.events.push(invalid.events[0].clone());
    assert!(matches!(
        store.commit(&invalid).await,
        Err(Error::Invalid(_))
    ));
    invalid.events.pop();
    invalid.request_digest = "not-a-hash".into();
    assert!(matches!(
        store.commit(&invalid).await,
        Err(Error::Invalid(_))
    ));
    invalid.request_digest = "a".repeat(64);
    invalid.command_id = "nul\0id".into();
    assert!(matches!(
        store.commit(&invalid).await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(store.snapshot().await.unwrap(), before);
}

#[tokio::test]
async fn oversized_snapshot_and_event_page_fail_without_truncating() {
    let fixture = test_support::TestFixture::start().await;
    let store = fixture.initialize().await;
    for index in 0..2 {
        let mut command = batch(&format!("large-{index}"), index * 2);
        let payload = json!({"text": "x".repeat(9 * 1024 * 1024)});
        command.events[0].payload = payload.clone();
        command.projections.clear();
        command.effects.clear();
        // Each commit stays below the 16 MiB batch limit; the later page exceeds it.
        store.commit(&command).await.unwrap();
        let mut projection = batch(&format!("projection-{index}"), index * 2 + 1);
        projection.events.clear();
        projection.effects.clear();
        projection.projections = vec![ProjectionMutation::Put {
            key: format!("large:{index}"),
            payload,
        }];
        store.commit(&projection).await.unwrap();
    }
    assert!(matches!(store.snapshot().await, Err(Error::Invalid(_))));
    let mut project = batch("bounded-project", 4);
    project.events.clear();
    project.effects.clear();
    project.projections = vec![ProjectionMutation::Put {
        key: "project/scoped".into(),
        payload: json!({"projectId": "scoped"}),
    }];
    store.commit(&project).await.unwrap();
    let scoped = store.project_snapshot().await.unwrap();
    assert_eq!(scoped.revision, 5);
    assert_eq!(scoped.last_sequence, 2);
    assert_eq!(scoped.projections.len(), 1);
    assert_eq!(scoped.projections[0].key, "project/scoped");
    assert!(matches!(store.snapshot().await, Err(Error::Invalid(_))));
    assert!(matches!(store.events(0, 2).await, Err(Error::Invalid(_))));
    assert_eq!(store.events(0, 1).await.unwrap().len(), 1);
    assert_eq!(store.events(1, 1).await.unwrap().len(), 1);
}

#[tokio::test]
async fn acknowledged_batch_survives_process_kill_and_reopens() {
    let mut fixture = test_support::TestFixture::start().await;
    fixture.initialize().await.shutdown().await.unwrap();
    let executable = env!("CARGO_BIN_EXE_t3-code-ls-db");
    let mut child = Command::new(executable)
        .arg("local")
        .arg(fixture.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let command = batch("durable", 0);
    serde_json::to_writer(&mut stdin, &json!({"operation":"commit", "batch":command})).unwrap();
    writeln!(stdin).unwrap();
    stdin.flush().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let acknowledgement: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(acknowledgement["ok"], true, "{acknowledgement}");
    child.kill().unwrap();
    child.wait().unwrap();
    fixture.restart().await;
    let mut reader = Command::new(executable)
        .arg("local")
        .arg(fixture.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = reader.stdin.take().unwrap();
    writeln!(input, "{{\"operation\":\"snapshot\"}}").unwrap();
    writeln!(
        input,
        "{{\"operation\":\"receipt\",\"command_id\":\"durable\"}}"
    )
    .unwrap();
    drop(input);
    let output = reader.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["result"]["revision"], 1);
    assert_eq!(lines[0]["result"]["last_sequence"], 1);
    assert_eq!(
        lines[0]["result"]["projections"][0]["payload"]["title"],
        "durable"
    );
    assert_eq!(lines[1]["result"], acknowledgement["result"]["receipt"]);
}

#[cfg(unix)]
#[tokio::test]
async fn service_trial_restore_cli_reports_one_result_and_prepares_reopenable_stage() {
    use std::fs;
    use t3_code_ls_storage::application::ApplicationTransactions;
    use t3_code_ls_storage::application_server_ownership::OwnerLock;

    const UPDATE_ID: &str = "aa212c2b-63d4-4b28-97e4-1c1d6dc6d281";
    let fixture = test_support::TestFixture::start().await;
    let home = fs::canonicalize(fixture.path().parent().unwrap()).unwrap();
    let state = home.join("userdata");
    fs::create_dir(&state).unwrap();
    fs::create_dir(home.join("runtime")).unwrap();
    let owner = OwnerLock::acquire(&state.join("server-owner.sqlite")).unwrap();
    let database = state.join("statev2.omdb");
    let store = Store::initialize_local(&database).await.unwrap();
    store.bootstrap_application().await.unwrap();
    store.commit(&batch("before", 0)).await.unwrap();
    let identity = ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await
        .unwrap()
        .unwrap();
    store.shutdown().await.unwrap();
    owner.activate_native().unwrap();
    drop(owner);

    let executable = env!("CARGO_BIN_EXE_t3-code-ls-db");
    let output = Command::new(executable)
        .arg("trial-backup")
        .arg(&home)
        .args([UPDATE_ID, &identity.catalog_sha256])
        .output()
        .unwrap();
    assert!(output.status.success());
    let backup: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(backup["ok"], true);
    let snapshot = json!({
        "catalog_sha256": identity.catalog_sha256,
        "rows": backup["result"]["backup"]["rows"],
        "checksum": backup["result"]["backup"]["checksum"],
    });
    let mut request = json!({
        "update_id": UPDATE_ID,
        "phase": "committed",
        "database": backup["result"]["database"],
        "checkpoint": snapshot,
        "target": snapshot,
    });
    let run_restore = |mode, request: &Value| {
        let mut child = Command::new(executable)
            .arg(mode)
            .arg(&home)
            .arg(UPDATE_ID)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        serde_json::to_writer(child.stdin.take().unwrap(), request).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(
            output.stdout.iter().filter(|byte| **byte == b'\n').count(),
            1
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let prepare = |request: &Value| run_restore("trial-prepare-restore", request);

    let stage = state.join(format!(".statev2-restore-{UPDATE_ID}.omdb"));
    let live_bytes = fs::read(&database).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "invalid_request");
    assert!(!stage.exists());
    request["phase"] = json!("failed-before-activation");
    let preparation = prepare(&request)["result"].clone();
    assert_eq!(preparation["reused"], false);
    assert_eq!(prepare(&request)["result"]["reused"], true);
    let reopened = Store::open_read_only(&stage).await.unwrap();
    assert!(reopened.read_receipt("before").await.unwrap().is_some());
    reopened.shutdown().await.unwrap();
    assert_eq!(fs::read(&database).unwrap(), live_bytes);

    #[cfg(target_os = "linux")]
    {
        use sha2::{Digest, Sha256};

        let publish = |request: &Value| run_restore("trial-publish-restore-offline", request);
        let checkpoint = home.join(format!("runtime/native-db-backup/{UPDATE_ID}.omdb"));
        let checkpoint_bytes = fs::read(&checkpoint).unwrap();
        let stage_bytes = fs::read(&stage).unwrap();
        let preserved = state.join(format!(".statev2-failed-{UPDATE_ID}.omdb"));
        let mut publication = json!({"restore": request, "preparation": preparation});
        assert_eq!(publish(&publication)["error"]["kind"], "invalid_request");
        assert!(!preserved.exists());
        let target_digest: String = Sha256::digest(&live_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        publication["witness"] = json!({
            "kind": "offline-pre-activation",
            "target_file_sha256": target_digest,
        });
        let published = publish(&publication);
        assert_eq!(published["ok"], true, "{published}");
        assert_eq!(published["result"]["reused"], false);
        assert_eq!(
            published["result"]["database"],
            preparation["staged_database"]
        );
        assert_eq!(publish(&publication)["result"]["reused"], true);
        assert!(!stage.exists());
        assert_eq!(fs::read(&database).unwrap(), stage_bytes);
        assert_eq!(fs::read(&preserved).unwrap(), live_bytes);
        assert_eq!(fs::read(&checkpoint).unwrap(), checkpoint_bytes);
        let reopened = Store::open_read_only(&database).await.unwrap();
        assert!(reopened.read_receipt("before").await.unwrap().is_some());
        reopened.shutdown().await.unwrap();
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn isolated_trial_cli_restarts_from_checkpoint_after_interruption() {
    use sha2::{Digest, Sha256};
    use std::fs;
    use t3_code_ls_storage::application::ApplicationTransactions;
    use t3_code_ls_storage::application_server_ownership::OwnerLock;

    const UPDATE: &str = "aa212c2b-63d4-4b28-97e4-1c1d6dc6d281";
    let fixture = test_support::TestFixture::start().await;
    let home = fs::canonicalize(fixture.path().parent().unwrap()).unwrap();
    let state = home.join("userdata");
    let runtime = home.join("runtime");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&runtime).unwrap();
    let selection = runtime.join("service-state.json");
    fs::write(&selection, b"existing runtime selection").unwrap();
    let owner_path = state.join("server-owner.sqlite");
    let owner = OwnerLock::acquire(&owner_path).unwrap();
    let live = state.join("statev2.omdb");
    let store = Store::initialize_local(&live).await.unwrap();
    store.bootstrap_application().await.unwrap();
    store.commit(&batch("original", 0)).await.unwrap();
    let identity = ApplicationTransactions::new(store.clone())
        .generation_identity()
        .await
        .unwrap()
        .unwrap();
    store.shutdown().await.unwrap();
    owner.activate_native().unwrap();
    drop(owner);

    let executable = env!("CARGO_BIN_EXE_t3-code-ls-db");
    let backup = Command::new(executable)
        .arg("trial-backup")
        .arg(&home)
        .args([UPDATE, &identity.catalog_sha256])
        .output()
        .unwrap();
    assert!(backup.status.success());
    let backup: Value = serde_json::from_slice(&backup.stdout).unwrap();
    assert_eq!(backup["ok"], true, "{backup}");
    let sha256 = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    let definition = include_bytes!("../../../apps/server/src/persistence/omdb-schema.json");
    let capabilities = Command::new(executable)
        .arg("trial-capabilities")
        .output()
        .unwrap();
    assert!(capabilities.status.success());
    assert!(capabilities.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&capabilities.stdout).unwrap(),
        json!({
            "ok": true,
            "result": {
                "version": 1,
                "engine": identity.engine,
                "engineRevision": identity.engine_revision,
                "targetSchemaSha256": sha256(definition),
            },
        })
    );
    let mut request = json!({
        "update_id": UPDATE,
        "database": backup["result"]["database"],
        "checkpoint": {
            "catalog_sha256": identity.catalog_sha256,
            "rows": backup["result"]["backup"]["rows"],
            "checksum": backup["result"]["backup"]["checksum"],
        },
        "target_schema_sha256": sha256(definition),
    });
    let run_trial = |operation: &str, request: &Value| {
        let mut child = Command::new(executable)
            .arg(operation)
            .arg(&home)
            .arg(UPDATE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        serde_json::to_writer(child.stdin.take().unwrap(), request).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout.iter().filter(|byte| **byte == b'\n').count(),
            1
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let prepare = |request: &Value| run_trial("trial-prepare-isolated", request);
    let verify = |request: &Value, preparation: &Value| {
        run_trial(
            "trial-verify-isolated",
            &json!({"request": request, "preparation": preparation}),
        )
    };
    let checkpoint = runtime.join(format!("native-db-backup/{UPDATE}.omdb"));
    let trial = state.join(format!(".statev2-trial-{UPDATE}.omdb"));
    let working = trial.with_extension("staging");
    let receipt_path = trial.with_extension("receipt-v1.json");
    let before = fs::read(&live).unwrap();
    let original_checkpoint = fs::read(&checkpoint).unwrap();

    let backup_receipt = checkpoint.with_extension("backup-receipt-v1.json");
    let held_receipt = backup_receipt.with_extension("held");
    fs::rename(&backup_receipt, &held_receipt).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    assert_eq!(fs::read(&checkpoint).unwrap(), original_checkpoint);
    assert!(!trial.exists());
    fs::rename(&held_receipt, &backup_receipt).unwrap();

    let target_digest = request["target_schema_sha256"].clone();
    request["target_schema_sha256"] = json!("0".repeat(64));
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    request["target_schema_sha256"] = target_digest;
    let source_identity = request["database"].clone();
    request["database"]["inode"] = json!("0000000000000000");
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    request["database"] = source_identity;
    let owner = OwnerLock::acquire(&owner_path).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "writer_busy");
    drop(owner);
    fs::hard_link(&checkpoint, &working).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    fs::remove_file(&working).unwrap();
    std::os::unix::fs::symlink(&live, &working).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    fs::remove_file(&working).unwrap();
    assert!(!trial.exists());

    // Model a process killed after a durable write to the working database.
    fs::copy(&checkpoint, &working).unwrap();
    let mut interrupted = Command::new(executable)
        .arg("exclusive-local")
        .arg(&working)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let command = json!({"operation": "commit", "batch": batch("interrupted", 1)});
    writeln!(interrupted.stdin.as_mut().unwrap(), "{command}").unwrap();
    let mut response = String::new();
    BufReader::new(interrupted.stdout.take().unwrap())
        .read_line(&mut response)
        .unwrap();
    interrupted.kill().unwrap();
    interrupted.wait().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap()["ok"],
        true
    );
    assert!(!trial.exists());

    // A previous helper may have published the candidate just before it stopped.
    fs::copy(&checkpoint, &trial).unwrap();
    assert!(!receipt_path.exists());
    let mut previous_preparation = None;
    for _ in 0..2 {
        let prepared = prepare(&request);
        assert_eq!(prepared["ok"], true, "{prepared}");
        assert_ne!(prepared["result"]["database"], request["database"]);
        assert_eq!(prepared["result"]["snapshot"], request["checkpoint"]);
        let trial_bytes = fs::read(&trial).unwrap();
        assert_eq!(prepared["result"]["file_sha256"], sha256(&trial_bytes));
        let receipt = &prepared["result"];
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&receipt_path).unwrap()).unwrap(),
            json!({ "request": request, "preparation": receipt })
        );
        assert_eq!(
            verify(&request, receipt),
            json!({"ok": true, "result": {"verified": true}})
        );
        assert_eq!(fs::read(&trial).unwrap(), trial_bytes);
        let mut broken = receipt.clone();
        broken["file_sha256"] = json!("0".repeat(64));
        assert_eq!(
            verify(&request, &broken)["error"]["kind"],
            "incompatible_store"
        );
        if let Some(previous) = previous_preparation.replace(receipt.clone()) {
            assert_eq!(
                previous, *receipt,
                "Retry must return the same durable trial"
            );
        }
        let owner = OwnerLock::acquire(&owner_path).unwrap();
        assert_eq!(verify(&request, receipt)["error"]["kind"], "writer_busy");
        assert_eq!(prepare(&request)["error"]["kind"], "writer_busy");
        drop(owner);
        let reopened = Store::open_read_only(&trial).await.unwrap();
        assert!(reopened.read_receipt("original").await.unwrap().is_some());
        assert!(
            reopened
                .read_receipt("interrupted")
                .await
                .unwrap()
                .is_none()
        );
        reopened.shutdown().await.unwrap();
        assert_eq!(fs::read(&live).unwrap(), before);
        assert_eq!(fs::read(&checkpoint).unwrap(), original_checkpoint);
        assert!(!working.exists());
    }

    let old_result = fs::read(&trial).unwrap();
    let old_receipt = fs::read(&receipt_path).unwrap();
    fs::write(&receipt_path, vec![b' '; 8 * 1024 + 1]).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    assert_eq!(fs::read(&trial).unwrap(), old_result);
    fs::write(&receipt_path, &old_receipt).unwrap();

    let displaced = trial.with_extension("displaced");
    fs::rename(&trial, &displaced).unwrap();
    fs::copy(&displaced, &trial).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    assert_eq!(fs::read(&receipt_path).unwrap(), old_receipt);
    fs::rename(&displaced, &trial).unwrap();
    assert_eq!(prepare(&request)["ok"], true);

    let store = Store::open_local(&live).await.unwrap();
    store.commit(&batch("later", 1)).await.unwrap();
    store.shutdown().await.unwrap();
    let later = fs::read(&live).unwrap();
    assert_eq!(prepare(&request)["error"]["kind"], "incompatible_store");
    assert_eq!(fs::read(&live).unwrap(), later);
    assert_eq!(fs::read(&checkpoint).unwrap(), original_checkpoint);
    assert_eq!(fs::read(&trial).unwrap(), old_result);
    assert_eq!(fs::read(&receipt_path).unwrap(), old_receipt);
    assert_eq!(fs::read(&selection).unwrap(), b"existing runtime selection");
}

#[tokio::test]
async fn concurrent_helpers_reopen_after_crash_without_reading_unrecovered_state() {
    let executable = env!("CARGO_BIN_EXE_t3-code-ls-db");
    for round in 0..32 {
        let fixture = test_support::TestFixture::start().await;
        let spawn = |mode| {
            Command::new(executable)
                .arg(mode)
                .arg(fixture.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        };
        let mut initial = spawn("initialize-local");
        writeln!(
            initial.stdin.as_mut().unwrap(),
            "{{\"operation\":\"snapshot\"}}"
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(initial.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], true);
        initial.kill().unwrap();
        initial.wait().unwrap();

        let mut readers = [spawn("local"), spawn("local")];
        for reader in &mut readers {
            let mut input = reader.stdin.take().unwrap();
            writeln!(input, "{{\"operation\":\"snapshot\"}}").unwrap();
        }
        // Reap both owned processes before asserting either result.
        let outputs = readers.map(|reader| reader.wait_with_output().unwrap());
        for output in outputs {
            assert!(
                output.status.success(),
                "round {round}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let response: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                response,
                json!({"ok":true,"result":{"revision":0,"last_sequence":0,"projections":[]}}),
                "round {round}"
            );
            assert!(
                output.stderr.is_empty(),
                "round {round}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
