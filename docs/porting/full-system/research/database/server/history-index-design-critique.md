# Critique: counted visible-history indexes and fork spans

## Verdict

A counted ordered history structure is a credible way to remove the pinned upstream's remaining prefix-count and full-index work. It is not supplied automatically by Fjall/redb ordered iteration, and a single visible flag per item cannot reproduce T3's history. The design needs explicit order, source identity, multiple visibility/counting modes, fork membership and transaction/snapshot semantics. Claim a possible reduction for specific read paths, not universal O(log N) history.

This is a source-derived design critique, not an implemented structure or measured result. Sources are pinned to upstream 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f.

## 1. Current opportunities must stay narrow

Pinned upstream already bounds the ordinary snapshot window and has per-run/per-thread counts. readTimelineIndex still reads all relevant run/attempt and item metadata; target-entry, stale/folded-cursor, fork and attachment cases can invoke it. Local history rank/count paths still execute prefix/whole-thread counts and subtract hidden entries. An implementation must record which exact operation it accelerates. Replacing one already bounded page with a new bounded page is a constant-factor experiment, not an asymptotic breakthrough.

Source: [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), especially readCanonicalProjection, readTimelineIndex, readSnapshotTimelineIndex, openLocalTimeline, visibleBefore, getThreadHistoryPage, readLocalTimelinePage and getTimelinePage.

## 2. Ordered KV iteration is not rank/select

An ordered key such as (thread, ordinal, item ID) supports seeking and traversing a page. It does not answer how many eligible items precede that key without counting. Nor does it directly select the item at visible position P. Store counts in an augmented tree or bounded blocks with an indexed tree of cumulative subtree counts.

A possible structure is a persistent balanced block tree per thread/generation. Leaves hold bounded sorted item headers; internal nodes hold child separators and count summaries. A point insert changes one path, occasional splits/merges and affected derived summaries. Atomic publication switches the committed root and associated sequence. If implemented over an LSM, its read/write/compaction amplification includes all path-node writes; do not assume an application-level tree is automatically cheaper than SQLite's optimized B-tree.

A flat array of cumulative block prefixes is insufficient: inserting an early item updates every later prefix. A Fenwick/tree arrangement with stable addressing may work but requires a well-defined insertion/rebalance strategy. A general order-statistic tree avoids that specific O(number of blocks) update, at the cost of more random metadata access.

Do not use tree height alone as the performance claim. Warm cached CPU, block fetches, binary encoding, compaction cost, transaction metadata and transferred payload bytes all matter.

## 3. Preserve the exact total order and item movement

Current local order uses ordinal and item ID. TurnItemPositionStore assigns run ranges with a stride of 1,000,000, reserves a run-start slot only when unused, and can move an existing item into a later run range when a steer misses its original turn. Pending messages keep submission order. keepExisting deliberately permits out-of-range items.

Consequences:

- An item ID is a stable identity; an ordinal key is a mutable position. Maintain ID-to-position and position-to-header indexes atomically.
- Encode numeric ordering correctly, including supported negative/fractional/large values if the contract permits them; document accepted range from contracts rather than choosing an engine integer representation blindly.
- Preserve tie-breaking and collation. SQLite BINARY, JavaScript string comparison and UTF-8 byte comparison need explicit consideration for non-ASCII IDs. Prove IDs are constrained or implement the exact comparator.
- A range aggregate by run ordinal does not automatically cover every item belonging to that run, because keepExisting/movement behavior can break a naive range assumption.
- Delete/recreate and stale cursor handling must resolve identities against the committed generation, not a recycled physical row position.

Source: [TurnItemPositionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/TurnItemPositionStore.ts), [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts).

## 4. Visibility is conditional state, not one permanent bit

Visibility depends on run status, cancelled/queued input, rolled-back runs, superseded attempts, stop-request overrides and item-specific rules. The current local optimized path still reads exceptional run/attempt state to apply these predicates. A single run update can change many items. An attempt transition can hide or expose a subset whose IDs are dispersed in storage order.

Materialization choices must be stated:

1. Update every affected item and ancestor count immediately. Reads are simple, but a status update costs at least the affected-entry work.
2. Store per-run/per-attempt subordinate ordered spans and summaries; compose counts using state-dependent weights. This reduces common status-switch work only if the resulting order and predicates can be composed without visiting interleaved entries.
3. Keep bounded exception overlays with exact counts and reconcile them later. Every read must combine the base and overlay at one sequence; an unbounded overlay recreates the original scan.

All can be valid. None permits an unconditional O(log N) write claim for arbitrary visibility changes. Report changed entries or groups H in the bound. Maintain secondary run-to-items and attempt-to-items membership so exceptional updates avoid a full-thread discovery scan.

## 5. Display modes need independent summaries or a proven compositional algebra

Conversation-only, full timeline and deferred/work-group views are not identical sets. Folding can turn several physical items into one display entry. The appearance of a user boundary, a persistent output, an inline result or a late item can change group membership, group anchors and cursor meaning. A count of physical visible items is not necessarily a count of displayed entries.

A block summary may need more than an integer: first/last boundary classification, open group state, group weight/count, and the merge rules for adjacent blocks. To aggregate exactly, those summaries must be compositional. If folding depends on information outside a finite boundary summary, use an explicitly materialized group index or accept an affected-range repair cost. Do not claim constant-time merge until its equivalence to upstream is established.

Retain source identity for each display group and its constituent items so a search hit or attachment can jump into a folded group without rebuilding the whole index. Define which anchor is returned when the target is hidden, superseded, deleted or folded, and keep the old cursor fallback response intact.

Source: [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), getThreadHistoryPage and the history/deferred-work helpers it invokes.

## 6. Forks need a different visibility model

The source provides precise rules around lines 1,654–1,805:

- Run ordinal enforces a fork's source-run cutoff.
- A runless item can inherit through this path only when historyOrigin is v1_import.
- A run rolled back before the fork's creation is excluded from that fork.
- A later rollback does not hide history that the fork already inherited. In inherited visibility, a rolled-back run is removed from the hiding-state set, except cancelled attempts retain cancellation evidence by treating that run as cancelled.
- Already inherited ancestor prefixes remain part of the child's inherited prefix.
- Side chats display local rows only.
- A fork introduces a synthetic marker with deterministic ID and then local rows.
- Portable handoff/context-transfer state can also determine whether conversation is inherited.

Therefore, neither the parent's current local-visible tree nor a frozen snapshot of all parent rows is automatically the child's correct history. A frozen snapshot can miss later item/payload changes to an included run; a current local tree can incorrectly hide a run after a later rollback. The precise extent of late updates must be preserved from source behavior, not guessed from a general event-sourcing design.

Possible approaches include per-fork eligible-run membership plus dynamic selected-run summaries; versioned structural spans with separate membership and payload revisions; or a multi-dimensional aggregate keyed by source run order and rollback/fork time. Each must prove exact handling of runless legacy items, cancellation evidence, nested prefixes and synthetic markers. A single timestamp or version number is not a sufficient specification.

If many descendants refer to one source run, updating all descendant materializations can cause large fan-out. Lazy dependency revisions avoid eager fan-out but shift work to reads. Persistent span references share unchanged structure, but a span has to encode the fork-specific eligibility rule. These are real tradeoffs that belong in the benchmark and worst-case model.

Source: [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts#L1654), plus inheritedRunFork, inheritsForkConversation and buildVisibleTurnItems.

## 7. Snapshot coherence and invalidation are part of the index

Current full-index caching checks projection sequences across ancestor threads. A replacement must tie canonical entities, item ordering, visibility/group aggregates, fork references, source anchors and attachment/search relations to one committed snapshot. Returning a total from one generation and page rows from another changes cursor semantics even if both are individually valid reads.

A transaction can build new persistent roots, then publish roots and the projection/event sequence atomically. This helps large rewrites because readers continue using the old generation until commit. It does not remove the work to build or retain the new roots, and garbage collection must respect active readers and backup snapshots.

If updates use an overlay, an overlay's count correction and payload references must become visible with its canonical event. Nested provider rollback must discard every staged index change. A batching savepoint cannot roll back only canonical records while retaining counted-tree or search-posting mutations.

Source: [EventSink.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EventSink.ts), [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts).

## 8. Attachments and search hits need direct anchors

Maintain attachment ID to source-thread/source-item references at the same commit that changes attachments. Filter candidate owners through the target thread's ancestry and visibility rules, then map the selected source item to its current display anchor/rank. If an attachment appears in many rows, query cost includes those candidate references; there is no universal point-lookup bound.

Search similarly needs stable source anchors. Global search's document eligibility, normalization, candidate caps and ordering are separate from timeline visibility. In-thread find currently uses the full visible index. A replacement may combine posting hits with visibility/order metadata, but it must preserve which matching items are reachable and how result navigation behaves. A posting index alone does not supply display rank.

Source: [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), [ThreadFind.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadFind.ts), [ThreadSearch.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadSearch.ts).

## 9. Honest complexity statement

Let N be a local thread's physical item count, K returned entries, B returned payload bytes, D ancestor depth, H changed visibility/group members, and F affected descendant spans. For a balanced counted structure with correct bounded summaries, an ordinary local rank/select plus page can plausibly be O(log N + K + B) work, with constants and I/O determined by tree blocks and storage caching.

An inherited page also pays to locate and compose relevant ancestry/spans. A conservative design target is O(D log N + K + B) plus repairs or exceptional predicate work, not O(log N) for every fork. Pathological fan-out or late status changes may require O(H), O(F), or both, unless a proven shared representation avoids those updates. Imported/folded history and stale cursor fallbacks need their own bounds.

These are algorithm-design targets. No benchmark in this source review demonstrates them, and no candidate engine itself guarantees them. The practical win is avoiding known unnecessary full-thread work on representative upstream operations without shifting larger costs onto the live write path.

## 10. Minimum semantic oracle cases before performance claims

A future differential harness should replay the same operations into pinned upstream and the candidate and compare complete responses and durable state at commit boundaries. Cases must include:

- Empty/small/very long threads; payload-heavy tool outputs; many runs with few items and few runs with many items.
- Ordinal ties, moved steers, run-start placement, keepExisting and pending input.
- Queued/cancelled/rolled-back runs, rollback before versus after fork creation, cancelled/superseded attempts, stop overrides and late output.
- Nested forks, deleted intermediate source threads, runless imported history, side chats and portable handoff with no inherited budget.
- Both work modes, conversation-only pages, groups crossing block boundaries and group changes after late results.
- Valid/stale/missing/folded cursors, search jumps, hidden targets and attachments with multiple owners across ancestry.
- Concurrent writer/read snapshots, provider batch inner failure, process death during commit and replay after pruned events.
- Migration/reopen/backup/restore, while all canonical and auxiliary indexes agree at the committed sequence.

The harness is proposed future work, not a test run or implementation authorization in this research task.
