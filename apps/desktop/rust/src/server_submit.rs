//! One turn and one optional approval through the application's authenticated WebSocket RPC.
use crate::server_snapshot::{Connection, Snapshot};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use t3_code_ls_client_text::text_revision::{TextChange, TextEdit, TextRevision};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

pub const FAILED: &str =
    "Could not confirm submission. Draft kept. Check the thread before retrying.";
pub const INTERRUPTED: &str = "Server run interrupted. Draft kept.";
pub const STOP_UNKNOWN: &str =
    "Could not confirm interruption. Draft kept. Check the server thread before retrying.";
pub const STOP_PENDING: &str = "Stop requested. Waiting for server interruption.";
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
    Interrupted(Snapshot),
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

#[derive(Default)]
struct StopState {
    active: Option<String>,
    requested: Option<String>,
    attempted: bool,
}

pub struct Session {
    connection: Connection,
    project_id: String,
    command_id: String,
    message_id: String,
    approval_command_id: Option<String>,
    stop_command_id: Option<String>,
    stop: Mutex<StopState>,
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
        let has_stop = object.contains_key("stopCommandId");
        let expected_fields = 7 + usize::from(has_approval) + usize::from(has_stop);
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
        let stop_command_id = has_stop.then(|| identity("stopCommandId")).transpose()?;
        if stop_command_id
            .as_ref()
            .is_some_and(|id| id == &command_id || Some(id) == approval_command_id.as_ref())
        {
            return Err(FAILED);
        }
        if approval_command_id.as_deref() == Some(command_id.as_str()) {
            return Err(FAILED);
        }
        Ok(Self {
            connection: Connection::read(connection.as_slice()).map_err(|_| FAILED)?,
            project_id: identity("projectId")?,
            command_id,
            message_id: identity("messageId")?,
            approval_command_id,
            stop_command_id,
            stop: Mutex::new(StopState::default()),
            attempted: AtomicBool::new(false),
            approval_attempted: AtomicBool::new(false),
        })
    }

    pub fn can_stop(&self) -> bool {
        self.stop_command_id.is_some()
            && self.stop.lock().is_ok_and(|state| {
                state.active.is_some() && state.requested.is_none() && !state.attempted
            })
    }

    // Only queue a confirmed streamed identity. The transport revalidates it before dispatch.
    pub fn request_stop(&self) -> bool {
        let Ok(mut state) = self.stop.lock() else {
            return false;
        };
        if self.stop_command_id.is_none() || state.requested.is_some() || state.attempted {
            return false;
        }
        let Some(run) = state.active.take() else {
            return false;
        };
        state.requested = Some(run);
        true
    }

    fn stop_attempted(&self) -> bool {
        self.stop.lock().map_or(true, |state| state.attempted)
    }

    fn dispatch_stop(
        &self,
        snapshot: &Value,
        text: &str,
        cancelled: &AtomicBool,
    ) -> Result<bool, &'static str> {
        let requested = {
            let mut state = self.stop.lock().map_err(|_| STOP_UNKNOWN)?;
            let Some(run) = state.requested.take() else {
                return Ok(false);
            };
            state.attempted = true;
            run
        };
        let run = self.selected_run(snapshot, text).ok_or(STOP_UNKNOWN)?;
        if run["id"].as_str() != Some(requested.as_str())
            || run["status"].as_str() != Some("running")
        {
            return Err(STOP_UNKNOWN);
        }
        // No retry after a lost acknowledgement. Only a fresh interrupted projection confirms Stop.
        let _receipt = self.dispatch(json!({
            "type":"run.interrupt", "commandId":self.stop_command_id.as_ref().ok_or(STOP_UNKNOWN)?,
            "threadId":self.connection.thread_id(), "runId":requested,
        }), cancelled);
        Ok(true)
    }

    pub fn submit(&self, text: &str, cancelled: &AtomicBool) -> Result<Progress, &'static str> {
        self.submit_inner(text, cancelled, None)
    }

    pub fn submit_streaming(
        &self,
        text: &str,
        cancelled: &AtomicBool,
        deliver: &mut dyn FnMut(Snapshot) -> Result<(), &'static str>,
    ) -> Result<Progress, &'static str> {
        self.submit_inner(text, cancelled, Some(deliver))
    }

    fn submit_inner(
        &self,
        text: &str,
        cancelled: &AtomicBool,
        deliver: Option<&mut dyn FnMut(Snapshot) -> Result<(), &'static str>>,
    ) -> Result<Progress, &'static str> {
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
        if !self.ready_for_dispatch(&before) {
            return Err(FAILED);
        }
        self.check_cancelled(cancelled)?;
        let mut stream = deliver
            .map(|deliver| {
                self.subscribe(cancelled).map(|socket| Delivery {
                    socket,
                    deliver,
                    bytes: 0,
                    frames: 0,
                    text: None,
                })
            })
            .transpose()?;
        let command = json!({
            "type":"message.dispatch", "commandId":self.command_id,
            "threadId":self.connection.thread_id(), "messageId":self.message_id,
            "text":text, "attachments":[], "createdBy":"user", "creationSource":"web",
            "dispatchMode":{"type":"start_immediately"},
        });
        // Even an RPC error can follow a committed dispatch. Reconcile only by reading this identity.
        let _receipt = self.dispatch(command, cancelled);
        let result = self.observe(cancelled, text, stream.as_mut(), |snapshot| {
            let run = self.selected_run(snapshot, text)?;
            if self.stop_attempted() {
                return (run["status"].as_str() == Some("interrupted"))
                    .then(|| self.completed(snapshot).ok().map(Progress::Interrupted))
                    .flatten();
            }
            if run["status"].as_str() == Some("completed") {
                return self.completed(snapshot).ok().map(Progress::Completed);
            }
            self.approval_command_id.as_ref()?;
            self.pending_approval(snapshot, run).map(Progress::Approval)
        });
        result.map_err(|error| {
            if self
                .stop
                .lock()
                .is_ok_and(|state| state.attempted || state.requested.is_some())
            {
                STOP_UNKNOWN
            } else {
                error
            }
        })
    }

    pub fn allow_once(
        &self,
        approval: &Approval,
        text: &str,
        cancelled: &AtomicBool,
    ) -> Result<Snapshot, &'static str> {
        self.allow_once_inner(approval, text, cancelled, None)
    }

    pub fn allow_once_streaming(
        &self,
        approval: &Approval,
        text: &str,
        cancelled: &AtomicBool,
        deliver: &mut dyn FnMut(Snapshot) -> Result<(), &'static str>,
    ) -> Result<Snapshot, &'static str> {
        self.allow_once_inner(approval, text, cancelled, Some(deliver))
    }

    fn allow_once_inner(
        &self,
        approval: &Approval,
        text: &str,
        cancelled: &AtomicBool,
        deliver: Option<&mut dyn FnMut(Snapshot) -> Result<(), &'static str>>,
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
        let mut stream = deliver
            .map(|deliver| {
                self.subscribe(cancelled).map(|socket| Delivery {
                    socket,
                    deliver,
                    bytes: 0,
                    frames: 0,
                    text: None,
                })
            })
            .transpose()?;
        // The server still validates that this request is pending when it commits the command.
        let _receipt = self.dispatch(
            json!({
                "type": "runtime-request.respond", "commandId": command_id,
                "threadId": self.connection.thread_id(), "requestId": approval.request_id,
                "decision": ACCEPT_ONCE,
            }),
            cancelled,
        );
        self.observe(cancelled, text, stream.as_mut(), |snapshot| {
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
        submitted: &str,
        mut stream: Option<&mut Delivery<'_>>,
        observed: impl Fn(&Value) -> Option<T>,
    ) -> Result<T, &'static str> {
        let mut started = Instant::now();
        while started.elapsed() < RPC_DEADLINE {
            self.check_cancelled(cancelled)?;
            if let Ok(snapshot) = self.bound_projection() {
                if self.dispatch_stop(&snapshot, submitted, cancelled)? {
                    started = Instant::now();
                }
                if self.stop_attempted()
                    && self.selected_run(&snapshot, submitted).is_some_and(|run| {
                        matches!(
                            run["status"].as_str(),
                            Some("completed" | "failed" | "cancelled" | "rolled_back")
                        )
                    })
                {
                    return Err(STOP_UNKNOWN);
                }
                if let Some(delivery) = stream.as_mut() {
                    self.check_cancelled(cancelled)?;
                    if !self.stop_attempted() {
                        delivery.receive(self, submitted, &snapshot, cancelled)?;
                    }
                }
                if let Some(result) = observed(&snapshot) {
                    self.check_cancelled(cancelled)?;
                    if let Some(delivery) = stream.as_mut() {
                        // Reconcile the authoritative final body through the same text owner,
                        // even when completion overtakes buffered WebSocket updates.
                        let sequence = snapshot["snapshotSequence"].as_u64().ok_or(FAILED)?;
                        for message in snapshot["projection"]["messages"]
                            .as_array()
                            .ok_or(FAILED)?
                        {
                            delivery
                                .apply(self, submitted, &snapshot, message, sequence, cancelled)?;
                        }
                    }
                    return Ok(result);
                }
            }
            if stream.is_none() || self.stop_attempted() {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        Err(if self.stop_attempted() {
            STOP_UNKNOWN
        } else {
            FAILED
        })
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

    fn ready_for_dispatch(&self, snapshot: &Value) -> bool {
        let projection = &snapshot["projection"];
        projection["messages"].as_array().is_some_and(|messages| {
            messages.iter().all(|message| {
                checked_identity(&message["id"]).is_some_and(|id| id != self.message_id)
            })
        }) && projection["runs"].as_array().is_some_and(|runs| {
            runs.iter().all(|run| {
                matches!(
                    run["status"].as_str(),
                    Some("completed" | "interrupted" | "failed" | "cancelled" | "rolled_back")
                )
            })
        })
    }

    fn selected_run<'a>(&self, snapshot: &'a Value, text: &str) -> Option<&'a Value> {
        let projection = &snapshot["projection"];
        let mut messages = projection["messages"]
            .as_array()?
            .iter()
            .filter(|message| message["id"].as_str() == Some(self.message_id.as_str()));
        let message = messages.next()?;
        if messages.next().is_some()
            || message["role"].as_str() != Some("user")
            || message["text"].as_str() != Some(text)
            || message["threadId"].as_str() != Some(self.connection.thread_id())
        {
            return None;
        }
        let run_id = checked_identity(&message["runId"])?;
        let mut runs = projection["runs"]
            .as_array()?
            .iter()
            .filter(|run| run["id"].as_str() == Some(run_id));
        let run = runs.next()?;
        (runs.next().is_none() && run["threadId"].as_str() == Some(self.connection.thread_id()))
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

    fn subscribe(
        &self,
        cancelled: &AtomicBool,
    ) -> Result<tungstenite::WebSocket<DeadlineStream>, &'static str> {
        self.check_cancelled(cancelled)?;
        let mut socket = self.open_socket()?;
        self.check_cancelled(cancelled)?;
        socket.send(Message::Text(json!({
            "_tag":"Request", "id":"stream", "tag":"orchestration.subscribeThread",
            "payload":{"threadId":self.connection.thread_id(), "acceptBoundedSnapshot":true},
            "headers":[],
        }).to_string().into())).map_err(|_| FAILED)?;
        Ok(socket)
    }

    fn open_socket(&self) -> Result<tungstenite::WebSocket<DeadlineStream>, &'static str> {
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
        Ok(socket)
    }

    fn dispatch(&self, command: Value, cancelled: &AtomicBool) -> Result<(), &'static str> {
        self.check_cancelled(cancelled)?;
        let mut socket = self.open_socket()?;
        let deadline = socket.get_ref().deadline;
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

// Full message updates only. Delta/compact encodings are deliberately not negotiated.
// One selected assistant item and a bounded UI queue avoid an unbounded renderer backlog.
struct Delivery<'a> {
    socket: tungstenite::WebSocket<DeadlineStream>,
    deliver: &'a mut dyn FnMut(Snapshot) -> Result<(), &'static str>,
    bytes: usize,
    frames: usize,
    text: Option<(String, TextRevision)>,
}

impl Delivery<'_> {
    fn receive(
        &mut self,
        session: &Session,
        submitted: &str,
        snapshot: &Value,
        cancelled: &AtomicBool,
    ) -> Result<(), &'static str> {
        session.check_cancelled(cancelled)?;
        if self.frames >= 128 || Instant::now() >= self.socket.get_ref().deadline {
            return Err(FAILED);
        }
        let message = match self.socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(());
            }
            Err(_) => return Err(FAILED),
        };
        self.frames += 1;
        match message {
            Message::Text(text) => {
                self.bytes += text.len();
                if self.bytes > 4 * MAX_REPLY {
                    return Err(FAILED);
                }
                let value: Value = serde_json::from_str(&text).map_err(|_| FAILED)?;
                let batch = match &value {
                    Value::Array(batch) => batch.as_slice(),
                    value => std::slice::from_ref(value),
                };
                if batch.len() > 64 {
                    return Err(FAILED);
                }
                for frame in batch {
                    match frame["_tag"].as_str() {
                        Some("Ping") => self
                            .socket
                            .send(Message::Text("{\"_tag\":\"Pong\"}".into()))
                            .map_err(|_| FAILED)?,
                        Some("Pong") => {}
                        Some("Chunk") if frame["requestId"].as_str() == Some("stream") => {
                            let values = frame["values"]
                                .as_array()
                                .filter(|values| values.len() <= 64)
                                .ok_or(FAILED)?;
                            for item in values {
                                if item["kind"].as_str() == Some("event")
                                    && item["event"]["type"].as_str() == Some("message.updated")
                                {
                                    if item["event"]["threadId"].as_str()
                                        != Some(session.connection.thread_id())
                                    {
                                        return Err(FAILED);
                                    }
                                    self.apply(
                                        session,
                                        submitted,
                                        snapshot,
                                        &item["event"]["payload"],
                                        item["sequence"].as_u64().ok_or(FAILED)?,
                                        cancelled,
                                    )?;
                                } else if item["kind"].as_str() == Some("snapshot") {
                                    if item["projection"]["thread"]["id"].as_str()
                                        != Some(session.connection.thread_id())
                                        || item["projection"]["thread"]["projectId"].as_str()
                                            != Some(session.project_id.as_str())
                                    {
                                        return Err(FAILED);
                                    }
                                    for message in item["projection"]["messages"]
                                        .as_array()
                                        .filter(|items| items.len() <= 200)
                                        .ok_or(FAILED)?
                                    {
                                        self.apply(
                                            session,
                                            submitted,
                                            snapshot,
                                            message,
                                            item["snapshotSequence"].as_u64().ok_or(FAILED)?,
                                            cancelled,
                                        )?;
                                    }
                                }
                            }
                            self.socket
                                .send(Message::Text(
                                    json!({"_tag":"Ack","requestId":"stream"})
                                        .to_string()
                                        .into(),
                                ))
                                .map_err(|_| FAILED)?;
                        }
                        _ => return Err(FAILED),
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => self.socket.flush().map_err(|_| FAILED)?,
            _ => return Err(FAILED),
        }
        Ok(())
    }

    fn apply(
        &mut self,
        session: &Session,
        submitted: &str,
        snapshot: &Value,
        message: &Value,
        sequence: u64,
        cancelled: &AtomicBool,
    ) -> Result<(), &'static str> {
        let Some(run) = session.selected_run(snapshot, submitted) else {
            return Ok(());
        };
        if message["role"].as_str() != Some("assistant") || message["runId"] != run["id"] {
            return Ok(());
        }
        if message["threadId"].as_str() != Some(session.connection.thread_id()) {
            return Err(FAILED);
        }
        let id = checked_identity(&message["id"]).ok_or(FAILED)?;
        let body = message["text"].as_str().ok_or(FAILED)?;
        let (selected, state) = self.text.get_or_insert_with(|| {
            (
                id.to_owned(),
                TextRevision::from_snapshot(0, 0, String::new(), MAX_REPLY).expect("empty text"),
            )
        });
        if selected != id {
            return Ok(());
        }
        if sequence == state.sequence() {
            return if state.text() == body {
                Ok(())
            } else {
                Err(FAILED)
            };
        }
        if sequence < state.sequence() {
            return Ok(());
        }
        state
            .apply(TextChange {
                base_revision: state.revision(),
                revision: state.revision() + 1,
                sequence,
                edit: TextEdit::Replace(body),
            })
            .map_err(|_| FAILED)?;
        session.check_cancelled(cancelled)?;
        if session.stop_command_id.is_some() && run["status"].as_str() == Some("running") {
            let mut stop = session.stop.lock().map_err(|_| FAILED)?;
            if !stop.attempted && stop.requested.is_none() {
                stop.active = checked_identity(&run["id"]).map(str::to_owned);
            }
        }
        (self.deliver)(Snapshot {
            text: format!(
                "Thread {}\nMessage {}\nassistant\n{}\n",
                session.connection.thread_id(),
                id,
                state.text()
            ),
        })
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

    fn with_previous_turn(mut value: Value) -> Value {
        value["projection"]["runs"].as_array_mut().unwrap().insert(
            0,
            json!({
                "id": "earlier-run", "threadId": THREAD, "status": "completed"
            }),
        );
        value["projection"]["messages"]
            .as_array_mut()
            .unwrap()
            .insert(
                0,
                json!({
                    "id": "earlier-message", "threadId": THREAD, "runId": "earlier-run",
                    "role": "user", "text": PROMPT
                }),
            );
        value
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

    fn stop_input(port: u16) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(&input(port)).unwrap();
        value["stopCommandId"] = json!("fixture-stop-command");
        serde_json::to_vec(&value).unwrap()
    }

    #[test]
    fn stop_exact_run_once_reconciles_ack_and_lost_ack_without_treating_cancel_as_interrupt() {
        for (terminal, acknowledge) in [
            ("interrupted", true),
            ("interrupted", false),
            ("cancelled", true),
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let peer = thread::spawn(move || {
                let mut active = projection(true);
                active["projection"]["runs"][0]["status"] = json!("running");
                read_projection_value(&listener, active);
                let mut socket = command_socket(&listener);
                let command: Value =
                    serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
                assert_eq!(command["tag"], "orchestration.dispatchCommand");
                assert_eq!(
                    command["payload"],
                    json!({"type":"run.interrupt", "commandId":"fixture-stop-command",
                    "threadId":THREAD, "runId":"fixture-run"})
                );
                if acknowledge {
                    socket.send(Message::Text(json!({"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"sequence":8}}}).to_string().into())).unwrap();
                }
                drop(socket);
                let mut after = projection(true);
                after["projection"]["runs"][0]["status"] = json!(terminal);
                read_projection_value(&listener, after);
                // The listener owns exactly one interrupt dispatch; repeats must stay local.
                thread::sleep(Duration::from_millis(50));
                assert!(listener.accept().is_err());
            });
            let session = Session::read(stop_input(port).as_slice()).unwrap();
            assert!(!session.request_stop());
            session.stop.lock().unwrap().active = Some("fixture-run".into());
            assert!(session.can_stop());
            assert!(session.request_stop());
            assert!(!session.request_stop());
            let result = session.observe(&AtomicBool::new(false), PROMPT, None, |snapshot| {
                let run = session.selected_run(snapshot, PROMPT)?;
                (run["status"].as_str() == Some("interrupted"))
                    .then(|| session.completed(snapshot).unwrap())
            });
            if terminal == "interrupted" {
                assert!(result.unwrap().text.contains("Message fixture-reply"));
            } else {
                assert_eq!(result.err(), Some(STOP_UNKNOWN));
            }
            assert!(!session.can_stop());
            assert!(!session.request_stop());
            peer.join().unwrap();
        }
    }

    #[test]
    fn stale_stop_and_local_cancel_never_send_interrupt() {
        for changed in [false, true] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let peer = thread::spawn(move || {
                let mut value = projection(true);
                if changed {
                    value["projection"]["runs"][0]["id"] = json!("replacement-run");
                    value["projection"]["messages"][0]["runId"] = json!("replacement-run");
                    value["projection"]["runs"][0]["status"] = json!("running");
                }
                read_projection_value(&listener, value);
                thread::sleep(Duration::from_millis(50));
                assert!(listener.accept().is_err());
            });
            let session = Session::read(stop_input(port).as_slice()).unwrap();
            session.stop.lock().unwrap().active = Some("fixture-run".into());
            assert!(session.request_stop());
            let result = session.observe::<()>(&AtomicBool::new(false), PROMPT, None, |_| None);
            assert_eq!(result.err(), Some(STOP_UNKNOWN));
            assert!(!session.request_stop());
            peer.join().unwrap();
        }
        let session = Session::read(stop_input(1).as_slice()).unwrap();
        session.stop.lock().unwrap().active = Some("fixture-run".into());
        assert!(session.request_stop());
        assert!(
            session
                .observe::<()>(&AtomicBool::new(true), PROMPT, None, |_| None)
                .is_err()
        );
        assert!(!session.stop_attempted());
    }

    #[test]
    fn streams_original_partial_then_final_for_one_dispatch_and_same_message() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = thread::spawn(move || {
            read_projection(&listener, false);
            let mut stream = command_socket(&listener);
            let subscription: Value =
                serde_json::from_str(stream.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(subscription["tag"], "orchestration.subscribeThread");
            assert_eq!(
                subscription["payload"],
                json!({"threadId": THREAD, "acceptBoundedSnapshot": true})
            );
            let mut dispatch = command_socket(&listener);
            let command: Value =
                serde_json::from_str(dispatch.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(command["payload"]["type"], "message.dispatch");
            assert_eq!(command["payload"]["messageId"], "fixture-message-1");
            dispatch.send(Message::Text(json!({"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"sequence":1}}}).to_string().into())).unwrap();
            let mut partial = projection(true);
            partial["projection"]["runs"][0]["status"] = json!("running");
            partial["projection"]["messages"][1]["text"] = json!("I'll track the three steps");
            read_projection_value(&listener, partial.clone());
            stream.send(Message::Text(json!({"_tag":"Chunk","requestId":"stream","values":[{
                "kind":"event","sequence":5,"event":{"type":"message.updated","threadId":THREAD,
                "payload":partial["projection"]["messages"][1]}
            }]}).to_string().into())).unwrap();
            let ack: Value =
                serde_json::from_str(stream.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(ack, json!({"_tag":"Ack","requestId":"stream"}));
            read_projection(&listener, true);
            stream.send(Message::Text(json!({"_tag":"Chunk","requestId":"stream","values":[{
                "kind":"event","sequence":7,"event":{"type":"message.updated","threadId":THREAD,
                "payload":projection(true)["projection"]["messages"][1]}
            }]}).to_string().into())).unwrap();
            let _ = stream.read().unwrap();
        });
        let session = Session::read(input(port).as_slice()).unwrap();
        let mut updates = Vec::new();
        let result = session
            .submit_streaming(PROMPT, &AtomicBool::new(false), &mut |snapshot| {
                updates.push(snapshot.text);
                Ok(())
            })
            .unwrap();
        assert_eq!(updates.len(), 2);
        assert!(updates[0].contains("I'll track the three steps"));
        assert!(!updates[0].contains("Recorded reply"));
        assert!(
            updates
                .iter()
                .all(|text| text.contains("Message fixture-reply\n"))
        );
        let Progress::Completed(snapshot) = result else {
            panic!("expected completed turn")
        };
        assert!(snapshot.text.contains("Message fixture-reply\n"));
        assert!(snapshot.text.contains("Recorded reply"));
        assert!(session.submit(PROMPT, &AtomicBool::new(false)).is_err());
        peer.join().unwrap();
    }

    #[test]
    fn dispatches_once_and_reconciles_the_same_identity_after_a_lost_ack_or_reopen() {
        for (send_ack, populated) in [(true, false), (false, true)] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let count = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&count);
            let peer = thread::spawn(move || {
                let read = |accepted| {
                    let value = projection(accepted);
                    read_projection_value(
                        &listener,
                        if populated {
                            with_previous_turn(value)
                        } else {
                            value
                        },
                    );
                };
                read(false);
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
                read(true);
                // A fresh view with the caller's original identities reads the receipt's projected result.
                read(true);
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

    #[test]
    fn unresolved_or_duplicate_identity_refuses_dispatch() {
        let session = Session::read(input(1).as_slice()).unwrap();
        let mut current = with_previous_turn(projection(false));
        assert!(session.ready_for_dispatch(&current));
        current["projection"]["runs"][0]["status"] = json!("waiting");
        assert!(!session.ready_for_dispatch(&current));
        current["projection"]["runs"][0]["status"] = json!("completed");
        current["projection"]["messages"][0]["id"] = json!("fixture-message-1");
        assert!(!session.ready_for_dispatch(&current));

        let mut ambiguous = with_previous_turn(projection(true));
        ambiguous["projection"]["runs"][0]["id"] = json!("fixture-run");
        assert!(session.selected_run(&ambiguous, PROMPT).is_none());
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
