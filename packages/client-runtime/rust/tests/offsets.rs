use t3_code_ls_client_text::{
    FlatOffset, MarkdownOffset, OffsetMap, ProseMirrorPosition, Run, RunKind,
};

fn run(kind: RunKind, flat: (u32, u32), markdown: (u32, u32, u32), pm: u32) -> Run {
    Run {
        kind,
        flat_start: flat.0,
        document_length: flat.1,
        markdown_start: markdown.0,
        markdown_length: markdown.1,
        opening_length: markdown.2,
        prose_mirror_position: pm,
    }
}

#[test]
fn maps_utf16_text_atoms_and_markdown_delimiters() {
    let runs = [
        run(RunKind::Prefix, (0, 0), (0, 2, 0), 1),
        // Three UTF-16 units for a supplementary character and one BMP character.
        run(RunKind::Text { code_block: false }, (0, 3), (2, 7, 2), 1),
        run(RunKind::Token, (3, 1), (9, 8, 0), 4),
        run(RunKind::Break, (4, 1), (17, 2, 0), 5),
        run(RunKind::Text { code_block: true }, (5, 2), (19, 10, 4), 8),
        run(RunKind::Text { code_block: false }, (7, 2), (29, 2, 0), 12),
    ];
    let map = OffsetMap::new(&runs, 9);

    for (flat, markdown) in [
        (-4., 4.),
        (0., 4.),
        (2., 6.),
        (3., 9.),
        (7., 25.),
        (9., 31.),
    ] {
        assert_eq!(
            map.flat_to_markdown(FlatOffset(flat)),
            MarkdownOffset(markdown)
        );
    }
    for (markdown, flat) in [
        (1., 0.),
        (3., 0.),
        (7., 3.),
        (9., 3.),
        (10., 4.),
        (18., 5.),
        (27., 7.),
        (31., 9.),
    ] {
        assert_eq!(
            map.markdown_to_flat(MarkdownOffset(markdown)),
            FlatOffset(flat)
        );
    }
    for (flat, pm) in [(0., 1.), (3., 4.), (5., 8.), (7., 12.), (9., 14.)] {
        assert_eq!(
            map.flat_to_prose_mirror(FlatOffset(flat)),
            ProseMirrorPosition(pm)
        );
        assert_eq!(
            map.prose_mirror_to_flat(ProseMirrorPosition(pm)),
            FlatOffset(flat)
        );
    }
    assert_eq!(
        map.prose_mirror_to_flat(ProseMirrorPosition(7.)),
        FlatOffset(5.)
    );
}

#[test]
fn empty_runs_and_out_of_range_queries_keep_editor_boundary_defaults() {
    let empty = OffsetMap::new(&[], 0);
    assert_eq!(
        empty.flat_to_prose_mirror(FlatOffset(6.)),
        ProseMirrorPosition(1.)
    );
    assert_eq!(empty.flat_to_markdown(FlatOffset(6.)), MarkdownOffset(0.));
    assert_eq!(empty.markdown_to_flat(MarkdownOffset(6.)), FlatOffset(0.));
    assert_eq!(
        empty.prose_mirror_to_flat(ProseMirrorPosition(6.)),
        FlatOffset(0.)
    );

    let runs = [run(
        RunKind::Text { code_block: true },
        (0, 0),
        (0, 8, 4),
        2,
    )];
    let map = OffsetMap::new(&runs, 0);
    assert_eq!(map.flat_to_markdown(FlatOffset(0.)), MarkdownOffset(4.));
    assert_eq!(
        map.flat_to_markdown(FlatOffset(f64::NAN)),
        MarkdownOffset(8.)
    );
    assert_eq!(
        map.flat_to_prose_mirror(FlatOffset(f64::INFINITY)),
        ProseMirrorPosition(2.)
    );
}
