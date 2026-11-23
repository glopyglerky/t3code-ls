# Native savings accounting

The portable crate folds the five task sources into the existing savings fields.
It uses `no_std`, allocates no memory and has no dependencies. The input uses
source codes and millisecond pairs. Its output follows the D1 bind order in
`Savings.ts`. Binary64 additions retain each source's input order, including
rounding above the safe integer range. Each input millisecond value retains the
Summary schema's safe nonnegative integer limit. There are at most 1,000 tasks.

The policy is ported from MIT-licensed `infra/task-cache/src/Savings.ts` at stock
`pingdotgg/t3code` commit `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`.
`Summary.ts` retains request decoding and per-task telemetry. `Savings.ts` retains
the D1 receipt insertion and totals update in its existing atomic batch.

The `web` crate supplies a Wasm binding through the repository's pinned
wasm-bindgen 0.2.130. That facade uses allocation and the hosted Rust standard
library. `SavingsFold.fromWasm` binds the module before `Savings.layerWithFold`
constructs the service. A selected fold failure occurs before the D1 batch.

The hosted workflow builds the actual module and runs the production Savings
service against a synthetic SQLite implementation of D1 transactions. It compares
all five sources, empty and maximum-size input, binary64 rounding, duplicate
receipts, failed batches and module failure. Cloudflare worker packaging and
runtime loading require the separate Worker packaging check. The deployed worker
uses the retained fold unless its build explicitly selects the native artifacts.

For an opt-in Worker build, generate the facade with wasm-bindgen's `--target web`
and `--out-name savings`. Set `TASK_CACHE_NATIVE_SAVINGS_DIRECTORY` to its absolute
canonical directory and `TASK_CACHE_NATIVE_SAVINGS_SHA256` to the combined
fingerprint reported by `inspectNativeSavings`. The fingerprint includes both
file names, lengths and bytes. The build refuses missing, redirected, oversized
or mismatched artifacts. The existing Alchemy build aliases `SavingsRuntime.ts`
to the native facade and includes the Wasm as a compiled module. The facade uses
the generated `initSync` with that precompiled module.

`verify-savings-worker.ts` invokes the same pinned Alchemy WorkerBundle provider
on the actual Worker entry with both selections. It requires the retained graph
to contain no Wasm and the selected graph to contain the exact provided Wasm.
It loads the emitted native Savings facade with a synthetic precompiled-module
loader and calls the normal authenticated telemetry route against synthetic D1
transactions. This checks packaging and the route's receipt behavior. Actual
Cloudflare isolate startup, remote bindings and deployment remain unqualified.

The inspected `@alchemy.run/cloudflare` 2.0.0-beta.85 package matches the lockfile
SHA-512. Its `Workers/Sources/Rolldown.ts` and `Workers/Worker.ts` implement the
build alias and CompiledWasm routes used here. Cloudflare documents compiled
Wasm imports and precompiled instantiation in its
[bundling guidance](https://developers.cloudflare.com/workers/wrangler/bundling/)
and [Wasm API](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).

Use the `candidate/t3code-ls-t15-task-cache-savings-*` lane for qualification with
the pinned Lustr/blueFe compiler. Generated binding files and build targets stay
under the hosted runner's temporary directory.
