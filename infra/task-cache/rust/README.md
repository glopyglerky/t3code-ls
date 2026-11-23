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
runtime loading remain unqualified. The deployed worker uses the retained fold.

Use the `candidate/t3code-ls-t15-task-cache-savings-*` lane for qualification with
the pinned Lustr/blueFe compiler. Generated binding files and build targets stay
under the hosted runner's temporary directory.
