# J02 plain-1 stopped event cursor diagnostic

This is a separate named untimed diagnostic, not an alternate matcher. The
original `t16-strict-control match`, exact selected ordered-history checks,
transcript manifest comparisons, identity checks and output gates stay unchanged.
The plain lane still rejects the observed seed HTTP / WebSocket coordinate
mismatch. A diagnostic receipt never authorizes pooling or performance acceptance.

The existing plain itinerary invokes this command for round 1 after successful
`probe-reopen` exit, before deleting that arm's synthetic trial. No new workflow,
product option, live profile or provider turn is added. This adds post-scope reads
and their page-cache effects; do not pool subsequent observations with earlier
runs or claim unchanged observer cost. Later rounds retain the original matcher.
A diagnostic failure fails this control rather than synthesizing missing rows.

## Source and milestone meanings

The candidate probe is `126ee67adb8a0042d79c8bbc4ba600faa28026f8`.
At that pin, `tools/src/startup_probe/browser/reopen.rs:80` calls the direct HTTP
snapshot helper after the durable IndexedDB cache-presence check. That check
establishes presence of selected text, not equality of cached and HTTP cursors.
`tools/src/startup_probe/browser/reopen-snapshot.js:3-36` issues concurrent no-store
shell and selected-thread HTTP reads and retains their snapshotSequence values.
`tools/src/startup_probe/reopen.rs` assigns `saved_thread_sequence` from this
seed snapshot's threadSequence. It is not an IndexedDB sequence readback.

At the same pin, `browser/reopen-observer.js:30-66` observes the subscription's
`afterSequence` when it sees the synchronized chunk and records it as
`threadResumeAfterSequence`. The timestamp uses navigation `performance.now()`;
the integer is an event-log resume position, not a timestamp or necessarily the
newest synchronized sequence. The client subscription construction is owned by
`packages/client-runtime/src/state/threads.ts`, using lastSequence when cached
projection data can resume. Final shellSequence/threadSequence come from the
later direct HTTP snapshot after the visible and authoritative readiness checks.
The two HTTP requests are concurrent, not one shared snapshot transaction.

Fixed stock `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`,
`apps/server/src/orchestration-v2/ProjectionStore.ts:7053-7067` obtains the selected
thread snapshot sequence from MAX(sequence) for version-2 thread events in that
stream. Its shell snapshot at `:9270-9276` uses version-2 thread events across
streams. A shell cursor is therefore not inherently a selected-thread cursor.
The initial and reopened descriptor/HTML offsets use the probe's pre-spawn Rust
Instant. Browser performance.now() has a different origin. Stored event sequence
numbers are ordinal positions; none of these integer comparisons aligns clocks.
The diagnostic deliberately emits no event timestamps and no causal conclusion.

Native helper protocol was inspected at the itinerary's actual native pin
`98726c9640a0c45f58310ce4180ac3e2d125f11c`, in
`crates/storage/src/bin/t3-code-ls-db.rs:172-177,224-234,753-762,837-861,1735`.
It supports read-only-local, application_begin mode read, bounded
application_events_read and rollback. The corresponding
`apps/server/src/persistence/redb_transactions.rs` opens begin_read_only for that
mode. EventResultRow exposes aggregate_kind/stream_id/event_type but no actor_kind.
The receipt's owner is the stored stream category, not a claim about a producing
fiber, background service, actor or causal code path.

## Bounded private observations

Only exact coordinate case 12865..12867 is admitted, including the differing
seed coordinate for stock/full versus native. Each command requires the exact
selected fixture ID, 32 threads, 200 selected messages, valid snapshot and a
sample whose fixture workspace resolves inside that supplied owned trial.
Canonical database identity rejects symlink escapes. Stopped ownership is a
caller obligation established by successful probe exit in the itinerary; the
CLI does not establish process quiescence for an arbitrary supplied directory.
Never invoke it on installed state or use a forged sample to admit another path.

Stock uses sqlite3 -readonly with immutable=1 and refuses a nonempty, inaccessible
or nonregular WAL rather than ignore committed WAL data. This assumes the owned
fixture remains stopped and unchanged throughout the read. No checkpoint, schema
preparation, migration or writable fallback is attempted. An absent sqlite3 CLI
is a hosted prerequisite failure; it is not installed by this patch.

Native uses the existing packaged helper without product edits or a new backend.
Its API returns full event rows internally. Those bytes stay in bounded process
memory and are never logged or saved. Only three sequential event types from the
base schema literal allowlist and stream categories survive the projection.
Payloads, raw IDs, commands, timestamps and actor guesses are omitted. Missing,
duplicate, unknown-schema or foreign-owner rows reject the diagnostic. Child
stdout is capped at 16 MiB, stderr discarded and runtime bounded by timeout.
The existing workload already requires Linux timeout. This is hosted diagnostic
Rust with OS subprocess adapters, not a no_std or whole-stack Rust claim.

## Rerun under the existing hosted owner

After patch application in the owner's authorized staging source, the existing
plain-strict selector copies the new Rust file into the pinned probe's bin
directory. Use the existing pinned Lustr/BlueFe route and CARGO_TARGET_DIR:

```sh
"$lustr" --bluefe-root "$T3_CODE_LS_TOOLCHAIN" test --locked -p t3code-ls-tools --bin t16-cursor-diagnostic
"$lustr" --bluefe-root "$T3_CODE_LS_TOOLCHAIN" build --release --locked -p t3code-ls-tools --bin t16-cursor-diagnostic
"$CARGO_TARGET_DIR/release/t16-cursor-diagnostic" "$mode" \
  "$root/apps/server/dist/bin.mjs" "$trial" "$sample" > "$cursor_receipt"
```

Run the last command only after the existing probe exits successfully and before
its existing trial deletion. mode is stock for stock/full and native for native.
The existing source/binary manifests now include this diagnostic. Keep all three
original sample receipts, transcript comparisons and original strict-match failure.
No workflow dispatch or publication was performed to prepare this patch.

Authored hosted tests cover the distinct milestone values, missing/wrong
coordinates and selected identity, row schema/sequence/ownership refusal,
duplicate and missing rows, native refused/truncated/malformed frames, and
payload/identity omission. They are unexecuted until the hosted owner runs them.
Also verify real fixture opens and rejection for WAL-bearing SQLite, database
symlink escape, wrong fixture sample, nonzero subprocess exit, bounded stdout,
timeout and missing executable. These integration rejection checks remain unrun;
unit tests are not evidence those process/file paths work.

Retain small category receipts and existing source/binary hashes. Existing cleanup
removes profiles and staging. No new retained database, raw helper output, cache,
workflow, index, ref or progress register is needed. Actual stored event types,
their stream owners and causal/performance conclusions remain unknown pending
execution. The old archive contains the coordinates but no retained database or
event rows with which to backfill this receipt.

MIT applies to the diagnostic under the repository LICENSE. Preserve upstream
T3 Tools Inc. notices. Author of this diagnostic and documentation: gpt-6.1-sol,
T3 Code -> Codex harness. No independent reviewer authored these changes.
