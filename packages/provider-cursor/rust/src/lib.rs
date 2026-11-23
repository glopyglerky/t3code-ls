#![no_std]

//! The uncompressed Connect JSON subset for Cursor's sdk.v1 Send stream.
//! Protocol source: https://github.com/cursor/sdk-bridge/tree/6c9101088c18fab95c73d2dd68ca11d6fbf7d483

extern crate alloc;

use alloc::{borrow::ToOwned, string::String};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamError {
    FrameTooLarge,
    UnsupportedFrameFlags,
    InvalidMessage,
    RunMismatch,
    UnexpectedMessage,
    BridgeError,
    IncompleteRun,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    Message(&'a [u8]),
    EndStream(&'a [u8]),
}

pub fn frame(input: &[u8], limit: usize) -> Result<Option<(Frame<'_>, &[u8])>, StreamError> {
    let Some((header, body)) = input.split_first_chunk::<5>() else {
        return Ok(None);
    };
    let [flags, length @ ..] = *header;
    let size = u32::from_be_bytes(length) as usize;
    if size > limit {
        return Err(StreamError::FrameTooLarge);
    }
    if flags != 0 && flags != 2 {
        return Err(StreamError::UnsupportedFrameFlags);
    }
    Ok(body.split_at_checked(size).map(|(payload, rest)| {
        let frame = match flags {
            0 => Frame::Message(payload),
            _ => Frame::EndStream(payload),
        };
        (frame, rest)
    }))
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunStatus {
    Finished,
    Failed,
    Cancelled,
    Expired,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TerminalRun {
    pub run_id: String,
    pub status: RunStatus,
    pub final_text: String,
}

pub struct SendStream<'a> {
    agent_id: &'a str,
    terminal: Option<TerminalRun>,
    done: bool,
    ended: bool,
    failure: Option<StreamError>,
}

impl<'a> SendStream<'a> {
    pub const fn new(agent_id: &'a str) -> Self {
        Self {
            agent_id,
            terminal: None,
            done: false,
            ended: false,
            failure: None,
        }
    }

    /// Returns a live assistant text fragment. Read the terminal result with `finish`.
    pub fn push(&mut self, frame: Frame<'_>) -> Result<Option<String>, StreamError> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let update = self.push_frame(frame);
        self.failure = update.as_ref().err().copied();
        update
    }

    fn push_frame(&mut self, frame: Frame<'_>) -> Result<Option<String>, StreamError> {
        if self.ended {
            return Err(StreamError::UnexpectedMessage);
        }
        let (bytes, is_end) = match frame {
            Frame::Message(bytes) => (bytes, false),
            Frame::EndStream(bytes) => (bytes, true),
        };
        let envelope: Value =
            serde_json::from_slice(bytes).map_err(|_| StreamError::InvalidMessage)?;
        let message = envelope.as_object().ok_or(StreamError::InvalidMessage)?;
        if is_end {
            if message.get("error").is_some_and(|error| !error.is_null()) {
                return Err(StreamError::BridgeError);
            }
            self.ended = true;
            return Ok(None);
        }
        let mut recognized = ["result", "done", "interactionUpdate", "sdkMessage", "step"]
            .into_iter()
            .filter_map(|key| {
                message
                    .get(key)
                    .filter(|value| !value.is_null())
                    .map(|v| (key, v))
            });
        let Some((kind, payload)) = recognized.next() else {
            return Ok(None);
        };
        if recognized.next().is_some() || !payload.is_object() {
            return Err(StreamError::InvalidMessage);
        }
        if self.done || (self.terminal.is_some() && kind != "done") {
            return Err(StreamError::UnexpectedMessage);
        }
        match kind {
            "result" => {
                let run_id = run_id(payload, self.agent_id)?.to_owned();
                let status = match (payload["status"].as_str(), payload["status"].as_u64()) {
                    (Some("RUN_LIFECYCLE_STATUS_FINISHED"), _) | (_, Some(3)) => {
                        RunStatus::Finished
                    }
                    (Some("RUN_LIFECYCLE_STATUS_ERROR"), _) | (_, Some(4)) => RunStatus::Failed,
                    (Some("RUN_LIFECYCLE_STATUS_CANCELLED"), _) | (_, Some(5)) => {
                        RunStatus::Cancelled
                    }
                    (Some("RUN_LIFECYCLE_STATUS_EXPIRED"), _) | (_, Some(6)) => RunStatus::Expired,
                    _ => return Err(StreamError::InvalidMessage),
                };
                let final_text = payload["result"]["result"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                self.terminal = Some(TerminalRun {
                    run_id,
                    status,
                    final_text,
                });
            }
            "done" => {
                let run = self.terminal.as_ref().ok_or(StreamError::IncompleteRun)?;
                if run_id(payload, self.agent_id)? != run.run_id {
                    return Err(StreamError::RunMismatch);
                }
                self.done = true;
            }
            "interactionUpdate" if payload["type"] == "text-delta" => {
                return payload["update"]["text"]
                    .as_str()
                    .map(|text| Some(text.to_owned()))
                    .ok_or(StreamError::InvalidMessage);
            }
            _ => {}
        }
        Ok(None)
    }

    /// Call only after a clean transport EOF and after processing every buffered frame.
    pub fn finish(self) -> Result<TerminalRun, StreamError> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.done || !self.ended {
            return Err(StreamError::IncompleteRun);
        }
        self.terminal.ok_or(StreamError::IncompleteRun)
    }
}

fn run_id<'a>(payload: &'a Value, agent_id: &str) -> Result<&'a str, StreamError> {
    if payload["agentId"].as_str() != Some(agent_id) {
        return Err(StreamError::RunMismatch);
    }
    payload["runId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(StreamError::InvalidMessage)
}
