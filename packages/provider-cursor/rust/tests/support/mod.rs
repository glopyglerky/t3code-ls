use serde_json::{Value, json};

const SIMPLE: &str = include_str!(
    "../../../../../apps/server/src/orchestration-v2/testkit/fixtures/simple/cursor_transcript.ndjson"
);

pub fn captured_send() -> (String, Vec<u8>) {
    let capture: Vec<Value> = SIMPLE
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let open = capture
        .iter()
        .find(|event| event["label"] == "agent.opened")
        .unwrap();
    let agent_id = open["frame"]["agentId"].as_str().unwrap();
    let mut wire = Vec::new();
    for recorded in &capture {
        let event = &recorded["frame"];
        match event["type"].as_str() {
            Some("interaction.update") => envelope(
                &mut wire,
                0,
                json!({ "interactionUpdate": { "type": event["update"]["type"], "update": event["update"] } }),
            ),
            Some("run.completed") => {
                let run = &event["result"];
                assert_eq!(run["status"], "finished");
                envelope(
                    &mut wire,
                    0,
                    json!({"result": {
                        "agentId": agent_id,
                        "runId": run["id"],
                        "status": "RUN_LIFECYCLE_STATUS_FINISHED",
                        "result": {"result": run["result"]}
                    }}),
                );
                envelope(
                    &mut wire,
                    0,
                    json!({"done": {"agentId": agent_id, "runId": run["id"]}}),
                );
            }
            _ => {}
        }
    }
    envelope(&mut wire, 2, json!({}));
    (agent_id.to_owned(), wire)
}

fn envelope(output: &mut Vec<u8>, flags: u8, json: Value) {
    let body = serde_json::to_vec(&json).unwrap();
    output.push(flags);
    output.extend_from_slice(&u32::try_from(body.len()).unwrap().to_be_bytes());
    output.extend(body);
}
