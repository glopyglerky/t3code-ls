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
