use t3_code_ls_client_text::draft::{DraftMerge, reconcile_draft};

#[test]
fn reconciles_every_combination_of_group_edits_and_clears() {
    // Two versions plus empty for each of the four stored/local/base groups.
    // Expected choices follow the retained TS oracle, independently of Rust's loop.
    for n in 0_u32..3_u32.pow(12) {
        let mut remaining = n;
        let values: [u32; 12] = core::array::from_fn(|_| {
            let value = remaining % 3;
            remaining /= 3;
            value
        });
        let s = [values[0], values[1], values[2], values[3]];
        let l = [values[4], values[5], values[6], values[7]];
        let b = [values[8], values[9], values[10], values[11]];
        let expected = [
            if l[0] == b[0] { s[0] } else { l[0] },
            if l[1] == b[1] { s[1] } else { l[1] },
            if l[2] == b[2] { s[2] } else { l[2] },
            if l[3] == b[3] { s[3] } else { l[3] },
        ];
        assert_eq!(
            reconcile_draft(2, 1, false, s, l, b, [0; 4]),
            if expected == [0; 4] {
                DraftMerge::Remove
            } else {
                DraftMerge::Groups(expected)
            }
        );
        assert_eq!(
            reconcile_draft(1, 1, false, s, l, b, [0; 4]),
            DraftMerge::KeepStored
        );
        assert_eq!(
            reconcile_draft(0, 1, false, s, l, b, [0; 4]),
            DraftMerge::Remove
        );
        assert_eq!(
            reconcile_draft(2, 1, true, s, l, b, [0; 4]),
            DraftMerge::Local
        );
    }
}
