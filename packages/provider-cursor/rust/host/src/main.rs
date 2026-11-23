#![forbid(unsafe_code)]

use std::io::{self, BufRead, Read, Write};
use std::net::SocketAddr;

use serde_json::{Value, json};
use t3_code_ls_cursor_bridge::RunStatus;
use t3_code_ls_cursor_bridge_host::BridgeClient;

const FRAME_LIMIT: u64 = 1024 * 1024;

fn request(input: &mut impl BufRead) -> Result<Value, String> {
    let mut frame = Vec::new();
    input
        .take(FRAME_LIMIT + 1)
        .read_until(b'\n', &mut frame)
        .map_err(|_| "input")?;
    if frame.len() as u64 > FRAME_LIMIT || frame.last() != Some(&b'\n') {
        return Err("input frame limit".into());
    }
    serde_json::from_slice(&frame).map_err(|_| "invalid input".into())
}

fn emit(output: &mut impl Write, frame: Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &frame)?;
    output.write_all(b"\n")?;
    output.flush()
}

async fn run(endpoint: SocketAddr) -> Result<(), String> {
    let client = BridgeClient::new(endpoint).map_err(|_| "invalid endpoint")?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let open = request(&mut input)?;
    if open["operation"] != "create" || !open["options"].is_object() {
        return Err("expected create".into());
    }
    let agent = client
        .create_agent(open["options"].clone())
        .await
        .map_err(|_| "create failed")?;
    let result: Result<_, String> = async {
        emit(&mut output, json!({"version":1,"agentId":agent})).map_err(|_| "output")?;
        let send = request(&mut input)?;
        if send["operation"] != "send" {
            return Err("expected send".into());
        }
        let prompt = send["text"].as_str().ok_or("expected text")?;
        let mut output_failed = false;
        let terminal = client
            .send(&agent, prompt, |text| {
                if emit(&mut output, json!({"version":1,"text":text})).is_err() {
                    output_failed = true;
                }
            })
            .await
            .map_err(|_| "incomplete or invalid bridge stream")?;
        if output_failed {
            return Err("output".into());
        }
        Ok(terminal)
    }
    .await;
    // Always attempt the bridge's explicit lifecycle close before acknowledging completion.
    let closed = client.close_agent(&agent).await;
    let terminal = result?;
    closed.map_err(|_| "close failed")?;
    let status = match terminal.status {
        RunStatus::Finished => "finished",
        RunStatus::Failed => "error",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Expired => "expired",
    };
    emit(
        &mut output,
        json!({"version":1,"result":{
            "id":terminal.run_id,"status":status,"result":terminal.final_text
        }}),
    )
    .map_err(|_| "output".into())
}

fn main() {
    let result: Result<(), String> = (|| {
        let mut args = std::env::args().skip(1);
        let endpoint: SocketAddr = args
            .next()
            .ok_or("missing endpoint")?
            .parse()
            .map_err(|_| "invalid endpoint")?;
        if args.next().is_some() {
            return Err("unexpected arguments".into());
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "runtime")?
            .block_on(run(endpoint))
    })();
    if let Err(error) = result {
        eprintln!("cursor bridge host rejected request: {error}");
        std::process::exit(2);
    }
}
