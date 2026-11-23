//! Frame and request ownership for the Claude stream-JSON control channel.
//! Frame shapes follow the public SDK declarations pinned in pnpm-lock.yaml.

extern crate alloc;

use crate::json::{self, Value};
use alloc::{borrow::ToOwned, collections::BTreeMap, format, string::String, sync::Arc, vec};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    FrameTooLarge,
    InvalidFrame,
    DuplicatePeerRequest,
    TooManyRequests,
    SequenceExhausted,
}

pub fn frame(input: &[u8], max_bytes: usize) -> Result<Option<(&str, &[u8])>, ProtocolError> {
    let scan = &input[..input.len().min(max_bytes.saturating_add(1))];
    if let Some(newline) = scan.iter().position(|byte| *byte == b'\n') {
        let line =
            core::str::from_utf8(&input[..newline]).map_err(|_| ProtocolError::InvalidFrame)?;
        return Ok(Some((line, &input[newline + 1..])));
    }
    if input.len() > max_bytes {
        return Err(ProtocolError::FrameTooLarge);
    }
    Ok(None)
}

#[derive(Clone, Debug)]
pub struct PermissionTicket {
    request_id: String,
    issued: u64,
    owner: Arc<()>,
}

impl PartialEq for PermissionTicket {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
            && self.issued == other.issued
            && self.request_id == other.request_id
    }
}

impl Eq for PermissionTicket {}

#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Message(Value),
    BackgroundResult(Value),
    PermissionRequested {
        ticket: PermissionTicket,
        request: Value,
    },
    PermissionWithdrawn(PermissionTicket),
    InitializeResponse {
        success: bool,
        response: Value,
    },
    InterruptResponse {
        request_id: String,
        success: bool,
        response: Value,
    },
    Ignored,
}

enum RequestKind {
    Initialize,
    Interrupt,
}

pub struct ControlSession {
    owner: Arc<()>,
    next_sequence: u64,
    max_pending: usize,
    requests: BTreeMap<String, RequestKind>,
    permissions: BTreeMap<String, u64>,
}

impl ControlSession {
    pub fn new(max_pending: usize) -> Self {
        Self {
            owner: Arc::new(()),
            next_sequence: 0,
            max_pending,
            requests: BTreeMap::new(),
            permissions: BTreeMap::new(),
        }
    }

    fn reserve_request(&mut self) -> Result<u64, ProtocolError> {
        if self.requests.len().saturating_add(self.permissions.len()) >= self.max_pending {
            return Err(ProtocolError::TooManyRequests);
        }
        let issued = self
            .next_sequence
            .checked_add(1)
            .ok_or(ProtocolError::SequenceExhausted)?;
        self.next_sequence = issued;
        Ok(issued)
    }

    pub fn request_initialize(&mut self) -> Result<Value, ProtocolError> {
        self.request(RequestKind::Initialize, "initialize")
    }

    pub fn request_interrupt(&mut self) -> Result<Value, ProtocolError> {
        self.request(RequestKind::Interrupt, "interrupt")
    }

    fn request(&mut self, kind: RequestKind, subtype: &str) -> Result<Value, ProtocolError> {
        let request_id = format!("t3-{subtype}-{}", self.reserve_request()?);
        self.requests.insert(request_id.clone(), kind);
        Ok(Value::Object(vec![
            ("type".into(), Value::String("control_request".into())),
            ("request_id".into(), Value::String(request_id)),
            (
                "request".into(),
                Value::Object(vec![("subtype".into(), Value::String(subtype.into()))]),
            ),
        ]))
    }

    pub fn receive(&mut self, line: &str, limits: json::Limits) -> Result<Incoming, ProtocolError> {
        let message =
            json::parse_with_limits(line, limits).map_err(|_| ProtocolError::InvalidFrame)?;
        self.receive_value(message)
    }

    pub(crate) fn receive_value(&mut self, message: Value) -> Result<Incoming, ProtocolError> {
        match text(&message, "type")? {
            "control_request" => {
                let request = field(&message, "request")?;
                if text(request, "subtype")? != "can_use_tool" {
                    return Ok(Incoming::Message(message));
                }
                let request_id = text(&message, "request_id")?;
                if self.permissions.contains_key(request_id) {
                    return Err(ProtocolError::DuplicatePeerRequest);
                }
                let issued = self.reserve_request()?;
                let ticket = PermissionTicket {
                    request_id: request_id.to_owned(),
                    issued,
                    owner: self.owner.clone(),
                };
                self.permissions.insert(ticket.request_id.clone(), issued);
                Ok(Incoming::PermissionRequested {
                    ticket,
                    request: request.clone(),
                })
            }
            "control_cancel_request" => {
                let request_id = text(&message, "request_id")?;
                Ok(self
                    .permissions
                    .remove(request_id)
                    .map_or(Incoming::Ignored, |issued| {
                        Incoming::PermissionWithdrawn(PermissionTicket {
                            request_id: request_id.to_owned(),
                            issued,
                            owner: self.owner.clone(),
                        })
                    }))
            }
            "control_response" => {
                let response = field(&message, "response")?;
                let request_id = text(response, "request_id")?;
                if !self.requests.contains_key(request_id) {
                    return Ok(Incoming::Ignored);
                }
                let success = match text(response, "subtype")? {
                    "success" => true,
                    "error" => false,
                    _ => return Err(ProtocolError::InvalidFrame),
                };
                Ok(match self.requests.remove(request_id) {
                    Some(RequestKind::Initialize) => Incoming::InitializeResponse {
                        success,
                        response: response.clone(),
                    },
                    Some(RequestKind::Interrupt) => Incoming::InterruptResponse {
                        request_id: request_id.to_owned(),
                        success,
                        response: response.clone(),
                    },
                    None => Incoming::Ignored,
                })
            }
            "result"
                if message
                    .get("origin")
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                    == Some("task-notification") =>
            {
                Ok(Incoming::BackgroundResult(message))
            }
            _ => Ok(Incoming::Message(message)),
        }
    }

    /// Only the pending request generation can consume the caller's decision.
    pub fn answer_permission(
        &mut self,
        ticket: &PermissionTicket,
        decision: Value,
    ) -> Option<Value> {
        if !Arc::ptr_eq(&ticket.owner, &self.owner)
            || self.permissions.get(&ticket.request_id) != Some(&ticket.issued)
        {
            return None;
        }
        self.permissions.remove(&ticket.request_id);
        Some(Value::Object(vec![
            ("type".into(), Value::String("control_response".into())),
            (
                "response".into(),
                Value::Object(vec![
                    ("subtype".into(), Value::String("success".into())),
                    (
                        "request_id".into(),
                        Value::String(ticket.request_id.clone()),
                    ),
                    ("response".into(), decision),
                ]),
            ),
        ]))
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, ProtocolError> {
    value.get(key).ok_or(ProtocolError::InvalidFrame)
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    field(value, key)?
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(ProtocolError::InvalidFrame)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERMISSION: &str = r#"{"type":"control_request","request_id":"peer","request":{"subtype":"can_use_tool","tool_name":"Read","input":{}}}"#;
    const WITHDRAW: &str = r#"{"type":"control_cancel_request","request_id":"peer"}"#;

    fn permission(session: &mut ControlSession) -> PermissionTicket {
        let Incoming::PermissionRequested { ticket, .. } = session
            .receive(PERMISSION, json::Limits::default())
            .unwrap()
        else {
            panic!("expected a permission request");
        };
        ticket
    }

    #[test]
    fn withdrawn_permission_cannot_answer_a_reused_id() {
        let limits = json::Limits::default();
        let mut session = ControlSession::new(2);
        let old = permission(&mut session);
        assert_eq!(
            session.receive(PERMISSION, limits),
            Err(ProtocolError::DuplicatePeerRequest)
        );
        assert_eq!(
            session.receive(WITHDRAW, limits),
            Ok(Incoming::PermissionWithdrawn(old.clone()))
        );

        let current = permission(&mut session);
        assert_ne!(old, current);
        let decision = json::parse(r#"{"behavior":"allow","updatedInput":{}}"#).unwrap();
        assert_eq!(session.answer_permission(&old, decision.clone()), None);
        let answer = session
            .answer_permission(&current, decision.clone())
            .unwrap();
        assert_eq!(text(&answer, "type"), Ok("control_response"));
        assert_eq!(
            text(field(&answer, "response").unwrap(), "request_id"),
            Ok("peer")
        );
        assert_eq!(session.answer_permission(&current, decision), None);
    }

    #[test]
    fn interrupt_reply_is_correlated_and_does_not_suppress_late_messages() {
        let limits = json::Limits::default();
        let mut session = ControlSession::new(1);
        let interrupt = session.request_interrupt().unwrap();
        let request_id = text(&interrupt, "request_id").unwrap();
        assert_eq!(
            session.receive(PERMISSION, limits),
            Err(ProtocolError::TooManyRequests)
        );
        let unsolicited =
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"old"}}"#;
        assert_eq!(session.receive(unsolicited, limits), Ok(Incoming::Ignored));
        let reply = format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{request_id}","response":{{}}}}}}"#
        );
        assert!(matches!(
            session.receive(&reply, limits),
            Ok(Incoming::InterruptResponse { success: true, .. })
        ));
        assert_eq!(session.receive(&reply, limits), Ok(Incoming::Ignored));
        let late = r#"{"type":"result","subtype":"success","session_id":"fixture"}"#;
        assert_eq!(
            session.receive(late, limits),
            Ok(Incoming::Message(json::parse(late).unwrap()))
        );
    }

    #[test]
    fn the_captured_background_results_keep_their_tag() {
        let capture = include_str!(
            "../testkit/fixtures/claude_background_wake_before_queued_prompt/claude_transcript.ndjson"
        );
        let mut session = ControlSession::new(1);
        let mut user_results = 0;
        let mut background_results = 0;
        for line in capture.lines() {
            let recorded = json::parse(line).unwrap();
            let Some(result) = recorded
                .get("frame")
                .filter(|value| text(value, "type") == Ok("result"))
            else {
                continue;
            };
            match session
                .receive(&json::stringify(result), json::Limits::default())
                .unwrap()
            {
                Incoming::BackgroundResult(value) => {
                    assert_eq!(value, *result);
                    background_results += 1;
                }
                Incoming::Message(value) => {
                    assert_eq!(value, *result);
                    user_results += 1;
                }
                other => panic!("unexpected result classification: {other:?}"),
            }
        }
        assert_eq!((user_results, background_results), (4, 2));
    }

    #[test]
    fn ndjson_limits_are_checked_before_an_incomplete_line_can_grow() {
        assert_eq!(frame(b"{}\nmore", 2), Ok(Some(("{}", &b"more"[..]))));
        assert_eq!(frame(b"{}", 2), Ok(None));
        assert_eq!(frame(b"123\n", 2), Err(ProtocolError::FrameTooLarge));
        assert_eq!(frame(&[255, b'\n'], 2), Err(ProtocolError::InvalidFrame));
    }
}
