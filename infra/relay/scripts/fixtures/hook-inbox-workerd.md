The local Workerd proof bundles the production `HookInboxStore` and shared
`HookInboxTransaction` with the existing `@effect/sql-sqlite-do` adapter. It tests
native SQLite and alarm transaction behavior without loading relay deployment,
authentication, tunnels or delivery. The fixture clock holds alarms in 2035 so
no delivery alarm runs during the proof. All hook identities, tokens, bytes and
target URLs are synthetic. Targets use the reserved `.invalid` domain and are
never fetched.

Run on the hosted Linux x64 lane after the frozen workspace install:

```sh
node infra/relay/scripts/verify-hook-inbox-workerd.mjs "$RUNNER_TEMP/relay-inbox-workerd-proof"
```

The workflow also runs it in a fresh network namespace with only loopback enabled.
Workerd exposes one loopback listener and its global outbound service denies all
addresses. The harness locates only the installed, locked Workerd 1.20261026.1 and
esbuild 0.28.2 packages. It installs and downloads nothing. Node and Workerd have
bounded request, readiness and termination waits. The proof retains actual
runtime, bundle, lock and production-source hashes and bounded runtime logs.
Its temporary bundle, configuration and SQLite directory are removed after the
owned Workerd process exits, including on a failed assertion.

The first hold commits bytes, target and alarm. Two attempts at a second hold fail
inside the real storage transaction, once after the row and target update and once
after changing the alarm. The fixture records the staged values before rejecting.
The harness requires the prior committed state and alarm to survive both failures,
then retries the same delivery and checks duplicate refusal. A fresh Workerd
process opens the same disposable SQLite directory and must reproduce the committed
state with a new object incarnation. A further failure and retry run after restart.
These assertions qualify this local engine and shared transaction seam when they
pass. They do not qualify hosted alarm scheduling, tunnel wake, remote delivery,
network partition behavior or physical power-loss durability.

The shared transaction owner preserves the production span names and keeps external
delivery outside its transaction. The production relay remains on its existing
Alchemy Durable Object adapter. MIT T3 Code lineage remains at stock
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. The mandatory method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

References consulted on 2026-11-23:

- [Cloudflare SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
  specify that direct SQL and alarm operations participate in SQLite-backed storage transactions.
- [Cloudflare Durable Object testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
  recommends the Workers runtime and distinguishes instance persistence from restart evidence.
  The current Vitest integration package is absent from the frozen lock, so this proof
  uses the existing Workerd runtime directly.
- [Pinned Workerd configuration schema](https://github.com/cloudflare/workerd/blob/v1.20261026.1/src/workerd/server/workerd.capnp)
  defines `enableSql`, disk-backed namespaces, disk services and network allow lists.
- [Effect Clock service](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Clock.ts)
  describes replacing wall-clock operations through the existing service. The actual
  bundled Effect version remains the lock's 4.1.3 and requires hosted execution.

Local checks cover syntax, patch whitespace and the Linux-only admission guard.
The Workerd bundle and engine assertions remain unexecuted until the hosted lane runs.
