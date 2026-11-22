# Upstream T3 Code server persistence research

## Scope, evidence and limits

This report studies upstream pingdotgg/t3code at **28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f**. It does not evaluate the user's fork. The historical CI comparator 2c4310eb remains a separate benchmark baseline; conclusions about current behavior here come from the pinned current source.

The mechanical inventory inspected 1,717 tracked blobs under apps/server/src, selected 744 production JS/TS files after excluding test/spec/testkit/fixture helpers, and found **172 SQL-related source candidates: 54 runtime files and 118 migration source files**. All 54 runtime source files were captured during research. This publication retains immutable source URLs and Git object identifiers in sql-inventory.json; raw source copies are omitted. The migration inventory contains 314 lexical DDL occurrences. The operation index contains 257 named Effect.fn operation occurrences; this is a lexical count, not the count of public APIs.

Semantic coverage is explicitly different: **43 runtime candidates received substantive selected operation-family review; five are external-provider SQLite interoperability readers; six are dependency/routing/error candidates rather than independent persistence implementations.** Every runtime candidate belongs to at least one operation family in operation-family-map.json. Large modules were not audited line by line. The 113 inventoried non-SQL persistence importers were not all traced through every caller. The schema inventory records migration history, not an executed final sqlite_schema. No build, benchmark, migration or test was run. Proposed speedups remain hypotheses until measured end to end.

The supporting artifacts are coverage.json, sql-inventory.json, migrations-inventory.json, runtime-operation-index.json, operation-family-map.json and history-index-design-critique.md. Sources outside the counted server scope were selected for architecture review, particularly packages/shared/src/nodeSqliteClient.ts and the provider commit batching implementation.

## Decision-relevant conclusions

1. **Replacing the engine underneath SQL is not the strongest opportunity.** Upstream already uses prepared statement caches, separate reader/writer workers, bounded projection windows, selective indexes, materialized counts, and batched provider commits. A Rust design should make the operation consume fewer records and return fewer bytes, then benchmark Fjall, direct redb and direct rusqlite behind the same operation interface.
2. **Do not characterize current snapshot windows as decoding all historical runs.** That was a real historical optimization target, but the pinned source already bounds ordinary windowed reads. Residual full-history work is concentrated in specific fallback, jump, ancestry, media and in-thread-search paths. A historical PR benchmark does not measure this revision.
3. **The database is an atomic state machine, not merely a key/value log.** Events, authoritative projections, command deduplication and effect enqueue are committed together. Nested rollback within provider batches, conditional authentication and scheduling updates, snapshot high-water marks, and exact search semantics are essential.
4. **Pruned events cannot reconstruct all current projections.** A new storage design needs a complete checkpoint/snapshot and recovery contract. Calling projections a disposable cache would silently change the current durability model.
5. **A complete Rust service replaces a storage boundary, not every SQLite use.** Settings remain atomic JSON files, external provider databases remain SQLite interoperability formats, and process ownership plus upgrade backup/restore need explicit replacement designs.

## Current SQLite baseline that a fair replacement must match

The primary connection policy is WAL, synchronous=NORMAL, checkpoint_fullfsync=ON, foreign_keys=ON, busy_timeout=5000, temp_store=MEMORY and a 128 MiB journal-size limit. Incremental auto-vacuum is enabled for an empty database. The source explicitly accepts loss of post-checkpoint commits after OS/power loss while expecting application crashes not to lose committed data. This is a weaker power-loss durability target than a synchronous durable flush on every commit; comparing those modes without labeling them would be misleading. The connection initializer also drops stale sqlite_stat1 estimates and reloads planner statistics because tiny-table estimates had caused bad scans.

The shared client has four reader workers and a writer worker, prepared statement caching (200 per worker), transaction binding to a worker and asynchronous result delivery. A separate worker performs idle WAL checkpoints, with a 1,000-frame target, 100 ms idle timer and a 10,000-frame writer backstop. The main request path must remain nonblocking. Workers cannot silently migrate an active transaction to another connection or restart a writer without reestablishing connection policy.

Source: [Sqlite.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Sqlite.ts), [nodeSqliteClient.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/shared/src/nodeSqliteClient.ts).

Stock already includes provider commit batching and coalescing with a bounded backlog and fairness to other writers; thread/run item-count projections; active-shell and background partial indexes; a message-ID expression index; prepared statements; and paged/bounded reads. These are part of the comparator, not new contributions of a Rust replacement.

## Atomic commit, replay and recovery contract

EventSink places command reservation/deduplication, events, projection changes, outbox requests and final command receipt within one transaction. Notifications are published only after commit. Each provider snapshot inside a shared batch uses nested rollback boundaries. A failed snapshot must discard its database changes, provisional projection state and deferred publications while allowing valid sibling snapshots to commit. A native KV batch that only supports all-or-nothing rollback needs a transaction-local staged overlay with checkpoints or an equivalent implementation; simply swallowing a callback error would be wrong.

The active event source is orchestration_events with ordered global sequence and stream version checks. Command receipts live in orchestration_command_receipts. The V2 naming of many projection tables does not imply a separate complete V2 event log.

ProjectionMaintenance prunes old events in bounded batches, retaining selected anchors, newest stream events, thread creation and facts needed by live usage/recovery. A pruned-through marker requires old clients to take a snapshot instead of requesting unavailable replay. Receipts continue deduplicating commands after their events are pruned. Thus the projections and native indexes required to serve them are persistent authoritative state, and snapshots must include their consistent generation.

The outbox uses atomic conditional claims, per-thread ordering constraints, availability times, lease ownership and a title-generation concurrency cap. Completion/retry/failure requires the current running lease owner. On process loss, process-bound effects are cancelled, and only explicitly replay-safe effect types are requeued. Unknown accepted network work cannot be made safe by a generic at-least-once queue.

Sources: [EventSink.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EventSink.ts), [OrchestrationEventStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/OrchestrationEventStore.ts), [OrchestrationCommandReceipts.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/OrchestrationCommandReceipts.ts), [ProjectionMaintenance.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionMaintenance.ts), [EffectOutbox.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EffectOutbox.ts).

## Verified remaining history work

The 9,910-line ProjectionStore is the dominant persistence module. The distinctions below matter when estimating an improvement:

| Current path | Verified current work | Native opportunity |
|---|---|---|
| Ordinary windowed projection snapshot | Selects live/cohort/required runs and attempts; does not unconditionally decode every historical run | Preserve this bound and reduce record/bridge/validation overhead; do not claim removal of an already removed scan |
| Ordinary local history page | Reads bounded item windows plus hiding runs, superseded attempts and necessary stop-request state | Compact visibility headers and indexed exceptional state can reduce bytes and decoding |
| Full timeline index | Reads all run/attempt records and turn-item metadata for the relevant thread, then recursively incorporates inherited history and filters visibility | Maintain an exact ordered visible sequence with explicit ancestry and visibility dependencies |
| Prefix rank and local page total | Counts an ordinal/item-ID prefix or whole thread and subtracts hidden entries | A counted order tree or counted blocks can answer rank/total without scanning the prefix |
| Search jump, missing/folded cursor fallback and some fork cases | Falls back to full timeline index | Stable source-item-to-display anchors and exact fallback rules |
| Attachment navigation | Uses full visible index and scans JSON attachment ownership across ancestry | Transactional attachment-to-source-item reverse index plus lineage eligibility |
| In-thread find | Receives the full visible timeline index and checks revision | Search hit anchors tied to the same visible-history generation |

Relevant source anchors in the pinned file: readCanonicalProjection around lines 4,125–4,270; readTimelineIndex around 7,086; readSnapshotTimelineIndex around 7,210; openLocalTimeline around 7,320; visibleBefore around 7,430; getThreadHistoryPage around 7,713; readLocalTimelinePage around 8,040; getTimelinePage around 8,090. Exact behavior varies by request mode, ancestry and cursor validity.

The current full index cache validates the projection sequence for all ancestors. An index that ignores late ancestor changes or changes in hidden state can return a fast but incorrect page. A page containing K rows cannot be cheaper than reading/serializing those K rows and their payload bytes. Any theoretical bound must include ancestor depth, changed visibility, folded groups and returned bytes, not just total history length.

Source: [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), [ThreadFind.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadFind.ts), [TurnItemPositionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/TurnItemPositionStore.ts).

### Ordering is not append-only

TurnItemPositionStore allocates a stable ordinal per thread/item. Run ordinal defines a million-position range. Existing items may move when a steer misses a turn and becomes input to a later run. Pending items retain submission order; keepExisting can preserve an out-of-run-range position. The run_start placement uses the first slot only if still unused, otherwise appends. Item ID breaks ordinal ties elsewhere in the timeline. A monotonically incremented thread counter cannot preserve all these behaviors.

## Other concrete upstream-specific opportunities

**Issue and pull-request reverse relations.** Both linked-thread modules expand arrays within each thread's payload_json and normalize/filter the results. A transactionally maintained reverse index keyed by the same normalized tracker/host/project/key or provider/host/repository/PR identity can avoid traversing unrelated thread payloads. Preserve deletion, sidechat and dismissed-link filters, exact normalization and deterministic output order.

**Provider/native-session ownership.** AcpRegistrySessions finds a matching driver/instance/native-session reference in JSON, joins to nondeleted threads and selects the latest updated owner. An exact compound covering index can return the same owner without payload parsing.

**Usage model facts.** CodexUsageHistory correlates native turns and attempts with the first run.updated event that entered running for that attempt to recover model selection. Persist that exact fact when the event commits; retain its provenance and import/backfill semantics. The event-retention rule currently exists partly because such facts are still derived from events.

**Path references.** KnownWorkspaces extracts distinct worktree paths from nondeleted thread JSON, while cleanup traverses recursive fork and checkpoint references. Path ownership and retained-checkpoint indexes can reduce repeated discovery, but must preserve platform path containment, aliases and deleted intermediate ancestors. A faster reference count with missing references would cause unsafe cleanup.

**Typed headers and payload separation.** Projection records combine hot statuses/IDs/order information with larger opaque message/tool JSON. A native representation can keep compact, validated headers and payload references separate, materialize command/shell facts, and read blobs only for requested response rows. This is plausible constant-factor work reduction, not a demonstrated engine speedup. Do not decode or copy every nested payload merely to implement a new adapter.

Sources: [issue/linkedThreads.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/issue/linkedThreads.ts), [pullRequest/linkedThreads.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/pullRequest/linkedThreads.ts), [AcpRegistrySessions.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/AcpRegistrySessions.ts), [CodexUsageHistory.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/usage/CodexUsageHistory.ts), [KnownWorkspaces.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/workspace/KnownWorkspaces.ts), [storageCleanup.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/storageCleanup.ts).

## Search equivalence is a product requirement

Current global message search uses a contentless-delete FTS5 trigram index and transactional insert/update/delete triggers. Streaming messages are excluded until settled; updates avoid reindexing when indexed content did not change. Indexing excludes attachment bootstrap placeholders, generated notices and subagent threads, and accepts specific user/assistant roles. Search uses readable citation/link-label transformations, apostrophe folding and specific case/diacritic behavior. Short queries and non-ASCII text have explicit handling rather than arbitrary token matching.

The query intentionally bounds work: 10,000 newest candidate hits, 2,000 accepted hits, and a 20,000-row fallback window when the index is unavailable or the query requires scanning. Results/snippets and title/project filters follow their own deterministic ranking. Those limits are part of observed behavior. A native posting index can preserve them, but a new tokenizer that merely splits words is not equivalent. FTS rowids link to the message table, so VACUUM/copy maintenance rebuilds search in an atomic clear/refill operation.

The native design should explicitly specify text normalization, posting keys, newest-first order, document eligibility transitions, update/delete atomicity, fallback queries and bounded candidate work. A correctness oracle should compare exact upstream responses, including Unicode, punctuation, citations, placeholders, hidden threads and stale/recreated documents. No such differential execution was performed in this research.

Sources: [ThreadSearch.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadSearch.ts), [messageSearchIndex.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/messageSearchIndex.ts), migration sources in migrations-inventory.json.

## Less-hot domains still constrain the design

Authentication contains single-use conditional pairing-link consumption with scope, proof-key, trusted-device, expiry and revocation checks in the update predicate. Session replacement revokes and inserts atomically. Listing intentionally treats some connected-but-expired sessions differently from ordinary inactive sessions. These are transaction semantics, not performance bottlenecks to weaken.

Scheduled tasks and webhooks are a concurrent persisted state machine. Edits preserve run state; generation/created_at comparisons prevent same-ID delete/recreate races; task dispatch rechecks current enabled/due state; token rotation cannot be overwritten by a stale task save. Pending coalesced deliveries, replay keys, relay deduplication and accepted-send recovery require coordinated indexes and transitions. One worker drains each task's persisted order, while other tasks can advance independently. Delivery retention and diagnostic bodies are part of the storage workload.

Peer links keep secret references in SQL and actual credentials in a separate secret store. Linking and unlinking have explicit compensation steps around database commits and network/session revocation. A new engine does not make these external operations transactional.

PR viewed-file state uses a compound identity including viewer/path and batches set/unset operations. Review guides are compound-key cached documents. MCP context notes need visibility rules that distinguish local rollback from inherited copied context. Task folders require root and real-root aliases and longest-containing-root lookup. Project metadata includes shell ordering, pins, archive/delete state and tracked folders.

## Migration, ownership, backup and external boundaries

Migrations.ts registers 107 numbered migrations. The 118 SQL-related migration sources include helper modules; lexical DDL ordering is not final schema ordering. Preview migration collisions are reconciled transactionally. Initial V2 setup copies a legacy SQLite database using VACUUM INTO a temporary file, publishes only the completed snapshot without overwriting a competing winner, and retains legacy tables for lazy per-thread import. A native importer must preserve all still-unimported transcript data and import markers, not just active V2 tables.

Server settings are atomic JSON files, with generation caching, write serialization and secret-management behavior. SQL references in serverSettings.ts are chiefly migration inputs. Moving all settings into a native DB would be an additional product/storage-contract change.

server-owner.sqlite is a separate, data-free SQLite lock file. Its held exclusive transaction is released by process death. The code verifies inode/device identity and does not unlink the file. CLI and server can currently access the main database in different processes. A single-owner Fjall service therefore needs an explicit CLI IPC path and an equivalent crash-released ownership lock.

serviceLauncher coordinates upgrade backups. Its online path pins the SQLite WAL using a read transaction, copies the main file while running, stops the server, copies/syncs the WAL, deliberately omits shared-memory state, publishes atomically and preserves the previous known-good backup through trial/restart. Offline fallback and disk-headroom behavior also matter. A Rust engine needs an engine-specific coherent checkpoint/export and restore protocol before this path can be replaced; copying live files opportunistically is insufficient.

Codex and Antigravity store their own session/usage data in SQLite. The scanner and Antigravity readers must continue to read those external formats even if T3's primary state store is native Rust. A narrow read-only SQLite compatibility component remains necessary.

Sources: [Migrations.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Migrations.ts), [initializeV2Database.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/initializeV2Database.ts), [LegacyV1ThreadImporter.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts), [serverSettings.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serverSettings.ts), [serverOwnership.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serverOwnership.ts), [serviceLauncher.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serviceLauncher.ts), [AgentSessionScanner.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/project/AgentSessionScanner.ts).

## Native service shape and validation boundary

Use domain operations such as CommitProviderSnapshotBatch, ReadThreadWindow, ReadHistoryAtAnchor, SearchThreads, ClaimEffect, ConsumePairingLink and DispatchDueTask. Each operation receives a typed request and returns exactly the bounded result the caller needs. Keep events, canonical records, visibility/order indexes, relation indexes, postings, receipt state and queues in one atomic store. A process boundary should transport one domain result or batch, not one tiny SQL-equivalent call per record.

The strongest prospective asymptotic gains come from replacing proven full-index/prefix work with materialized, snapshot-consistent indexes. Constant-factor gains come from compact records, fewer copies, decoding only projected fields and coarser request batching. Fjall's LSM design, redb's copy-on-write tree and SQLite's B-tree trade read amplification, write amplification, compaction, fsync and cache behavior; no source inspection proves a universal winner.

Benchmark the same upstream-derived operation traces with three controls: current pinned upstream, direct Rust/rusqlite with the domain layout where feasible, and direct native candidate engines behind identical operations. Compare matched durability, dataset shape, concurrency, cache state and response bytes. Include p50/p95/p99, CPU, allocations/bytes decoded, physical read/write bytes, WAL/compaction stalls, peak disk use and crash recovery. Require correctness parity first. Do not credit a faster result that omits histories, returns fewer search hits, loses accepted commands or weakens power-loss behavior without explicit product agreement.

## Uncovered work

This source study does not prove every branch in ProjectionStore, every legacy import transformation, every cleanup/backup edge or every scheduling network race. It does not execute all 107 migrations to extract final constraints/index definitions, and it does not inspect every one of the 113 non-SQL persistence importers. Tests, crash injection, benchmark corpus construction, traces and throughput results remain future implementation/validation work. The enumerated sources and family map provide a concrete starting checklist rather than a claim that an entire replacement has already been verified.

## Complete runtime operation-family map

The following map covers all 54 runtime candidates. Object names are current runtime references, with legacy/external roles labeled; migration history contains additional retired objects.

### Sqlite Runtime

**Storage:** sqlite_stat1; sqlite_schema.

**Operations:** connection policy; size and freelist accounting; incremental reclaim; low-space handling.

**Semantics:** WAL/NORMAL durability baseline; checkpoint_fullfsync; busy_timeout 5000; foreign_keys ON; Separate reader and writer workers; no synchronous I/O on main request path.

**Native plan:** same durability and end-to-end boundary for comparator; typed native operation batching can remove worker-message/SQL/result decoding overhead.

**Pinned sources:** [Sqlite.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Sqlite.ts), [DatabaseStorage.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/DatabaseStorage.ts).

### Events And Command Receipts

**Storage:** orchestration_events; orchestration_command_receipts; orchestration_v2_projection_metadata.

**Operations:** append ordered events; stream version checking; command deduplication and result receipt; event replay; projection sequence high water.

**Semantics:** One transaction spans reservation/events/projections/outbox/result receipt; Publish only after commit; Nested savepoint per provider snapshot in a shared batch; local failure must roll back its indexes and staged publications.

**Native plan:** one typed atomic domain commit; global sequence and stream-version indexes; transaction-local overlay/checkpoint for nested rollback.

**Pinned sources:** [EventSink.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EventSink.ts), [EventStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EventStore.ts), [OrchestrationEventStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/OrchestrationEventStore.ts), [OrchestrationCommandReceipts.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/OrchestrationCommandReceipts.ts).

### Entity Projections

**Storage:** orchestration_v2_projection_threads; orchestration_v2_projection_runs; orchestration_v2_projection_run_attempts; orchestration_v2_projection_turn_items; orchestration_v2_projection_messages; orchestration_v2_projection_provider_threads; orchestration_v2_projection_provider_turns; orchestration_v2_projection_provider_sessions; orchestration_v2_projection_provider_session_bindings; orchestration_v2_projection_subagents; orchestration_v2_projection_runtime_requests; orchestration_v2_projection_nodes; orchestration_v2_projection_plans; orchestration_v2_projection_context_handoffs; orchestration_v2_projection_context_transfers; orchestration_v2_projection_checkpoints; orchestration_v2_projection_checkpoint_scopes; orchestration_v2_projection_turn_item_counts; orchestration_v2_projection_thread_item_counts.

**Operations:** event projection; live/cohort entity lookup; window snapshot; thread/run lifecycle; fork-aware lookup; checkpoint retention; shell and background eligibility.

**Semantics:** Projection updates and derived counts are atomic with events; Projections are authoritative after retained events are pruned; Preserve status visibility, attempts, active/latest state, and parent/fork cutoffs.

**Native plan:** typed compact headers separated from large message/tool payloads; covering indexes for exact domain predicates; materialize only still-derived facts; current counts and bounded snapshot reads already exist.

**Pinned sources:** [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts).

### History Order And Find

**Storage:** orchestration_v2_turn_item_positions; orchestration_v2_projection_turn_items; orchestration_v2_projection_runs; orchestration_v2_projection_run_attempts; orchestration_v2_projection_threads.

**Operations:** allocate stable ordinal; local cursor page; visible rank/count; target entry jump; stale/folded cursor fallback; fork ancestry history; attachment owner lookup; in-thread search.

**Semantics:** Order is ordinal then item ID; run ordinal ranges use stride 1000000; A missed steer may move to a different run range; pending items keep submission order; Visibility and folding are not a single immutable boolean; Snapshot and all ancestors must share coherent committed sequence.

**Native plan:** counted order tree/blocks rather than assuming ordered KV supports rank/select; versioned ancestry spans and explicit dependency revisions; attachment reverse index and normalized search-to-source anchors.

**Pinned sources:** [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), [TurnItemPositionStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/TurnItemPositionStore.ts), [ThreadFind.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadFind.ts).

### Effect Outbox

**Storage:** orchestration_v2_effect_outbox; orchestration_v2_projection_runs.

**Operations:** enqueue idempotently; claim earliest eligible effect; thread serialization; lease-guarded completion/retry/failure; cancel and wake waiters; process-loss reconciliation; bounded prune.

**Semantics:** Atomic conditional claim; only lease owner can settle running row; Prior running/pending work constrains later work on same thread; Title-generation concurrency cap and restart continuation rules; Process-bound effects cancel after loss; only classified replay-safe effects requeue.

**Native plan:** ordered eligible queues plus per-thread predecessor state; do not replace with a generic FIFO or unguarded delete/pop.

**Pinned sources:** [EffectOutbox.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EffectOutbox.ts).

### Shell Stream Activity

**Storage:** orchestration_v2_projection_runs.

**Operations:** initial shell snapshot; older settled shell page; sequence-based subscriber updates; active-work detection.

**Semantics:** Publish committed projection sequence; Stock already has materialized counts and active/background indexes; Subscriber shell snapshots need consistent project/thread components.

**Native plan:** compact shell records and snapshot-stable reads; avoid rescanning or decoding unchanged payloads.

**Pinned sources:** [ShellStream.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ShellStream.ts), [KeepAwake.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/background/KeepAwake.ts).

### Global Message Search

**Storage:** orchestration_v2_message_search; orchestration_v2_projection_messages; orchestration_v2_projection_threads; orchestration_v2_projection_runs; projection_projects.

**Operations:** search normalized message text and titles; trigram candidate retrieval; short-word/non-ASCII fallback; eligible-thread filtering; snippet creation; index rebuild.

**Semantics:** Contentless-delete FTS5 trigram index is maintained transactionally by insert/update/delete triggers; Only settled eligible user/assistant messages; exclude placeholders/generated notices/subagent threads; Readable citation/link labels and apostrophe folding are part of matching contract; Candidate budget 10000, hit budget 2000, fallback scan budget 20000; newest rowid first; Rebuild after rowid-changing maintenance; clear/refill atomic.

**Native plan:** native transactional postings with identical normalization/filter/order/limits; retain SQLite search until behavioral parity if native tokenizer is incomplete.

**Pinned sources:** [ThreadSearch.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadSearch.ts), [messageSearchIndex.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/messageSearchIndex.ts).

### Projects

**Storage:** projection_projects.

**Operations:** get/list project shells; create/update metadata; archive/delete state; tracked folders and pin fields.

**Semantics:** Project state commits with project events; Stable creation/project-ID ordering.

**Native plan:** small typed project records and ordered shell index.

**Pinned sources:** [ProjectStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectStore.ts).

### Provider Runtime And Usage

**Storage:** provider_session_runtime; orchestration_v2_projection_provider_threads; orchestration_v2_projection_provider_turns; orchestration_v2_projection_run_attempts; orchestration_v2_projection_threads; orchestration_events.

**Operations:** session resume/runtime state; imported transcript source append/dedupe; native-session owner lookup; legacy short ID collision lookup; usage/model attribution.

**Semantics:** Imported source update preserves unrelated runtime fields and has explicit null semantics; Native owner excludes deleted threads and chooses latest updated match; Usage can depend on first running run.updated event matching attempt.

**Native plan:** provider-instance/native-session covering owner index; persist exact first-running model-selection fact; typed imported-source set plus preserved opaque runtime payload.

**Pinned sources:** [ProviderSessionRuntime.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/ProviderSessionRuntime.ts), [AcpRegistrySessions.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/AcpRegistrySessions.ts), [ProviderOrchestrationAdapterInfrastructure.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/ProviderOrchestrationAdapterInfrastructure.ts), [ProviderInstanceRegistryHydration.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/ProviderInstanceRegistryHydration.ts), [CodexUsageHistory.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/usage/CodexUsageHistory.ts).

### Authentication

**Storage:** auth_connect_devices; auth_pairing_links; auth_sessions.

**Operations:** trust/revoke device; create/consume/revoke pairing link; create/replace/revoke/extend session; active and pending lists; proof-key revocation.

**Semantics:** Pairing consume is single conditional update with expiry, revoked/consumed state, scope and trust/proof predicates; Replacing active session revokes and inserts atomically; Expired-but-currently-connected session listing semantics are intentional; Revocation decisions cannot rely on stale eventually consistent cache.

**Native plan:** small typed auth records and expiry/proof/subject indexes; preserve all atomic predicates and one-time consumption.

**Pinned sources:** [AuthConnectDevices.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/AuthConnectDevices.ts), [AuthPairingLinks.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/AuthPairingLinks.ts), [AuthSessions.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/AuthSessions.ts).

### Peer Links

**Storage:** peer_environment_links.

**Operations:** link/list/reachability state; monotonic expiry refresh; unlink and fence.

**Semantics:** DB holds secret reference, token lives in separate secret store; New token stored before DB upsert; failure compensation; old secret removed afterward; Unlink removes persisted reference then secret/network effects; Legacy unfenced links expire at linked_at.

**Native plan:** typed environment key and expiry index; retain secret-store and network compensation protocol.

**Pinned sources:** [PeerLinks.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/peer/PeerLinks.ts).

### Scheduled Tasks And Webhooks

**Storage:** scheduled_tasks; scheduled_task_webhook_deliveries; scheduled_task_webhook_pending; scheduled_task_webhook_replay_keys; scheduled_task_webhook_relay_deliveries.

**Operations:** task CRUD/enable/move/runNow; due scheduling; webhook token rotation; replay/relay dedupe; pending coalescence; dispatch/recovery; delivery diagnostics and retention.

**Semantics:** Compare generation/created_at to prevent same-ID recreate races; Settings writes preserve run-state columns and concurrent schedule/token changes; Dispatch rereads current task and cannot resurrect paused/deleted work; markRunning and pending transition atomic; Persisted per-task due_at,rowid order; independent tasks can progress; Distinguish pending/dispatching/running and unknown accepted-send recovery; Replay keys can be released only for classified failure-before-send.

**Native plan:** due/status/task/generation indexes in one transaction; explicit state-machine commands rather than generic KV overwrites.

**Pinned sources:** [ScheduledTaskService.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/scheduledTasks/ScheduledTaskService.ts), [webhookDedupe.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/scheduledTasks/webhookDedupe.ts).

### Issue Pr Relations

**Storage:** orchestration_v2_projection_threads; issue_tracker_bindings; pull_request_files_viewed; pull_request_review_guides.

**Operations:** find linked issue/PR threads; project tracker binding; set/unset/list viewed file revisions; cache review guide.

**Semantics:** Normalize issue tracker/host/project and PR host/repository identity as current code does; Exclude deleted/sidechat/dismissed links as applicable; Viewed-file compound key includes provider/host/repo/PR/viewer/path; batch updates atomic.

**Native plan:** normalized transactional issue-to-thread and PR-to-thread reverse indexes; small typed compound-key stores for review metadata.

**Pinned sources:** [linkedThreads.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/issue/linkedThreads.ts), [ThreadIssueService.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadIssueService.ts), [linkedThreads.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/pullRequest/linkedThreads.ts), [IssueTrackerBindings.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/IssueTrackerBindings.ts), [PullRequestFilesViewed.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/PullRequestFilesViewed.ts), [PullRequestReviewGuides.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/PullRequestReviewGuides.ts).

### Mcp Model Context

**Storage:** mcp_app_model_context; orchestration_v2_projection_turn_items; orchestration_v2_projection_runs.

**Operations:** upsert/delete per-item notes; ordered thread context lookup.

**Semantics:** Empty note deletes; Exclude local rolled-back run context but retain inherited copied context from other thread; Order updated date then item ID.

**Native plan:** typed thread/item key and visibility-aware ordered context index.

**Pinned sources:** [McpAppModelContext.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/mcpApps/McpAppModelContext.ts).

### Workspace Metadata

**Storage:** task_folders; orchestration_v2_projection_threads.

**Operations:** list referenced worktree paths; upsert/delete task root; real-root alias and longest-containing-root lookup.

**Semantics:** Path containment and realpath aliases must match current platform behavior; Known worktrees exclude deleted threads; Task-folder update intentionally preserves fields outside requested change.

**Native plan:** reverse path ownership index; root/real-root lookup with normalized ancestor candidates.

**Pinned sources:** [KnownWorkspaces.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/workspace/KnownWorkspaces.ts), [TaskFolderStore.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/workspace/TaskFolderStore.ts).

### Settings

**Storage:** projection_projects; projection_thread_sessions; provider_session_runtime.

**Operations:** atomic JSON settings read/write; legacy provider/project settings migration.

**Semantics:** Current settings live in atomic JSON files, not primary SQLite; Write semaphore, generation cache and secret rollback must survive refactor; SQL is legacy migration input.

**Native plan:** keep file compatibility boundary unless intentionally redesigned.

**Pinned sources:** [serverSettings.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serverSettings.ts).

### Migrations And Legacy

**Storage:** effect_sql_migrations; orchestration_v2_legacy_imports; projection_threads; projection_thread_messages; projection_thread_pull_requests; orchestration_events; orchestration_v2_projection_threads; orchestration_v2_turn_item_positions.

**Operations:** ordered migration history; preview version reconciliation; initial v1 snapshot copy; lazy transcript import; shell reconciliation.

**Semantics:** 107 registered numbered migrations; some helper source files expand them; Initialize with VACUUM INTO temporary copy, publish complete copy without overwriting winner; Lazy import requires legacy tables and per-thread serialization/import markers; Preview migration ID repair preserves import progress.

**Native plan:** explicit importer from existing SQLite including preserved lazy legacy data; versioned native schema and restart-safe import checkpoints.

**Pinned sources:** [Migrations.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Migrations.ts), [databaseMigrationHead.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/databaseMigrationHead.ts), [initializeV2Database.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/initializeV2Database.ts), [reconcileV2PreviewMigration.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/reconcileV2PreviewMigration.ts), [LegacyV1ThreadImporter.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts).

### Retention Reclaim Cleanup

**Storage:** orchestration_events; orchestration_command_receipts; orchestration_v2_projection_metadata; orchestration_v2_legacy_imports; orchestration_v2_projection_threads; orchestration_v2_projection_checkpoint_scopes; orchestration_v2_projection_provider_sessions; orchestration_v2_effect_outbox; scheduled_tasks; projection_projects.

**Operations:** bounded event pruning; pruned-through sequence; incremental reclaim; offline VACUUM/rebuild search; retained checkpoint/worktree analysis; legacy DB maintenance.

**Semantics:** Retain newest stream events, thread.created, prompt anchors, live usage facts; After pruning, projections are authoritative and old clients resnapshot; Cleanup protects scheduled/live/queued references and recursive fork checkpoint ancestry; Storage maintenance uses owner/exclusive coordination and must not invalidate FTS rowids.

**Native plan:** generation-safe native retention and compaction budgets; coherent live snapshot/export API; explicit filesystem ownership/reference indexes.

**Pinned sources:** [ProjectionMaintenance.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionMaintenance.ts), [DatabaseMaintenance.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/DatabaseMaintenance.ts), [DatabaseStorage.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/DatabaseStorage.ts), [storageCleanup.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/storageCleanup.ts).

### Ownership Backup And Launch

**Storage:** separate server-owner.sqlite SQLite lock file.

**Operations:** cross-process owner lock; lock inode replacement detection; online/offline upgrade backup; restore/restart coordination.

**Semantics:** Exclusive SQLite transaction lock releases on process death; never unlink lock file; Online backup pins WAL through read BEGIN, copies main, stops server, copies/syncs WAL, omits shm, publishes atomically; Preserve old good backup during restart/trial and account for disk headroom.

**Native plan:** equivalent OS crash-released owner lock; single Rust service owns Fjall; CLI routes through domain IPC; new engine-specific snapshot/restore protocol must be complete before replacing launcher path.

**Pinned sources:** [serverOwnership.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serverOwnership.ts), [serviceLauncher.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serviceLauncher.ts).

### External Provider Sqlite

**Storage:** external Codex threads; external Codex project_roots; external Antigravity gen_metadata; external Antigravity steps; external Antigravity trajectory_metadata_blob.

**Operations:** read external session metadata/transcripts; usage/child-work/ownership/terminal outcome extraction.

**Semantics:** These SQLite databases are provider-owned interoperability formats; Read-only, bounded queries and busy handling remain required after T3 primary-store replacement.

**Native plan:** retain narrow SQLite compatibility reader.

**Pinned sources:** [AgentSessionScanner.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/project/AgentSessionScanner.ts), [antigravityUsageReader.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/Drivers/antigravityUsageReader.ts), [AntigravityChildWork.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/acp/AntigravityChildWork.ts), [AntigravitySessionFiles.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/acp/AntigravitySessionFiles.ts), [AntigravityTurnOutcome.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/acp/AntigravityTurnOutcome.ts).

### Routing And Errors

**Storage:** No independent tables; service dependency/routing/error boundary..

**Operations:** provide SqlClient dependencies; route domain requests; translate database failures.

**Semantics:** These lexical candidates are not additional data stores.

**Native plan:** replace dependency boundary with domain client and preserve errors.

**Pinned sources:** [http.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/http.ts), [ws.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/ws.ts), [UserFacingErrors.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/UserFacingErrors.ts).
