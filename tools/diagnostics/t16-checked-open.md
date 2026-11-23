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
`local` helper, after fixture import and clean shutdown. The prior read-only
inspection runs without tracing. Each trial uses a fresh directory and a
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
