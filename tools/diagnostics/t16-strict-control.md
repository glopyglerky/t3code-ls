# J02 extra strict SQLite control verifier

This opt-in diagnostic extends T16 without changing the original stock
WAL/NORMAL denominator or any product setting. The workflow branch prefix is
`measure/t3code-ls-t16-checked-open-engine-reuse-paired-strict-`.
The existing six-round stock/control/reuse comparison runs unchanged. Its
observations remain separate from the additional verifier's two stock/strict
pairs in AB/BA order. Do not pool either set with previous hosted results.

The strict staging checkout starts at stock commit
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, tree
`af9112ce82be93109079ca7b7a89f7182455eca5`. The Rust diagnostic refuses dirty
or mismatched source. It emits a benchmark-only overlay for
`apps/server/src/persistence/Sqlite.ts`: replace the unique NORMAL assignment
with FULL and assert journal_mode=wal and synchronous=2 on the same writer
route during setup. The frozen shared client's default route selects its
writer unless the ReadOnly context is supplied. These setup calls supply none.
The strict build reuses the unchanged stock web assets and frozen lockfile.
The original stock bundle manifest is checked after strict build and workloads.
The actual overlay, full bundle hashes, verifier source and binary hashes are
retained in the evidence artifact. MIT and upstream provenance remain intact.

A successful strict seed and reopened descriptor require those assertions to
have passed. This is an application configuration and work verifier. The two
extra PRAGMA reads add diagnostic setup work. There is no plain strict timing
arm, balanced strict performance qualification, power-loss test, or proof that
SQLite FULL and omdb Immediate have equivalent failure semantics. FULL's
contract still depends on VFS, filesystem and device synchronization.
See [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).
Do not infer connection settings by opening a second SQLite connection.

Each verifier workload uses a private mount, loopback network and PID namespace.
Both staged source roots and bundles are mounted read-only there. A fresh
synthetic profile at the same fixture pathname is writable. PID namespace exit
terminates leftover fixture processes. Read-only bind mounts constrain that
workload's view, not host-global storage. The existing ordered-history,
descriptor identity, saved browser cache, migration and fixture checks remain.
No installed state, live providers, personal profiles or source databases are used.

The additional Rust `account` command validates the existing probe's retained
per-identity CPU deltas, tick conversion, group disjointness and RSS page units.
It writes separate accounting receipts for the original three-arm observations
and extra verifier observations. It retains sampler scan wall time, gaps and
unavailable reads. These receipts establish internal arithmetic, not an
independent measurement of the kernel or reconstruction of peak RSS.
See [Linux proc](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The inherited sampler uses PID plus start ticks, tracks observed descendants
across reparenting, sums process self CPU and samples summed RSS. The server
includes its root; browser excludes ChromeDriver. Node worker threads are
included by the process counters. Browser baseline is captured before server
spawn. The final scan follows the finish request after authoritative selected
history and snapshot verification, before browser/server shutdown. This differs
from descriptor timing. Processes exiting between scans and their final CPU can
be missed. Shared RSS may be counted repeatedly and peaks between scans missed.
Probe, sampler and ChromeDriver CPU are excluded; scan wall time is not sampler
CPU. Existing `cpu_rss_qualified:false` remains. No total-resource or limiter claim
follows, and there is no invented acceptance threshold.

Root qualification must run the added diagnostic's unit tests with the pinned
Lustr/BlueFe toolchain, then the opt-in hosted lane. Unit tests cover counter
regression, duplicate identities, invalid units and arithmetic mismatch. Before
any strict performance decision, add plain exact-source strict samples and a
balanced same-host design, demonstrate completed equivalent work, bound observer
overhead and identify the actual limiter. Keep the strict diagnostic overhead
and durability/fault-injection gaps explicit. The existing workflow cleanup owns
all strict staging, dependencies and profiles and records filesystem free space.
