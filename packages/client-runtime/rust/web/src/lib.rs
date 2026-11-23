use t3_code_ls_client_text::text_revision::{
    Applied, TextChange, TextEdit, TextRevision, Utf16Offset,
};
use t3_code_ls_client_text::{
    FlatOffset, MarkdownOffset, OffsetMap, ProseMirrorPosition, Run, RunKind,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct ComposerOffsetMap {
    runs: Vec<Run>,
    document_length: u32,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl ComposerOffsetMap {
    /// Each run carries its kind, starting flat and Markdown offsets, document,
    /// Markdown, and opening-marker lengths, and starting ProseMirror position.
    pub fn from_words(words: Box<[u32]>, document_length: u32) -> Option<Self> {
        let (rows, tail) = words.as_chunks::<7>();
        if !tail.is_empty() {
            return None;
        }
        let runs = rows.iter().map(decode_run).collect::<Option<Vec<_>>>()?;
        Some(Self {
            runs,
            document_length,
        })
    }

    pub fn flat_to_markdown(&self, offset: f64) -> f64 {
        self.map().flat_to_markdown(FlatOffset(offset)).0
    }

    pub fn markdown_to_flat(&self, offset: f64) -> f64 {
        self.map().markdown_to_flat(MarkdownOffset(offset)).0
    }

    pub fn flat_to_prose_mirror(&self, offset: f64) -> f64 {
        self.map().flat_to_prose_mirror(FlatOffset(offset)).0
    }

    pub fn prose_mirror_to_flat(&self, position: f64) -> f64 {
        self.map()
            .prose_mirror_to_flat(ProseMirrorPosition(position))
            .0
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct ThreadMessageText {
    text: TextRevision,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl ThreadMessageText {
    pub fn from_message(sequence: f64, text: String, max_bytes: u32) -> Option<Self> {
        Some(Self {
            text: TextRevision::from_snapshot(
                0,
                sequence_number(sequence)?,
                text,
                max_bytes as usize,
            )
            .ok()?,
        })
    }

    pub fn append(&mut self, base_sequence: f64, sequence: f64, suffix: &str) -> Option<String> {
        self.apply(base_sequence, sequence, TextEdit::Append(suffix))
    }

    pub fn splice(
        &mut self,
        base_sequence: f64,
        sequence: f64,
        start_utf16: u32,
        end_utf16: u32,
        text: &str,
    ) -> Option<String> {
        self.apply(
            base_sequence,
            sequence,
            TextEdit::Splice {
                start: Utf16Offset(start_utf16),
                end: Utf16Offset(end_utf16),
                text,
            },
        )
    }
}

impl ThreadMessageText {
    fn apply(&mut self, base_sequence: f64, sequence: f64, edit: TextEdit<'_>) -> Option<String> {
        if sequence_number(base_sequence)? != self.text.sequence() {
            return None;
        }
        let base_revision = self.text.revision();
        let change = TextChange {
            base_revision,
            revision: base_revision.checked_add(1)?,
            sequence: sequence_number(sequence)?,
            edit,
        };
        match self.text.apply(change).ok()? {
            Applied::Updated => Some(self.text.text().to_owned()),
            Applied::Duplicate | Applied::SnapshotRequired => None,
        }
    }
}

fn sequence_number(sequence: f64) -> Option<u64> {
    (sequence >= 0.0 && sequence <= 9_007_199_254_740_991.0 && sequence.fract() == 0.0)
        .then_some(sequence as u64)
}

#[cfg(test)]
mod thread_message_tests {
    use super::ThreadMessageText;

    #[test]
    fn appends_from_exact_wire_sequence_and_keeps_text_on_error() {
        let mut text = ThreadMessageText::from_message(10.0, "日本".to_owned(), 12).unwrap();
        assert_eq!(text.append(9.0, 17.0, "語"), None);
        assert_eq!(text.append(10.0, 10.0, "語"), None);
        assert_eq!(text.append(10.0, 17.0, "語🐟"), None);
        assert_eq!(text.append(10.0, 17.0, "語").as_deref(), Some("日本語"));
        assert_eq!(text.append(10.0, 18.0, "!"), None);
        assert_eq!(text.append(17.0, 18.0, "!").as_deref(), Some("日本語!"));
        assert!(ThreadMessageText::from_message(f64::NAN, String::new(), 12).is_none());
    }

    #[test]
    fn splices_keep_the_exact_base_when_the_utf16_range_is_invalid() {
        let mut text = ThreadMessageText::from_message(10.0, "界🐟語".to_owned(), 12).unwrap();
        assert_eq!(text.splice(10.0, 20.0, 2, 3, "🚀"), None);
        assert_eq!(text.splice(9.0, 20.0, 1, 3, "🚀"), None);
        assert_eq!(
            text.splice(10.0, 20.0, 1, 3, "🚀").as_deref(),
            Some("界🚀語")
        );
        assert_eq!(text.append(20.0, 21.0, "!").as_deref(), Some("界🚀語!"));
    }
}

impl ComposerOffsetMap {
    fn map(&self) -> OffsetMap<'_> {
        OffsetMap::new(&self.runs, self.document_length)
    }
}

fn decode_run(
    &[
        kind,
        flat_start,
        markdown_start,
        document_length,
        markdown_length,
        opening_length,
        prose_mirror_position,
    ]: &[u32; 7],
) -> Option<Run> {
    let kind = match kind {
        0 => RunKind::Text { code_block: false },
        1 => RunKind::Text { code_block: true },
        2 => RunKind::Token,
        3 => RunKind::Break,
        4 => RunKind::Prefix,
        _ => return None,
    };
    Some(Run {
        kind,
        flat_start,
        markdown_start,
        document_length,
        markdown_length,
        opening_length,
        prose_mirror_position,
    })
}
