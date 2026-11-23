//! MIT. Untimed J02 event attribution for the observed fixture window.
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const SELECTED: &str = "import:codex:0251af00-0000-4000-8000-000000000000";
const BOUND: u64 = 16 * 1024 * 1024;

const FIRST_SEQUENCE: u64 = 12865;
const LAST_SEQUENCE: u64 = 12867;

fn sample_coordinates(sample: &Value, native: bool) -> Result<(Value, u64)> {
    if sample["journey"] != "J02"
        || sample["profile"] != if native { "native" } else { "stock" }
        || sample["native_lookups"] != false
        || !sample["persistence_spans"].is_null()
        || !sample["readiness_phases"].is_null()
        || sample["snapshot"]["valid"] != true
        || sample["snapshot"]["selectedThreadId"] != SELECTED
        || sample["snapshot"]["threadCount"] != 32
        || sample["snapshot"]["messageCount"] != 200
    {
        return Err("not the plain-1 fixture".into());
    }

    let mut through = FIRST_SEQUENCE;
    let mut coordinates = serde_json::Map::new();
    for (name, value) in [
        (
            "seed_http_thread_sequence",
            &sample["saved_thread_sequence"],
        ),
        (
            "reopen_ws_after_sequence",
            &sample["browser"]["threadResumeAfterSequence"],
        ),
        (
            "final_http_shell_sequence",
            &sample["snapshot"]["shellSequence"],
        ),
        (
            "final_http_thread_sequence",
            &sample["snapshot"]["threadSequence"],
        ),
    ] {
        let sequence = value
            .as_u64()
            .filter(|sequence| (FIRST_SEQUENCE..=LAST_SEQUENCE).contains(sequence))
            .ok_or_else(|| format!("{name} outside the observed fixture window"))?;
        through = through.max(sequence);
        coordinates.insert(name.to_owned(), json!(sequence));
    }
    Ok((Value::Object(coordinates), through))
}

fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(BOUND + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > BOUND {
        return Err("input bound exceeded".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

// timeout bounds child lifetime; stdout is bounded in memory and never logged raw.
fn capture(mut command: Command, input: &[u8]) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| -> Result<Vec<u8>> {
        child
            .stdin
            .take()
            .ok_or("missing input")?
            .write_all(input)?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or("missing output")?
            .take(BOUND + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > BOUND {
            return Err("diagnostic output bound exceeded".into());
        }
        if !child.wait()?.success() {
            return Err("read-only diagnostic command failed".into());
        }
        Ok(bytes)
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn native_rows(helper: &Path, database: &Path, through: u64) -> Result<Value> {
    let mut command = Command::new("timeout");
    command
        .args(["--kill-after=1s", "5s"])
        .arg(helper)
        .arg("read-only-local")
        .arg(database)
        .env_clear();
    let input = [
        json!({"operation":"application_begin","transaction_id":"cursor-diagnostic","mode":"read"}),
        json!({"operation":"application_events_read","transaction_id":"cursor-diagnostic",
            "after_sequence":FIRST_SEQUENCE - 1,"through_sequence":through,
            "limit":through - FIRST_SEQUENCE + 1}),
        json!({"operation":"application_rollback","transaction_id":"cursor-diagnostic"}),
    ]
    .iter()
    .map(|v| format!("{v}\n"))
    .collect::<String>();
    let bytes = capture(command, input.as_bytes())?;
    native_response(&bytes)
}

fn native_response(bytes: &[u8]) -> Result<Value> {
    let frames: Vec<Value> = bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(serde_json::from_slice)
        .collect::<std::result::Result<_, _>>()?;
    if frames.len() != 3 || frames.iter().any(|v| v["ok"] != true) {
        return Err("native read-only event inspection refused".into());
    }
    Ok(frames[1]["result"].clone())
}

fn sqlite_rows(database: &Path, through: u64) -> Result<Value> {
    // Immutable avoids even SHM creation. Refuse WAL content rather than ignore it.
    match fs::symlink_metadata(database.with_file_name("statev2.sqlite-wal")) {
        Ok(m) if m.file_type().is_file() && m.len() == 0 => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err("WAL requires a separately qualified stopped snapshot".into()),
    }
    let path = database.to_str().ok_or("invalid database path")?;
    if path.contains(['?', '#', '%']) {
        return Err("unsafe SQLite URI path".into());
    }
    let mut command = Command::new("timeout");
    command.args(["--kill-after=1s", "5s", "sqlite3", "-batch", "-bail", "-readonly", "-json"])
        .arg(format!("file:{path}?immutable=1"))
        .arg(format!("SELECT sequence, aggregate_kind, stream_id, event_type, application_event_version FROM orchestration_events WHERE sequence BETWEEN {FIRST_SEQUENCE} AND {through} ORDER BY sequence;"));
    Ok(serde_json::from_slice(&capture(command, b"")?)?)
}

fn categories(rows: &Value, through: u64) -> Result<Value> {
    let rows = rows
        .as_array()
        .filter(|rows| rows.len() as u64 == through - FIRST_SEQUENCE + 1)
        .ok_or("missing coordinate events")?;
    let mut output = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let kind = row["event_type"].as_str().ok_or("missing event type")?;
        if row["sequence"] != FIRST_SEQUENCE + index as u64 {
            return Err("unexpected coordinate event sequence".into());
        }
        if row["application_event_version"] != 2 {
            return Err("unexpected coordinate event version".into());
        }
        if !KNOWN_TYPES.contains(&kind) {
            return Err("coordinate event type absent from pinned contracts".into());
        }
        let owner = match row["aggregate_kind"].as_str() {
            Some("thread") if row["stream_id"] == SELECTED => "selected-thread",
            Some("thread") => {
                let id = row["stream_id"].as_str().ok_or("missing owner")?;
                let suffix = id
                    .strip_prefix("import:codex:0251af00-0000-4000-8000-")
                    .filter(|s| s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit()))
                    .ok_or("owner outside synthetic fixture")?;
                if suffix.parse::<u32>()? >= 32 {
                    return Err("owner outside synthetic fixture".into());
                }
                "other-fixture-thread"
            }
            Some("project") if row["stream_id"] == "reopen-fixture" => "fixture-project",
            _ => return Err("owner outside synthetic fixture".into()),
        };
        output.push(json!({"sequence":row["sequence"],"event_type":kind,"owner":owner}));
    }
    Ok(json!(output))
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let [mode, bundle, trial, sample] = args.as_slice() else {
        return Err(
            "usage: t16-cursor-diagnostic stock|native BUNDLE STOPPED_OWNED_TRIAL SAMPLE.json"
                .into(),
        );
    };
    let native = match mode.to_str() {
        Some("native") => true,
        Some("stock") => false,
        _ => return Err("unknown arm".into()),
    };
    let sample = read_json(Path::new(sample))?;
    let (coordinates, through) = sample_coordinates(&sample, native)?;
    let trial = fs::canonicalize(trial)?;
    if fs::canonicalize(trial.join("reopen-fixture"))?.to_str()
        != sample["fixture_workspace"].as_str()
    {
        return Err("sample does not own this fixture".into());
    }
    let state = trial.join("profile/userdata");
    let path = state.join(if native {
        "statev2.omdb"
    } else {
        "statev2.sqlite"
    });
    // No user-supplied database path and no symlink traversal outside the owned trial.
    let database = fs::canonicalize(&path)?;
    if database != path || !fs::metadata(&database)?.is_file() {
        return Err("expected exact-case regular fixture database".into());
    }
    let rows = if native {
        let bundle = fs::canonicalize(bundle)?;
        native_rows(
            &bundle
                .parent()
                .ok_or("bundle directory missing")?
                .join("native-bin/t3-code-ls-db"),
            &database,
            through,
        )?
    } else {
        sqlite_rows(&database, through)?
    };
    let events = categories(&rows, through)?;
    println!(
        "{}",
        json!({"kind":"plain-1-stopped-event-cursor-diagnostic","schema_version":2,
        "coordinates":coordinates,"events":events,"observation":"after probe exit and clean shutdown",
        "equivalence_qualified":false,"performance_qualified":false,"causal_attribution_qualified":false,
        "limits":["Stored event types and stream owners only; no actor, payload, command, timestamp or identity retained",
            "No exact event creation milestone or clock alignment follows from a stopped event row",
            "Original ordered-history, fixture hashes and strict match gates remain required and unchanged"]})
    );
    Ok(())
}

// Event names from the shipped candidate and the pinned stock contracts.
const KNOWN_TYPES: &[&str] = &[
    "run.output-submitted",
    "thread.issue-synced",
    "thread.visit-recorded",
    "checkpoint-scope.created",
    "checkpoint.captured",
    "checkpoint.rollback",
    "checkpoint.rollback-requested",
    "checkpoint.rollback.fail",
    "context-handoff.updated",
    "context-transfer.created",
    "context-transfer.updated",
    "message.dispatch",
    "message.updated",
    "node.updated",
    "notification.delivery.accept",
    "plan.updated",
    "prepared-run.fail",
    "prepared-run.progress",
    "prepared-run.release",
    "prepared-run.retry",
    "project.removed",
    "project.updated",
    "provider-session.attached",
    "provider-session.detach",
    "provider-session.detached",
    "provider-session.updated",
    "provider-thread.updated",
    "provider-turn.updated",
    "provider.switch",
    "queue.resume",
    "queued-message.promote-to-steer",
    "queued-run.cancel",
    "queued-run.edit",
    "queued-run.reorder",
    "queued-run.start",
    "run-attempt.created",
    "run-attempt.updated",
    "run.background-work-cancelled",
    "run.created",
    "run.interrupt",
    "run.updated",
    "runtime-request.delivery.fail",
    "runtime-request.respond",
    "runtime-request.updated",
    "subagent.stop",
    "subagent.updated",
    "thread.active-reordered",
    "thread.active.reorder",
    "thread.archive",
    "thread.archived",
    "thread.auto-settle",
    "thread.auto-settle-set",
    "thread.auto-settle.set",
    "thread.background-work.settle",
    "thread.create",
    "thread.created",
    "thread.created.record",
    "thread.delete",
    "thread.deleted",
    "thread.fork",
    "thread.guest-message.dismiss",
    "thread.guest-message.submit",
    "thread.guest-share-updated",
    "thread.guest-share.close",
    "thread.guest-share.open",
    "thread.guest-share.redeem",
    "thread.interaction-mode-updated",
    "thread.interaction-mode.set",
    "thread.interrupt.unresponsive",
    "thread.mark-unread",
    "thread.marked-unread",
    "thread.metadata-updated",
    "thread.metadata.update",
    "thread.model-selection-updated",
    "thread.model-selection.set",
    "thread.pin",
    "thread.pin-reordered",
    "thread.pin.reorder",
    "thread.pinned",
    "thread.project.adopt-folder",
    "thread.provider-switched",
    "thread.pull-request-link-updated",
    "thread.pull-request-link.sync",
    "thread.pull-request-synced",
    "thread.pull-request-watch.checks-reopen",
    "thread.pull-request-watch.sync",
    "thread.pull-request.link",
    "thread.pull-request.sync",
    "thread.pull-request.unlink",
    "thread.pull-request.watch",
    "thread.removed",
    "thread.runtime-mode-updated",
    "thread.runtime-mode.set",
    "thread.settle",
    "thread.settled",
    "thread.snooze",
    "thread.snoozed",
    "thread.stop",
    "thread.tag.set",
    "thread.tags-updated",
    "thread.title.regeneration.complete",
    "thread.unarchive",
    "thread.unarchived",
    "thread.unpin",
    "thread.unpinned",
    "thread.unsettle",
    "thread.unsettled",
    "thread.unsnooze",
    "thread.unsnoozed",
    "thread.updated",
    "thread.user-input.dismiss",
    "thread.visit",
    "thread.visited",
    "turn-item.updated",
];

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(native: bool) -> Value {
        json!({"journey":"J02","profile":if native {"native"} else {"stock"},
            "native_lookups":false,"persistence_spans":null,"readiness_phases":null,
            "saved_thread_sequence":if native {12865} else {12866},
            "browser":{"threadResumeAfterSequence":12865},
            "snapshot":{"valid":true,"selectedThreadId":SELECTED,"threadCount":32,
                "messageCount":200,"shellSequence":12867,"threadSequence":12867}})
    }
    fn rows() -> Value {
        json!(
            (12865..=12867)
                .map(|sequence| json!({"sequence":sequence,
            "application_event_version":2,"aggregate_kind":"thread","stream_id":SELECTED,
            "event_type":"thread.metadata-updated","payload_json":"PRIVATE_SENTINEL",
            "occurred_at":"PRIVATE_SENTINEL","command_id":"PRIVATE_SENTINEL"}))
                .collect::<Vec<_>>()
        )
    }
    #[test]
    fn native_requires_three_successful_frames() {
        let good = b"{\"ok\":true,\"result\":{}}\n{\"ok\":true,\"result\":[]}\n{\"ok\":true,\"result\":null}\n";
        assert_eq!(native_response(good).unwrap(), json!([]));
        assert!(native_response(b"{\"ok\":false,\"error\":{\"kind\":\"writer_busy\"}}\n").is_err());
        assert!(native_response(b"{\"ok\":true}\n").is_err());
        assert!(native_response(b"malformed").is_err());
    }

    #[test]
    fn preserves_coordinates_from_both_hosted_runs() {
        assert_eq!(
            sample_coordinates(&sample(false), false).unwrap().0["seed_http_thread_sequence"],
            12866
        );
        assert_eq!(
            sample_coordinates(&sample(true), true).unwrap().0["seed_http_thread_sequence"],
            12865
        );
        for field in [
            "/saved_thread_sequence",
            "/browser/threadResumeAfterSequence",
            "/snapshot/threadSequence",
            "/snapshot/shellSequence",
            "/snapshot/valid",
            "/snapshot/selectedThreadId",
            "/native_lookups",
            "/profile",
        ] {
            let mut bad = sample(false);
            *bad.pointer_mut(field).unwrap() = Value::Null;
            assert!(sample_coordinates(&bad, false).is_err(), "{field}");
        }
        assert!(sample_coordinates(&sample(true), false).is_err());
        let mut observed = sample(false);
        observed["browser"]["threadResumeAfterSequence"] = json!(12866);
        observed["snapshot"]["shellSequence"] = json!(12866);
        observed["snapshot"]["threadSequence"] = json!(12866);
        let (coordinates, through) = sample_coordinates(&observed, false).unwrap();
        assert_eq!(coordinates["reopen_ws_after_sequence"], 12866);
        assert_eq!(through, 12866);
        observed["snapshot"]["shellSequence"] = json!(12868);
        assert!(sample_coordinates(&observed, false).is_err());
    }
    #[test]
    fn emits_only_bounded_categories_and_rejects_missing_or_foreign_events() {
        let result = categories(&rows(), 12867).unwrap();
        assert_eq!(result[0]["owner"], "selected-thread");
        assert!(!result.to_string().contains("PRIVATE_SENTINEL"));
        assert!(!result.to_string().contains(SELECTED));
        let mut stock = rows();
        stock[1]["event_type"] = json!("thread.visit-recorded");
        assert_eq!(
            categories(&stock, 12867).unwrap()[1]["event_type"],
            "thread.visit-recorded"
        );
        for field in [
            "sequence",
            "application_event_version",
            "aggregate_kind",
            "stream_id",
            "event_type",
        ] {
            let mut bad = rows();
            bad[1][field] = json!("PRIVATE_SENTINEL");
            assert!(categories(&bad, 12867).is_err(), "{field}");
        }
        let mut missing = rows();
        missing.as_array_mut().unwrap().pop();
        assert!(categories(&missing, 12867).is_err());
        assert_eq!(
            categories(&missing, 12866)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let mut duplicate = rows();
        duplicate[1] = duplicate[0].clone();
        assert!(categories(&duplicate, 12867).is_err());
    }
}
