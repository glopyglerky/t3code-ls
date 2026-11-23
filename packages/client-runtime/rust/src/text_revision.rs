//! Renderer-independent apply rules for one streamed text item.

extern crate alloc;

use alloc::string::String;

// Sequence numbers and revisions can also be represented by a JSON number.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Utf16Offset(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextEdit<'a> {
    Append(&'a str),
    Replace(&'a str),
    Splice {
        start: Utf16Offset,
        end: Utf16Offset,
        text: &'a str,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextChange<'a> {
    pub base_revision: u64,
    pub revision: u64,
    pub sequence: u64,
    pub edit: TextEdit<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    Updated,
    Duplicate,
    SnapshotRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyError {
    InvalidRevision,
    SequenceOrder,
    ConflictingRevision,
    InvalidUtf16Range,
    TextLimit,
    Allocation,
}

enum RetainedEdit {
    Append(String),
    Replace(String),
    Splice {
        start: Utf16Offset,
        end: Utf16Offset,
        text: String,
    },
}

impl RetainedEdit {
    fn as_edit(&self) -> TextEdit<'_> {
        match self {
            Self::Append(text) => TextEdit::Append(text),
            Self::Replace(text) => TextEdit::Replace(text),
            Self::Splice { start, end, text } => TextEdit::Splice {
                start: *start,
                end: *end,
                text,
            },
        }
    }
}

/// The current text and last edit each retain at most `max_bytes` of payload.
/// An older retry outside that retained boundary requires an authoritative snapshot.
pub struct TextRevision {
    revision: u64,
    sequence: u64,
    text: String,
    max_bytes: usize,
    last_edit: Option<RetainedEdit>,
}

impl TextRevision {
    pub fn from_snapshot(
        revision: u64,
        sequence: u64,
        text: String,
        max_bytes: usize,
    ) -> Result<Self, ApplyError> {
        if revision > MAX_SAFE_INTEGER || sequence > MAX_SAFE_INTEGER {
            return Err(ApplyError::InvalidRevision);
        }
        if text.len() > max_bytes {
            return Err(ApplyError::TextLimit);
        }
        Ok(Self {
            revision,
            sequence,
            text,
            max_bytes,
            last_edit: None,
        })
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn apply(&mut self, change: TextChange<'_>) -> Result<Applied, ApplyError> {
        if change.base_revision.checked_add(1) != Some(change.revision)
            || change.revision > MAX_SAFE_INTEGER
            || change.sequence > MAX_SAFE_INTEGER
        {
            return Err(ApplyError::InvalidRevision);
        }
        if change.revision == self.revision
            && let Some(last_edit) = &self.last_edit
        {
            return if change.sequence == self.sequence && change.edit == last_edit.as_edit() {
                Ok(Applied::Duplicate)
            } else {
                Err(ApplyError::ConflictingRevision)
            };
        }
        if change.base_revision != self.revision {
            return Ok(Applied::SnapshotRequired);
        }
        if change.sequence <= self.sequence {
            return Err(ApplyError::SequenceOrder);
        }
        let (start, end, replacement) = match change.edit {
            TextEdit::Append(text) => (self.text.len(), self.text.len(), text),
            TextEdit::Replace(text) => (0, self.text.len(), text),
            TextEdit::Splice { start, end, text } if start.0 <= end.0 => (
                byte_offset(&self.text, start)?,
                byte_offset(&self.text, end)?,
                text,
            ),
            TextEdit::Splice { .. } => return Err(ApplyError::InvalidUtf16Range),
        };
        let new_len = (self.text.len() - (end - start))
            .checked_add(replacement.len())
            .filter(|len| *len <= self.max_bytes)
            .ok_or(ApplyError::TextLimit)?;
        let mut retained = String::new();
        retained
            .try_reserve_exact(replacement.len())
            .map_err(|_| ApplyError::Allocation)?;
        retained.push_str(replacement);
        self.text
            .try_reserve(new_len.saturating_sub(self.text.len()))
            .map_err(|_| ApplyError::Allocation)?;
        self.text.replace_range(start..end, replacement);
        self.last_edit = Some(match change.edit {
            TextEdit::Append(_) => RetainedEdit::Append(retained),
            TextEdit::Replace(_) => RetainedEdit::Replace(retained),
            TextEdit::Splice { start, end, .. } => RetainedEdit::Splice {
                start,
                end,
                text: retained,
            },
        });
        self.revision = change.revision;
        self.sequence = change.sequence;
        Ok(Applied::Updated)
    }
}

fn byte_offset(text: &str, offset: Utf16Offset) -> Result<usize, ApplyError> {
    let offset = u64::from(offset.0);
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += character.len_utf16() as u64;
        if units > offset {
            return Err(ApplyError::InvalidUtf16Range);
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err(ApplyError::InvalidUtf16Range)
    }
}
