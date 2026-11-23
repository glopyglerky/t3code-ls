use std::time::Duration;

use serde_json::{Value, json};
use t3_code_ls_cursor_bridge::{Frame, RunStatus, StreamError, frame};
use t3_code_ls_cursor_bridge_host::{BridgeClient, BridgeError};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    time::timeout,
};

#[path = "../../tests/support/mod.rs"]
mod support;

#[tokio::test]
async fn complete_turn_runs_over_a_real_connect_http_connection() {
    run_captured_turn(false).await;
}

#[tokio::test]
async fn truncated_stream_delivers_deltas_without_a_completed_turn() {
    run_captured_turn(true).await;
}

async fn run_captured_turn(truncated: bool) {
    let (agent_id, mut wire) = support::captured_send();
    if truncated {
        // Retain the stream up to its run result. Close before done or Connect's end.
        let mut rest = wire.as_slice();
        while let Some((Frame::Message(payload), next)) = frame(rest, 4096).unwrap() {
            let envelope: Value = serde_json::from_slice(payload).unwrap();
            if envelope.get("done").is_some() {
                break;
            }
            rest = next;
        }
        wire.truncate(wire.len() - rest.len());
    }

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let client = BridgeClient::new(listener.local_addr().unwrap()).unwrap();
    timeout(Duration::from_secs(10), async {
        let peer = async {
            exchange(
                &listener,
                "CreateAgent",
                "application/json",
                json!({ "options": { "local": {} } }),
                json!({ "agentId": agent_id }).to_string().as_bytes(),
            )
            .await;
            exchange(
                &listener,
                "Send",
                "application/connect+json",
                json!({
                    "agentId": agent_id,
                    "message": { "text": "fixture prompt" },
                    "options": { "enableDeltas": true }
                }),
                &wire,
            )
            .await;
            exchange(
                &listener,
                "CloseAgent",
                "application/json",
                json!({ "agentId": agent_id }),
                b"{}",
            )
            .await;
        };
        let run = async {
            let created = client.create_agent(json!({ "local": {} })).await.unwrap();
            assert_eq!(created, agent_id);
            let mut received = Vec::new();
            let terminal = client
                .send(&created, "fixture prompt", |text| {
                    received.push(text.to_owned())
                })
                .await;
            client.close_agent(&created).await.unwrap();
            assert_eq!(received, ["fixture", " simple ok"]);
            if truncated {
                assert!(matches!(
                    terminal,
                    Err(BridgeError::Stream(StreamError::IncompleteRun))
                ));
            } else {
                let completed = terminal.unwrap();
                assert_eq!(completed.status, RunStatus::Finished);
                assert_eq!(completed.final_text, "fixture simple ok");
            }
        };
        tokio::join!(peer, run);
    })
    .await
    .unwrap();
}

async fn exchange(
    listener: &TcpListener,
    action: &str,
    media_type: &str,
    expected: Value,
    response: &[u8],
) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut socket = BufReader::new(socket);
    let mut line = String::new();
    socket.read_line(&mut line).await.unwrap();
    assert_eq!(
        line.trim_end(),
        format!("POST /sdk.v1.SdkAgentService/{action} HTTP/1.1")
    );
    let mut length = None;
    let mut content_type = None;
    let mut version = None;
    loop {
        line.clear();
        assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        let (key, value) = line.trim_end().split_once(':').unwrap();
        match key.to_ascii_lowercase().as_str() {
            "content-length" => length = Some(value.trim().parse::<usize>().unwrap()),
            "content-type" => content_type = Some(value.trim().to_owned()),
            "connect-protocol-version" => version = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    assert_eq!(content_type.as_deref(), Some(media_type));
    assert_eq!(version.as_deref(), Some("1"));
    let size = length.unwrap();
    assert!(size <= 1024 * 1024);
    let mut body = vec![0; size];
    socket.read_exact(&mut body).await.unwrap();
    let body = if action == "Send" {
        let (Frame::Message(message), trailing) = frame(&body, 4096).unwrap().unwrap() else {
            panic!("Expected a request message");
        };
        assert!(trailing.is_empty());
        message
    } else {
        body.as_slice()
    };
    assert_eq!(serde_json::from_slice::<Value>(body).unwrap(), expected);
    let response_headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {media_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.len(),
    );
    socket
        .get_mut()
        .write_all(response_headers.as_bytes())
        .await
        .unwrap();
    for bytes in response.chunks(7) {
        socket.get_mut().write_all(bytes).await.unwrap();
    }
    socket.get_mut().shutdown().await.unwrap();
}
