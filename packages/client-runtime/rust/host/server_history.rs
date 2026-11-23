//! Saved local conversation pages. Server cursors stay opaque and records retain wire order.
use super::{Connection, FAILED, Value, encode_component, parse_snapshot};
use std::collections::BTreeSet;

const MAX_CURSOR: usize = 4096;
const MAX_PAGE_ROWS: usize = 500;
const MAX_ROWS: usize = 500;
const MAX_PAGES: usize = 8;
const MAX_RETAINED_BYTES: usize = 2 * 1024 * 1024;

pub const FAILED_HISTORY: &str = "Could not load older history. Reopen to refresh.";

pub struct History {
    connection: Connection,
    sequence: u64,
    heading: String,
    rows: Vec<Value>,
    cursor: Option<String>,
    visited: BTreeSet<String>,
    pages: usize,
    blocked: bool,
    text: String,
}

impl History {
    pub(super) fn open(connection: Connection) -> Result<Self, &'static str> {
        connection.verify_environment()?;
        let reply = connection.get(
            &format!(
                "/api/orchestration/threads/{}/bounded",
                encode_component(&connection.thread_id)
            ),
            true,
        )?;
        // Preserve the existing snapshot validation before enabling the stricter history profile.
        if reply.get("ids").is_some() || reply.get("turnItemsOmitLocalVisible").is_some() {
            return Err(FAILED);
        }
        parse_snapshot(&reply, &connection.thread_id)?;
        let cursor = page_cursor(&reply, "historyCursor")?;
        let rows = parse_rows(
            &reply["projection"]["visibleTurnItems"],
            &connection.thread_id,
        )?;
        let sequence = reply["snapshotSequence"].as_u64().ok_or(FAILED)?;
        let title = reply["projection"]["thread"]["title"]
            .as_str()
            .ok_or(FAILED)?;
        let heading = format!(
            "{title}\nThread {}\nSnapshot {sequence}\n",
            connection.thread_id
        );
        let text = render(&heading, &rows)?;
        Ok(Self {
            connection,
            sequence,
            heading,
            rows,
            cursor,
            visited: BTreeSet::new(),
            pages: 1,
            blocked: false,
            text,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn record_count(&self) -> usize {
        self.rows.len()
    }
    pub fn has_older(&self) -> bool {
        !self.blocked && self.cursor.is_some()
    }

    /// A failed page leaves the displayed records unchanged and fences this view until reopen.
    pub fn load_older(&mut self) -> Result<bool, &'static str> {
        if self.blocked {
            return Err(FAILED_HISTORY);
        }
        if self.cursor.is_none() {
            return Ok(false);
        }
        let result = self.load_page();
        if result.is_err() {
            self.blocked = true;
        }
        result.map(|()| true).map_err(|_| FAILED_HISTORY)
    }

    fn load_page(&mut self) -> Result<(), &'static str> {
        if self.pages >= MAX_PAGES {
            return Err(FAILED);
        }
        let cursor = self.cursor.as_ref().ok_or(FAILED)?;
        if self.visited.contains(cursor) {
            return Err(FAILED);
        }
        self.connection.verify_environment()?;
        let reply = self.connection.get(
            &format!(
                "/api/orchestration/threads/{}/history?cursor={}&view=conversation",
                encode_component(&self.connection.thread_id),
                encode_component(cursor),
            ),
            true,
        )?;
        if reply.get("idTable").is_some()
            || reply.get("ids").is_some()
            || reply["snapshotSequence"].as_u64() != Some(self.sequence)
        {
            return Err(FAILED);
        }
        let next = page_cursor(&reply, "nextCursor")?;
        if next
            .as_ref()
            .is_some_and(|next| next == cursor || self.visited.contains(next))
        {
            return Err(FAILED);
        }
        let mut rows = parse_rows(&reply["items"], &self.connection.thread_id)?;
        if rows.is_empty() || rows.len() + self.rows.len() > MAX_ROWS {
            return Err(FAILED);
        }
        let old_ids: BTreeSet<_> = self
            .rows
            .iter()
            .map(|row| row["sourceItemId"].as_str().unwrap())
            .collect();
        let old_messages: BTreeSet<_> = self
            .rows
            .iter()
            .map(|row| row["item"]["messageId"].as_str().unwrap())
            .collect();
        if rows.iter().any(|row| {
            old_ids.contains(row["sourceItemId"].as_str().unwrap())
                || old_messages.contains(row["item"]["messageId"].as_str().unwrap())
        }) {
            return Err(FAILED);
        }
        rows.extend(self.rows.iter().cloned());
        let text = render(&self.heading, &rows)?;
        // Only publish a fully checked page, including its next opaque cursor.
        self.visited.insert(cursor.clone());
        self.rows = rows;
        self.text = text;
        self.cursor = next;
        self.pages += 1;
        Ok(())
    }
}

fn page_cursor(value: &Value, field: &str) -> Result<Option<String>, &'static str> {
    let more = value["hasMoreHistory"].as_bool().ok_or(FAILED)?;
    let cursor = match value.get(field).ok_or(FAILED)? {
        Value::Null => None,
        Value::String(cursor)
            if !cursor.trim().is_empty()
                && cursor.len() <= MAX_CURSOR
                && !cursor.chars().any(char::is_control) =>
        {
            Some(cursor.clone())
        }
        _ => return Err(FAILED),
    };
    if more != cursor.is_some() {
        return Err(FAILED);
    }
    Ok(cursor)
}

fn parse_rows(value: &Value, thread: &str) -> Result<Vec<Value>, &'static str> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_PAGE_ROWS)
        .ok_or(FAILED)?;
    let mut ids = BTreeSet::new();
    let mut message_ids = BTreeSet::new();
    let mut last_position = None;
    for row in rows {
        let position = row["position"].as_u64().ok_or(FAILED)?;
        let item = &row["item"];
        if last_position.is_some_and(|last| position <= last)
            || row["visibility"].as_str() != Some("local")
            || row["sourceThreadId"].as_str() != Some(thread)
            || item["threadId"].as_str() != Some(thread)
            || !matches!(
                item["type"].as_str(),
                Some("user_message" | "assistant_message")
            )
            || item.get("textOmitted").is_some()
            || item.get("deferredWork").is_some()
            || item["text"].as_str().is_none()
        {
            return Err(FAILED);
        }
        let id = identity(&row["sourceItemId"])?;
        if item["id"].as_str() != Some(id)
            || !ids.insert(id)
            || !message_ids.insert(identity(&item["messageId"])?)
        {
            return Err(FAILED);
        }
        last_position = Some(position);
    }
    // Bound retained wire records as well as their rendered text.
    if serde_json::to_vec(rows).map_err(|_| FAILED)?.len() > MAX_RETAINED_BYTES {
        return Err(FAILED);
    }
    Ok(rows.clone())
}

fn identity(value: &Value) -> Result<&str, &'static str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control))
        .ok_or(FAILED)
}

fn render(heading: &str, rows: &[Value]) -> Result<String, &'static str> {
    if serde_json::to_vec(rows).map_err(|_| FAILED)?.len() > MAX_RETAINED_BYTES {
        return Err(FAILED);
    }
    let mut text = heading.to_owned();
    for row in rows {
        let item = &row["item"];
        let role = if item["type"] == "user_message" {
            "user"
        } else {
            "assistant"
        };
        let body = item["text"].as_str().ok_or(FAILED)?;
        if text.len() + role.len() + body.len() + 3 > MAX_RETAINED_BYTES {
            return Err(FAILED);
        }
        text.push_str(&format!("\n{role}\n{body}\n"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        thread,
        time::Duration,
    };

    const THREAD: &str = "saved:λ";
    const CURSOR: &str = "opaque+older/one?=λ";

    fn rows(start: usize, end: usize) -> Vec<Value> {
        (start..end)
            .enumerate()
            .map(|(position, index)| {
                json!({
                    "position": position, "visibility": "local", "sourceThreadId": THREAD,
                    "sourceItemId": format!("turn-item:{index}"), "item": {
                        "id": format!("turn-item:{index}"), "threadId": THREAD,
                        "messageId": format!("message:{index}"),
                        "type": if index % 2 == 0 { "user_message" } else { "assistant_message" },
                        "text": format!("record {index:03}"),
                    }
                })
            })
            .collect()
    }

    fn snapshot() -> Value {
        json!({ "snapshotSequence": 7, "historyCursor": CURSOR, "hasMoreHistory": true,
            "projection": { "thread": { "id": THREAD, "title": "Saved history" },
                "messages": [{ "role": "assistant", "text": "record 079" }],
                "visibleTurnItems": rows(60, 80),
            }
        })
    }

    fn start(pages: Vec<Value>) -> (History, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let peer = thread::spawn(move || {
            let mut requests = vec![
                (
                    "/.well-known/t3/environment".to_owned(),
                    json!({"environmentId":"fixture-env"}),
                ),
                (
                    format!(
                        "/api/orchestration/threads/{}/bounded",
                        encode_component(THREAD)
                    ),
                    snapshot(),
                ),
            ];
            let mut cursor = CURSOR.to_owned();
            for page in pages {
                requests.push((
                    "/.well-known/t3/environment".to_owned(),
                    json!({"environmentId":"fixture-env"}),
                ));
                requests.push((
                    format!(
                        "/api/orchestration/threads/{}/history?cursor={}&view=conversation",
                        encode_component(THREAD),
                        encode_component(&cursor)
                    ),
                    page.clone(),
                ));
                cursor = page["nextCursor"].as_str().unwrap_or("").to_owned();
            }
            for (path, body) in requests {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(socket) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => panic!("History replay peer did not receive its bounded request"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 16 * 1024);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.0\r\n")));
                assert_eq!(
                    request.contains("Authorization: Bearer fixture.token\r\n"),
                    path.contains("/api/")
                );
                let body = serde_json::to_vec(&body).unwrap();
                write!(
                    socket,
                    "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                )
                .unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let input = serde_json::to_vec(&json!({ "port":port,"token":"fixture.token","environmentId":"fixture-env","threadId":THREAD })).unwrap();
        (
            Connection::read(input.as_slice())
                .unwrap()
                .history()
                .unwrap(),
            peer,
        )
    }

    #[test]
    fn follows_opaque_pages_and_retains_eighty_records_in_wire_order() {
        let (mut history, peer) = start(vec![
            json!({"snapshotSequence":7,"items":rows(20,60),"hasMoreHistory":true,"nextCursor":"older:two"}),
            json!({"snapshotSequence":7,"items":rows(0,20),"hasMoreHistory":false,"nextCursor":null}),
        ]);
        assert_eq!(history.record_count(), 20);
        assert!(!history.text().contains("record 000"));
        assert!(history.load_older().unwrap());
        assert!(history.load_older().unwrap());
        assert_eq!(history.record_count(), 80);
        let mut position = 0;
        for index in 0..80 {
            let marker = format!("record {index:03}");
            position += history.text()[position..].find(&marker).unwrap() + marker.len();
        }
        assert!(!history.has_older());
        assert!(!history.load_older().unwrap());
        peer.join().unwrap();
    }

    #[test]
    fn rejects_next_page_cycles_wrong_scope_overlap_and_sequence_changes_without_publication() {
        let valid = json!({"snapshotSequence":7,"items":rows(20,60),"hasMoreHistory":false,"nextCursor":null});
        let mut cycle = valid.clone();
        cycle["nextCursor"] = json!(CURSOR);
        cycle["hasMoreHistory"] = json!(true);
        let mut scope = valid.clone();
        scope["items"][0]["sourceThreadId"] = json!("another-thread");
        let mut sequence = valid.clone();
        sequence["snapshotSequence"] = json!(8);
        let mut overlap = valid.clone();
        overlap["items"] = json!(rows(59, 61));
        let mut malformed = valid.clone();
        malformed["hasMoreHistory"] = json!(true);
        for page in [cycle, scope, sequence, overlap, malformed] {
            let (mut history, peer) = start(vec![page]);
            let original = history.text().to_owned();
            assert!(history.load_older().is_err());
            assert_eq!(history.text(), original);
            assert_eq!(history.record_count(), 20);
            assert!(!history.has_older());
            assert!(history.load_older().is_err());
            peer.join().unwrap();
        }
    }

    #[test]
    fn rejects_a_later_cursor_cycle_after_preserving_the_first_accepted_page() {
        assert_eq!(encode_component(CURSOR), "opaque%2Bolder%2Fone%3F%3D%CE%BB");
        let (mut history, peer) = start(vec![
            json!({"snapshotSequence":7,"items":rows(20,60),"hasMoreHistory":true,"nextCursor":"older:two"}),
            json!({"snapshotSequence":7,"items":rows(0,20),"hasMoreHistory":true,"nextCursor":CURSOR}),
        ]);
        assert!(history.load_older().unwrap());
        let accepted = history.text().to_owned();
        assert!(history.load_older().is_err());
        assert_eq!(history.record_count(), 60);
        assert_eq!(history.text(), accepted);
        peer.join().unwrap();
    }

    #[test]
    fn rejects_unbounded_cursors_duplicate_ids_and_excess_rows() {
        let oversized = json!({"hasMoreHistory":true,"nextCursor":"x".repeat(MAX_CURSOR+1)});
        assert!(page_cursor(&oversized, "nextCursor").is_err());
        assert!(parse_rows(&json!(rows(0, MAX_PAGE_ROWS + 1)), THREAD).is_err());
        let mut duplicate = rows(0, 2);
        duplicate[1]["item"]["messageId"] = duplicate[0]["item"]["messageId"].clone();
        assert!(parse_rows(&json!(duplicate), THREAD).is_err());
        let mut inherited = rows(0, 1);
        inherited[0]["visibility"] = json!("inherited");
        assert!(parse_rows(&json!(inherited), THREAD).is_err());
    }
}
