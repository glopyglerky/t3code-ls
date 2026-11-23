use t3_code_ls_client_text::text_revision::{
    Applied, ApplyError, TextChange, TextEdit, TextRevision, Utf16Offset,
};

fn change(base_revision: u64, sequence: u64, edit: TextEdit<'_>) -> TextChange<'_> {
    TextChange {
        base_revision,
        revision: base_revision + 1,
        sequence,
        edit,
    }
}

#[test]
fn appends_then_preserves_utf16_positions_for_corrections() {
    let mut state = TextRevision::from_snapshot(0, 10, "東京".into(), 64).unwrap();
    assert_eq!(
        state.apply(change(0, 13, TextEdit::Append("🦊e\u{301}"))),
        Ok(Applied::Updated)
    );
    assert_eq!(state.text(), "東京🦊e\u{301}");
    let splice = TextEdit::Splice {
        start: Utf16Offset(2),
        end: Utf16Offset(4),
        text: "🌿",
    };
    assert_eq!(state.apply(change(1, 14, splice)), Ok(Applied::Updated));
    assert_eq!(state.text(), "東京🌿e\u{301}");
    assert_eq!(
        state.apply(change(2, 17, TextEdit::Replace("東京🌿é"))),
        Ok(Applied::Updated)
    );
    assert_eq!(
        (state.revision(), state.sequence(), state.text()),
        (3, 17, "東京🌿é")
    );
}

#[test]
fn distinguishes_retries_conflicts_and_lost_bases() {
    let mut state = TextRevision::from_snapshot(5, 21, "base".into(), 32).unwrap();
    let first = change(5, 25, TextEdit::Append(" chunk"));
    assert_eq!(state.apply(first), Ok(Applied::Updated));
    assert_eq!(state.apply(first), Ok(Applied::Duplicate));
    assert_eq!(
        state.apply(change(5, 25, TextEdit::Append(" other"))),
        Err(ApplyError::ConflictingRevision)
    );
    assert_eq!(
        state.apply(change(5, 29, TextEdit::Append(" chunk"))),
        Err(ApplyError::ConflictingRevision)
    );
    assert_eq!(
        state.apply(change(6, 25, TextEdit::Append("!"))),
        Err(ApplyError::SequenceOrder)
    );
    assert_eq!(
        state.apply(change(7, 29, TextEdit::Replace("future"))),
        Ok(Applied::SnapshotRequired)
    );
    assert_eq!(state.text(), "base chunk");
    assert_eq!(
        state.apply(change(6, 26, TextEdit::Append("!"))),
        Ok(Applied::Updated)
    );
    assert_eq!(state.apply(first), Ok(Applied::SnapshotRequired));

    let mut reopened = TextRevision::from_snapshot(6, 25, "base chunk".into(), 32).unwrap();
    assert_eq!(reopened.apply(first), Ok(Applied::SnapshotRequired));
    assert_eq!(
        reopened.apply(change(6, 26, TextEdit::Append("!"))),
        Ok(Applied::Updated)
    );
    assert_eq!(reopened.text(), state.text());
}

#[test]
fn invalid_ranges_and_budget_failures_keep_the_previous_state() {
    let mut state = TextRevision::from_snapshot(1, 5, "a🦊b".into(), 8).unwrap();
    for (start, end) in [(2, 3), (1, 2), (4, 0), (4, 5)] {
        assert_eq!(
            state.apply(change(
                1,
                6,
                TextEdit::Splice {
                    start: Utf16Offset(start),
                    end: Utf16Offset(end),
                    text: "!",
                }
            )),
            Err(ApplyError::InvalidUtf16Range)
        );
    }
    assert_eq!(
        state.apply(change(1, 6, TextEdit::Append("é!"))),
        Err(ApplyError::TextLimit)
    );
    assert_eq!(
        (state.revision(), state.sequence(), state.text()),
        (1, 5, "a🦊b")
    );
    assert_eq!(
        state.apply(change(1, 6, TextEdit::Append("é"))),
        Ok(Applied::Updated)
    );
    assert_eq!(state.text(), "a🦊bé");
}

#[test]
fn enforces_the_wire_integer_bound_and_consecutive_text_revisions() {
    let max = (1 << 53) - 1;
    let mut state = TextRevision::from_snapshot(max - 1, 12, String::new(), 16).unwrap();
    assert_eq!(
        state.apply(change(max - 1, max, TextEdit::Append("x"))),
        Ok(Applied::Updated)
    );
    assert_eq!(
        state.apply(change(max, max + 1, TextEdit::Append("y"))),
        Err(ApplyError::InvalidRevision)
    );
    assert_eq!(
        state.apply(TextChange {
            base_revision: max - 2,
            revision: max,
            sequence: max,
            edit: TextEdit::Append("z"),
        }),
        Err(ApplyError::InvalidRevision)
    );
    assert_eq!(state.text(), "x");
}
