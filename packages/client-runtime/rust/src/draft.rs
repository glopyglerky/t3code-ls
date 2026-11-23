//! Three-way draft reconciliation over adapter-interned equality classes.
//! Tokens preserve the host's equality contract without moving JSON, keys, or
//! storage ownership into the portable client. Zero denotes an absent record.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftMerge {
    KeepStored,
    Remove,
    Local,
    Groups([u32; 4]),
}

/// Groups are body (including inline context), model, runtime, interaction.
/// A local edit wins within a group; unchanged groups retain the stored value.
/// This is a three-way save, not a commutative CRDT or an atomic storage write.
pub fn reconcile_draft(
    local: u32,
    baseline: u32,
    replace_stored: bool,
    stored_groups: [u32; 4],
    local_groups: [u32; 4],
    baseline_groups: [u32; 4],
    empty_groups: [u32; 4],
) -> DraftMerge {
    if local == baseline {
        return DraftMerge::KeepStored;
    }
    if local == 0 {
        return DraftMerge::Remove;
    }
    if replace_stored {
        return DraftMerge::Local;
    }
    let groups = core::array::from_fn(|i| {
        if local_groups[i] == baseline_groups[i] {
            stored_groups[i]
        } else {
            local_groups[i]
        }
    });
    if groups == empty_groups {
        DraftMerge::Remove
    } else {
        DraftMerge::Groups(groups)
    }
}
