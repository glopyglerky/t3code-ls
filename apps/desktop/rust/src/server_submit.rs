//! One turn and one optional approval through the application's authenticated WebSocket RPC.
use crate::server_snapshot::{Connection, Snapshot};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

pub const FAILED: &str =
    "Could not confirm submission. Draft kept. Check the thread before retrying.";
pub const CONFIRMED: &str = "Server submission confirmed.";
pub const APPROVAL_UNCONFIRMED: &str =
    "Could not confirm approval and turn completion. Draft kept. Check the server thread.";
const MAX_INPUT: usize = 16 * 1024;
const MAX_REPLY: usize = 1024 * 1024;
const MAX_DRAFT: usize = 4096;
const RPC_DEADLINE: Duration = Duration::from_secs(8);
const ACCEPT_ONCE: &str = "accept";

pub enum Progress {
    Completed(Snapshot),
    Approval(Approval),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Approval {
    request_id: String,
    run_id: String,
    node_id: String,
    provider_turn_id: String,
    session_id: String,
    pub detail: String,
}

pub struct Session {
    connection: Connection,
    project_id: String,
    command_id: String,
    message_id: String,
    approval_command_id: Option<String>,
    attempted: AtomicBool,
    approval_attempted: AtomicBool,
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
        let object = value.as_object().ok_or(FAILED)?;
        let has_approval = object.contains_key("approvalCommandId");
        let expected_fields = if has_approval { 8 } else { 7 };
        if object.len() != expected_fields {
            return Err(FAILED);
        }
        let identity = |name: &str| {
            checked_identity(&value[name])
                .map(str::to_owned)
                .ok_or(FAILED)
        };
        let connection = serde_json::to_vec(&json!({
            "port":value["port"], "token":value["token"],
            "environmentId":value["environmentId"], "threadId":value["threadId"],
        }))
        .map_err(|_| FAILED)?;
        let command_id = identity("commandId")?;
        let approval_command_id = has_approval
            .then(|| identity("approvalCommandId"))
            .transpose()?;
        if approval_command_id.as_deref() == Some(command_id.as_str()) {
            return Err(FAILED);
        }
        Ok(Self {
            connection: Connection::read(connection.as_slice()).map_err(|_| FAILED)?,
            project_id: identity("projectId")?,
            command_id,
            message_id: identity("messageId")?,
            approval_command_id,
            attempted: AtomicBool::new(false),
            approval_attempted: AtomicBool::new(false),
        })
    }

    pub fn submit(&self, text: &str, cancelled: &AtomicBool) -> Result<Progress, &'static str> {
        if text.trim().is_empty() || text.len() > MAX_DRAFT {
            return Err(FAILED);
        }
        // A refusal or lost acknowledgement never authorizes a new identity or automatic resend.
        if self.attempted.swap(true, Ordering::AcqRel) {
            return Err(FAILED);
        }
        self.check_cancelled(cancelled)?;
        let before = self.bound_projection()?;
        if let Some(run) = self.selected_run(&before, text)
            && run["status"].as_str() == Some("completed")
        {
            return self.completed(&before).map(Progress::Completed);
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
        self.observe(cancelled, |snapshot| {
            let run = self.selected_run(snapshot, text)?;
            if run["status"].as_str() == Some("completed") {
                return self.completed(snapshot).ok().map(Progress::Completed);
            }
            self.approval_command_id.as_ref()?;
            self.pending_approval(snapshot, run).map(Progress::Approval)
        })
    }

    pub fn allow_once(
        &self,
        approval: &Approval,
        text: &str,
        cancelled: &AtomicBool,
    ) -> Result<Snapshot, &'static str> {
        let command_id = self.approval_command_id.as_ref().ok_or(FAILED)?;
        if self.approval_attempted.swap(true, Ordering::AcqRel) {
            return Err(FAILED);
        }
        self.check_cancelled(cancelled)?;
        let before = self.bound_projection()?;
        let run = self.selected_run(&before, text).ok_or(FAILED)?;
        if self.pending_approval(&before, run).as_ref() != Some(approval) {
            return Err(FAILED);
        }
        // The server still validates that this request is pending when it commits the command.
        let _receipt = self.dispatch(
            json!({
                "type": "runtime-request.respond", "commandId": command_id,
                "threadId": self.connection.thread_id(), "requestId": approval.request_id,
                "decision": ACCEPT_ONCE,
            }),
            cancelled,
        );
        self.observe(cancelled, |snapshot| {
            let run = self.selected_run(snapshot, text)?;
            let request = approval.request(snapshot)?;
            if run["status"].as_str() != Some("completed")
                || run["id"].as_str() != Some(approval.run_id.as_str())
                || request["status"].as_str() != Some("resolved")
                || request["decision"].as_str() != Some(ACCEPT_ONCE)
            {
                return None;
            }
            self.completed(snapshot).ok()
        })
    }

    fn observe<T>(
        &self,
        cancelled: &AtomicBool,
        observed: impl Fn(&Value) -> Option<T>,
    ) -> Result<T, &'static str> {
        let started = Instant::now();
        while started.elapsed() < RPC_DEADLINE {
            self.check_cancelled(cancelled)?;
            if let Ok(snapshot) = self.bound_projection()
                && let Some(result) = observed(&snapshot)
            {
                self.check_cancelled(cancelled)?;
                return Ok(result);
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

    fn completed(&self, snapshot: &Value) -> Result<Snapshot, &'static str> {
        self.connection.snapshot_from(snapshot).map_err(|_| FAILED)
    }

    fn selected_run<'a>(&self, snapshot: &'a Value, text: &str) -> Option<&'a Value> {
        let projection = &snapshot["projection"];
        let [run] = projection["runs"].as_array()?.as_slice() else {
            return None;
        };
        let run_id = checked_identity(&run["id"])?;
        if run["threadId"].as_str() != Some(self.connection.thread_id()) {
            return None;
        }
        let mut users = projection["messages"]
            .as_array()?
            .iter()
            .filter(|message| message["role"].as_str() == Some("user"));
        let message = users.next()?;
        (users.next().is_none()
            && message["id"].as_str() == Some(self.message_id.as_str())
            && message["text"].as_str() == Some(text)
            && message["threadId"].as_str() == Some(self.connection.thread_id())
            && message["runId"].as_str() == Some(run_id))
        .then_some(run)
    }

    fn pending_approval(&self, snapshot: &Value, run: &Value) -> Option<Approval> {
        if !matches!(run["status"].as_str(), Some("running" | "waiting")) {
            return None;
        }
        let run_id = checked_identity(&run["id"])?;
        let projection = &snapshot["projection"];
        let mut pending = projection["runtimeRequests"]
            .as_array()?
            .iter()
            .filter(|request| request["status"].as_str() == Some("pending"));
        let request = pending.next()?;
        if pending.next().is_some()
            || request["kind"].as_str() != Some("command")
            || request["responseCapability"]["type"].as_str() != Some("live")
        {
            return None;
        }
        let request_id = checked_identity(&request["id"])?;
        let node_id = checked_identity(&request["nodeId"])?;
        let provider_turn_id = checked_identity(&request["providerTurnId"])?;
        let session_id = checked_identity(&request["responseCapability"]["providerSessionId"])?;
        let mut items = projection["turnItems"].as_array()?.iter().filter(|item| {
            item["type"].as_str() == Some("approval_request")
                && item["requestId"].as_str() == Some(request_id)
        });
        let item = items.next()?;
        if items.next().is_some()
            || item["status"].as_str() != Some("waiting")
            || item["requestKind"].as_str() != Some("command")
            || item["threadId"].as_str() != Some(self.connection.thread_id())
            || item["runId"].as_str() != Some(run_id)
            || item["nodeId"].as_str() != Some(node_id)
            || item["providerTurnId"].as_str() != Some(provider_turn_id)
            || item.get("reason").is_some()
            || item.get("fullAccessOverride").is_some()
        {
            return None;
        }
        // Missing options use the stock client's default. Explicit options must offer accept.
        if let Some(options) = item.get("options")
            && !options.as_array()?.iter().any(|option| {
                option["decision"].as_str() == Some(ACCEPT_ONCE) && option.get("warning").is_none()
            })
        {
            return None;
        }
        let detail = item["prompt"]
            .as_str()
            .filter(|prompt| !prompt.trim().is_empty() && prompt.len() <= MAX_DRAFT)?;
        Some(Approval {
            request_id: request_id.to_owned(),
            run_id: run_id.to_owned(),
            node_id: node_id.to_owned(),
            provider_turn_id: provider_turn_id.to_owned(),
            session_id: session_id.to_owned(),
            detail: detail.to_owned(),
        })
    }

    fn dispatch(&self, command: Value, cancelled: &AtomicBool) -> Result<(), &'static str> {
        self.check_cancelled(cancelled)?;
        let deadline = Instant::now() + RPC_DEADLINE;
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.connection.port()));
        let stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| FAILED)?;
        let stream = DeadlineStream {
            stream,
            deadline,
            read_slice: Duration::from_secs(2),
        };
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
        socket.get_mut().read_slice = Duration::from_millis(250);
        self.check_cancelled(cancelled)?;
        socket.send(Message::Text(serde_json::to_string(&json!({
            "_tag":"Request", "id":"1", "tag":"orchestration.dispatchCommand", "payload":command, "headers":[],
        })).map_err(|_| FAILED)?.into())).map_err(|_| FAILED)?;
        let mut received = 0;
        for _ in 0..128 {
            self.check_cancelled(cancelled)?;
            if Instant::now() >= deadline {
                return Err(FAILED);
            }
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

struct DeadlineStream {
    stream: TcpStream,
    deadline: Instant,
    read_slice: Duration,
}

impl DeadlineStream {
    fn remaining(&self, limit: Duration) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|time| !time.is_zero())
            .map(|time| time.min(limit))
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.stream
            .set_read_timeout(Some(self.remaining(self.read_slice)?))?;
        self.stream.read(buffer)
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream
            .set_write_timeout(Some(self.remaining(Duration::from_secs(2))?))?;
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

fn checked_identity(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        !id.is_empty() && id.trim() == *id && id.len() <= 1024 && !id.chars().any(char::is_control)
    })
}

impl Approval {
    fn request<'a>(&self, snapshot: &'a Value) -> Option<&'a Value> {
        let mut matches = snapshot["projection"]["runtimeRequests"]
            .as_array()?
            .iter()
            .filter(|request| request["id"].as_str() == Some(self.request_id.as_str()));
        let request = matches.next()?;
        (matches.next().is_none()
            && request["kind"].as_str() == Some("command")
            && request["nodeId"].as_str() == Some(self.node_id.as_str())
            && request["providerTurnId"].as_str() == Some(self.provider_turn_id.as_str())
            && request["responseCapability"]["type"].as_str() == Some("live")
            && request["responseCapability"]["providerSessionId"].as_str()
                == Some(self.session_id.as_str()))
        .then_some(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::TcpListener,
        sync::{Arc, atomic::AtomicUsize, mpsc},
        thread,
    };

    const THREAD: &str = "fixture-thread";
    const PROJECT: &str = "fixture-project";
    const PROMPT: &str = "Recorded prompt";

    fn input(port: u16) -> Vec<u8> {
        serde_json::to_vec(&json!({"port":port,"token":"fixture.token","environmentId":"fixture-env",
            "threadId":THREAD,"projectId":PROJECT,"commandId":"fixture-command-1","messageId":"fixture-message-1"})).unwrap()
    }

    fn approval_input(port: u16) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(&input(port)).unwrap();
        value["approvalCommandId"] = json!("fixture-approval-command");
        serde_json::to_vec(&value).unwrap()
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
        read_projection_value(listener, projection(accepted));
    }

    fn read_projection_value(listener: &TcpListener, value: Value) {
        http(
            listener,
            "/.well-known/t3/environment",
            json!({"environmentId":"fixture-env"}),
            false,
        );
        http(
            listener,
            &format!("/api/orchestration/threads/{THREAD}/bounded"),
            value,
            true,
        );
    }

    fn command_socket(listener: &TcpListener) -> tungstenite::WebSocket<TcpStream> {
        tungstenite::accept_hdr(
            accept(listener),
            |request: &tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri(), "/ws?orchestrationProtocol=2");
                assert_eq!(request.headers()["Authorization"], "Bearer fixture.token");
                Ok(response)
            },
        )
        .unwrap()
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
                let mut socket = command_socket(&listener);
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
            let Progress::Completed(snapshot) = session.submit(PROMPT, &cancelled).unwrap() else {
                panic!("Expected an immediately completed turn");
            };
            assert!(snapshot.text.contains("Recorded reply"));
            assert!(session.submit(PROMPT, &cancelled).is_err());
            let reopened = Session::read(bytes.as_slice()).unwrap();
            assert!(reopened.submit(PROMPT, &cancelled).is_ok());
            peer.join().unwrap();
            assert_eq!(count.load(Ordering::Acquire), 1);
        }
    }

    fn approval_projection(resolved: bool) -> Value {
        let mut value = projection(true);
        let projection = &mut value["projection"];
        if !resolved {
            projection["runs"][0]["status"] = json!("running");
            projection["messages"].as_array_mut().unwrap().pop();
        }
        projection["runtimeRequests"] = json!([{
            "id": "fixture-request", "nodeId": "fixture-node", "providerTurnId": "fixture-turn",
            "kind": "command", "status": if resolved { "resolved" } else { "pending" },
            "responseCapability": { "type": "live", "providerSessionId": "fixture-session" },
        }]);
        if resolved {
            projection["runtimeRequests"][0]["decision"] = json!("accept");
        }
        projection["turnItems"] = json!([{
            "type": "approval_request", "requestId": "fixture-request", "requestKind": "command",
            "threadId": THREAD, "runId": "fixture-run", "nodeId": "fixture-node", "providerTurnId": "fixture-turn",
            "status": if resolved { "completed" } else { "waiting" },
            "prompt": "Read a synthetic fixture",
        }]);
        value
    }

    #[test]
    fn sends_one_approval_and_confirms_the_same_request_after_a_lost_ack() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = thread::spawn(move || {
            read_projection(&listener, false);
            let mut socket = command_socket(&listener);
            let first: Value =
                serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(first["payload"]["type"], "message.dispatch");
            drop(socket);
            read_projection_value(&listener, approval_projection(false));
            read_projection_value(&listener, approval_projection(false));
            let mut socket = command_socket(&listener);
            let second: Value =
                serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(
                second,
                json!({
                    "_tag": "Request", "id": "1", "tag": "orchestration.dispatchCommand", "headers": [],
                    "payload": {
                        "type": "runtime-request.respond", "commandId": "fixture-approval-command",
                        "threadId": THREAD, "requestId": "fixture-request", "decision": "accept",
                    },
                })
            );
            drop(socket);
            read_projection_value(&listener, approval_projection(true));
        });
        let session = Session::read(approval_input(port).as_slice()).unwrap();
        let cancelled = AtomicBool::new(false);
        let Progress::Approval(approval) = session.submit(PROMPT, &cancelled).unwrap() else {
            panic!("Expected the selected run to wait for a decision");
        };
        assert_eq!(approval.detail, "Read a synthetic fixture");
        assert!(session.submit(PROMPT, &cancelled).is_err());
        let snapshot = session.allow_once(&approval, PROMPT, &cancelled).unwrap();
        assert!(snapshot.text.contains("Recorded reply"));
        assert!(session.allow_once(&approval, PROMPT, &cancelled).is_err());
        peer.join().unwrap();
    }

    #[test]
    fn changed_approval_detail_refuses_before_dispatch() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let session = Session::read(approval_input(port).as_slice()).unwrap();
        let before = approval_projection(false);
        let run = session.selected_run(&before, PROMPT).unwrap();
        let approval = session.pending_approval(&before, run).unwrap();
        let mut changed = before;
        changed["projection"]["turnItems"][0]["prompt"] = json!("Different request details");
        let (done, finished) = mpsc::channel();
        let peer = thread::spawn(move || {
            read_projection_value(&listener, changed);
            finished.recv_timeout(Duration::from_secs(15)).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        });
        assert!(
            session
                .allow_once(&approval, PROMPT, &AtomicBool::new(false))
                .is_err()
        );
        done.send(()).unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn refuses_normalized_identity_and_header_injection_before_network_io() {
        let mut value: Value = serde_json::from_slice(&input(1)).unwrap();
        value["commandId"] = json!(" padded-command ");
        assert!(Session::read(value.to_string().as_bytes()).is_err());
        value["commandId"] = json!("fixture-command-1");
        value["approvalCommandId"] = json!("fixture-command-1");
        assert!(Session::read(value.to_string().as_bytes()).is_err());
        value["approvalCommandId"] = json!("fixture-approval-command");
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
