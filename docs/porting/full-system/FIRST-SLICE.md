# First end-to-end implementation slice

## User outcome

A user opens a real T3 client, creates a conversation, submits a prompt, handles an approval, watches a long rich response while scrolling older content, interrupts or completes the turn, reloads, reconnects after server restart, reopens history and searches it. The same outcome must work through the selected Rust owners and preserve authoritative state, receipts, effects and client position.

Use T02 for the first complete conversation, T04 for history/storage comparisons, T03 for negotiated deltas and T05 for existing-profile activation, as defined in [the implementation plan](IMPLEMENTATION.md). Complete baseline/qualification ownership prerequisites first. This is the first performance proof for the architecture, not a replacement for the remaining full-product packages.

## Exact inputs before editing

Record the fork commit/tree, integrated upstream commit, researched comparison commit, chosen stock artifact/build, compiler package and produced driver/sysroot, target, fixture hashes and expected outcome. Read the current [port map](../../../port-map.json), [upstream lock](../../../upstream.lock.json) and [current-state audit](CURRENT-STATE.md). Reconcile relevant upstream changes before using a newer contract.

Use independent, disposable fixture state for each implementation. A production or installed application home is not a benchmark fixture. A SQLite control must use an independent non-activated fixture; it must never reopen a native-activated home. Do not run real model/provider turns for routine qualification.

Generate the current plans through existing tools. These commands create reports, not implementations or acceptance:

```sh
t3code_plan_dir="$(mktemp -d /tmp/t3code-full-system.XXXXXX)"
python3 tools/plan-porting.py --repo-root "$PWD" --fetch-default \
  --output "$t3code_plan_dir/porting-plan.json" \
  --summary "$t3code_plan_dir/porting-plan.md"
python3 tools/ci_plan.py --repo-root "$PWD" \
  --output "$t3code_plan_dir/ci-plan.json" \
  --summary "$t3code_plan_dir/ci-plan.md"
```

The planners require the repository context and source objects described in [CI and porting](../../ci-and-porting.md). `--offline` on `ci_plan.py` intentionally plans full qualification; it is not a shortcut around missing evidence. A generated queue does not authorize pin changes or source retirement.

## Keep the existing production entry

| Responsibility | Existing boundary to extend | Required change |
|---|---|---|
| Authenticated client request and subscription | `apps/server/src/server.ts`, `ws.ts`, contracts and RPC handlers | Preserve public schemas, authorization, error/cancellation behavior and independently versioned clients |
| Domain decision and event preparation | `apps/server/src/orchestration-v2`, current policy/dispatch ports | Introduce Rust ownership for the actual command/ingestion path, not a second standalone API |
| Provider frames | Provider package and its orchestration adapter | Decode and normalize once; preserve final corrections, question/approval identity and unknown outcomes |
| Durable transaction | Existing omdb selection, native database/store and domain row owners | Commit compact data, events, receipts, indexes and outbox consistently through the existing authoritative owner |
| Live publication | Current coalescer, stream budget and subscription handlers | Publish committed revisions with bounded retention and explicit gap recovery |
| Client state and rendering | `packages/client-runtime`, `apps/web`, `apps/desktop`, `apps/mobile` | Introduce shared Rust state and a real client view consuming it; keep renderer-independent semantics |

The standalone `crates/app` protocol is a component input. Redirecting the user to `POST /rpc` instead of the actual application is not this slice. Existing crate moves are separate from behavior substitutions. New Rust lives under its application/package owner, with compilation and source ownership recorded in the port map.

## Implement in reviewable increments

### A. Preserve behavior while removing internal boundaries

Port one full provider-event and command path into Rust behind the current application contract. Keep current wire behavior first so the existing clients remain a controlled comparison. Replace per-operation JSON subprocess work where the domain and store can share one Rust process. Keep process isolation for actual provider/browser lifetimes.

Trace request admission, queue delay, normalization, commit, publication, encoding, client apply, layout and presentation. Trace external provider/model time separately. Record which implementation handled each stage without exposing credentials or user content.

### B. Define a versioned incremental representation

The following is a design contract, not an existing wire schema. Define item identity, an expected base revision, a new revision and the committed global sequence. Support append, full replacement and exact splices with explicitly typed offset units. Internal byte offsets and public UTF-16/source offsets require tested conversions; never leave offset units implicit.

For each operation define these outcomes:

| Input condition | Required behavior |
|---|---|
| Expected base revision matches | Apply once and publish the resulting revision |
| Same operation/revision and payload arrives again | Recover the existing result without appending twice |
| Reused operation/revision has a different payload | Reject the conflict through the defined error/receipt contract; do not report a successful duplicate |
| Base is missing, ahead or expired | Request or emit a bounded authoritative snapshot; do not guess |
| Provider final text differs | Apply a full replacement or an exact supported correction |
| Command/event commit fails | Publish no durable success; preserve the original failure/receipt semantics |
| Commit outcome is uncertain | Reconcile by the original identity; never retry through another backend |
| Authority is revoked | Stop unauthorized delivery/effects and invalidate applicable encoded-cache access |

Keep current JSON for clients without the negotiated capability. Measure their remaining full-prefix cost separately. A new capability must not silently change an existing message schema.

### C. Change durable data and event/outbox representation together

Maintain an owner-local chunked builder, compact item headers and query-specific indexes. Persist new chunks with the authoritative revision and required event/outbox representation in one transaction. Adding chunks beside an unchanged full-prefix event log does not remove the repeated work.

Specify migration versions, old-record decoding, finalized text, attachments/tool output, replay anchors, snapshot construction and retention. Preserve existing visibility, receipt, idempotency and cancellation semantics. Do not split a required cross-thread/global commit into independent writers merely because messages appear unrelated.

External calls remain outside the transaction. Acknowledged intent follows the promised commit boundary; durable effect workers dispatch it afterward. Preserve per-job failure behavior within a coalesced commit batch. Do not change durability or acknowledged loss windows to obtain a better timing.

### D. Carry the representation through subscriptions and the client

Encode once for each equivalent negotiated and authorization-filtered representation. Cache keys must distinguish permission scope/revision and schema capabilities. Share immutable encoded bytes only among equivalent authorized consumers.

Bound retained chunks, revisions and queued bytes. A slow subscriber must receive the documented gap/resnapshot behavior instead of pinning unbounded historical versions. Advance a replay cursor only after applying its state, and acquire a snapshot and cursor from the same committed boundary.

Use shared Rust client state with stable item IDs. Invalidate only changed Markdown, syntax and layout blocks. Preserve source selection, IME, scroll anchors, editing, citations, code/math/tables and provider corrections. Completed-block caching already exists upstream; measure any additional reduction in work.

### E. Extend through history and search

Add large histories, nested forks, old-page loading, rank/seek, item details, jump, search and cursor recovery. Return the required visible window plus its anchors. Preserve exact ranking, visibility and Unicode positions. An ordered key-value range by itself does not implement counted rank/select or fork ancestry.

Keep headers/indexes compact and load large payloads when requested. Reopen after event pruning and reconstruct the same authoritative state. Compare the complete path through storage, encoding, transport, state application and stable viewport.

## Controlled fixture matrix

Include long single messages and many small messages; coalesced and bursty updates; Unicode and split multibyte inputs; rich Markdown/code; provider corrections; approval/questions; completion and interruption; multiple concurrent threads; slow subscribers; history/forks/search; and restart/reconnect. The same recorded provider input and expected final state must reach every compared implementation.

Inject failure before commit, after commit before reply, during event publication, while an approval is unresolved, during pruning/snapshot creation, and during upgrade/activation. Distinguish a lost acknowledgement from an uncommitted operation. Record actual process stop before claiming cleanup. Include authority changes and stale client scopes.

## Comparisons and promotion

Compare pinned stock upstream; Rust server with an isolated SQLite control; the same domain/layout with omdb-backed transactional Fjall and direct redb candidates; retained clients; and the selected Rust client path. The final claim compares the full Rust journey to stock. Internal variants isolate contributions and are not alternative denominators.

Report p50/p95/p99 only with adequate samples; queue and longest-stall data; actual presentation; total process-tree memory; CPU/allocations; encoded/wire bytes; disk writes including maintenance; and recovery. Alternate order and separate cold, warm and sustained/aged state. Trace actual emitted update count when testing the full-prefix versus delta hypothesis.

Predeclare a practically meaningful gain and no-regression budgets from stock measurements before candidate results. Include the same durability, dataset and feature work. Small component wins cannot compensate for a missing required operation or broken platform.

## Deliverables that close the slice

- A scoped implementation PR using current source owners and real application entry points.
- Updated port-map consumers, compiler routes, required tests and source identities for the changed scope, with no unsupported acceptance/retirement promotion.
- Exact source, artifact, fixture and target identities for observed runs, plus failures and raw measurements.
- Contract, negative, crash/recovery and client-flow evidence for the affected targets.
- The comparison report, including regressions and which work remains on retained implementations.
- A continuation handoff naming the next dependency-ready package and unresolved boundaries.

Fixture success permits further qualification. Production activation requires the relevant migration, backup and recovery gates. Whole-product completion still requires the remaining client, provider, workspace, remote, platform and distribution packages.
