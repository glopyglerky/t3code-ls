//! Read-only loopback adapter for the production orchestration HTTP contract.
//! No redirect, proxy, provider action or alternate endpoint is selected here.
#[path = "server_history.rs"]
mod history;
pub use history::{FAILED_HISTORY, History};

use serde_json::Value;
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

const MAX_INPUT: usize = 16 * 1024;
const MAX_REPLY: usize = 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(5);

pub const LABEL: &str = "Server thread snapshot";
pub const FAILED: &str = "Could not read the selected server thread.";

pub struct Connection {
    port: u16,
    token: String,
    environment_id: String,
    thread_id: String,
}

pub struct Snapshot {
    pub text: String,
}

#[derive(Clone, Copy)]
pub enum SnapshotFormat {
    Conversation,
    WithMessageIds,
}

impl Connection {
    pub fn read(mut input: impl Read) -> Result<Self, &'static str> {
        let mut bytes = Vec::new();
        input
            .by_ref()
            .take((MAX_INPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| FAILED)?;
        if bytes.len() > MAX_INPUT {
            return Err(FAILED);
        }
        let input: Value = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
        let object = input.as_object().ok_or(FAILED)?;
        if object.len() != 4 {
            return Err(FAILED);
        }
        let port = input["port"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or(FAILED)?;
        let token = input["token"]
            .as_str()
            .filter(|token| {
                !token.is_empty()
                    && token.len() <= 8192
                    && token.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            })
            .ok_or(FAILED)?
            .to_owned();
        let identity = |key: &str| {
            input[key]
                .as_str()
                .filter(|id| {
                    !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or(FAILED)
        };
        Ok(Self {
            port,
            token,
            environment_id: identity("environmentId")?,
            thread_id: identity("threadId")?,
        })
    }

    pub fn snapshot(&self, format: SnapshotFormat) -> Result<Snapshot, &'static str> {
        let snapshot = self.projection()?;
        parse_snapshot(&snapshot, &self.thread_id, format)
    }

    pub fn history(self) -> Result<History, &'static str> {
        History::open(self)
    }

    pub(super) fn port(&self) -> u16 {
        self.port
    }
    pub(super) fn token(&self) -> &str {
        &self.token
    }
    pub(super) fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub(super) fn projection(&self) -> Result<Value, &'static str> {
        self.verify_environment()?;
        self.get(
            &format!(
                "/api/orchestration/threads/{}/bounded",
                encode_component(&self.thread_id)
            ),
            true,
        )
    }
    pub(super) fn snapshot_from(&self, value: &Value) -> Result<Snapshot, &'static str> {
        parse_snapshot(value, &self.thread_id, SnapshotFormat::WithMessageIds)
    }
    fn verify_environment(&self) -> Result<(), &'static str> {
        let descriptor = self.get("/.well-known/t3/environment", false)?;
        if descriptor["environmentId"].as_str() != Some(self.environment_id.as_str()) {
            return Err(FAILED);
        }
        Ok(())
    }

    fn get(&self, path: &str, authenticated: bool) -> Result<Value, &'static str> {
        let started = Instant::now();
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let mut socket =
            TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| FAILED)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| FAILED)?;
        // HTTP/1.0 gives this bounded one-shot reader a close-delimited response.
        let mut request = format!(
            "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nAccept: application/json\r\nx-t3-orchestration-protocol: 2\r\n",
            self.port
        );
        if authenticated {
            request.push_str(&format!("Authorization: Bearer {}\r\n", self.token));
        }
        request.push_str("\r\n");
        socket.write_all(request.as_bytes()).map_err(|_| FAILED)?;
        let mut bytes = Vec::new();
        loop {
            let remaining = DEADLINE
                .checked_sub(started.elapsed())
                .filter(|time| !time.is_zero())
                .ok_or(FAILED)?;
            socket
                .set_read_timeout(Some(remaining))
                .map_err(|_| FAILED)?;
            let mut chunk = [0; 8192];
            let read = socket.read(&mut chunk).map_err(|_| FAILED)?;
            if read == 0 {
                break;
            }
            if bytes.len() + read > MAX_REPLY {
                return Err(FAILED);
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        decode_response(&bytes)
    }
}

fn encode_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(result, "%{byte:02X}").expect("Writing to a String cannot fail");
        }
    }
    result
}

fn decode_response(bytes: &[u8]) -> Result<Value, &'static str> {
    let boundary = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .filter(|index| *index <= MAX_HEADERS)
        .ok_or(FAILED)?;
    let header = std::str::from_utf8(&bytes[..boundary]).map_err(|_| FAILED)?;
    let mut lines = header.split("\r\n");
    let status = lines.next().ok_or(FAILED)?;
    if !matches!(
        status
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .as_slice(),
        ["HTTP/1.0" | "HTTP/1.1", "200"]
    ) {
        return Err(FAILED);
    }
    let body = &bytes[boundary + 4..];
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(FAILED)?;
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-encoding")
        {
            return Err(FAILED);
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(FAILED);
            }
            length = Some(value.trim().parse::<usize>().map_err(|_| FAILED)?);
        }
    }
    if length.is_some_and(|length| length != body.len()) {
        return Err(FAILED);
    }
    serde_json::from_slice(body).map_err(|_| FAILED)
}

fn parse_snapshot(
    value: &Value,
    thread: &str,
    format: SnapshotFormat,
) -> Result<Snapshot, &'static str> {
    let projection = &value["projection"];
    if projection["thread"]["id"].as_str() != Some(thread) || value.get("idTable").is_some() {
        return Err(FAILED);
    }
    let sequence = value["snapshotSequence"].as_u64().ok_or(FAILED)?;
    let title = projection["thread"]["title"]
        .as_str()
        .filter(|title| title.len() <= 4096)
        .ok_or(FAILED)?
        .to_owned();
    let messages = projection["messages"]
        .as_array()
        .filter(|messages| messages.len() <= 200)
        .ok_or(FAILED)?;
    let mut text = format!("{title}\nThread {thread}\nSnapshot {sequence}\n");
    for message in messages {
        let role = message["role"]
            .as_str()
            .filter(|role| matches!(*role, "user" | "assistant" | "system"))
            .ok_or(FAILED)?;
        let body = message["text"].as_str().ok_or(FAILED)?;
        if text.len() + role.len() + body.len() + 3 > MAX_REPLY {
            return Err(FAILED);
        }
        if let (SnapshotFormat::WithMessageIds, Some(id)) = (format, message["id"].as_str()) {
            if id.len() > 1024 || id.chars().any(char::is_control) {
                return Err(FAILED);
            }
            text.push_str(&format!("\nMessage {id}\n"));
        }
        if text.len() + role.len() + body.len() + 3 > MAX_REPLY {
            return Err(FAILED);
        }
        text.push_str(&format!("\n{role}\n{body}\n"));
    }
    Ok(Snapshot { text })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refuses_header_injection_and_unbounded_input() {
        let input = |token: &str| {
            serde_json::to_vec(&json!({"port": 1234, "token": token, "environmentId": "env", "threadId": "thread"})).unwrap()
        };
        assert!(Connection::read(input("secret.token").as_slice()).is_ok());
        assert!(Connection::read(input("secret\r\nInjected: true").as_slice()).is_err());
        assert!(Connection::read(vec![b' '; MAX_INPUT + 1].as_slice()).is_err());
    }

    #[test]
    fn binds_environment_before_authorization_and_percent_encodes_the_exact_thread() {
        use std::{net::TcpListener, thread};
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = thread::spawn(move || {
            for (path, body, authorized) in [
                (
                    "/.well-known/t3/environment",
                    serde_json::json!({"environmentId": "fixture-env"}),
                    false,
                ),
                (
                    "/api/orchestration/threads/thread%3A%CE%BB/bounded",
                    serde_json::json!({
                        "snapshotSequence": 7, "projection": {
                            "thread": {"id": "thread:λ", "title": "Selected thread"},
                            "messages": [{"role": "assistant", "text": "Bounded reply"}],
                        }
                    }),
                    true,
                ),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < MAX_HEADERS);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.0\r\n")));
                assert_eq!(
                    request.contains("Authorization: Bearer fixture.token\r\n"),
                    authorized
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
        let input = serde_json::to_vec(&serde_json::json!({
            "port": port, "token": "fixture.token", "environmentId": "fixture-env", "threadId": "thread:λ",
        })).unwrap();
        let result = Connection::read(input.as_slice())
            .unwrap()
            .snapshot(SnapshotFormat::WithMessageIds)
            .unwrap();
        assert!(result.text.contains("Bounded reply"));
        peer.join().unwrap();
    }

    #[test]
    fn preserves_order_and_refuses_excess_rows_and_compact_ids() {
        let mut reply = json!({"snapshotSequence": 9, "projection": {
            "thread": {"id": "thread", "title": "Synthetic café"},
            "messages": [{"role": "user", "text": "first"}, {"role": "assistant", "text": "second"}],
        }});
        let text = parse_snapshot(&reply, "thread", SnapshotFormat::Conversation)
            .unwrap()
            .text;
        assert!(text.find("first").unwrap() < text.find("second").unwrap());
        reply["idTable"] = json!([]);
        assert!(parse_snapshot(&reply, "thread", SnapshotFormat::Conversation).is_err());
        reply.as_object_mut().unwrap().remove("idTable");
        reply["projection"]["messages"] =
            json!(vec![json!({"role": "assistant", "text": "row"}); 201]);
        assert!(parse_snapshot(&reply, "thread", SnapshotFormat::Conversation).is_err());
        assert!(
            decode_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
                .is_err()
        );
        assert!(
            decode_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}")
                .is_err()
        );
    }

    #[test]
    fn refuses_wrong_identity_auth_failure_and_incomplete_http() {
        let reply = json!({"snapshotSequence": 9, "projection": {"thread": {"id": "thread", "title": "Synthetic café"}, "messages": [{"role": "assistant", "text": "Reply 🦀"}]}});
        assert!(parse_snapshot(&reply, "other", SnapshotFormat::WithMessageIds).is_err());
        assert!(
            parse_snapshot(&reply, "thread", SnapshotFormat::WithMessageIds)
                .unwrap()
                .text
                .contains("Reply 🦀")
        );
        assert!(decode_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}").is_err());
        assert!(
            decode_response(b"HTTP/1.1 302 Found\r\nLocation: http://fixture.invalid\r\n\r\n{}")
                .is_err()
        );
        assert!(decode_response(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}").is_err());
    }
}
