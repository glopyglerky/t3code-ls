//! Codex import's canonical-user prepass.
//!
//! Ports `parseAgentSessionRecords` in `AgentSessionScanner.ts` at fork
//! 229606717aa4d334bb328a1ab2a386f0cec83773. The same prepass is retained in
//! stock pingdotgg/t3code at 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f.
//! Copyright (c) 2026 T3 Tools Inc. Distributed under the repository's MIT license.
//!
//! The caller supplies decoded records in their original order and response text
//! after the scanner's `extractText` rule. Returned indices identify response
//! copies replaced by a canonical event, including generated context sharing
//! that exact turn ID. Assistant records end a turn even when their text is empty.
//! Malformed or missing turn IDs remain `None` and cannot suppress response text.
//!
//! This portable core uses only core/alloc. JSON decoding, lone-surrogate handling,
//! descriptor identity, decompression and the scanner's broader memory accounting
//! remain host-adapter responsibilities. The current TypeScript scanner remains
//! selected until a bounded per-transcript native adapter is qualified.

extern crate alloc;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

pub const MAX_RECORDS: usize = 100_000;
pub const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Record<'a> {
    Other,
    Assistant,
    UserEvent {
        text: &'a str,
    },
    ResponseUser {
        turn_id: Option<&'a str>,
        text: &'a str,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitError {
    Records,
    TextBytes,
}

/// Uses ECMAScript TrimString's WhiteSpace and LineTerminator set.
/// Rust's `str::trim` has a different treatment of BOM and NEXT LINE.
fn trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

fn finish_turn(
    events: &mut BTreeSet<&str>,
    responses: &mut Vec<(usize, &str, &str)>,
    suppressed: &mut Vec<usize>,
) {
    let canonical_turns: BTreeSet<_> = responses
        .iter()
        .filter(|(_, _, text)| events.contains(text))
        .map(|(_, turn_id, _)| *turn_id)
        .collect();
    suppressed.extend(
        responses
            .iter()
            .filter(|(_, turn_id, _)| canonical_turns.contains(turn_id))
            .map(|(index, _, _)| *index),
    );
    events.clear();
    responses.clear();
}

/// Returns increasing original record indices. All input strings are borrowed.
/// Limits are checked before allocating the per-turn sets or output.
pub fn canonical_response_user_indices(records: &[Record<'_>]) -> Result<Vec<usize>, LimitError> {
    if records.len() > MAX_RECORDS {
        return Err(LimitError::Records);
    }
    let mut bytes = 0usize;
    for record in records {
        let text_bytes = match record {
            Record::Other | Record::Assistant => 0,
            Record::UserEvent { text } => text.len(),
            Record::ResponseUser { turn_id, text } => text
                .len()
                .checked_add(turn_id.map_or(0, str::len))
                .ok_or(LimitError::TextBytes)?,
        };
        bytes = bytes.checked_add(text_bytes).ok_or(LimitError::TextBytes)?;
        if bytes > MAX_TEXT_BYTES {
            return Err(LimitError::TextBytes);
        }
    }

    let mut events = BTreeSet::new();
    let mut responses = Vec::new();
    let mut suppressed = Vec::new();
    for (index, record) in records.iter().enumerate() {
        match *record {
            Record::Other => {}
            Record::Assistant => finish_turn(&mut events, &mut responses, &mut suppressed),
            Record::UserEvent { text } => {
                let text = trim(text);
                if !text.is_empty() {
                    events.insert(text);
                }
            }
            Record::ResponseUser { turn_id, text } => {
                if let Some(turn_id) = turn_id.filter(|value| !trim(value).is_empty()) {
                    let text = trim(text);
                    if !text.is_empty() {
                        responses.push((index, turn_id, text));
                    }
                }
            }
        }
    }
    finish_turn(&mut events, &mut responses, &mut suppressed);
    Ok(suppressed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn response<'a>(turn_id: Option<&'a str>, text: &'a str) -> Record<'a> {
        Record::ResponseUser { turn_id, text }
    }

    #[test]
    fn canonical_event_replaces_all_generated_context_in_its_exact_turn() {
        let records = [
            Record::Other,
            response(
                Some("turn-1"),
                "<environment_context>synthetic</environment_context>",
            ),
            response(Some("turn-1"), "# AGENTS.md instructions for a fixture"),
            Record::UserEvent {
                text: "  Make a project.\n",
            },
            response(Some("turn-1"), "Make a project."),
            response(Some("other-turn"), "Keep this response-only prompt"),
            Record::Assistant,
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![1, 2, 4]));
    }

    #[test]
    fn assistant_boundary_ends_matching_even_when_turn_ids_repeat() {
        let records = [
            response(Some("old"), "Keep the older prompt"),
            Record::UserEvent {
                text: "Newer prompt",
            },
            response(Some("new"), "Newer prompt"),
            Record::Assistant,
            response(Some("new"), "Newer prompt"),
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![2]));
    }

    #[test]
    fn missing_ambiguous_or_nonmatching_turn_ids_keep_response_text() {
        let records = [
            Record::UserEvent { text: "Prompt" },
            response(None, "Prompt"),
            response(Some(" \u{feff}\n"), "Prompt"),
            response(Some("turn-1 "), "Generated context"),
            response(Some("turn-1"), "Prompt"),
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![4]));
    }

    #[test]
    fn ecmascript_whitespace_and_unicode_text_match_the_retained_scanner() {
        let records = [
            Record::UserEvent {
                text: "\u{feff}\u{2000}👩🏽‍💻 résumé 日本語\u{2029}",
            },
            response(Some("unicode"), "👩🏽‍💻 résumé 日本語"),
            Record::Assistant,
            Record::UserEvent {
                text: "\u{85}Prompt\u{85}",
            },
            response(Some("next-line"), "Prompt"),
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![1]));
    }

    #[test]
    fn final_turn_and_event_order_preserve_original_record_indices() {
        let records = [
            response(Some("one"), "first"),
            Record::Other,
            Record::UserEvent { text: "first" },
            Record::Assistant,
            Record::UserEvent { text: "second" },
            response(Some("two"), "second"),
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![0, 5]));
        assert_eq!(canonical_response_user_indices(&[]), Ok(vec![]));
    }

    #[test]
    fn response_only_context_has_no_canonical_replacement() {
        let records = [
            response(
                Some("one"),
                "<environment_context>synthetic</environment_context>",
            ),
            response(Some("one"), "Initialize Git and add a README."),
            Record::Assistant,
            Record::UserEvent {
                text: "Initialize Git and add a README.",
            },
        ];
        assert_eq!(canonical_response_user_indices(&records), Ok(vec![]));
    }

    #[test]
    fn bounds_refuse_the_whole_prepass_without_partial_output() {
        let at_limit = vec![Record::Other; MAX_RECORDS];
        assert_eq!(canonical_response_user_indices(&at_limit), Ok(vec![]));
        let too_many = vec![Record::Other; MAX_RECORDS + 1];
        assert_eq!(
            canonical_response_user_indices(&too_many),
            Err(LimitError::Records)
        );
        let text = "x".repeat(MAX_TEXT_BYTES);
        assert_eq!(
            canonical_response_user_indices(&[Record::UserEvent { text: &text }]),
            Ok(vec![])
        );
        assert_eq!(
            canonical_response_user_indices(&[response(Some("id"), &text)]),
            Err(LimitError::TextBytes),
        );
    }
}
