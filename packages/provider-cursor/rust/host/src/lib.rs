//! Connect JSON client for a local sdk.v1 bridge.

use std::{net::SocketAddr, time::Duration};

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode, header};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};
use t3_code_ls_cursor_bridge::{SendStream, StreamError, TerminalRun, frame};

const UNARY: &str = "application/json";
const STREAM: &str = "application/connect+json";
const FRAME_LIMIT: usize = 1024 * 1024;
const ENVELOPE_BYTES: usize = 5;
const READ_TIMEOUT: Duration = Duration::from_secs(30);

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
    client: Client<HttpConnector, Full<Bytes>>,
    endpoint: SocketAddr,
}

impl BridgeClient {
    pub fn new(endpoint: SocketAddr) -> Result<Self, BridgeError> {
        if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
            return Err(BridgeError::InvalidEndpoint);
        }
        let mut connector = HttpConnector::new();
        connector.enforce_http(true);
        connector.set_connect_timeout(Some(Duration::from_secs(5)));
        let client = Client::builder(TokioExecutor::new())
            .retry_canceled_requests(false)
            .build(connector);
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

    /// An empty RPC response acknowledges the request, not a terminal run outcome.
    pub async fn cancel_run(&self, agent_id: &str, run_id: &str) -> Result<(), BridgeError> {
        self.unary("CancelRun", json!({ "agentId": agent_id, "runId": run_id }))
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
        while let Some(bytes) = response_chunk(response.body_mut()).await? {
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
        while let Some(chunk) = response_chunk(response.body_mut()).await? {
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
    ) -> Result<Response<Incoming>, BridgeError> {
        let request = Request::post(format!(
            "http://{}/sdk.v1.SdkAgentService/{action}",
            self.endpoint
        ))
        .header(header::CONTENT_TYPE, media_type)
        .header("connect-protocol-version", "1")
        .body(Full::new(Bytes::from(body)))
        .map_err(|_| BridgeError::InvalidEndpoint)?;
        let response = tokio::time::timeout(READ_TIMEOUT, self.client.request(request))
            .await
            .map_err(|_| BridgeError::Transport)?
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

async fn response_chunk(body: &mut Incoming) -> Result<Option<Bytes>, BridgeError> {
    tokio::time::timeout(READ_TIMEOUT, async {
        while let Some(frame) = body.frame().await {
            if let Ok(bytes) = frame.map_err(|_| BridgeError::Transport)?.into_data() {
                return Ok(Some(bytes));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|_| BridgeError::Transport)?
}

fn encode(message: &Value) -> Result<Vec<u8>, BridgeError> {
    let bytes = serde_json::to_vec(message).map_err(|_| BridgeError::Response)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(BridgeError::TooLarge);
    }
    Ok(bytes)
}
