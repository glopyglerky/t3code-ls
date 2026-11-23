# Makepad ARM64 package from an Intel host

The existing `candidate/t3code-ls-t01-makepad-input-cross-*` selector runs the
build-only job on `macos-15-intel`. It retains an ARM64 Makepad image and a
supported upstream server CLI archive. It does not execute either ARM64 image.
The existing Linux history and native macOS gates keep their original scope.

The job uses Node 26.12.1, frozen pnpm 12.14.0 dependencies, lock-selected
esbuild 0.28.2 and bootstrap Rust 1.99.1. The server is built with
`apps/server/scripts/cli.ts build-exe --target darwin-arm64` and assembled with
`scripts/build-cli-archive.ts --platform mac --arch arm64`. It includes the
cross-built resource monitor, web client, runtime externals and explicit upstream
component manifest. Ad hoc signatures are checked. This is retained TypeScript
and SQLite behavior, not native storage, Lustr/BlueFe or release qualification.

`verify-makepad-thread-snapshot.mjs` bundles the existing Effect RPC fixture and
its dependencies. `saved-history.json` is its exact adjacent data input.
The default source invocation continues to run `apps/server/dist/bin.mjs` through
Node. The explicit `--server-executable /absolute/path/to/t3` option selects the
packaged CLI directly. Both modes preserve the authenticated import, ordered
40-turn/80-record history assertions, cursor bounds and three refusal windows
before the successful window. The bundle requires an absolute packaged server.

The artifact contains `SHA256SUMS`, `server-files.sha256`, fixture input hashes,
source commit/tree identity, compiler identity and Makepad resource hashes.
Intel checks package architecture, signatures, explicit upstream selection,
standalone fixture loading, relocation and missing/changed-resource refusal.
It archives no Makepad fonts or icons. Runtime staging reads their exact blobs
from Makepad commit `888d1b501ff41d0084ddd5417446b7341d5f873e` and checks their
hashes. The existing server web client remains part of its supported package.
The stock source denominator is `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`.

After the owner admits a hosted run, download and extract its exact
`makepad-arm64-cross-build-<commit>` artifact into a disposable directory.
In a logged-in ARM64 macOS graphical session, run:

```sh
/bin/bash /absolute/artifact/run-loopback.sh /absolute/makepad-git-object-store /absolute/node26
```

The Git object store must already contain the pinned Makepad commit. Node must
be ARM64 version 26.12.1. No dependency installation, compiler or application
source checkout is required on the runtime host. The runner verifies retained
hashes, stages pinned resources in a relocated copy, extracts and verifies the
server package, and uses an unrelated working directory and disposable HOME.
It runs the input proof, saved-thread proof and history proof. Its EXIT trap
removes its own staging; it never supplies an installed application profile.
Use the owner's separately admitted network sandbox for runtime qualification.
An empty environment alone does not deny network access.

Retain the exact artifact hash and runner output before cleanup. Runtime receipts
include hashes of the selected server, Makepad executable, fixture driver and
history data. A staged package or `--help` result does not qualify native windows,
accessibility, physical input, subscriptions, provider submission or storage.
