# Rust storage design for upstream T3 Code

Research checkpoint: November 22, 2026. Comparison target is stock upstream T3 Code at `28706ace`, not the existing t3code-ls database implementation. This report records inspected source, authored experiments and design inference. No candidate was implemented or benchmarked here.

## Decision

Build a native typed T3 storage service. Use transactional Fjall as its first engine candidate. Keep base records, events, projection updates, receipts, outbox state, ordered covering indexes, search metadata and trigram postings in one database with atomic cross-keyspace transactions. Execute complete domain operations in Rust, rather than translating SQL statements into generic key-value requests.

The proposed advantage is less work per operation: direct typed access to required fields, compact ordered indexes, less JSON decoding, fewer representation conversions and no SQL virtual-machine execution for fixed queries. LSM storage is a candidate for that design, not proof that it is faster. Existing upstream already has a reader pool, provider group commit, materialized counters and optimized snapshot reads. Preserve those features. Do not count them as new gains.

Fjall fits frequent event/projection/outbox updates and growing histories. Its atomic keyspaces, snapshots, value separation and maintained Rust implementation make it the strongest first candidate. redb is the appropriate B-tree comparator under the SAME native layout: hot reads and ranges may favor it. Do not split production across both merely to avoid deciding. Cross-store atomicity and recovery would add work without an established benefit.

Turso is a serious Rust SQL engine with measured wins for concurrent durable writes. Its current FTS implementation does not directly implement T3's FTS5 schema and behavior. Its published gains do not establish faster T3 single-writer batches or small indexed reads. Keep it a secondary candidate if general SQL is itself a product requirement.

## Required upstream behavior

The root and upstream-workload agents inspected these requirements at `28706ace`:

* Event, authoritative projection, receipt and outbox changes can be atomic, with publication after commit.
* ProviderCommitBatch already groups up to 64 jobs or 1 MiB. Each job has nested savepoint semantics. Failed jobs rewind deferred publications, event counts and projection-cache mutations; successful siblings survive.
* Stock SQLite uses WAL, `synchronous=NORMAL`, and `checkpoint_fullfsync=ON`. Its power-loss contract permits rollback since the last relevant checkpoint.
* CLI and server can write the same file from separate processes.
* Search is contentless-delete FTS5, trigram tokenizer, `remove_diacritics=1`, completed messages only. It takes newest 10,000 FTS matches before eligibility filters, then newest 2,000 eligible hits, then T3's palette ranking, usually returning 50. It avoids BM25. Two-character CJK uses a newest-20,000-row fallback. Apostrophe/Unicode/hidden-subagent/project semantics matter.
* JSON payloads coexist with scalar indexes and JSON expressions. Native storage may eliminate SQL internally but must preserve domain results and retained payloads.
* The separate server-owner SQLite file contains no application data; its exclusive transaction supplies a crash-released cross-process ownership lock. Replace that contract explicitly if removing that file.
* Upstream launcher backup pins a read transaction, copies the main database, stops the server, then copies and syncs WAL before atomic publication. It also supports offline fallback and backup reuse during rollback. A Fjall folder copy while compaction runs is not equivalent.
* Settings remain atomic JSON files, and peer rows reference tokens in a separate secret store with compensation. Native DB replacement must preserve those boundaries. External Codex/Antigravity provider databases remain SQLite interoperability requirements, even after T3's own state changes engines.

The full inventory and upstream citations belong in the root report. Engine selection follows that inventory.

## Engine comparison

| Engine | Useful mechanism | Main cost or gap | Selection |
|---|---|---|---|
| Fjall | Ordered LSM keyspaces, atomic batches, snapshot reads, serializable single-writer or optimistic transactions, selectable persistence, optional value separation | One process per database; no inspected nested-savepoint API; custom domain indexes/search/backup; compaction overhead | First native engine candidate |
| redb | Typed copy-on-write B+trees, snapshots, durable transactions, current multiprocess modes | Page/checksum/allocation overhead on writes; query/search work remains; savepoint restrictions need actual compatibility tests | Same-layout B-tree comparator |
| Turso Database | Rust SQL engine, SQLite file support, MVCC/group commit, async I/O | Partial compatibility, different FTS, backup C API stubs, experimental multiprocess path | Secondary SQL candidate |
| ZeroDB | Rust LMDB reimplementation, heed-shaped API, mapped CoW pages | Young implementation, unsafe mmap/page boundaries, no independent audit, main ahead of release | Mechanism research only |
| mpedb | Rust SQL/compiled-plan engine, shared-memory multiprocess design | Deliberately different SQL semantics and incomplete SQLite compatibility | Mechanism research only |
| heed/LMDB, libmdbx bindings | Mapped KV designs accessible from Rust | C engine remains | Performance comparators, not pure-Rust replacement |
| RocksDB bindings | Mature LSM implementation | C++ engine remains | Comparator |
| sled/Persy | Rust embedded engines | sled still documents beta status; latest Persy release reports rare high-concurrency crash investigation | Not first choices |

## Pinned engine source

### Fjall

Revision: [`87006048139bfe1b072bbc29a5a92bf1f97628e3`](https://github.com/fjall-rs/fjall/tree/87006048139bfe1b072bbc29a5a92bf1f97628e3).

[README](https://github.com/fjall-rs/fjall/blob/87006048139bfe1b072bbc29a5a92bf1f97628e3/README.md) documents ordered ranges/prefixes, atomic keyspaces, optional serializable transactions, exclusive database ownership and default persistence to OS buffers. Optimistic multi-writer transactions can conflict and retry. A serialized writer is simpler for T3's ordered operations. Independent processes cannot open the same database concurrently.

The inspected [batch commit implementation](https://github.com/fjall-rs/fjall/blob/87006048139bfe1b072bbc29a5a92bf1f97628e3/src/batch/mod.rs) locks the journal, writes a sequence-numbered batch, optionally persists it, applies its entries to memtables, then publishes the snapshot sequence. It accounts for write-buffer growth and applies backpressure. This is the boundary to use for commit acknowledgement.

[Single-writer transaction source](https://github.com/fjall-rs/fjall/blob/87006048139bfe1b072bbc29a5a92bf1f97628e3/src/tx/single_writer/write_tx.rs) has reads, mutations, commit, rollback and durability settings. No native nested-savepoint API was found in this inspected layer. Per-job staging is necessary to preserve upstream semantics.

[Keyspace options](https://github.com/fjall-rs/fjall/blob/87006048139bfe1b072bbc29a5a92bf1f97628e3/src/keyspace/options.rs) expose value separation, block/index/filter policies and compaction. Inspected defaults use leveled compaction, no value separation, and, with LZ4 enabled, leave upper levels uncompressed before compressing deeper data. Keep hot metadata inline. Enable value separation only for payload families whose observed size/access profile benefits.

The [Fjall 3 design article](https://fjall-rs.github.io/post/fjall-3/) explains block indexing, checksum checks, selective blob reads and filter caching. Its roadmap lists checkpoint backups, merge operators and range deletion as future work. Do not claim those APIs from the roadmap alone. A consistent logical snapshot export can be the first backup implementation; efficient physical checkpoints need separate verification.

### redb

Revision: [`2fc790d14fb62f39137b13f7943df433bec082c2`](https://github.com/cberner/redb/tree/2fc790d14fb62f39137b13f7943df433bec082c2).

[Design](https://github.com/cberner/redb/blob/2fc790d14fb62f39137b13f7943df433bec082c2/docs/design.md) and [transaction API](https://docs.rs/redb/latest/redb/struct.WriteTransaction.html) establish CoW trees, snapshots and default Immediate durability. Only one write transaction exists at a time; multiple writer processes are not simultaneous independent write transactions. Long-lived snapshots retain old pages.

Published engine benchmarks show useful Rust performance, but their SQLite adapter is not configured like T3. The pinned [adapter](https://github.com/cberner/redb/blob/2fc790d14fb62f39137b13f7943df433bec082c2/crates/redb-bench-compare/benches/common/mod.rs) creates `kv(key BLOB PRIMARY KEY,value BLOB)`, sets no WAL and no WITHOUT ROWID, and toggles FULL/OFF synchronization. SQLite therefore has row storage plus its PK index. Those ratios are not a stock-T3 comparison.

### Turso

Revision: [`4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9`](https://github.com/tursodatabase/turso/tree/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9).

| Requirement | Current evidence | Result |
|---|---|---|
| T3 FTS5 schema/contentless-delete | Source uses `CREATE INDEX ... USING fts` and `fts_match` patterns over Tantivy-backed segments | Not a direct replacement |
| Trigram/normalization | min_gram/max_gram configurable; ngram analyzer uses LowerCaser. Exact FTS5 remove_diacritics1 equivalence not established | Needs an exact differential test |
| FTS maintenance/visibility | Source has statement publication, same-transaction loading and automatic write-path merge via fts_merge_threshold | Old prose docs are stale; do not repeat no-auto-merge claim |
| JSON | COMPAT lists json_extract/json_set/json_each and broad support; json_tree partial | Test T3's actual expressions/null/numeric/path behavior |
| Savepoints | Listed as supported; ROLLBACK TO differs while a write statement is active | Sequential batch compatibility plausible, unqualified |
| Backup | sqlite3_backup_* C API functions are stubs | New tested backup/export path needed |
| Maintenance | VACUUM INTO supported, in-place VACUUM experimental | Actual migrations and maintenance must pass |
| Multiprocess | WAL coordination experimental; mixed SQLite/Turso file access unsupported | Migration must exclude concurrent old/new engines |
| Platforms | README describes Linux/macOS/Windows/browser WASM | Does not establish all optional features or T3 mobile integration |

Sources: [COMPAT.md](https://github.com/tursodatabase/turso/blob/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/COMPAT.md), [FTS implementation](https://github.com/tursodatabase/turso/blob/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/core/index_method/fts/mod.rs), [README](https://github.com/tursodatabase/turso/blob/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/README.md). `docs/fts.md` conflicts with current code on merges and likely transaction visibility. This report corrects the earlier inference from that stale prose. Do not assert no MATCH syntax solely from those docs either; the complete current FTS5 contract remains unqualified regardless.

## What Rust replacements have actually made faster

| Evidence | Observed result in source report | Limits |
|---|---|---|
| Turso 0.8 official concurrent writing | About 9,500 TPS at64 connections vs SQLite1,370. Separate latency test reports p99.9 2.4ms vs1.2s at32connections | FULL both; prepared statements; disjoint keys; Linux io_uring; explicit checkpoint worker. Throughput100rows/transaction closed loop; latency10rows/transaction open loop1000/s. SQLite wins single-connection throughput. Not T3's existing grouped writer. |
| redb official KV benchmark | Multiple direct-key reads/writes beat included SQLite adapter; Fjall wins some writing cases | SQLite uses different layout/mode from T3. Demonstrates specific operations, not app superiority. |
| Sophia authored editor comparison | Later synthetic100k-definition run: redb ID lookup1.3us vs SQLite4.9us; closure9.2ms vs26.9ms | Not T3 or measured real editor latency. Other SQL set queries beat its native executor by large margins. |
| ZeroDB under Meilisearch | Current movies indexing/search approximately equal to LMDB; some point/range operations faster | Producer-authored narrow corpus, trusted-page defaults and unsafe mmap boundaries; not SQLite or T3 proof. |
| mpedb authored four-engine test | Native WAL wins one Linux single-client insert comparison; selected point reads faster | Apple durable throughput approximately equal at flush floor. SQL semantics incomplete/different; Turso0.7 baseline is old. |
| Independent Node Turso comparison | Some point writes improve; indexed reads/ranges and batched inserts lose to SQLite bindings | macOS arm64, older Turso,10k seeded rows,WAL, published variability. Counterevidence to Rust automatically winning. |

Primary evidence and code:

* [Turso0.8 report](https://turso.tech/blog/turso-0.8.0), [latency method and code](https://github.com/tursodatabase/turso/tree/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/perf/latency), [throughput method and code](https://github.com/tursodatabase/turso/tree/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/perf/throughput), [group commit code](https://github.com/tursodatabase/turso/blob/4468e50b8b58dbfbfb8f5bf699c2a07978ba13e9/core/mvcc/database/group_commit.rs).
* [redb report](https://github.com/cberner/redb/blob/2fc790d14fb62f39137b13f7943df433bec082c2/README.md), [code](https://github.com/cberner/redb/tree/2fc790d14fb62f39137b13f7943df433bec082c2/crates/redb-bench-compare).
* [Sophia comparison](https://mathstruct.org/Sophia/vault/Research/Database-Comparison). Its full results matter, including native-query losses.
* [ZeroDB report](https://github.com/qdequele/ZeroDB/blob/a3d0c3442aa738cd547b9b49e5b21230bd3765b8/docs/PERFORMANCE.md), [README](https://github.com/qdequele/ZeroDB/blob/a3d0c3442aa738cd547b9b49e5b21230bd3765b8/README.md). Report's actual November12 Graviton4/gp3 measured revision is d70dbe9, not the documentation head. Main behavior differs from release0.2.
* [mpedb method/results](https://github.com/punnerud/mpedb/blob/70543d176049505cae5c3daac6e8245084568cff/benchmarks/turso.md), with separate durability classes and Turso0.7 scope.
* [Node experiment](https://github.com/devalade/turso-vs-sqlite/tree/8c2e134ed5eff81e0a9161673fcb6f4df76a1cde). This is not a current Turso0.8 verdict.

No reviewed source demonstrates a complete T3 replacement beating the pinned stock app. The evidence identifies winning mechanisms and conditions where they lose.

## Concrete native architecture

### Ownership and calls

Run one persistent native storage owner per database. CLI uses typed local RPC when it exists. A standalone CLI may own the file only after exclusive locking establishes no owner. Missing sockets do not prove owner death. Define startup races, handoff, stale endpoints and crash recovery. This changes the multiprocess mechanism and must preserve CLI/server behavior and acceptable latency.

During a TS transition cross the native boundary once per COMPLETE domain operation through a persistent extension/worker. No per-query subprocess launches, generic JSON row RPC or SQL-string interpreter. Final native backend calls these operations directly.

A single ordered writer matches current event/sequence relationships. Parallelize read snapshots and independent preparation. Optimistic writers that all conflict on sequence/owner metadata add retries without throughput.

### Per-job rollback

Process provider jobs in upstream order. Give each job a child overlay of mutations/tombstones, sequence changes, projection-cache changes and deferred publications. Reads see the child, prior successful siblings and a consistent base snapshot. Failure discards only the child; success merges it into the batch. Commit all successful changes in one Fjall transaction, then publish. A commit failure publishes none.

Range queries must merge staged changes as well as point reads. The overlay must preserve read-your-writes, nested rollback, output/error ordering, limits and cancellation. This is substantial correctness work, not an engine feature switch. Unknown I/O completion needs reconciliation rather than blind external-effect retry.

### Records and indexes

Keep opaque provider/event JSON where history/protocol requires it, while extracting stable hot fields once into versioned binary records. Covering indexes carry the exact fields a query returns. Separate large text/tool payloads from compact sidebar/queue indexes. Encode order-preserving keys with explicit upstream-compatible tie breakers.

Index families include project/thread/time lists, per-thread message pages, event replay sequence, provider-session identity, command receipts and outbox eligibility/state. They are access paths to existing records, not duplicate queues or owners. Update them atomically. Preserve output shapes, missing/null distinctions, timestamp precision, errors and cursors.

### Search

Use transactional in-store trigram postings for the observed bounded T3 search contract. This avoids a separate index publication/watermark owner and per-commit Tantivy segment overhead. Completed-message indexing avoids per-token posting churn.

Preserve imported SQLite rowid order with stable document IDs. Store normalized searchable text and compact metadata. Order postings by descending document ID. Intersect grams, then verify EXACT phrase/tokenizer semantics before counting a match toward the newest10k cap. Gram false positives must not consume the cap. Apply project/visibility rules next, keep newest2k eligible, then execute T3 palette ranking. Preserve separate newest20k CJK fallback, apostrophe/diacritic behavior and Unicode boundaries.

Read thread visibility from snapshot-consistent metadata; archiving should not rewrite all message postings. Base messages, old posting removal, new posting insertion, metadata and deletion commit together.

Posting layout remains a physical experiment. Per-(gram,doc) keys simplify mutations but create many entries; compressed blocks reduce read/space costs but can amplify read-modify-write work. Measure both with real message sizes/edit rates/common terms. Differential tests must include false-positive saturation near every cap, deletion, replay/import and tied ranks. This is the highest-risk custom component.

### Weighted history, maintenance and portability

A covering history index prevents irrelevant payload decoding. A prefix-sum/count index can locate a byte/token/rendered-weight boundary in logarithmic traversal if upstream actually needs that operation. Its weights, edits, deletes and counters must share the base transaction. It does not automatically improve existing keyset pagination; avoid adding it without a concrete query.

Compaction, blob collection and backups consume foreground CPU/I/O budget. Set bounded memory, worker counts and backpressure. Measure steady state and maintenance completion. Ending a benchmark before compaction drains hides cost.

Fjall uses standard filesystem/thread facilities. Browser clients can use the same domain protocol, but truly offline WASM storage needs another qualified backend. Do not claim no_std/browser storage from Rust alone. Native mobile requires real target/build/recovery qualification too.

## Durability profiles

`matchStock` is a product contract, not a synonym for a mode name. The closest Fjall starting point is explicit Buffer persistence, preserving process-crash safety while allowing some OS/power-loss rollback. It must be accompanied by a bounded persistence/checkpoint policy and verified replay/atomicity behavior at least as strong as stock. Buffer alone does not automatically match SQLite's actual loss window or checkpoints. Document whether the WAL has reached OS buffers at acknowledgement, and test application crash separately from OS/power loss.

`strictDurable` uses explicit SyncAll before success/publication, compared with SQLite WAL FULL and relevant platform flush semantics. SyncData is acceptable only when its filesystem/OS guarantees are established. On macOS, fsync and full device-flush behavior require explicit qualification; do not assume a method named SyncAll equals F_FULLFSYNC. The same warning applies to upstream benchmark claims.

redb Immediate is durable-on-commit; None is not automatically equivalent to SQLite NORMAL, including after application crash. Do not claim a win by silently weakening durability.

Sources: [SQLite PRAGMA](https://sqlite.org/pragma.html), [SQLite WAL](https://sqlite.org/wal.html), [Fjall PersistMode](https://docs.rs/fjall/latest/fjall/enum.PersistMode.html), [redb Durability](https://docs.rs/redb/latest/redb/enum.Durability.html).

## Mathematical statements and limits

Model one operation as boundary + decode + query/index work + synchronization + storage I/O + maintenance share. Removing a positive-cost term proves a model improvement only if the remaining terms do not increase enough to cancel it. LSM reads, extra CLI IPC and cache misses can increase.

A covering ordered index gives O(log N + k) access for k adjacent outputs instead of an unindexed scan/sort. If upstream already has the equivalent index, the gain is only constants and representation. Incremental counters make retrieval O(1) by charging updates; upstream already uses some. Group commit amortizes a barrier by batch size but adds queue delay, and upstream already batches. No new B-fold win follows from merely preserving it.

LSM buffering exchanges immediate random-write costs for read, maintenance and space costs. No theorem picks Fjall for every T3 operation. The RUM paper is explicitly a conjecture about read/update/memory tradeoffs. Native code can remove interpreter overhead, but SQL optimizers can choose better algorithms than naive native loops.

Mechanism sources: [original LSM paper](https://dsf.berkeley.edu/cs286/papers/lsm-acta1996.pdf), [RUM](https://stratos.seas.harvard.edu/sites/g/files/omnuum4611/files/stratos/files/rum.pdf), [covering indexes](https://www.sqlite.org/queryplanner.html), [Hekaton native procedure compilation](https://www.microsoft.com/en-us/research/wp-content/uploads/2013/06/Hekaton-Sigmod2013-final.pdf), [DBSP incremental maintenance](https://doi.org/10.1007/s00778-025-00922-y), [WiscKey value separation](https://www.usenix.org/conference/fast16/technical-sessions/presentation/lu).

## Acceptance

Compare against pinned stock with its actual prepared statements, pool, materialization and batching. Measure engine-only calls and end-to-end journeys on identical imported data, realistic traces and adversarial distributions. Required correctness covers atomic events/receipts/outbox, sibling rollback, snapshots/history/sidebar, exact search ordering/caps, CLI/server coexistence, migrations/export/restore, cancellation and recovery.

Measure p50/p95/p99, sustained completed work, peak/steady memory, physical writes, final disk space, startup/reopen and maintenance. Separate stock-equivalent and strict-durable runs. Test actual crash/publication boundaries. Define a product-level improvement and allowable regressions before promotion. If important reads lose, test the identical typed layout over redb before creating a bespoke storage engine.

Reviewed: pinned docs and selected transaction/FTS code, benchmark methods/adapters, bounded authored reports, mechanism papers. Not established: independently reproduced numbers, full engine correctness, all platforms, T3 semantic parity or any T3 speedup. Source excerpts were research inputs and are omitted from this publication. No donor engine code was integrated into the product by this research.
