# Complete-user-journey performance acceptance matrix

Status: proposed measurement/acceptance design, **not measured results**. Upstream behavioral baseline is `pingdotgg/t3code@28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. Source/ownership details and immutable citations are in `nonserver-review.md` and `coverage.json`. Main server workload details must be joined with the server review.

## What must be compared

Compare a complete stock application path against the complete native application path, in addition to engine microbenchmarks. Keep fixture content, selected result/ordering, result limits, cache state, hardware/filesystem, process topology, concurrency, visibility and acknowledged-write guarantees equivalent. Use distinct profiles when durability differs; a different flush policy is not an engine-only win.

For each applicable journey report elapsed time to the user-visible outcome, p50/p95/p99, throughput under contention, server and UI CPU time, peak and retained RSS, bytes read/written, storage growth, and amount of work (rows/keys decoded, physical reads, protocol bytes and crossings). Long-lived mobile cases also need energy/background runtime. Report absolute values and speedup ratios; tiny operations can show large ratios with little UX consequence.

Treat crash classes separately: application task cancellation, process exit/SIGKILL, OS restart and power-loss persistence. Verify the declared acknowledgment/visibility point for each profile. An async cache update may legitimately be lossy; an accepted command receipt, trust revocation or recoverable unsent draft has a different contract.

Use fresh, typical and large/aged corpora. Large should vary both **count and payload size**: many threads, long active thread, very large individual message/tool output, many provider sessions, image-heavy imports, many environments and sustained churn. Cold OS page cache, cold process/warm filesystem, warm application and invalidated caches are distinct runs. A freshly created LSM without steady-state compaction is not the only workload.

## Matrix

| # | Real user journey | Workload and adverse conditions | User-facing measure and required behavior |
|---|---|---|---|
| 1 | Start a new desktop/server install | Empty store, create schema/identity, first client attachment | Time to server readiness and usable UI; correct initial identity/credentials; include native process/startup overhead |
| 2 | Reopen a mature workspace | Large existing store, cold/warm OS cache, thousands of sidebar rows, many envs | Time to cached first paint, authoritative shell and selected thread; bound CPU/RSS, distinguish background warming |
| 3 | Resume a long current conversation | Long message/work-log history, large payloads, pending provider state | Time to newest meaningful content and interactive composer, stable ordering/cursors, no eager full-history decode |
| 4 | Scroll backward, jump and find within a thread | Deep pages, sparse cursors, deleted/retried items, concurrent new messages | p95 page/jump latency and bytes decoded; no duplicates, missing boundaries or inconsistent snapshot |
| 5 | Global/thread search | Prefix/phrase/substrings as supported, accents/Unicode, exact identifiers, punctuation, many hits, long bodies | Match/rank/snippet parity and p95 latency; measure index freshness after edits/deletes and rebuild visibility |
| 6 | Send one message and stream a response | Short and very long answers; tool events; normal and burst stream cadence | Submit-to-durable-accept, first visible response, UI frame budget, disk/CPU per completed turn; correct event/projection/receipt/outbox visibility |
| 7 | Run several agents concurrently | Multiple threads/projects/providers; readers and writes mixed | Tail latency and fairness, throughput at saturation, cancellation cost; no writer starvation or unbounded backlog |
| 8 | Retry after disconnect or ambiguous response | Disconnect before/after durable acceptance, duplicate commands, reconnect with stale cursor | Exactly intended command effect via receipts/idempotency; replay/reconcile time and bytes, no lost accepted work |
| 9 | Switch provider, resume or fork | Original provider state exists/missing; moved workspace; retry/steer; handoff context | Resume latency and context/history parity; preserve Cursor storage workspace and provider native IDs |
| 10 | Sidebar/project/thread management | Visit/pin/archive/snooze/rename/delete/restore, 1k–100k realistic rows, burst updates | Time to consistent sidebar/UI update and durable mutation; exact rank/tie handling, bounded modified records |
| 11 | Approve work, execute outbox effects, schedule tasks | Pending approval/rejection, timed/recurring task, webhook-induced work, restart during effect | Acknowledgment-to-effect latency; correct claims/retries/receipt retention and no accidental duplicate external action |
| 12 | PR/issue workflows and VCS | Open list, fetch per-PR stats, switch branch/worktree, mark viewed, save review guide | Time to usable content; cache-hit/miss split, invalidate linked-worktree refs, retain viewed/review state |
| 13 | CLI while server is running | Auth/pair/connect/project/thread/status and diagnostics parallel with UI | End-to-end CLI latency and contention; owner RPC identity/auth/permissions equivalent; no accidental second writer |
| 14 | CLI with server stopped | Inspect/doctor/migrate/isolated seed, concurrent launcher attempt | Lease acquisition and useful completion time; refuse conflicting owner and preserve targeted home; release on crash |
| 15 | Offline mobile startup and reconnect | Airplane mode, previously cached shell/thread/config, stale schema, removed env | Time to useful offline view; no old-environment leakage, correct discarded cache behavior and reconnect convergence |
| 16 | Mobile draft/outbox durability | Type text, attach images, queue several sends, app update/background/kill mid-write | Draft/message recovery and flush latency; partial file corruption isolated, attachment references preserved, no premature cleanup |
| 17 | Mobile database failure and recovery | SQLite unavailable, preferences SecureStore fallback newer/older, failed fallback deletion | Preferences retained and reconciled; startup latency/error behavior; caches may miss without losing settings or drafts |
| 18 | Browser cache quota and connection churn | IDB denied/full/blocked/closed/versionchange, huge thread snapshot, many PR stats | Responsive UI and actionable fallback; stale oversized snapshot removed; pruning bounds and retry behavior |
| 19 | Multi-tab browser editing and trust changes | Two tabs editing distinct/same drafts; stale build tab; revoke routing grant; history visit | Cross-tab convergence and write cost; stale unrelated saves cannot restore revoked trust or erase unrelated draft edits |
| 20 | Desktop credential/catalog migration | Secure storage unavailable, legacy envs, unreadable encrypted catalog | Unlock/read/write/startup latency; no silent plaintext downgrade, preserved quarantine/recovery copy |
| 21 | Provider usage dashboard | OpenCode multi-GiB SQLite with giant JSON rows, warm unchanged DB, small append, live WAL; Antigravity sessions | Time to usable usage summary, event-loop delay/RSS, bounded row/body decode, correct fork/compaction/account semantics |
| 22 | Import provider projects/history | Codex state_5.sqlite plus transcript files; Claude/other files; screenshot-heavy GiB input; partial legacy imports | Discovery/first-thread/full import time, bounded memory, repeat import idempotency and ownership checks |
| 23 | Inspect SQLite attachment or import browser cookies | Bounded/untrusted file preview; running Chromium/Firefox with live WAL; encrypted cookies | Time to first table/page or import result; readonly source, viewer limits, correct cookie scope and no provider format mutation |
| 24 | First native migration or older-version upgrade | Tiny/large DB, low disk space, legacy collision, interruption after each completed stage | Time to usable app, progress and peak disk use; source preserved, resumable work, atomic publication of coherent native generation |
| 25 | Service update succeeds | Clone-capable and copy-only filesystems, symlinked DB, active reads/writes | Total interruption and time to ready; coherent backup/checkpoint and candidate readiness; do not overwrite original trial backup |
| 26 | Failed update/rollback/restart | Candidate fails after schema mutation; launcher dies during backup/restore; missing target runtime | Time to recovered usable prior version; marker/manifest prevents partial restore; separate failed-trial rollback from post-commit downgrade |
| 27 | Long-running retention/compaction | Days of append/delete/retry churn with historical usage and concurrent chat/search | Foreground p95/p99 during maintenance, write amplification, growth/reclamation; preserve required history and bound disk/CPU duty |
| 28 | Doctor/rebuild/repair/backup-restore | Rebuild search, reclaim, export/checkpoint, restore at another location; low disk/read-only/corrupt input | Completion/progress, downtime, peak extra disk; preserve authoritative data, IDs, references and documented recovery guarantees |
| 29 | Environment removal and attachment cleanup | Offline env, pending uploads/outbox/drafts/incoming shares, partial cleanup failure | Correct retained/deleted owned data, independent cleanup completion; no cross-env deletion or dangling live references |
| 30 | Remote relay identity/notification path | Concurrent DPoP consume, account switch, token revocation, managed endpoint generations, duplicate delivery job | Auth/delivery tail latency under concurrency; one successful replay claim, correct revocation/claim/identity semantics |
| 31 | Offline webhook hold and wake | Burst under caps, duplicate delivery, unreachable/busy host, alarm retry, 24-hour expiry | Durable hold ack latency, wake-to-delivery, bounded backlog; preserve IDs for ambiguous retry and conditional cap enforcement |
| 32 | Task-cache developer/CI path | Hit/miss/cold restore, competing generations, quota exhaustion, interrupted upload/GC, telemetry retry | Time to restored task outputs and full command result, R2/D1 work; atomic publication, policy/auth preserved, no duplicate savings |
| 33 | End-to-end representative working day | Startup → several concurrent coding turns → search/history/PR → offline/reconnect → close/reopen, with background maintenance | Weighted user time, worst-tail interactions, CPU/RSS/storage/energy; no isolated win that makes dominant workflows worse |

## How this expands the current five-operation fixture

The existing fixture's sidebar, history, two search cases and visit-write measurements exercise selected server persistence APIs. They are useful for those APIs. They do not cover process startup, actual UI rendering, network transport, real streaming cadence, outbox/receipt races, provider databases, mobile/browser persistence, credential migration, relays, task caches, upgrade backup/rollback or steady-state maintenance.

Keep the fixture as a narrow diagnostic/performance gate, but do not label its average “T3 database speed.” For a fresh candidate, compare against this pinned current upstream and its actual result semantics. Do not use an older upstream corpus without marking the version/workload difference.

A useful decision rule is a prespecified set of important workloads: meaningful improvement in the dominant interactive paths, no material regression in other required paths, bounded resource cost under sustained load, and correctness/lifecycle acceptance. Set absolute budgets from the product's observed UX before interpreting ratio wins. The table identifies what must be measured; it does not invent latency targets without a baseline.

## Native lifecycle implementation checkpoints

1. Define one visible commit sequence for events, projections, receipts, outbox, search/rank indexes and non-orchestration server owners. Document exactly when an API acknowledges.
2. Integrate every local writer/reader with the owner service or an exclusive offline lease. Include current desktop, service and SSH lock protocols in migration; do not change the server lock in isolation.
3. Make migration publish a new store generation only after all required authoritative state, references and indexes reach the same sequence. Retain the source and resumable progress.
4. Implement backup/checkpoint, update trial and restore-marker semantics before making the native store the only authority. A directory of copied files from different compaction generations is not a coherent backup.
5. Bound retention/index rebuilding and compaction so they cannot monopolize IO while chat is active. Retain or materialize historical usage facts and pending effects.
6. Leave provider-owned SQLite/SDK stores and browser/mobile/relay/task-cache owners behind their existing contracts. Native replacements for those are separate projects with separate performance and compatibility evidence.

