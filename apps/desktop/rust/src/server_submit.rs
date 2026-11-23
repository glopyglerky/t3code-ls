//! One authenticated message dispatch through the retained application's JSON WebSocket RPC.
use crate::server_snapshot::{Connection, Snapshot};
use serde_json::{Value, json};
use std::{
    io::Read,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

pub const FAILED: &str =
    "Could not confirm submission. Draft kept. Check the thread before retrying.";
pub const CONFIRMED: &str = "Server submission confirmed.";
const MAX_INPUT: usize = 16 * 1024;
const MAX_REPLY: usize = 1024 * 1024;
const MAX_DRAFT: usize = 4096;
const RPC_DEADLINE: Duration = Duration::from_secs(8);

pub struct Session {
    connection: Connection,
    project_id: String,
    command_id: String,
    message_id: String,
    attempted: AtomicBool,
}

impl Session {
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
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
        if value.as_object().is_none_or(|object| object.len() != 7) {
            return Err(FAILED);
        }
        let identity = |name: &str| {
            value[name]
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.trim() == *id
                        && id.len() <= 1024
                        && !id.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or(FAILED)
        };
        let connection = serde_json::to_vec(&json!({
            "port":value["port"], "token":value["token"],
            "environmentId":value["environmentId"], "threadId":value["threadId"],
        }))
        .map_err(|_| FAILED)?;
        Ok(Self {
            connection: Connection::read(connection.as_slice()).map_err(|_| FAILED)?,
            project_id: identity("projectId")?,
            command_id: identity("commandId")?,
            message_id: identity("messageId")?,
            attempted: AtomicBool::new(false),
        })
    }

    pub fn submit(&self, text: &str, cancelled: &AtomicBool) -> Result<Snapshot, &'static str> {
        if text.trim().is_empty() || text.len() > MAX_DRAFT {
            return Err(FAILED);
        }
        // A refusal or lost acknowledgement never authorizes a new identity or automatic resend.
        if self.attempted.swap(true, Ordering::AcqRel) {
            return Err(FAILED);
        }
        self.check_cancelled(cancelled)?;
        let before = self.bound_projection()?;
        if self.accepted(&before, text) {
            return self.connection.snapshot_from(&before).map_err(|_| FAILED);
        }
        if before["projection"]["messages"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
            || before["projection"]["runs"]
                .as_array()
                .is_none_or(|rows| !rows.is_empty())
        {
            return Err(FAILED);
        }
        self.check_cancelled(cancelled)?;
        let command = json!({
            "type":"message.dispatch", "commandId":self.command_id,
            "threadId":self.connection.thread_id(), "messageId":self.message_id,
            "text":text, "attachments":[], "createdBy":"user", "creationSource":"web",
            "dispatchMode":{"type":"start_immediately"},
        });
        // Even an RPC error can follow a committed dispatch. Reconcile only by reading this identity.
        let _receipt = self.dispatch(command, cancelled);
        let started = Instant::now();
        while started.elapsed() < RPC_DEADLINE {
            self.check_cancelled(cancelled)?;
            if let Ok(snapshot) = self.bound_projection() {
                if self.accepted(&snapshot, text) {
                    return self.connection.snapshot_from(&snapshot).map_err(|_| FAILED);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(FAILED)
    }

    fn check_cancelled(&self, cancelled: &AtomicBool) -> Result<(), &'static str> {
        if cancelled.load(Ordering::Acquire) {
            Err(FAILED)
        } else {
            Ok(())
        }
    }

    fn bound_projection(&self) -> Result<Value, &'static str> {
        let snapshot = self.connection.projection().map_err(|_| FAILED)?;
        let thread = &snapshot["projection"]["thread"];
        if thread["id"].as_str() != Some(self.connection.thread_id())
            || thread["projectId"].as_str() != Some(self.project_id.as_str())
        {
            return Err(FAILED);
        }
        self.connection
            .snapshot_from(&snapshot)
            .map_err(|_| FAILED)?;
        Ok(snapshot)
    }

    fn accepted(&self, snapshot: &Value, text: &str) -> bool {
        let projection = &snapshot["projection"];
        let Some(messages) = projection["messages"].as_array() else {
            return false;
        };
        let Some(runs) = projection["runs"].as_array() else {
            return false;
        };
        if runs.len() != 1
            || runs[0]["threadId"].as_str() != Some(self.connection.thread_id())
            || runs[0]["status"].as_str() != Some("completed")
        {
            return false;
        }
        let selected: Vec<_> = messages
            .iter()
            .filter(|message| message["role"].as_str() == Some("user"))
            .collect();
        selected.len() == 1
            && selected[0]["id"].as_str() == Some(self.message_id.as_str())
            && selected[0]["text"].as_str() == Some(text)
            && selected[0]["threadId"].as_str() == Some(self.connection.thread_id())
            && selected[0]["runId"]
                .as_str()
                .is_some_and(|run| runs[0]["id"].as_str() == Some(run))
    }

    fn dispatch(&self, command: Value, cancelled: &AtomicBool) -> Result<(), &'static str> {
        let started = Instant::now();
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.connection.port()));
        let stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| FAILED)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| FAILED)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| FAILED)?;
        let mut request = format!(
            "ws://127.0.0.1:{}/ws?orchestrationProtocol=2",
            self.connection.port()
        )
        .into_client_request()
        .map_err(|_| FAILED)?;
        let mut authorization: tungstenite::http::HeaderValue =
            format!("Bearer {}", self.connection.token())
                .parse()
                .map_err(|_| FAILED)?;
        authorization.set_sensitive(true);
        request.headers_mut().insert("Authorization", authorization);
        let config = WebSocketConfig::default()
            .read_buffer_size(8192)
            .write_buffer_size(8192)
            .max_write_buffer_size(64 * 1024)
            .max_message_size(Some(MAX_REPLY))
            .max_frame_size(Some(MAX_REPLY));
        let (mut socket, _) =
            tungstenite::client::client_with_config(request, stream, Some(config))
                .map_err(|_| FAILED)?;
        self.check_cancelled(cancelled)?;
        socket.send(Message::Text(serde_json::to_string(&json!({
            "_tag":"Request", "id":"1", "tag":"orchestration.dispatchCommand", "payload":command, "headers":[],
        })).map_err(|_| FAILED)?.into())).map_err(|_| FAILED)?;
        let mut received = 0;
        for _ in 0..128 {
            self.check_cancelled(cancelled)?;
            let remaining = RPC_DEADLINE.checked_sub(started.elapsed()).ok_or(FAILED)?;
            socket
                .get_mut()
                .set_read_timeout(Some(remaining.min(Duration::from_millis(250))))
                .map_err(|_| FAILED)?;
            let message = match socket.read() {
                Ok(message) => message,
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(_) => return Err(FAILED),
            };
            match message {
                Message::Text(text) => {
                    received += text.len();
                    if received > 4 * MAX_REPLY {
                        return Err(FAILED);
                    }
                    let value: Value = serde_json::from_str(&text).map_err(|_| FAILED)?;
                    let messages = match &value {
                        Value::Array(batch) => batch.as_slice(),
                        value => std::slice::from_ref(value),
                    };
                    if messages.len() > 64 {
                        return Err(FAILED);
                    }
                    for message in messages {
                        match message["_tag"].as_str() {
                            Some("Exit") if message["requestId"].as_str() == Some("1") => {
                                let result = if message["exit"]["_tag"].as_str() == Some("Success")
                                    && message["exit"]["value"]["sequence"].as_u64().is_some()
                                {
                                    Ok(())
                                } else {
                                    Err(FAILED)
                                };
                                let _ = socket.close(None);
                                return result;
                            }
                            Some("Ping") => socket
                                .send(Message::Text("{\"_tag\":\"Pong\"}".into()))
                                .map_err(|_| FAILED)?,
                            Some("Pong") => {}
                            _ => return Err(FAILED),
                        }
                    }
                }
                Message::Ping(_) | Message::Pong(_) => {
                    socket.flush().map_err(|_| FAILED)?;
                }
                _ => return Err(FAILED),
            }
        }
        Err(FAILED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::TcpListener,
        sync::{Arc, atomic::AtomicUsize},
        thread,
    };

    const THREAD: &str = "fixture-thread";
    const PROJECT: &str = "fixture-project";
    const PROMPT: &str = "Recorded prompt";

    fn input(port: u16) -> Vec<u8> {
        serde_json::to_vec(&json!({"port":port,"token":"fixture.token","environmentId":"fixture-env",
            "threadId":THREAD,"projectId":PROJECT,"commandId":"fixture-command-1","messageId":"fixture-message-1"})).unwrap()
    }

    fn projection(accepted: bool) -> Value {
        json!({"snapshotSequence":if accepted {7} else {0},"projection":{
            "thread":{"id":THREAD,"projectId":PROJECT,"title":"Fixture thread"},
            "messages":if accepted {json!([
                {"id":"fixture-message-1","threadId":THREAD,"runId":"fixture-run","role":"user","text":PROMPT},
                {"id":"fixture-reply","threadId":THREAD,"runId":"fixture-run","role":"assistant","text":"Recorded reply"}
            ])} else {json!([])},
            "runs":if accepted {json!([{"id":"fixture-run","threadId":THREAD,"status":"completed"}])} else {json!([])}
        }})
    }

    fn accept(listener: &TcpListener) -> TcpStream {
        let end = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < end =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => panic!("Fixture did not receive its bounded request"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
    }

    fn http(listener: &TcpListener, path: &str, body: Value, authorized: bool) {
        let mut stream = accept(listener);
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
            assert!(bytes.len() <= 16 * 1024);
        }
        let request = String::from_utf8(bytes).unwrap();
        assert!(request.starts_with(&format!("GET {path} HTTP/1.0\r\n")));
        assert_eq!(
            request.contains("Authorization: Bearer fixture.token\r\n"),
            authorized
        );
        let body = serde_json::to_vec(&body).unwrap();
        write!(
            stream,
            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
    }

    fn read_projection(listener: &TcpListener, accepted: bool) {
        http(
            listener,
            "/.well-known/t3/environment",
            json!({"environmentId":"fixture-env"}),
            false,
        );
        http(
            listener,
            &format!("/api/orchestration/threads/{THREAD}/bounded"),
            projection(accepted),
            true,
        );
    }

    #[test]
    fn dispatches_once_and_reconciles_the_same_identity_after_a_lost_ack_or_reopen() {
        for send_ack in [true, false] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let count = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&count);
            let peer = thread::spawn(move || {
                read_projection(&listener, false);
                let stream = accept(&listener);
                let mut socket = tungstenite::accept_hdr(
                    stream,
                    |request: &tungstenite::handshake::server::Request, response| {
                        assert_eq!(request.uri(), "/ws?orchestrationProtocol=2");
                        assert_eq!(request.headers()["Authorization"], "Bearer fixture.token");
                        Ok(response)
                    },
                )
                .unwrap();
                let command: Value =
                    serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
                assert_eq!(command["_tag"], "Request");
                assert_eq!(command["tag"], "orchestration.dispatchCommand");
                assert_eq!(command["payload"]["type"], "message.dispatch");
                assert_eq!(command["payload"]["createdBy"], "user");
                assert_eq!(command["payload"]["creationSource"], "web");
                assert_eq!(
                    command["payload"]["dispatchMode"]["type"],
                    "start_immediately"
                );
                assert_eq!(command["payload"]["commandId"], "fixture-command-1");
                assert_eq!(command["payload"]["messageId"], "fixture-message-1");
                assert_eq!(command["payload"]["threadId"], THREAD);
                assert_eq!(command["payload"]["text"], PROMPT);
                observed.fetch_add(1, Ordering::AcqRel);
                if send_ack {
                    socket.send(Message::Text(json!({"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"sequence":7}}}).to_string().into())).unwrap();
                }
                drop(socket);
                read_projection(&listener, true);
                // A fresh view with the caller's original identities reads the receipt's projected result.
                read_projection(&listener, true);
            });
            let bytes = input(port);
            let session = Session::read(bytes.as_slice()).unwrap();
            let cancelled = AtomicBool::new(false);
            assert!(
                session
                    .submit(PROMPT, &cancelled)
                    .unwrap()
                    .text
                    .contains("Recorded reply")
            );
            assert!(session.submit(PROMPT, &cancelled).is_err());
            let reopened = Session::read(bytes.as_slice()).unwrap();
            assert!(reopened.submit(PROMPT, &cancelled).is_ok());
            peer.join().unwrap();
            assert_eq!(count.load(Ordering::Acquire), 1);
        }
    }

    #[test]
    fn refuses_normalized_identity_and_header_injection_before_network_io() {
        let mut value: Value = serde_json::from_slice(&input(1)).unwrap();
        value["commandId"] = json!(" padded-command ");
        assert!(Session::read(value.to_string().as_bytes()).is_err());
        value["commandId"] = json!("fixture-command-1");
        value["token"] = json!("fixture\r\nInjected: true");
        assert!(Session::read(value.to_string().as_bytes()).is_err());
        assert!(Session::read(vec![b' '; MAX_INPUT + 1].as_slice()).is_err());
    }

    #[test]
    fn wrong_project_and_cancellation_do_not_dispatch() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = thread::spawn(move || {
            http(
                &listener,
                "/.well-known/t3/environment",
                json!({"environmentId":"fixture-env"}),
                false,
            );
            let mut wrong = projection(false);
            wrong["projection"]["thread"]["projectId"] = json!("other-project");
            http(
                &listener,
                &format!("/api/orchestration/threads/{THREAD}/bounded"),
                wrong,
                true,
            );
        });
        let bytes = input(port);
        let session = Session::read(bytes.as_slice()).unwrap();
        assert!(session.submit(PROMPT, &AtomicBool::new(false)).is_err());
        assert!(session.submit(PROMPT, &AtomicBool::new(false)).is_err());
        peer.join().unwrap();
        let cancelled = Session::read(input(1).as_slice()).unwrap();
        assert!(cancelled.submit(PROMPT, &AtomicBool::new(true)).is_err());
        assert!(cancelled.attempted.load(Ordering::Acquire));
    }
}
