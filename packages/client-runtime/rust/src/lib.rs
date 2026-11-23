#![no_std]

//! Offset mapping for the composer's serialized rich document.
//! The map borrows runs from the editor. UTF-16 text lengths and one-position
//! atoms match `apps/web/src/composer-rich-text-doc.ts` in the pinned source.

pub mod composer_draft;
pub mod text_revision;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlatOffset(pub f64);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarkdownOffset(pub f64);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProseMirrorPosition(pub f64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Text { code_block: bool },
    Token,
    Break,
    Prefix,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub kind: RunKind,
    pub flat_start: u32,
    pub document_length: u32,
    pub markdown_start: u32,
    pub markdown_length: u32,
    pub opening_length: u32,
    pub prose_mirror_position: u32,
}

impl Run {
    fn flat_end(self) -> f64 {
        f64::from(self.flat_start) + f64::from(self.document_length)
    }

    fn markdown_end(self) -> f64 {
        f64::from(self.markdown_start) + f64::from(self.markdown_length)
    }

    fn prose_mirror_end(self) -> f64 {
        f64::from(self.prose_mirror_position) + f64::from(self.document_length)
    }
}

/// `runs` keep the editor serialization order, including zero-length runs.
pub struct OffsetMap<'a> {
    runs: &'a [Run],
    document_length: u32,
}

impl<'a> OffsetMap<'a> {
    pub const fn new(runs: &'a [Run], document_length: u32) -> Self {
        Self {
            runs,
            document_length,
        }
    }

    pub fn flat_to_markdown(&self, FlatOffset(offset): FlatOffset) -> MarkdownOffset {
        let offset = offset.clamp(0.0, f64::from(self.document_length));
        for &run in self.runs {
            let end = run.flat_end();
            // A code block owns the caret just before its closing fence.
            if offset < end || (offset == end && run.kind == (RunKind::Text { code_block: true })) {
                let start = f64::from(run.markdown_start);
                let opening = match run.kind {
                    RunKind::Text { .. } | RunKind::Token => f64::from(run.opening_length),
                    RunKind::Break | RunKind::Prefix => 0.0,
                };
                return MarkdownOffset(start + opening + (offset - f64::from(run.flat_start)));
            }
        }
        MarkdownOffset(self.runs.last().map_or(0.0, |run| run.markdown_end()))
    }

    pub fn markdown_to_flat(&self, MarkdownOffset(offset): MarkdownOffset) -> FlatOffset {
        for &run in self.runs {
            if offset < run.markdown_end() {
                let start = f64::from(run.flat_start);
                let within = offset - f64::from(run.markdown_start);
                let opening = f64::from(run.opening_length);
                let mapped = match run.kind {
                    RunKind::Prefix => start,
                    RunKind::Break => start + within,
                    RunKind::Text { .. } | RunKind::Token if within <= opening => start,
                    RunKind::Token => run.flat_end(),
                    RunKind::Text { .. } => {
                        start + (within - opening).min(f64::from(run.document_length))
                    }
                };
                return FlatOffset(mapped);
            }
        }
        FlatOffset(f64::from(self.document_length))
    }

    pub fn flat_to_prose_mirror(&self, FlatOffset(offset): FlatOffset) -> ProseMirrorPosition {
        let offset = offset.clamp(0.0, f64::from(self.document_length));
        for &run in self.runs {
            if offset < run.flat_end() {
                return ProseMirrorPosition(
                    f64::from(run.prose_mirror_position) + (offset - f64::from(run.flat_start)),
                );
            }
        }
        ProseMirrorPosition(self.runs.last().map_or(1.0, |run| run.prose_mirror_end()))
    }

    pub fn prose_mirror_to_flat(
        &self,
        ProseMirrorPosition(position): ProseMirrorPosition,
    ) -> FlatOffset {
        let mut preceding_end = 0.0;
        for &run in self.runs {
            let start = f64::from(run.prose_mirror_position);
            if start <= position {
                if position <= run.prose_mirror_end() {
                    return FlatOffset(f64::from(run.flat_start) + (position - start));
                }
                preceding_end = run.flat_end();
            }
        }
        FlatOffset(preceding_end.clamp(0.0, f64::from(self.document_length)))
    }
}
