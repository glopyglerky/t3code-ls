use t3_code_ls_core::claude_stdio_control::{
    ControlSession, Incoming, PermissionTicket, ProtocolError, frame,
};
use t3_code_ls_core::json::{self, Value};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ProtocolError::InvalidFrame)
}

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
        text(answer.get("response").unwrap(), "request_id"),
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
        "../../../apps/server/src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt/claude_transcript.ndjson"
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
