> Historical storage research. The [full-system architecture](../../ARCHITECTURE.md), [implementation plan](../../IMPLEMENTATION.md) and [acceptance contract](../../ACCEPTANCE.md) control current implementation. Fjall and direct redb are experimental candidates behind authoritative omdb. Earlier single-engine language, narrower client scope and the proposed 2x storage benchmark target below are not the final whole-product choice or promotion rule. Use baseline-derived, preregistered per-journey and per-platform budgets from the current acceptance contract.

# Decision

Build a T3-specific Rust storage service backed by Fjall, with typed records, transactionally maintained history indexes, and an exact implementation of T3's bounded message search. Use one transactional database for authoritative state, events, command receipts, outbox entries, and secondary indexes. Keep direct redb and Rust-with-SQLite implementations as controls for the same operations.

This is the strongest pure Rust development plan supported by this research. It is not a measured T3 performance victory. The research does not establish that Fjall, redb, Turso, or any other Rust engine wins merely by replacing SQLite underneath the existing workload. The proposed advantage comes from removing work still present in upstream, while preserving its behavior.

Do not build a general SQLite adapter over redb. Do not use a second database as an independently committed search authority. Do not count weaker durability, missing features, a smaller result set, or an improvement over the existing native port as a win.

The baseline is unmodified upstream [pingdotgg/t3code at 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f](https://github.com/pingdotgg/t3code/tree/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f), inspected on November 22, 2026. Historical results below are attributed to their authors and their original comparisons. No new end-to-end performance experiment was executed for this report.

# What upstream already does

The current server is not a naive SQLite application. Its database setup uses WAL, synchronous NORMAL, a busy timeout, foreign keys, and a dedicated maintenance policy. The shared client has four reader workers, a writer worker, a separate checkpoint worker, and prepared-statement caching. Large bound values avoid long-lived cached statements. Read transactions stay on one connection. Sources: [database configuration](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Sqlite.ts), [worker client](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/shared/src/nodeSqliteClient.ts).

Provider snapshots already batch and coalesce. The batcher caps jobs and bytes, applies fairness and backpressure, isolates failed jobs, and releases notifications after commit. The relevant limits include 64 jobs and 1 MiB per batch. Native batching must preserve this advantage; it is not a new source of speedup. Source: [ProviderCommitBatch](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProviderCommitBatch.ts).

Upstream also has bounded history windows, materialized item counts, indexes for current work and recent messages, a trigram FTS5 index, and specialized command reads. The current ordinary window path no longer decodes every old run. Earlier PRs reporting that cost describe earlier code. Source: [current performance contract](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/performance-regressions.md).

# Entire persistence scope

The product contains multiple independent persistence owners. Replacing the native server database does not make provider files, browser storage, mobile offline state, or hosted service databases disappear.

| Owner or workload | Existing storage and behavior | Rust plan |
|---|---|---|
| Current server orchestration | statev2.sqlite: projections, events, command receipts, durable effects | Replace together in one Fjall transaction domain |
| Legacy orchestration | state.sqlite and import/reconciliation paths | Preserve SQLite import compatibility and completed migration markers |
| Projects, threads, runs, attempts, nodes | Point lookups, ordered relations, current work, projections | Typed records with covering relation indexes |
| Messages, plans, turn items, positions | Mutable state, ordered history, visibility and fork inheritance | Separate compact headers from payloads; explicit sequence indexes |
| Command deduplication and effect delivery | Receipts and outbox claims/status/retries | Atomic with accepted state; retain retry and unknown-outcome behavior |
| Authentication and pairing | Sessions, pairing links, connected devices, expiration/revocation | Typed indexed records, same transaction and secret handling boundaries |
| Scheduled tasks and webhook deduplication | Due work, scheduling state, replay/duplicate protection | Due-time and idempotency indexes; preserve scheduler semantics |
| Peers and workspace metadata | Peer links, known workspaces, task-folder state | Preserve identity, ownership and cleanup behavior |
| Pull requests and issues | Bindings, review guides, viewed files, linked-thread relations | Typed records and normalized reverse indexes |
| MCP application context | Provider/thread model-context notes with rollback and inheritance visibility | Preserve context ownership and visibility in typed records |
| Usage and provider runtime state | Provider sessions, usage history and event correlations | Current facts and indexed history; preserve reconciliation |
| Server settings | Atomic JSON files, separate from main DB | Keep the file contract unless a separate migration is justified |
| Server and launcher ownership | Separate SQLite lock databases and ownership probes | Coordinated OS-lock replacement with upgrade compatibility |
| Updates, rollback and doctor | SQLite/WAL backups, restore markers, maintenance and recovery | Native coherent generations, explicit restore protocol, full userdata coverage |
| Mobile | Expo SQLite caches/preferences, SecureStore, per-message persisted outbox files | Preserve offline behavior; native server migration does not migrate these |
| Browser | IndexedDB caches/catalog/history and CryptoKeys; localStorage settings | Preserve browser storage and credential constraints |
| Desktop | OS-encrypted catalog in atomic JSON; launcher/ownership coordination | Preserve encryption and coordinate owner protocol migration |
| Relay | PostgreSQL through Effect/Drizzle and Cloudflare Hyperdrive | Remains a hosted relational service |
| Offline webhook delivery | Cloudflare Durable Object SQLite | Remains a separate durable owner |
| Task cache | D1 metadata/receipts/counters and R2 artifacts | Preserve metadata/object-store coordination |
| Provider and external files | Codex, Antigravity, OpenCode, Cursor SDK stores, browser-cookie databases | Retain each integration's actual read/write/locking contract |
| SQLite file preview | sql.js/WASM in a browser worker, bounded read-only file inspection | Preserve SQLite file-format viewing |

The server inventory and non-server owner map accompanying this report contain the concrete paths and coverage limits. In particular, Cursor's SDK creates and writes its own local agent stores. It would be incorrect to label every provider SQLite dependency read-only.

Primary owner references: [mobile database](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/persistence/mobile-database.ts), [mobile outbox](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/state/thread-outbox-storage.ts), [browser storage](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/connection/storage.ts), [browser proof keys](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/cloud/dpop.ts), [desktop catalog](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/desktop/src/app/DesktopConnectionCatalogStore.ts), [relay database](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/infra/relay/src/db.ts), [webhook store](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/infra/relay/src/hooks/HookInboxStore.ts), [task cache](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/infra/task-cache/src/resources.ts), [Cursor SDK](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-cursor/src/server/CursorAgentSdk.ts), [SQLite file preview](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/files/binaryPreview.worker.ts).

Less frequent operations still carry essential semantics. Pairing links are consumed conditionally and only once; replacing sessions revokes and inserts atomically. Scheduled tasks use generation checks and preserve pending deliveries across edits. Peer records reference secrets in a separate store with compensation around failures. Viewed-file state has viewer/path identity. Workspace aliases and longest-containing-root lookup affect cleanup. These belong in the native port even when they contribute little to median database time. Sources: [AuthPairingLinks](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/AuthPairingLinks.ts), [ScheduledTaskService](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/scheduledTasks/ScheduledTaskService.ts), [PeerLinks](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/peer/PeerLinks.ts), [MCP context](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/mcpApps/McpAppModelContext.ts).

# Atomicity and durability that cannot be traded away

The native commit boundary must contain the domain events, authoritative projections, command receipt, durable effect intents, and every index needed to read that committed state. Publish notifications and start external effects only after that boundary succeeds. A lost response must be resolvable by the command receipt. Sources: [EventSink](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EventSink.ts), [EffectOutbox](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EffectOutbox.ts).

Persisted projections are authoritative. Event retention is finite and deliberately retains particular anchors. Rebuilding current state from only the retained event log is not a valid recovery strategy. Receipts must continue to deduplicate commands whose original events have been pruned. Sources: [ProjectionMaintenance](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionMaintenance.ts), [DatabaseMaintenance](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/DatabaseMaintenance.ts), [internal overview](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/overview.md).

There must be two separately named benchmark profiles. The stock profile matches SQLite WAL/NORMAL's failure contract, including acknowledged application-crash survival and possible loss of recent commits after OS/power failure. Fjall must flush its journal to the operating system before acknowledgement in that profile and qualify equivalent recovery behavior. A stronger profile compares SQLite FULL with a verified native sync barrier. It is not legitimate to compare SQLite NORMAL with redb Immediate and call the resulting difference pure engine overhead, or to leave native acknowledged writes only in userspace memory. Sources: [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous), [Fjall PersistMode](https://docs.rs/fjall/3.1.13/fjall/enum.PersistMode.html), [redb Durability](https://docs.rs/redb/latest/redb/enum.Durability.html).

Buffer-before-ack alone is incomplete. The native owner must also schedule journal synchronization by dirty-byte growth and idle time, impose a sustained-write backstop, track the durable sequence, and synchronize at shutdown and backup boundaries. Derive the starting budgets from the observed stock checkpoint policy and report the actual native policy alongside results. A sync failure must not allow unbounded continued acknowledgement. Qualify platform behavior: on macOS, a method called SyncAll does not by itself prove equivalence to the device-flush behavior requested by checkpoint_fullfsync or a strict durability contract.

# Current upstream costs worth removing

These targets were checked against the pinned source, not inferred from old PR descriptions.

| Current path | Work still performed | Proposed native replacement |
|---|---|---|
| Full timeline fallback | Reads all item metadata and run/attempt context, recursively assembles inherited history, caches by event sequence | Persisted sequence structure with visibility aggregates and source references |
| Timeline positions | Prefix COUNT and some total counts traverse index entries; hidden candidates require additional work | Rank/select and subtree counts maintained during mutation |
| In-thread find | Full timeline dependency; cold or invalidated searches load searchable payloads and count rendered segments | Stable item identities, incremental rendered-segment cache and exact candidate index |
| Global message search | FTS candidates joined to records and filtered using JSON fields, followed by application ranking | Atomic postings and compact eligibility records, preserving candidate order and custom scoring |
| Issue/PR linked threads | JSON-array expansion and normalization over thread records | Transaction-maintained reverse relation indexes |
| Usage/history-derived facts | Some facts recovered through event/payload correlation | Explicit persisted facts with matching correction/replay semantics |

Sources: [ProjectionStore](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts), [ThreadFind](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadFind.ts), [ThreadSearch](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadSearch.ts), [issue relations](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/issue/linkedThreads.ts), [pull-request relations](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/pullRequest/linkedThreads.ts), [CodexUsageHistory](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/usage/CodexUsageHistory.ts).

The common principle is to maintain the small answer a query needs when its inputs change. This spends additional write work and space. That trade is part of the design and must be measured under streaming writes, rollbacks, imports, large forks, and maintenance.

# What successful implementations actually establish

## Optimizations already in T3

| Source | Author-reported result | What transfers to this plan |
|---|---|---|
| [PR 27097](https://github.com/pingdotgg/t3code/pull/27097), reader pool | Contended test total 1.4 s to 0.6 s; point-read median stayed 0.2 ms | Queueing matters; concurrency throughput is different from individual lookup latency |
| [PR 34014](https://github.com/pingdotgg/t3code/pull/34014), inline-output flag | Heavy projection median 62 ms to 24 ms; open plus older page 127 ms to 50 ms | Deriving query facts once can remove repeated JSON work |
| [PR 39391](https://github.com/pingdotgg/t3code/pull/39391), thread item totals | 30,000-run shell case 8.9341 ms to 0.6704 ms; SQL VM steps became constant | Changing work complexity can produce much larger gains than swapping equivalent trees |
| [PR 34573](https://github.com/pingdotgg/t3code/pull/34573), page windows | On its long-thread experiment, cold bytes fell from hundreds of MB to tens of MB | Bound the data touched, and verify identical pages across hidden rows, forks and bad cursors |
| [PR 38544](https://github.com/pingdotgg/t3code/pull/38544), fair batching | Uncontended synthetic delayed-worker workload 24.9 s to 10.3 s; contended total slightly worsened while unrelated-write waits improved | Throughput, fairness and tail latency are separate objectives; its simulated delays are not disk measurements |

These are historical upstream comparisons. They are already part of the baseline. Their multipliers must not be added together or presented as expected native speedups.

## Rust engines and real applications

Turso 0.8 reports approximately 9,500 versus 1,370 transactions/s at 64 writer connections, and 2.4 ms versus 1.2 s p99.9 in a separate 32-connection latency experiment. Both use FULL durability. The supplied workloads exploit concurrent independent transactions and group commit; SQLite is faster in the single-connection throughput case. This is evidence that a Rust engine can beat SQLite in a specified workload. It does not predict a win over T3's already batched single writer. Source: [Turso 0.8 and benchmark links](https://turso.tech/blog/turso-0.8.0).

Fjall 3 changes its block representation so reads need not deserialize an entire block. The author reports large improvements over Fjall 2 for uncached block reads and provides comparison workloads. That supports compact indexed blocks and selective decoding as mechanisms. It is not a T3 application comparison. Source: [Fjall 3 architecture and measurements](https://fjall-rs.github.io/post/fjall-3/).

ZeroDB is a more directly relevant pure Rust replacement experiment: its authors report running Meilisearch on their LMDB-compatible implementation. The November 12 results show movies indexing at 0.98 times LMDB time and search at 1.00, selected point/range operations faster, and some tiny transactions/deletes slower. The report explicitly limits the evidence to particular machines and workloads. This is promising replacement parity, not proof of a whole-application speedup. Source: [ZeroDB performance report](https://github.com/qdequele/ZeroDB/blob/main/docs/PERFORMANCE.md).

Sophia's authored comparison is useful because it tests several stores behind one application interface. Its later synthetic 100,000-definition run reports redb ID lookup at 1.3 microseconds versus SQLite's 4.9, and closure traversal at 9.2 ms versus 26.9 ms. But SQL wins several set-oriented queries, and real edit latency remained unmeasured. It supports direct native access as a viable competitor while showing why a hand-written query layer can lose. Source: [Sophia database comparison](https://mathstruct.org/Sophia/vault/Research/Database-Comparison).

Meilisearch's production vector-store change reports throughput rising from roughly 6 to 20 embeddings/s. It removed global scans and fetched only required pages while preserving transaction visibility. This is useful evidence for workload-specific Rust integration, but the engine is patched C LMDB and the workload is vector indexing on network storage. Source: [Meilisearch engineering report](https://meilisearch.dev/blog/3xfaster-vector-store).

The research also checked attractive but unsuitable comparisons. redb's bundled SQLite adapter creates an ordinary rowid table with a separate BLOB primary-key index and does not reproduce T3's WAL setup. The sqlite-tantivy headline comparison uses different document counts and tokenization, does not implement T3's ranking or eligibility, and computes reported throughput from summed per-query thread latency. Neither proves a T3 win. Sources: [redb benchmark implementation](https://github.com/cberner/redb/blob/2fc790d14fb62f39137b13f7943df433bec082c2/crates/redb-bench-compare/benches/common/mod.rs), [audited sqlite-tantivy benchmark](https://github.com/russellromney/sqlite-tantivy/blob/ee1692c65ef9ed1ae29dbbe15660ab73fb75922e/bin/tantivy-bench.rs), [its corpus generator](https://github.com/russellromney/sqlite-tantivy/blob/ee1692c65ef9ed1ae29dbbe15660ab73fb75922e/benchmarks/db_manager.py).

# Engine decision

| Candidate | Decision | Reason and remaining qualification |
|---|---|---|
| Fjall 3.1.13 | Primary pure Rust candidate | Ordered keyspaces, snapshots, atomic cross-keyspace writes and optional value separation fit the proposed store; compaction and single-owner requirements must be included |
| Direct redb | Required alternative control | A compact B+tree may win warm point/range reads; compare the same native records and operations, not the existing port |
| Rust plus rusqlite | Required control | Retains mature SQLite/FTS5 and isolates runtime/query-design gains; selecting it as the final engine would retain C |
| Turso | Not a drop-in selection for this workload | Its current Tantivy-backed FTS schema/API differ from T3's contentless FTS5 contract; compatibility work remains |
| ZeroDB | Secondary read-oriented candidate | Published consumer compatibility and selected read wins are interesting; broader operational qualification remains |
| heed/LMDB or MDBX | Useful performance comparators if C dependencies are acceptable | Rust APIs do not make the underlying engine Rust |
| sled, Persy, other general stores | No evidence-backed preference over the finalists | They would still require the same T3 query, search, lifecycle and compatibility work |
| SQLite over redb/Fjall VFS | Reject as starting architecture | Keeps SQL VM and pager work while adding another storage layer |
| General SQL compatibility over a KV store | Reject as starting architecture | Reimplements a query engine when T3 needs a finite set of domain operations |

Sources: [Fjall transactional API](https://docs.rs/fjall/3.1.13/fjall/struct.SingleWriterTxDatabase.html), [Fjall scope and process restrictions](https://github.com/fjall-rs/fjall), [redb design](https://github.com/cberner/redb/blob/master/docs/design.md), [Turso FTS interface](https://github.com/tursodatabase/turso/blob/main/docs/fts.md), [Turso implementation](https://github.com/tursodatabase/turso/tree/main/core/index_method/fts), [SQLite VFS layer](https://www.sqlite.org/vfs.html).

The Turso documentation was checked against implementation because some limitations in its FTS document are stale. Current source has automatic segment merging and configurable ngram sizes. Those are not valid reasons to reject it. The actual unresolved issue is reproducing T3's FTS5 behavior and surrounding SQL/maintenance contracts.

Inspected engine revisions: [Fjall 87006048139bfe1b072bbc29a5a92bf1f97628e3](https://github.com/fjall-rs/fjall/tree/87006048139bfe1b072bbc29a5a92bf1f97628e3), [redb 2fc790d14fb62f39137b13f7943df433bec082c2](https://github.com/cberner/redb/tree/2fc790d14fb62f39137b13f7943df433bec082c2), [Turso 4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9](https://github.com/tursodatabase/turso/tree/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9). The ZeroDB documentation pin is a3d0c3442aa738cd547b9b49e5b21230bd3765b8; its quoted November 12 measured revision is d70dbe9. Documentation head and measured revision are distinct.

# Native storage architecture

## Public boundary

Expose complete operations such as commitCommand, applyProviderBatch, readShell, readHistoryPage, findInThread, searchThreads, claimEffects, and readUsage. Execute each operation within Rust against a consistent snapshot. Avoid one cross-runtime request per SQL statement or per field.

The interface should express T3 semantics. It should not expose arbitrary SQL, an untyped array of cells, or a general ORM. A narrow internal ordered-store abstraction can support the Fjall, redb and SQLite controls without forcing identical physical implementations.

## One authority and bounded readers

Use Fjall's SingleWriterTxDatabase initially. T3 already has a serialized commit discipline and global ordering requirements, so speculative multi-writer transactions add complexity before proving useful. Concurrent read snapshots operate outside the writer queue. Every cache key includes the relevant committed generation; caches never become the only copy of a projection.

Use a small fixed collection of keyspaces grouped by access pattern, not one keyspace per thread. Bound shared cache, write-buffer and worker resources. Compact metadata and large payloads need different tuning. Enable value separation selectively for large immutable or slowly changing payloads after measuring its extra read and garbage-collection costs.

| Logical record/index | Example ordered key | Purpose |
|---|---|---|
| Entity headers | kind, entity ID | Read status, ownership and links without decoding a full payload |
| Payloads | payload ID or entity/version | Preserve full data and unknown fields required by compatibility |
| Thread items | thread, ordinal, item ID | Stable order, including ordinal ties |
| Run relations | thread, status/order, run ID | Current work, recovery and command-specific reads |
| Timeline nodes | thread/view root, node ID | Counts, rank/select, visibility and byte budgets |
| Fork references | child, source, cutoff metadata | Shared payloads and correct inherited visibility |
| Search documents | stable insertion ID | Search text, metadata and verification state |
| Search postings | gram, document-ID block | Bounded descending candidate iteration |
| Reverse links | normalized issue/PR identity, thread ID | Direct linked-thread queries |
| Events | global sequence; thread/sequence index | Resume and retention |
| Receipts | command ID | Idempotency and ambiguous-commit resolution |
| Outbox | status/due time/effect ID | Claiming, retry and completion |

Keys need an explicitly versioned byte order matching the source's sort semantics. Rust UTF-8 ordering, JavaScript UTF-16 offsets, SQLite binary comparisons, null ordering, timestamps and floating-point values must not be conflated.

## Failed jobs inside a successful batch

Fjall does not provide SQLite savepoints. Implement nested staged mutation sets in the storage service. Each job reads the committed snapshot plus earlier successful jobs plus its own overlay. On failure discard that job's records, index edits, cache changes and pending publications. On success merge its overlay into the parent. Commit the parent once, and only then acknowledge successful jobs.

Any failed final persistence barrier leaves the whole batch unacknowledged. Receipt lookup after recovery determines whether an outcome is already committed. Do not retry external effects merely because the client lost an acknowledgement.

This is a correctness requirement, not an optional optimization. The overlay implementation must support read-your-writes, ordered range reads, sequence allocation, deletes and replacement of a key written by an earlier job. Bound generated postings and staged state separately: a 1 MiB input batch can expand into much more index work. Apply backpressure and subdivide preparation without rejecting inputs that upstream accepts or splitting one atomic command.

# History indexes that can beat the current source

An ordered key-value database does not automatically provide the rank of an item. Replacing SELECT COUNT with a KV prefix scan would preserve the same scaling problem.

Build a counted sequence tree over compact timeline metadata. Store subtree counts for required visibility modes and summary information needed for user-turn and work-group boundaries. The tree is a secondary index over authoritative entities, with its updates in the same transaction. Page reads seek to a cursor, obtain its rank from subtree totals, and load only the selected bodies.

Preserve the source tuple order of ordinal and item ID. Handle inserted historical rows, changed attempts, cancelled queued input, stop markers, work folding, synthetic fork markers, compactions, and imported data. Byte bounds are checked before loading payloads; exceptions that the source requires remain exceptions.

Forks require source-reference spans and explicit ancestry rules. A frozen copy of the parent's current visible list is insufficient: rollback timing relative to fork creation, source-run cutoffs and later changes to inherited records affect behavior. Share immutable tree portions where their semantics match, maintain child overlays where they differ, and measure propagation through descendant forks.

In particular, a rollback before fork creation differs from one after it; runless legacy-import items have special inheritance rules; side chats show only local history. Keep these dimensions separate from the parent's current visible-bit index. Materialized descendant views can amplify writes with fork fan-out, which belongs in the cost model.

The read target is logarithmic index work plus the page and relevant ancestry spans. That bound applies only when all required aggregates are valid. A mutation can affect many rows or descendants; its cost must be charged to writes or to an explicitly measured repair. Never hide an unbounded rebuild behind an average read latency.

In-thread find is a separate problem from global palette search. Persist or cache canonical searchable segments by content and renderer context. Context includes the working directory, skills, theme and renderer version where those influence the source result. Reuse unaffected documents across thread changes, and index exact candidate segments where possible. Preserve occurrence counts, offsets, folded answers and empty-reply fallback rules. A new rendering context can still require initial rendering work; report that miss separately.

# Exact search without a second database

The proposed search index lives inside the same Fjall transaction as messages. Store stable document IDs, searchable text, compact eligibility facts and trigram postings. Update only affected posting blocks and remove obsolete postings atomically. Index completion and text-change rules must match upstream.

T3's search is not generic BM25 search. Its source uses FTS to produce candidates, then applies custom matching and ranking. Preserve the following independently:

1. The newest 10,000 exact FTS candidates establish the indexed candidate boundary before later filtering.
2. The query keeps at most 2,000 eligible hits, ordered by the index's insertion identity.
3. Two-character CJK and index-unavailable paths have a bounded newest-message scan.
4. Project scope, excluded threads, deleted/archived state, side chats, subagents, stopped/rolled-back runs, placeholders and folded answers affect eligibility.
5. Final quality, user-message preference, timestamps, hit counts, thread opens and query picks affect ranking.
6. Apostrophes, accents, word starts, snippets and offsets use the source's actual Unicode rules.

Sources: [search implementation](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadSearch.ts), [index maintenance](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/messageSearchIndex.ts), [shared matching and ranking](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/shared/src/paletteSearch.ts).

An intersection of grams can contain false positives. Those cannot consume the 10,000-candidate boundary. Use positions or exact phrase verification before that boundary is counted. Likewise, a more generous Unicode fold could change which old result displaces another at the limit. Port the required behavior and verify it against SQLite plus the source matcher.

A Tantivy sidecar would require a second visibility protocol, a durable change queue and an exact delta overlay to avoid missing just-committed messages. The selected design avoids that coordination by keeping postings atomic. It still has substantial implementation cost. Frequent message corrections, common terms, large documents and deletion storms belong in the performance suite.

# Cost model and theoretical advantage

Let N be the number of timeline entries, R the related run metadata, K the page size, P the index prefix counted, B the required result bytes, and F the relevant fork spans. A full materialization path has work proportional to N + R before returning K entries. A covering prefix count still visits approximately P qualifying index entries.

The proposed counted index aims for local logical traversal proportional to log N + K, plus the unavoidable output cost B. Forks also require span resolution: a conservative per-ancestor design pays D log N for depth D, plus relevant span traversal and any repairs. A tighter log N + K + F bound needs a proved indexed span representation. Visibility and group changes can cost the number of affected members, and parent updates can affect many descendants. An LSM adds its own level, cache and merge costs; this is a bound on application work, not a claim that Fjall turns every physical read into one I/O.

For already well-indexed point reads and ordinary pages, both engines may have comparable asymptotic work. The proposed gains there are fewer allocations, smaller hot records, fewer runtime crossings, selective decoding and less JSON extraction. Their size has to be measured.

The read/write trade can be written as:

```math
r(C_{old}-C_{new}) > w\,\Delta C_{write} + C_{maintenance}
```

Here r and w are operation rates. Extra indexes are worthwhile only when saved read work exceeds their write and maintenance burden under the actual mix. The same reasoning explains why a write-optimized LSM is not automatically better for a warm read-heavy UI.

For end-to-end latency, if storage accounts for fraction f and is accelerated by factor s, total speedup is:

```math
S = \frac{1}{(1-f)+f/s}
```

If storage is half the request, even a fourfold storage improvement gives only 1.6 times overall speed. This is illustrative arithmetic, not a measurement of T3.

Separating large values can reduce compaction traffic, but adds indirection and garbage collection. The WiscKey research provides evidence for the mechanism, not a T3 multiplier. The RUM paper describes the read/update/space trade as a conjecture, not a universal proof that one design is optimal. Sources: [WiscKey](https://www.usenix.org/conference/fast16/technical-sessions/presentation/lu), [RUM](https://stratos.seas.harvard.edu/publications/designing-access-methods-rum-conjecture).

# Ownership, migration and recovery

Fjall is a single-process database. Route CLI operations through the active native owner. When no owner exists, acquire an OS-backed lease and start an owner that preserves standalone CLI behavior. A database directory must never be opened independently by two native owners.

Changing the owner lock requires a transition across the server, desktop, SSH launchers, doctor and updater. Existing launchers probe SQLite lock behavior. Either retain the legacy compatibility lock during transition or upgrade all cooperating components together. A new lock that old launchers cannot observe is unsafe.

Migration reads a coherent upstream snapshot and imports current projections, receipts, pending effects, retained events, all auxiliary tables and stable ordering identifiers. Preserve still-unimported V1 tables inside the copied statev2 database as well as the original legacy file and import markers: lazy per-thread import may be incomplete. It cannot rely on event replay alone. Build and verify new indexes, produce row/domain counts and output-equivalence results, and switch an atomic generation manifest only after the native snapshot is complete.

Keep the original SQLite data recoverable. Rollback after native-only writes needs either a tested reverse migration or a clearly enforced pre-write rollback boundary. Merely keeping an old SQLite file does not preserve new work.

The updater's backup and restore protocol also has to migrate. Upstream stages database/WAL copies, syncs files and directories, pins a snapshot during online preparation, stops the owner at the required boundary, and uses a restore-pending marker to survive interrupted restoration. The native equivalent needs coherent manifests/checkpoints, crash-safe generation switches and the same trial/commit/rollback semantics. Source: [serviceLauncher](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/serviceLauncher.ts).

Do not assume an efficient physical checkpoint API exists in the inspected Fjall version. The correctness-first implementation can export a consistent snapshot while the writer is stopped, with its outage explicitly measured. To preserve online preparation, capture all record mutations from the snapshot sequence until final quiescence, apply that bounded tail to the staged export, verify its final sequence, then publish. The already-pruned domain event log is not a substitute for that complete mutation capture. Copying a live directory during compaction is invalid.

Upstream's automated update backup covers the database/WAL; its user recovery guidance covers stopped-server userdata. Preserve that distinction. Product recovery must account for settings, attachments and credentials as well as database references. Client drafts and outboxes are persisted user work, even when adjacent tables are disposable caches; this source review did not prove their power-loss durability on every platform. Source: [user recovery guidance](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/thread-migration.md).

# Implementation sequence

| Stage | Concrete deliverable | Exit condition |
|---|---|---|
| 1. Freeze the oracle | Pinned upstream executable, dependency lock, SQLite configuration, deterministic public fixtures and recorded API traces | Expected results and failure outcomes can be reproduced independently |
| 2. Compare fresh stores | Domain-operation harness with direct Fjall, direct redb and rusqlite controls | Matched durability and equivalent records/results; no existing-port baseline |
| 3. Prove the main read advantages | Counted timeline index, fork references, reverse relations and incremental find | Exact outputs for ordinary, inherited, hidden and invalid-cursor cases; measured wins after writes and cold starts |
| 4. Prove search | Transactional postings and exact source matcher/ranker | Identical ordered hits/snippets/limits for multilingual and adversarial cases; wins including index-update cost |
| 5. Complete the write boundary | Staged savepoints, receipts, outbox, bounded batching and recovery | Failed jobs, lost acknowledgements and crashes cannot expose partial state |
| 6. Complete the lifecycle | All auxiliary domains, import, owner coordination, updater backup/restore and doctor | Whole-product parity, including legacy data and separate provider/client stores |
| 7. Qualify release | End-to-end journeys and long-running maintenance on target platforms | Performance and correctness gates pass against pinned upstream |

Stages 3 and 4 are the early decision point. If the architecture cannot beat current upstream on its intended read paths without unacceptable write costs, do not complete a large migration on faith. Keep the useful workload indexes and choose the engine that wins the fresh comparison.

# Acceptance plan against upstream

Use two levels of measurement. The end-to-end comparison is stock T3 versus the complete native operation through the same public boundary. The controlled comparison runs the new operation layout on Fjall, redb and SQLite to identify which engine contributes to the result. Neither substitutes for the other.

Every engine must include query construction, record decoding, result construction, equivalent transaction scope and the configured durability barrier. The stock baseline keeps its reader pool, batching, indexes and caches enabled.

| Workload family | Required cases |
|---|---|
| Shell/sidebar | Cold snapshot, active streaming, older settled threads, incremental resume, many archived threads and forks |
| History | Latest/older pages, messages/activity modes, work inline/deferred, folded groups, byte limits and missing/stale cursors |
| Forks and navigation | Nested ancestry, deleted sources, rollback before/after fork, late source changes, search jumps and attachment lookup |
| Search | Global palette, agent scoped search, in-thread find, exact occurrence counts, accents/apostrophes/CJK/emoji, common/rare terms and visibility filters |
| Writes | Prompt dispatch, provider snapshot bursts, corrections, completion, cancellation, steering, compaction, queue state, visits and settings |
| Effects and replay | Duplicate commands, pending/claimed/retried effects, crash between commit and acknowledgement, resume with retention gaps |
| Auxiliary state | Auth expiry/revocation, scheduled tasks, webhook dedupe, peers, workspaces, issue/PR links and usage reconciliation |
| Lifecycle | First open, migration, import, backup under activity, trial update, rollback, interrupted restore, doctor and cleanup |
| Platform integration | Desktop/CLI/SSH ownership, Windows and macOS/Linux behavior, provider SDK stores, mobile/browser offline semantics |
| Sustained operation | Compaction/checkpoints, large deletions, index rebuild, cache pressure, database larger than RAM and disk growth |

Measure warm steady state, a warm process after an invalidating write, cold process start, and explicitly controlled cold OS cache separately. Test skewed distributions and both small normal workspaces and long-history stress cases. Preserve real ordering, nulls, failures, cursor formats, and time-dependent ranking by freezing the comparison clock where appropriate.

Report p50, p95 and p99, request throughput, writer queue wait, commit time, CPU, allocations, resident memory, bytes read/written, database size, maintenance debt and recovery time. Use paired randomized runs and confidence intervals. Do not pool platforms, hide a losing critical path in an average, or stop before background work catches up.

Proposed decision targets, not measured results:

- Every replaced critical interactive journey must beat upstream at p50 and p95 with a convincing confidence interval; no material p99 or fairness regression.
- Target at least a twofold geometric-mean improvement across the explicitly named interactive suite, with individual ratios still reported.
- Search, history and sidebar must be judged separately. A spectacular fork-history win cannot excuse slower ordinary search.
- Writes, recovery and maintenance must satisfy their own latency/resource budgets and identical failure contracts.
- If Fjall loses to fresh redb under the same operation layout, choose redb. If SQLite remains fastest, retain the existing shipping baseline while deciding whether further pure Rust development is worth the cost; do not label a slower rewrite a success.

# Evidence and coverage limits

The server scan enumerated 744 production JS/TS source files after test/fixture exclusions and found 172 SQL-related candidates: 118 migration sources and 54 runtime candidates. All 54 runtime candidates were captured at immutable blob IDs. These are discovery counts, not counts of tables or independent database clients. Some candidates concern external data or mention SQL without owning a live connection.

Of the 54 runtime candidates, 43 received selected semantic review, five were classified as external SQLite interoperability readers, and six as dependency/routing/error sources. The 118 migration sources include helper modules around 107 registered numbered migrations; their 314 lexical DDL occurrences are not a final executed schema. A further 113 non-SQL persistence importers were enumerated without tracing every caller.

The semantic review covered the principal storage owners, transaction and read paths, schema evolution, search, maintenance, auxiliary repositories, ownership and update lifecycle. The non-server pass captured 78 sources: 28 read in full, 34 reviewed in selected sections, and 16 used only for navigation. It covers mobile, browser, desktop, relay, Cloudflare services, provider integrations and file viewers. Mechanical inventories are supplied so later implementation can track every method and migration. This research is not a formal proof of every SQL statement and does not substitute for runtime qualification.

The recommendation is specific: implement the native operation and index design on Fjall first, compare it directly with fresh redb and SQLite controls, and require a win over the pinned upstream application. Current evidence supports that development decision. Only the resulting complete measurements can establish the final engine winner.
