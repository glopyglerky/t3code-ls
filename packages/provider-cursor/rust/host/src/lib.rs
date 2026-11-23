//! Connect JSON client for a local sdk.v1 bridge.

use std::{net::SocketAddr, time::Duration};

use reqwest::{Client, Response, StatusCode, header};
use serde_json::{Value, json};
use t3_code_ls_cursor_bridge::{SendStream, StreamError, TerminalRun, frame};

const UNARY: &str = "application/json";
const STREAM: &str = "application/connect+json";
const FRAME_LIMIT: usize = 1024 * 1024;
const ENVELOPE_BYTES: usize = 5;

#[derive(Debug)]
pub enum BridgeError {
    InvalidEndpoint,
    Transport,
    Response,
    TooLarge,
    Stream(StreamError),
}

impl From<StreamError> for BridgeError {
    fn from(error: StreamError) -> Self {
        Self::Stream(error)
    }
}

pub struct BridgeClient {
    client: Client,
    endpoint: SocketAddr,
}

impl BridgeClient {
    pub fn new(endpoint: SocketAddr) -> Result<Self, BridgeError> {
        if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
            return Err(BridgeError::InvalidEndpoint);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| BridgeError::Transport)?;
        Ok(Self { client, endpoint })
    }

    pub async fn create_agent(&self, options: Value) -> Result<String, BridgeError> {
        let result = self
            .unary("CreateAgent", json!({ "options": options }))
            .await?;
        result["agentId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or(BridgeError::Response)
    }

    pub async fn close_agent(&self, agent_id: &str) -> Result<(), BridgeError> {
        self.unary("CloseAgent", json!({ "agentId": agent_id }))
            .await?;
        Ok(())
    }

    pub async fn send(
        &self,
        agent_id: &str,
        text: &str,
        mut on_text: impl FnMut(&str),
    ) -> Result<TerminalRun, BridgeError> {
        if text.len() > FRAME_LIMIT {
            return Err(BridgeError::TooLarge);
        }
        let request = json!({
            "agentId": agent_id,
            "message": { "text": text },
            "options": { "enableDeltas": true }
        });
        let body = encode(&request)?;
        let mut wire = Vec::with_capacity(body.len() + ENVELOPE_BYTES);
        wire.push(0);
        wire.extend_from_slice(&(body.len() as u32).to_be_bytes());
        wire.extend_from_slice(&body);

        let mut response = self.request("Send", STREAM, wire).await?;
        let mut stream = SendStream::new(agent_id);
        let mut pending = Vec::new();
        while let Some(bytes) = response.chunk().await.map_err(|_| BridgeError::Transport)? {
            let mut remaining = bytes.as_ref();
            while !remaining.is_empty() {
                let available = FRAME_LIMIT + ENVELOPE_BYTES - pending.len();
                if available == 0 {
                    return Err(BridgeError::TooLarge);
                }
                let (next, rest) = remaining.split_at(remaining.len().min(available));
                pending.extend_from_slice(next);
                remaining = rest;

                let mut frames = pending.as_slice();
                while let Some((envelope, rest)) = frame(frames, FRAME_LIMIT)? {
                    if let Some(text) = stream.push(envelope)? {
                        on_text(&text);
                    }
                    frames = rest;
                }
                let consumed = pending.len() - frames.len();
                pending.drain(..consumed);
            }
        }
        if !pending.is_empty() {
            return Err(StreamError::IncompleteRun.into());
        }
        stream.finish().map_err(Into::into)
    }

    async fn unary(&self, action: &str, message: Value) -> Result<Value, BridgeError> {
        let mut response = self.request(action, UNARY, encode(&message)?).await?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| BridgeError::Transport)? {
            if chunk.len() > FRAME_LIMIT - body.len() {
                return Err(BridgeError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body).map_err(|_| BridgeError::Response)?;
        if !value.is_object() {
            return Err(BridgeError::Response);
        }
        Ok(value)
    }

    async fn request(
        &self,
        action: &str,
        media_type: &str,
        body: Vec<u8>,
    ) -> Result<Response, BridgeError> {
        let response = self
            .client
            .post(format!(
                "http://{}/sdk.v1.SdkAgentService/{action}",
                self.endpoint
            ))
            .header(header::CONTENT_TYPE, media_type)
            .header("connect-protocol-version", "1")
            .body(body)
            .send()
            .await
            .map_err(|_| BridgeError::Transport)?;
        let content_type = response.headers().get(header::CONTENT_TYPE);
        if response.status() != StatusCode::OK
            || content_type
                .and_then(|header| header.to_str().ok())
                .and_then(|header| header.split(';').next())
                .is_none_or(|value| !value.eq_ignore_ascii_case(media_type))
        {
            return Err(BridgeError::Response);
        }
        Ok(response)
    }
}

fn encode(message: &Value) -> Result<Vec<u8>, BridgeError> {
    let bytes = serde_json::to_vec(message).map_err(|_| BridgeError::Response)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(BridgeError::TooLarge);
    }
    Ok(bytes)
}
