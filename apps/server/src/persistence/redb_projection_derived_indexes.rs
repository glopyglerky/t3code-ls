//! JSON-derived identities used by native projection and shell lookups.

use super::*;

pub(super) const COLUMNS: [&str; 15] = [
    "codex_native_turn",
    "pull_request_number",
    "issue_key",
    "_hidden_run_thread",
    "_shell_thread",
    "_deferred_slash_thread",
    "_shell_pending",
    "_deleted",
    "_non_stopped",
    "_unreadable_payload",
    "_invalid_pr_links",
    "_recovery",
    "_worktree_path",
    "_worktree_path_key",
    "_root_thread",
];

/// SQLite json_extract returns SQL scalars, with booleans represented as
/// integers and compound values represented by their compact JSON text. Keep
/// the first duplicate member and compound key order, as SQLite does.
pub(crate) fn worktree_key(path: &str) -> String {
    path.trim_matches(' ')
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

pub(crate) fn json_identity(source: &str, path: &[&str]) -> Result<Option<Value>> {
    let mut encoded = source.to_owned();
    for segment in path {
        let Some(fields) = crate::application_json::object_fields(&encoded)? else {
            return Ok(None);
        };
        let Some(value) = crate::application_json::field(&fields, segment) else {
            return Ok(None);
        };
        encoded = value.to_owned();
    }
    let value: Value = serde_json::from_str(&encoded).map_err(|_| Error::IncompatibleStore)?;
    Ok(match value {
        Value::Null => None,
        Value::String(value) => Some(text_cell(&value)),
        Value::Bool(value) => Some(int_cell(i64::from(value))),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                Some(int_cell(integer))
            } else {
                let number = value.as_f64().ok_or(Error::IncompatibleStore)?;
                if number.fract() == 0.0 && number >= i64::MIN as f64 && number < -(i64::MIN as f64)
                {
                    Some(int_cell(number as i64))
                } else {
                    Some(json!({"type":"real","value":number.to_string()}))
                }
            }
        }
        Value::Array(_) | Value::Object(_) => Some(text_cell(&encoded)),
    })
}

pub(crate) fn pull_request_links(payload: &Value) -> Result<Vec<Value>> {
    let links: Vec<Value> = match payload.get("pullRequests") {
        Some(Value::Array(values)) => values.clone(),
        Some(Value::Object(values)) => values.values().cloned().collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(value) => vec![value.clone()],
    };
    links
        .into_iter()
        .map(|value| match value {
            Value::String(source) => {
                serde_json::from_str(&source).map_err(|_| Error::IncompatibleStore)
            }
            other => Ok(other),
        })
        .collect()
}

pub(crate) fn sqlite_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(value) => Some(i64::from(*value)),
        Value::Number(number) => number.as_i64().or_else(|| {
            number.as_f64().and_then(|value| {
                if value.is_finite()
                    && value.fract() == 0.0
                    && value.abs() <= MAX_SAFE_INTEGER as f64
                {
                    Some(value as i64)
                } else {
                    None
                }
            })
        }),
        _ => None,
    }
}

pub(super) fn values(name: &str, row: &Map<String, Value>) -> Result<Vec<(&'static str, Value)>> {
    let mut result = Vec::new();
    let payload = if row.contains_key("payload_json") {
        let raw = text(row, "payload_json")?;
        let decoded = serde_json::from_str::<Value>(&raw);
        if name == MESSAGES && text(row, "role")? == "user" {
            // Keep malformed messages visible to the turn-start read. For
            // valid JSON, match SQLite's broad first-member slash prefix.
            let candidates = decoded.is_err()
                || json_identity(&raw, &["text"])?.is_some_and(|cell| {
                    cell["type"] == "text"
                        && cell["value"].as_str().is_some_and(|text| {
                            text.trim_start_matches(super::window::whitespace)
                                .starts_with('/')
                        })
                });
            if candidates {
                result.push((
                    "_deferred_slash_thread",
                    text_cell(&text(row, "thread_id")?),
                ));
            }
        }
        match decoded {
            Ok(value) if value.is_object() => Some(value),
            _ => {
                result.push(("_unreadable_payload", int_cell(1)));
                None
            }
        }
    } else {
        None
    };
    let p = payload.as_ref().unwrap_or(&Value::Null);
    let status = if row.contains_key("status") {
        nullable(row, "status")?
    } else {
        None
    };
    let status = status.as_deref();
    let live_run = matches!(
        status,
        Some("preparing" | "starting" | "running" | "waiting")
    );
    let live_item = matches!(status, Some("pending" | "running" | "waiting"));
    let shell_row = match name {
        ITEMS => {
            let kind = text(row, "type")?;
            let pending = matches!(
                kind.as_str(),
                "command_execution" | "dynamic_tool" | "subagent"
            ) && status.is_some_and(|status| {
                !matches!(status, "completed" | "interrupted" | "failed" | "cancelled")
            });
            if pending {
                result.push(("_shell_pending", int_cell(1)));
            }
            pending
                || kind == "run_interrupt_request"
                || (matches!(kind.as_str(), "error" | "compaction") && status == Some("failed"))
                || (matches!(kind.as_str(), "link_request" | "secret_request")
                    && status == Some("waiting"))
        }
        MESSAGES => text(row, "role")? == "user",
        REQUESTS => status == Some("pending"),
        PLANS => status == Some("active") && text(row, "kind")? == "proposed_plan",
        PROVIDER_THREADS => p["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| !tasks.is_empty()),
        _ => false,
    };
    if shell_row {
        if let Some(thread) = nullable(row, "thread_id")? {
            result.push(("_shell_thread", text_cell(&thread)));
        }
    }

    let mut flags = Vec::new();
    match name {
        THREADS => {
            if nullable(row, "deleted_at")?.is_some() {
                result.push(("_deleted", int_cell(1)));
            }
            if payload.is_some() {
                let raw = text(row, "payload_json")?;
                for (column, path) in [
                    ("_worktree_path", &["worktreePath"][..]),
                    ("_root_thread", &["lineage", "rootThreadId"][..]),
                ] {
                    if let Some(value) = json_identity(&raw, path)? {
                        if column == "_worktree_path" {
                            let path = value["value"].as_str().ok_or(Error::IncompatibleStore)?;
                            result.push(("_worktree_path_key", text_cell(&worktree_key(path))));
                        }
                        result.push((column, value));
                    }
                }
                let mut numbers = std::collections::BTreeSet::new();
                match pull_request_links(p) {
                    Ok(links) => {
                        for link in links {
                            if let Some(number) = link.get("number").and_then(sqlite_integer) {
                                numbers.insert(number);
                            }
                        }
                    }
                    Err(_) => result.push(("_invalid_pr_links", int_cell(1))),
                }
                result.extend(
                    numbers
                        .into_iter()
                        .map(|number| ("pull_request_number", int_cell(number))),
                );
                if let Some(issues) = p["issues"].as_array() {
                    let keys = issues
                        .iter()
                        .filter_map(|link| link.get("key").and_then(Value::as_str))
                        .collect::<std::collections::BTreeSet<_>>();
                    result.extend(keys.into_iter().map(|key| ("issue_key", text_cell(key))));
                }
                if p["lineage"]["relationshipToParent"] == "subagent"
                    && !p["lineage"]["parentThreadId"].is_null()
                    && p["forkedFrom"]["type"] == "node"
                {
                    flags.push("subagent_result");
                }
                if p["limitRecovery"]["autoResume"].as_bool() == Some(true)
                    || sqlite_integer(&p["limitRecovery"]["autoResume"]) == Some(1)
                {
                    flags.push("auto_resume");
                }
            }
        }
        TURNS => {
            if p["nativeTurnRef"]["driver"] == "codex" {
                if let Some(id) = p["nativeTurnRef"]["nativeId"].as_str() {
                    result.push(("codex_native_turn", text_cell(id)));
                }
            }
        }
        RUNS => {
            if matches!(status, Some("rolled_back" | "queued" | "cancelled")) {
                result.push(("_hidden_run_thread", text_cell(&text(row, "thread_id")?)));
            }
            if status == Some("queued") {
                flags.push("queued_run");
            }
            if p["delegatedCompletion"]["delivery"].is_object() {
                flags.push("delegated_completion");
            }
            if status == Some("starting") && !p["restartContinuationOfRunId"].is_null() {
                flags.push("restart_continuation");
            }
            if live_run || (status == Some("queued") && sqlite_integer(&p["queueHeld"]) != Some(1))
            {
                flags.push("runtime_run");
            }
        }
        SESSIONS => {
            if status.is_some_and(|value| value != "stopped") {
                result.push(("_non_stopped", int_cell(1)));
            }
            if status.is_some_and(|value| !matches!(value, "stopped" | "error")) {
                flags.push("live_session");
            }
            if status == Some("error")
                && p["extensionStatuses"]
                    .as_array()
                    .is_some_and(|value| !value.is_empty())
            {
                flags.push("extension_session");
            }
        }
        PROVIDER_THREADS => {
            if status == Some("active")
                || p["pendingBackgroundTasks"]
                    .as_array()
                    .is_some_and(|value| !value.is_empty())
            {
                flags.push("pending_provider_thread");
            }
        }
        REQUESTS => {
            if status == Some("pending") {
                flags.push("pending_request");
            }
        }
        SUBAGENTS => {
            if live_item && nullable(row, "origin")?.as_deref() == Some("provider_native") {
                flags.push("runtime_subagent");
            }
        }
        NODES => {
            if matches!(status, Some("pending" | "starting" | "running" | "waiting"))
                && nullable(row, "run_id")?.is_none()
                && text(row, "kind")? == "root_turn"
            {
                flags.push("live_root_node");
            }
        }
        ITEMS => {
            let kind = text(row, "type")?;
            if kind == "user_message"
                && status == Some("pending")
                && matches!(
                    p["inputIntent"].as_str(),
                    Some("steer" | "promoted_queued_to_steer")
                )
            {
                flags.push("unread_steer");
            }
            if live_item
                && matches!(
                    kind.as_str(),
                    "command_execution" | "dynamic_tool" | "subagent"
                )
            {
                flags.push("runtime_item");
            }
            if status == Some("failed") && kind == "error" && p["failure"]["class"] == "usage_limit"
            {
                flags.push("usage_limit");
            }
        }
        _ => (),
    }
    result.extend(flags.into_iter().map(|flag| ("_recovery", text_cell(flag))));
    Ok(result)
}
