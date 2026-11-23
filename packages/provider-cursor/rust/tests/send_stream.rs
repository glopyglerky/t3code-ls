use t3_code_ls_cursor_bridge::{Frame, RunStatus, SendStream, StreamError, frame};

mod support;

#[test]
fn translates_the_captured_simple_turn_to_connect_and_preserves_the_text() {
    let (agent_id, wire) = support::captured_send();
    let mut pending = Vec::new();
    let mut stream = SendStream::new(&agent_id);
    let mut deltas = Vec::new();
    for chunk in wire.chunks(7) {
        pending.extend_from_slice(chunk);
        let mut rest = pending.as_slice();
        while let Some((envelope, trailing)) = frame(rest, 4096).unwrap() {
            if let Some(text) = stream.push(envelope).unwrap() {
                deltas.push(text);
            }
            rest = trailing;
        }
        let consumed = pending.len() - rest.len();
        pending.drain(..consumed);
    }
    assert!(pending.is_empty());
    assert_eq!(deltas, ["fixture", " simple ok"]);
    let terminal = stream.finish().unwrap();
    assert_eq!(terminal.status, RunStatus::Finished);
    assert_eq!(terminal.final_text, deltas.concat());
}

const RESULT: &[u8] = br#"{"result":{"agentId":"a","runId":"r","status":3}}"#;
const DONE: &[u8] = br#"{"done":{"agentId":"a","runId":"r"}}"#;

#[test]
fn a_result_requires_done_and_a_clean_connect_end() {
    let mut incomplete = SendStream::new("a");
    incomplete.push(Frame::Message(RESULT)).unwrap();
    incomplete.push(Frame::EndStream(b"{}")).unwrap();
    assert_eq!(incomplete.finish(), Err(StreamError::IncompleteRun));

    let mut transport_error = SendStream::new("a");
    transport_error.push(Frame::Message(RESULT)).unwrap();
    transport_error.push(Frame::Message(DONE)).unwrap();
    assert_eq!(
        transport_error.push(Frame::EndStream(br#"{"error":{"code":"unavailable"}}"#)),
        Err(StreamError::BridgeError)
    );
    assert_eq!(transport_error.finish(), Err(StreamError::BridgeError));
}

#[test]
fn ignores_keepalives_and_refuses_mismatched_terminal_identity() {
    let mut stream = SendStream::new("a");
    assert_eq!(stream.push(Frame::Message(b"{}")), Ok(None));
    assert_eq!(
        stream.push(Frame::Message(br#"{"futureCase":{}}"#)),
        Ok(None)
    );
    stream.push(Frame::Message(RESULT)).unwrap();
    assert_eq!(
        stream.push(Frame::Message(
            br#"{"done":{"agentId":"a","runId":"different"}}"#
        )),
        Err(StreamError::RunMismatch)
    );
    assert_eq!(stream.finish(), Err(StreamError::RunMismatch));
}

#[test]
fn bounds_frames_before_waiting_for_their_bodies() {
    assert_eq!(frame(&[0, 0, 0], 32), Ok(None));
    assert_eq!(frame(&[0, 0, 0, 0, 6, 1], 32), Ok(None));
    assert_eq!(
        frame(&[0, 0, 0, 0, 33], 32),
        Err(StreamError::FrameTooLarge)
    );
    assert_eq!(
        frame(&[1, 0, 0, 0, 4], 32),
        Err(StreamError::UnsupportedFrameFlags)
    );
}
