//! Committed plain text and directed selection for a composer adapter.
//! The editor owns provisional IME text, grapheme navigation and undo.

extern crate alloc;

use alloc::string::String;

use crate::text_revision::Utf16Offset;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DraftSelection {
    pub anchor: Utf16Offset,
    pub head: Utf16Offset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DraftError {
    InvalidSelection,
    TextLimit,
    Empty,
}

pub struct ComposerDraft {
    text: String,
    selection: DraftSelection,
    max_bytes: usize,
}

impl ComposerDraft {
    pub const fn new(max_bytes: usize) -> Self {
        Self {
            text: String::new(),
            selection: DraftSelection {
                anchor: Utf16Offset(0),
                head: Utf16Offset(0),
            },
            max_bytes,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn selection(&self) -> DraftSelection {
        self.selection
    }

    /// Updates the draft atomically. The two byte indices retain their direction.
    pub fn update_committed(
        &mut self,
        text: String,
        anchor_byte: usize,
        head_byte: usize,
    ) -> Result<(), DraftError> {
        if text.len() > self.max_bytes {
            return Err(DraftError::TextLimit);
        }
        let anchor =
            Utf16Offset::from_byte_index(&text, anchor_byte).ok_or(DraftError::InvalidSelection)?;
        let head =
            Utf16Offset::from_byte_index(&text, head_byte).ok_or(DraftError::InvalidSelection)?;
        self.text = text;
        self.selection = DraftSelection { anchor, head };
        Ok(())
    }

    pub fn submit(&self) -> Result<&str, DraftError> {
        if self.text.trim().is_empty() {
            return Err(DraftError::Empty);
        }
        Ok(&self.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_directed_utf16_selection_and_rejects_invalid_snapshots() {
        let mut draft = ComposerDraft::new(12);
        assert_eq!(draft.submit(), Err(DraftError::Empty));
        let text = "日🐟e\u{301}";
        draft.update_committed(text.into(), text.len(), 3).unwrap();
        let selection = DraftSelection {
            anchor: Utf16Offset(5),
            head: Utf16Offset(1),
        };
        assert_eq!(draft.selection(), selection);
        assert_eq!(
            draft.update_committed(text.into(), 4, 3),
            Err(DraftError::InvalidSelection)
        );
        assert_eq!(
            draft.update_committed("🐟🐟🐟魚".into(), 0, 0),
            Err(DraftError::TextLimit)
        );
        assert_eq!(draft.selection(), selection);
        assert_eq!(draft.submit(), Ok(text));
        draft.update_committed(" \u{3000}".into(), 0, 0).unwrap();
        assert_eq!(draft.submit(), Err(DraftError::Empty));
    }
}
