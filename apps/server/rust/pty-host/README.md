# Linux PTY host candidate

This isolated T07 package exposes a Linux PTY owner through a public Rust API and
`--stdio-v1`. The application still selects `NodePtyAdapter`. Its existing caller
owns shell selection, workspace and environment authorization. This helper accepts
an explicit absolute executable and directory, arguments and environment. It clears
the inherited environment before spawning.

The binary accepts one JSON object per line. Its first request is `spawn` with
`executable`, `args`, `cwd`, `env`, `cols` and `rows`. A successful response has
`version: 1` and `pid`. Subsequent requests are `write` with byte-array `bytes`,
`read`, `acknowledge` with `end`, `resize` with `cols` and `rows`, and `close`.
The operation name goes in `operation`.

A write returns `accepted`, the exact prefix accepted by the PTY kernel. A caller
may send only the remaining suffix after partial acceptance. This receipt does not
prove that a shell command executed. A read returns `start`, `end`, byte-array
`bytes` and `ended`. The same nonempty chunk is offered until an exact
acknowledgement returns `acknowledged`. Resize returns `resized: true`. Close
returns `exitCode` and `success`, then the transport exits.

Every response has `version: 1`. Errors print a diagnostic on stderr and exit 2
without a successful response for that request. EOF closes the owned child.
A rejected request, a broken output pipe and normal helper return drop the owner,
signal its unreaped process-group leader and reap the direct child. There is no
replay across helper restart. Linux SIGKILL of the helper, interactive foreground
job groups, descendants that create another session, and OS restart still require
containment qualification before application selection.

The host bounds frames at 128 KiB and chunks at 8 KiB. It keeps one output chunk
until acknowledgement and advances a byte cursor within the exact JSON integer
range. Writes yield on kernel backpressure and return their accepted prefix
within a 250 ms retry interval. Reads are nonblocking. The stdio transport
requires a continuously consumed response pipe. Input and output lifetime cancellation remain
caller responsibilities. The API uses `std` and Linux host APIs.

`portable-pty` 0.9.0 is pinned with defaults disabled. Its MIT source package has
SHA-256 `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e` and
records WezTerm commit `f8921727a11b9f8b073e8c24821d72fd41283500`, directory `pty`.
The inspected `unix.rs` establishes the session and controlling terminal before
exec. `cmdbuilder.rs` provides the explicit-environment spawn. That dependency and
`nix` encapsulate native unsafe/FFI. This package forbids its own unsafe code.

The authored Linux fixture exercises real PTY Unicode and control bytes, resize
through `stty size`, exact replay acknowledgement, bounded blocked input, explicit
environment and child cleanup on owner drop and transport EOF. It uses only
synthetic `/bin/sh` scripts and fixture-owned PIDs. Run it with the pinned hosted
compiler and an external target directory.

```sh
CARGO_TARGET_DIR="$RUNNER_TEMP/pty-host-target" \
  "$T3_CODE_LS_TOOLCHAIN/bin/lustr" --bluefe-root "$T3_CODE_LS_TOOLCHAIN" \
  test --locked --manifest-path apps/server/rust/pty-host/Cargo.toml
```

The source oracle is the retained `NodePtyAdapter.ts` at
`c7a3f02e3851923ced8ebd000db79f641e11b038`, blob
`cc7ae638f7df2c5605584eba1c0de3f4799acdfc`. Whole terminal rendering, reconnect,
authorization and platform acceptance remain with T07's application owner.
