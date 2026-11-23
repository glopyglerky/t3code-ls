# J02 native checked-open diagnostic

The [earlier persistence trace](https://github.com/glopyglerky/t3code-ls/actions/runs/45170497344)
placed 424–546 ms in the initial writable helper's connection path. This Linux
x64 gate counts database-file traffic inside that helper and puts it alongside
the cost of observing it. The [paired startup result](https://github.com/glopyglerky/t3code-ls/actions/runs/45177228845)
remains the stock comparison, with stock pinned to `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`.

The workflow builds the frozen integrated bundle with its pinned compiler and
omdb dependency. It reuses the MIT-licensed J02 browser probe at `126ee67adb`,
with a small patch in a disposable checkout. Each of four alternating pairs
imports the same 32 synthetic threads and 6,400 messages through the packaged
server. The probe checks the selected thread's exact ordered history and the
committed migration head after reopening the saved profile. The gate compares
the fixture and migration receipts across each pair and records database size
at reopen. Each seed creates its own profile and authentication state, so the
database files can differ despite equivalent logical work.

The plain run uses ordinary bundle resolution. In the traced run, the
reopened server uses the existing executable override. The override runs the
packaged helper with its original arguments and streams. It traces only the
`local` helper, after fixture import and clean shutdown. The same packaged helper
runs the owner lock and the prior read-only inspection without tracing. Each trial uses a fresh directory and a
loopback-only network namespace. Its PID namespace ends with the trial so
leftover fixture processes cannot outlive it.

`checked-open-*.tsv` groups database-file calls into four intervals bounded by
helper execution, the writable file open, acquisition and release of omdb's
writer byte, and the first request read on standard input. The writer-lock
interval includes header work, integrity checks, allocator rebuild and
publication, and savepoint restoration in the [pinned engine](https://github.com/glopyglerky/omdb/blob/b2ff031398b1f0a793a352db7a699575b5d4d3d4/src/db.rs#L1698-L1779).
Read and write counts use successful return sizes. These are bytes passed by
syscalls, which can include repeat reads and page-cache hits. The intervals
cannot divide checksum CPU from allocator CPU, identify physical device I/O,
or determine why a specific write or sync occurred. File metadata calls are
outside the selected syscall set.

`overhead.tsv` shows the paired difference in descriptor readiness with and
without the launcher and tracer. Treat traced syscall time as diagnostic only.
The traced wall intervals use `strace` timestamps and include scheduling and
trace overhead. The filesystem cache is unmanaged. A spread comparable to
the paired difference leaves the size of that overhead inconclusive. The
gate measures this Linux route and leaves J02 and stock performance
acceptance to the existing qualification.
Raw syscall traces and disposable profiles stay in runner scratch.

The hosted gate runs on a push to `measure/t3code-ls-t16-checked-open-*`.
Use the `checked-open-evidence` artifact for the source and binary receipts,
per-pair comparisons, and syscall totals.

See the [strace manual](https://github.com/strace/strace/blob/v6.8/doc/strace.1.in)
for the trace process, FD annotation, and timestamp behavior.

## Phase counts inside the engine

The `measure/t3code-ls-t16-checked-open-engine-phases-*` lane runs one copy
of the same packaged workload with an instrumented omdb dependency. It records
the scratch overlay, exact engine tree and packaged helper hash. The overlay
changes only the dependency identity and diagnostic feature. The fixture
enables the counters for the reopened writable helper and retains phase totals
from that helper after checking the actual profile and selected thread.

The engine test verifies current and alternate roots, refuses a torn backup
slot, and exercises persistent savepoint restore. The workload receipts
describe successful backend read requests and requested bytes, including
possible page-cache hits. They do not establish physical disk reads or a
startup speedup. [Engine qualification](https://github.com/glopyglerky/omdb/actions/runs/45197280102)


## Fresh stock denominator on the paired lane

The `measure/t3code-ls-t16-checked-open-engine-reuse-paired-*` lane now builds
stock at `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` using the optimized stock
construction from `126ee67adb`. It runs stock, the current engine with reuse
disabled, and the same engine with reuse enabled on one host. Six rounds use
all six arm orders. Each arm creates a fresh owned profile at the same pathname
within a round. The gate compares transcript hashes and meaningful fixture
coordinates across all arms, and migration/cursor receipts between native arms.
Stock and native migration numbers need not match.

The existing probe checks the PID-bound runtime record, descriptor environment
identity, served HTML root, durable browser caches, exact ordered selected history
and authoritative synchronization. Each sample retains the descriptor response
used for readiness at `/.well-known/t3/environment`. Source overlays, toolchain
proofs, lock hashes and full emitted bundle hashes identify the actual arms.

Stock retains SQLite WAL/NORMAL; both native arms retain omdb Immediate. These
are separate durability profiles, not an equal-durability engine comparison.
Runtime engine counters and server spans are disabled. Process samples remain
unqualified for CPU/RSS and are omitted from the comparison table. The same
browser observer and routes run for all arms, but its visible-text timestamps
do not establish cached-paint attribution or presentation to a physical display.
Filesystem cache remains unmanaged after import. No limiter or resource claim,
global performance acceptance, product pin or normal profile change follows.
Use only this fresh run's matched observations; do not pool earlier runs or hosts.


## Descriptor-window attribution after verified-page reuse

Use `measure/t3code-ls-t16-checked-open-engine-reuse-paired-readiness-*` to
extend the same proof route with plain/traced pairs for each stock, control
and reuse arm. The six existing arm permutations remain. Within each arm,
plain precedes tracing in odd rounds and follows it in even rounds. Both
members seed fresh profiles at the same path; transcript hashes, fixture
coordinates, migration head and selected history must match. Runtime engine
read counters remain disabled. There is no new runner or engine algorithm.

The existing Rust probe records the first PID-bound runtime record it observes
and descriptor request start/end offsets on its monotonic spawn clock. A
successful descriptor is still checked against the profile environment ID,
then the actual HTML root is fetched. Record observation can lag publication
by polling and scheduling. Request wall time includes launching curl. These
are observer boundaries, not exact application event timestamps.

With the existing `server-spans` option, `readiness_phases` retains emitted
`server.startup.*`, `Omdb.make`, `Sqlite.setup` and `NativeDatabase.*` spans.
The trace is read after clean shutdown so closed spans crossing descriptor
readiness can be clipped to that window. Absolute server epoch timestamps
are aligned to the probe's pre-spawn epoch sample; that alignment is not a
shared monotonic clock. Trace output and retained spans stay bounded by the
existing parser. Completed startup spans after readiness are excluded.

Each named row reports summed held time and its interval union. The overall
instrumented union merges every retained interval, including nested and
parallel spans. Never sum the named rows as elapsed time. Held spans include
await and scheduler time; neither their duration nor uncovered time proves
CPU cost or a causal critical path. `http.wait` measures the startup fiber's
wait for its listener signal, not all HTTP initialization. Missing spans are
not zero work. The remaining wall interval includes loading, uninstrumented
work, observer delay and clock alignment error. CPU/RSS, physical I/O and
causal critical-path qualification remain false.

`readiness-overhead.tsv` retains each paired descriptor delta. Assess those
six deltas per arm and their spread before trusting trace attribution. Do not
subtract one median as a universal correction or pool this probe's timings
with prior artifacts. Plain samples also use the new boundary observer.
The original `paired-*.json` filenames hold plain observations; `-spans.json`
holds diagnostics. Raw trace files and profiles are removed with each trial.
The existing full bundle/tool/probe/source manifests identify both arms;
`diagnostic-source.sha256` also covers the Rust interval accountant. The
patched probe overlay must be retained alongside its binary hash.

Decision rule: use the largest named held interval intersecting readiness as
a source investigation candidate only after overhead is acceptably bounded.
A large uncovered interval directs the next observation toward module/layer
construction or observer delay. No current result authorizes changing reads,
transactions, integrity checks, activation or durability. The independently
qualified engine read counters remain the source for logical backend read
attribution, not evidence of physical device traffic.

The completed-work probe separately validates all 200 retained messages and the
authoritative bounded window used by the web client's cache. The cache must
match that window's ordered message IDs, roles, text and selected-thread
cursor. The bounded read runs in preparation, before the timed reopen.
