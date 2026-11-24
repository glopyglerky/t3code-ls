use serde_json::Value;
use t3_code_ls_client_text::text_revision::{Applied, TextChange, TextEdit, TextRevision};

pub const PROMPT: &str = "Replay: showcase";
const TRANSCRIPT: &str =
    include_str!("../../../server/scripts/dev-replay/showcase_transcript.ndjson");
const REPLY_BYTE_LIMIT: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ReplayError {
    EmptyDraft,
    UnexpectedPrompt,
    InvalidTranscript,
}

impl ReplayError {
    pub const fn message(&self) -> &'static str {
        match self {
            Self::EmptyDraft => "Enter a message before submitting.",
            Self::UnexpectedPrompt => "This fixture expects the exact prompt “Replay: showcase”.",
            Self::InvalidTranscript => {
                "The recorded reply could not be loaded. Your draft is still here."
            }
        }
    }
}

pub fn submit(draft: &str) -> Result<String, ReplayError> {
    if draft.trim().is_empty() {
        return Err(ReplayError::EmptyDraft);
    }
    if draft != PROMPT {
        return Err(ReplayError::UnexpectedPrompt);
    }
    replay(TRANSCRIPT).ok_or(ReplayError::InvalidTranscript)
}

fn replay(transcript: &str) -> Option<String> {
    let mut reply = TextRevision::from_snapshot(0, 0, String::new(), REPLY_BYTE_LIMIT).ok()?;
    for line in transcript.lines() {
        let record = serde_json::from_str::<Value>(line).ok()?;
        if record["type"] != "emit_inbound" {
            continue;
        }
        let frame = &record["frame"];
        if frame["method"] == "session/prompt" && frame["kind"] == "response" {
            return (frame["result"]["stopReason"] == "end_turn" && !reply.text().is_empty())
                .then(|| reply.text().to_owned());
        }
        let update = &frame["params"]["update"];
        if frame["method"] == "session/update" && update["sessionUpdate"] == "agent_message_chunk" {
            let chunk = update["content"]["text"].as_str()?;
            let revision = reply.revision() + 1;
            let applied = reply
                .apply(TextChange {
                    base_revision: reply.revision(),
                    revision,
                    sequence: revision,
                    edit: TextEdit::Append(chunk),
                })
                .ok()?;
            if applied != Applied::Updated {
                return None;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_showcase_prompt_replays_recorded_assistant_text_in_order() {
        let reply = submit(PROMPT).unwrap();
        assert!(reply.starts_with(
            "The project has a single math module. I will add a `clamp` helper beside `sum`.\n\n## Done"
        ));
        assert!(reply.ends_with(
            "This turn is a replay. It costs nothing, so send it again as often as you need."
        ));
        assert!(!reply.contains("session/request_permission"));
    }

    #[test]
    fn empty_and_changed_prompts_are_rejected() {
        assert_eq!(submit(" \n"), Err(ReplayError::EmptyDraft));
        assert_eq!(
            submit("Replay: showcase\n"),
            Err(ReplayError::UnexpectedPrompt)
        );
        assert_eq!(
            submit("你好 👩🏽‍💻 e\u{301}"),
            Err(ReplayError::UnexpectedPrompt)
        );
    }

    #[test]
    fn truncated_replay_does_not_complete() {
        let (without_terminal, _) = TRANSCRIPT.trim_end().rsplit_once('\n').unwrap();
        assert!(replay(without_terminal).is_none());
    }
}
