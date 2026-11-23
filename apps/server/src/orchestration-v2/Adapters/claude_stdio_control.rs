//! Frame and request ownership for the Claude stream-JSON control channel.
//! Frame shapes follow the public SDK declarations pinned in pnpm-lock.yaml.

extern crate alloc;

use crate::json::{self, Value};
use alloc::{
    borrow::ToOwned,
    collections::{BTreeMap, BTreeSet},
    format,
    string::String,
    vec,
};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionTicket {
    request_id: String,
    issued: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Message(Value),
    BackgroundResult(Value),
    PermissionRequested {
        ticket: PermissionTicket,
        request: Value,
    },
    PermissionWithdrawn(PermissionTicket),
    InterruptResponse {
        request_id: String,
        success: bool,
        response: Value,
    },
    Ignored,
}

pub struct ControlSession {
    next_sequence: u64,
    max_pending: usize,
    interrupts: BTreeSet<String>,
    permissions: BTreeMap<String, u64>,
}

impl ControlSession {
    pub const fn new(max_pending: usize) -> Self {
        Self {
            next_sequence: 0,
            max_pending,
            interrupts: BTreeSet::new(),
            permissions: BTreeMap::new(),
        }
    }

    fn reserve_request(&mut self) -> Result<u64, ProtocolError> {
        if self.interrupts.len().saturating_add(self.permissions.len()) >= self.max_pending {
            return Err(ProtocolError::TooManyRequests);
        }
        let issued = self
            .next_sequence
            .checked_add(1)
            .ok_or(ProtocolError::SequenceExhausted)?;
        self.next_sequence = issued;
        Ok(issued)
    }

    pub fn request_interrupt(&mut self) -> Result<Value, ProtocolError> {
        let request_id = format!("t3-interrupt-{}", self.reserve_request()?);
        self.interrupts.insert(request_id.clone());
        Ok(Value::Object(vec![
            ("type".into(), Value::String("control_request".into())),
            ("request_id".into(), Value::String(request_id)),
            (
                "request".into(),
                Value::Object(vec![("subtype".into(), Value::String("interrupt".into()))]),
            ),
        ]))
    }

    pub fn receive(&mut self, line: &str, limits: json::Limits) -> Result<Incoming, ProtocolError> {
        let message =
            json::parse_with_limits(line, limits).map_err(|_| ProtocolError::InvalidFrame)?;
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
                        })
                    }))
            }
            "control_response" => {
                let response = field(&message, "response")?;
                let request_id = text(response, "request_id")?;
                if !self.interrupts.contains(request_id) {
                    return Ok(Incoming::Ignored);
                }
                let success = match text(response, "subtype")? {
                    "success" => true,
                    "error" => false,
                    _ => return Err(ProtocolError::InvalidFrame),
                };
                self.interrupts.remove(request_id);
                Ok(Incoming::InterruptResponse {
                    request_id: request_id.to_owned(),
                    success,
                    response: response.clone(),
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
        if self.permissions.get(&ticket.request_id) != Some(&ticket.issued) {
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
