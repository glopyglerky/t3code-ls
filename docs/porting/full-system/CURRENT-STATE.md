# Current implementation and ownership

Recorded on 2026-11-22. This is an immutable implementation audit, not a second live status register. Read the current [port map](../../../port-map.json) and [upstream lock](../../../upstream.lock.json) before starting work.

Newest upstream default-branch head observed during publication was `a3323d4a433a1a4d074e402083df15c63db1a32c`. This is detection only. It was not integrated or semantically reviewed by this publication, and does not replace the researched performance baseline `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. Refresh detection through the existing planner.

## Scope and conclusion

This is a source audit of `glopyglerky/t3code-ls` at [3577878a5e008c8af87a8fbdae13d26dea1c2f50][fork]. The research target is stock `pingdotgg/t3code` at [28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f][research]. The objective is the complete T3 product implemented in Rust and measured against stock upstream. The present fork is an implementation starting point, not the performance denominator.

The current production application remains the retained T3 server and clients. Selected server policy, provider-process and persistence work calls Rust. The standalone native API and Iroh transport are separate candidates. The plan should extend those existing application owners and preserve every client and public contract. It should not turn `crates/app` into a second reduced product. This follows the repository instructions and the recorded port ownership. [Sources: AGENTS.md][agents], [port map][map], [current README][readme].

At this revision, `port-map.json` contains eight `integrated` ports and two `candidate` ports. Every recorded `acceptance_evidence` object is empty, and every `retired_paths` list is empty. There are no `accepted`, `retired` or `synced` port entries. These are the committed accounting states, not a claim that no historical check ever passed. Historical reports cannot substitute for exact-source, exact-platform receipts. [Source: port-map.json][map].

No builds, tests, benchmarks, providers, migrations, installed state, GitHub writes or product edits ran for this audit. Large server files were reviewed at their entry and composition boundaries; this is not a full semantic review of every branch.

## Revision identities and their meaning

| Identity | Recorded value | Consequence for the plan |
| --- | --- | --- |
| Fork source reviewed here | `3577878a5e008c8af87a8fbdae13d26dea1c2f50` | All fork implementation observations below are fixed to this commit. |
| Integrated upstream source | `c7a3f02e3851923ced8ebd000db79f641e11b038` | Both `upstream.lock.json` and `port-map.json` use this revision. |
| Integrated upstream tree | `f68ccc29fad051614b6c072bf176bb0938628443` | Source identity, not behavior or performance evidence. |
| Committed detection field | `c7a3f02e3851923ced8ebd000db79f641e11b038`, status `integrated` | The committed lock does not yet record the newer research target as integrated. |
| Source qualification | `unqualified`, `last_qualified_commit: null`, empty evidence | A documentation plan must not promote this state. |
| Research and performance baseline | `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` | Later research target, distinct from the implementation pin. Importing and adapting its changes remains implementation work. |
| Nightly reference | `822671581383a357c5dc8d3ea9984b408c3e03c6`, status `contained-in-integrated-source` | Historical release comparison, not the current default-branch implementation identity. |

Sources: [upstream.lock.json][lock], [port-map.json][map], [c7a3f02e integration record][integration], [research target][research]. The c7a3f02e report says its immediate upstream delta changes desktop setting decoding and retains the mapped upstream oracle blobs. It also says source integration does not establish full application qualification. The existing source history must remain intact when a later implementation change advances the baseline. [Sources: integration record][integration], [source retention rules][map-doc].

## Existing Rust owners

The table is a pinned audit. `port-map.json` remains the only mutable implementation and platform-status register. Its complete `rust_paths`, `adapter_paths`, upstream blobs and tests should be reused rather than copied into a second task-status file. [Source: port-map.json][map].

| Existing port ID and state | Owning application or package domain | Present Rust implementation | Actual integration boundary and remaining scope |
| --- | --- | --- | --- |
| `command-and-dispatch-policy`, integrated | `apps/server/src/orchestration-v2` | `crates/core/src/command_policy.rs`, `dispatch.rs`, `bin/t3-code-ls-policy.rs` | Production `CommandPolicy.ts`, `NativeCommandPolicy.ts`, `NativeDispatchFacts.ts` and `NativeDispatchPolicy.ts` call the Rust decisions. This does not replace the orchestrator, command executor or provider event system. |
| `project-commands`, integrated | `apps/server/src/project` | `crates/core/src/project_commands.rs`, `project_commands_wire.rs`, `bin/t3-code-ls-project.rs` | `ProjectCommands.ts`, `NativeProjectCommands.ts` and `ProjectService.ts` use the planner. Authorization, workspace locking, receipts and forced-delete partial progress remain service responsibilities. |
| `guest-share-decisions`, integrated | `apps/server/src/guest` | `crates/core/src/guest_share.rs`, `guest_share_wire.rs`, helper executable, `apps/server/src/guest/guest_uploads.rs` | `NativeGuestShare.ts`, `GuestShareDecider.ts` and `GuestShareService.ts` select decision and upload classification work. Filesystem observations, Unicode case folding, attachment copying and cleanup remain application responsibilities. The map's note still mentions SQLite transactions and should be reconciled with the selected native persistence graph during implementation review. |
| `provider-recovery`, integrated | `apps/server/src/orchestration-v2` | `crates/core/src/provider_recovery.rs`, wire module and helper executable | `ProviderRecoveryPlanner.ts`, `ProviderRuntimeRecoveryService.ts` and `packages/provider-core/src/server/subagentProjection.ts` use the planner. IDs, interruption and transaction ownership remain in the Effect application. |
| `provider-maintenance`, integrated | `packages/provider-core/src/server` | `crates/core/src/maintenance.rs`, wire module and helper executable; `apps/server/src/provider/provider_update_verification.rs` | `NativeMaintenancePolicy.ts`, `maintenanceResolver.ts` and `providerMaintenanceRunner.ts` use native action and verification decisions. Credentials, update locks, version refreshes and execution of updates remain in existing services. |
| `codex-structured-generation`, integrated | `apps/server/src/textGeneration` | `crates/core/src/codex_generation.rs`, wire module and helper executable | `CodexTextGeneration.ts` and `NativeCodexTextGeneration.ts` select the Rust process route on the supported Linux host. Installation gates and separate exec/MCP argument contracts remain required. `WindowsCodexTextGeneration.ts` remains an upstream route. |
| `codex-process-runtime`, integrated | `apps/server/src/provider` | `crates/core/src/provider_process.rs`, `bin/t3-code-ls-provider.rs` | `CodexAppServerProcess.ts`, `CodexProvider.ts` and `orchestration-v2/Adapters/CodexAdapterV2.ts` select the process transport. Provider schemas, event translation and Windows process behavior remain required. A process transport is not the full Codex adapter. |
| `redb-persistence`, integrated | `apps/server/src/persistence` | `crates/storage`, core persistence wire helpers and domain Rust modules under `apps/server/src/persistence`, `orchestration-v2`, `peer`, `scheduledTasks` and `pullRequest` | `SelectedPersistence.ts`, `Omdb.ts`, `NativeDatabase.ts`, `RedbClient.ts` and the selected runtime graph connect the native application repositories. The package and many filenames retain `redb`; the actual pinned engine dependency is the omdb fork. Shared application algorithms and provider workers still run in the retained server. |
| `iroh-transport`, candidate | `infra/relay` | `crates/transport/src/bridge.rs`, `identity.rs`, `admission_file.rs`, with core connection logic | No `adapter_paths` are registered. The component forwards authenticated bytes. Connect accounts, pairing, session lifecycle, browser access, push and mobile reconnect still require the functioning application. |
| `native-api-component`, candidate | `apps/server` | `crates/app/src/lib.rs`, `service.rs`, `provider.rs`, `http.rs`, with core/storage dependencies | No `adapter_paths` are registered. `POST /rpc` is a standalone protocol and is not the production WebSocket contract or product entry point. Reuse internals in their domains through separate behavior-preserving changes. |

Sources for ownership, scope and state: [port-map.json][map]. Direct implementation checks: [core module declarations][core-lib], [storage module declarations][storage-lib], [Codex process selection][codex-process], [native API handler][native-http], [Iroh bridge][bridge].

### Physical ownership and compilation

The root workspace contains `crates/core`, `crates/transport`, `crates/storage`, `crates/app` and `tools`. It explicitly excludes the independent native helpers `native/hyprland-snap-shot`, `native/kde-snap-shot` and `native/resource-monitor`. They need their own platform ownership and qualification in a full-product plan; a root workspace result does not cover them. [Source: Cargo.toml][cargo].

Some new Rust already lives beside its application owner. `crates/core/src/lib.rs` includes guest-upload and provider-update modules from `apps/server`. `crates/storage/src/lib.rs` includes persistence, peer, scheduled-task, pull-request and orchestration Rust by explicit `#[path]`. A move into domain crates must update these compilation relationships and the port map. Source relocation and behavior replacement should remain separate changes. [Sources: core declarations][core-lib], [storage declarations][storage-lib], [repository instructions][agents].

The default native selector accepts Linux x64 with GLIBC 2.39 or later. Other hosts select retained upstream implementation before effects. Explicit native selections fail when unsupported; errors do not trigger a backend retry. The selector's host predicate is an execution policy, not proof of a current platform acceptance receipt. [Sources: nativeExecutable.ts][selection], [port map][map].

## What the production execution path still does

The real entry and composition boundaries remain `apps/server/src/server.ts` and `apps/server/src/ws.ts`. The server imports selected persistence and `orchestration-v2/selectedRuntimeLayer.ts`. The WebSocket endpoint still constructs `ServerWsRpcGroup` through Effect RPC and the authenticated session machinery. Replacing these contracts with the standalone `crates/app` API would break existing clients. [Sources: server.ts][server], [ws.ts][ws], [native API handler][native-http].

`nativeRuntimeLayer.ts` calls the shared `makeRuntimeLayers` function and supplies native persistence services. Its comment explicitly limits that composition change to storage implementations. `runtimeLayer.ts` still builds the actual orchestrator, provider session manager, event ingestor, command execution, worker, recovery, thread lifecycle, scheduler and other services. The integrated database does not make this graph a Rust server. [Sources: nativeRuntimeLayer.ts][native-runtime], [runtimeLayer.ts][runtime].

The selected database path uses one omdb service layer, paired native repositories and shared application services. `Omdb.ts` owns startup, source verification, import, schema upgrade, resumable index preparation and activation fencing. `NativeDatabase.ts` spawns the helper, serializes JSON requests over piped standard input/output, coordinates access with a semaphore and holds a helper session across a transaction. It distinguishes a rejected request from an uncertain outcome and closes poisoned sessions. Moving the domain and storage into one Rust process is a plausible way to remove encoding and scheduling boundaries, but no speedup is established by inspecting this code. The replacement must preserve transaction lifetime, receipt recovery and unknown-outcome behavior. [Sources: SelectedPersistence.ts][selected-persistence], [Omdb.ts][omdb], [NativeDatabase.ts][native-db].

`crates/storage/Cargo.toml` pins the `redb` package name to `glopyglerky/omdb` revision `b2ff031398b1f0a793a352db7a699575b5d4d3d4`, version 4.5.0. That source identity must not be described as a crates.io redb build. An engine comparison can be proposed behind the same application semantics, but changing the engine alone does not complete the server, clients or remote lifecycle. [Source: storage Cargo.toml][storage-cargo].

## Obligations for implementation work packages

The full plan needs work packages that name an application owner, retained upstream source, actual client/server entry, Rust replacement, failure cases and acceptance evidence. These are prospective obligations, not new completion states.

### Baseline integration and parity

Before accepting behavior against the research target, compare the integrated c7a3f02e source with 28706ace and review every affected translated source, adapter, contract, dependency and upstream removal. Preserve the original implementations for any newly introduced or still-unported behavior. Keep detected, integrated and qualified revisions separate. A plan citation to the newer target must not silently advance `upstream.lock.json`. The current planner already performs immutable-tree comparison and ownership joins; reuse it. [Sources: upstream lock][lock], [porting planner][porting-planner], [source retention rules][map-doc].

### Whole server and provider behavior

Continue from `apps/server/src/orchestration-v2`, `apps/server/src/provider`, provider packages and the current runtime graph. Port the domain state machine, normalization, publication, queue ownership, effects and recovery along with their native persistence calls. Preserve omitted/null distinctions, typed errors, authorization, cancellation, ordering, receipts and transaction boundaries. Complete each provider's schema, protocol translation, approvals, interruptions and restart behavior. Codex process transport cannot close Claude, Cursor, ACP or other provider work. The existing graph and map show the present split. [Sources: runtimeLayer.ts][runtime], [port-map.json][map], [AGENTS.md][agents].

### Clients and platform behavior

The current map contains no integrated Rust web, desktop or mobile client replacement. Treat `apps/web`, `apps/desktop`, `apps/mobile`, shared client runtime and native platform helpers as first-class implementation owners. Preserve input, IME, accessibility, rich rendering, previews, terminal interaction, reconnect, local state, notifications and distribution lifecycle until the affected Rust client passes its platform gates. A Rust backend or retained-client smoke flow cannot establish Rust client completion. [Sources: current map][map], [README source organization][readme], [retirement rules][map-doc].

### Workspace, remote and hosted behavior

Add complete ownership for files, search, Git/worktrees/checkpoints, terminals, source-control hosts, MCP, preview/browser/device/media behavior, delegation, scheduling, webhooks and hosted entry points. Storage row ports support these systems but do not replace their execution and client behavior. For transport, complete Connect identity, account, pairing, authorization and lifecycle through the actual browser, desktop and mobile clients before retiring the existing implementation. Iroh is currently a candidate with no production adapter mapping. [Sources: server composition][server], [runtime composition][runtime], [Iroh map entry][map], [repository instructions][agents].

### Qualification selection and acceptance metadata

Two concrete gaps belong in future implementation work, not this documentation PR:

1. `tools/ci_plan.py` lists seven production ports in `PRODUCTION_PORTS`; `redb-persistence` is absent. A database-only mapped runtime change can select Rust and its component acceptance checks without selecting the normal browser/application gate. The shared production policy requires a client flow when the execution boundary changes, so the implementation package must review this selection, its regressions and the required integration evidence. Do not infer that the existence of a browser job means every storage change selects it. [Sources: ci_plan.py][ci-plan], [hybrid workflow][hybrid], [AGENTS.md][agents].
2. The current persistence route records `implementation: "omdb"`. `tools/plan-porting.py` recognizes only `rust` and `rust-backed-client` as Rust routes, while `tools/src/migration.rs` allows only those labels when a route enters `accepted`, `retired` or `synced`. The current integrated state is valid, but future acceptance must reconcile the route label with the reviewed schema and keep engine identity separately precise. Merely adding a passing receipt to the present `omdb` label would not satisfy that validator. [Sources: port-map.json][map], [plan-porting.py][porting-planner], [migration.rs][migration-guard].

The current full Rust compiler route is the packaged Lustr coordinator forwarding to rustc-derived BlueFe. The compiler lock explicitly says native Lust is absent from that compatibility package. Keep compiler route, application correctness and performance as separate acceptance claims. All supported target families remain in the map; Linux checks cannot close the other targets. [Sources: toolchain.lock.json][toolchain], [port-map.json][map].

### Performance and retirement

Measure complete user journeys against the pinned optimized stock-upstream application with equivalent features, durability, provider fixtures, dataset, viewport and network conditions. Record action-to-visible-result timing, queue delay, frame presentation, resource use and restart/recovery behavior. Treat process-boundary removal, bounded queues, compact indexes and reduced repeated rendering as hypotheses to test. Do not use an improvement over the existing fork or a component-only comparison as the product success criterion.

Retirement requires current application, contract, failure and target-build evidence. The source guard validates hashes and mappings; it cannot infer semantic parity or turn a report into a passing run. Keep every upstream mapping after accepted source removal so future changes reach the corresponding Rust owner. [Sources: retirement and evidence rules][map-doc], [migration guard][migration-guard].

## Existing documentation conflicts

These files contain stale current-tense statements. Correct their framing and link the new plan without changing implementation states.

| File | Conflict with the current source | Recommended documentation action |
| --- | --- | --- |
| `docs/porting/port-map.md` | Its introduction still calls the redb backend a candidate. The current map marks `redb-persistence` integrated. | Describe the state definitions, defer current status to `port-map.json`, and link the complete plan. |
| `docs/internals/t3-code-ls.md` | Its persistence section says production SQLite still owns the common transaction and redb is a candidate. | State that the selected native route uses omdb through the shared transaction boundary; retain the original route and platform limitations. Link the cutover record and authoritative map. |
| `docs/native-api.md` | Its opening calls the web, desktop and mobile clients retired. They are retained production clients under current instructions and source. | Identify the document as the standalone experimental component protocol, incompatible with the production client protocol. |
| `docs/ci-and-porting.md` | Its closing historical integration pointer highlights 9e12eca1, while the lock and latest integration report use c7a3f02e. | Link current pin identity through `upstream.lock.json` rather than maintaining a second current-revision sentence. Add a full-system plan link. |
| `docs/porting/recovery.md` | Its integration and validation claims describe the recovery checkpoint, including an older pin and historical gates. | Keep it as a dated historical report. Do not reinterpret it as current platform acceptance. A short historical-scope note is enough if edited. |

Sources: [map documentation][map-doc], [design/divergence document][design-doc], [native API document][native-api-doc], [CI documentation][ci-doc], [recovery report][recovery-doc], [current map][map], [current lock][lock].

## Where the complete plan should live

Use [this guide](README.md) and its linked architecture, implementation and acceptance documents as the complete prospective plan. It should contain the product goal, pinned source basis, architecture decisions, every capability family's owner, work-package dependencies, complete journey acceptance and the performance comparison design. Keep detailed current implementation state in `port-map.json`, revision identity in `upstream.lock.json`, compiler identity in `toolchain.lock.json`, and executable qualification policy in the existing tools. Do not add another mutable status JSON or hand-maintained progress table.

Use `docs/ci-and-porting.md`, `docs/porting/port-map.md` and the repository instructions as navigation and policy pointers. The planner's generated porting queue remains the short-lived upstream-impact artifact. It already states that it does not generate implementations, update pins, accept ports or delete source. The full-system plan should explain the additional work beyond that queue, including unmapped capability families. [Sources: porting planner][porting-planner], [CI documentation][ci-doc], [AGENTS.md][agents].

The map lists both `README.md` and `AGENTS.md` as persistence adapter inputs, so `ci_plan.py` handles navigation changes there as mapped-owner changes before its Markdown exemption and can select Rust/storage qualification. The same caution applies to the mapped storage cutover document. This is a consequence of current source accounting, not a request to weaken the gate. Missing qualified ancestry can independently widen any planned run to full qualification. [Sources: map][map], [CI planner][ci-plan].

The current hybrid workflow triggers on pushes to `main`, `codex/t3code-ls-hybrid-*` and `ci/*`, plus manual dispatch; it has no `pull_request` trigger. A documentation PR's existence alone does not prove a workflow ran. Publication and qualification should report the actual observed result. [Source: hybrid.yml][hybrid].

## Existing PR 1

[PR 1][pr1] was observed open and draft, with head `d456f1cc05f01e6a26098e0f34bb6686d694a551` on `codex/t3-code-ls-provider-session-20261108`. Its body describes an opt-in provider subprocess and explicitly disclaims full application/mobile qualification. Its changed paths use the earlier `native/t3-code-ls` layout and a `nativeCodexProcess.ts` selector. The current pinned main has a later mapped provider route through `CodexAppServerProcess.ts` and the root Rust workspace. It should be treated as historical, unmerged work to reconcile separately, not as acceptance evidence or a dependency that the documentation PR silently absorbs. [Sources: PR 1][pr1], [current provider selector][codex-process], [Cargo.toml][cargo], [port-map.json][map].

## Source links

[fork]: https://github.com/glopyglerky/t3code-ls/tree/3577878a5e008c8af87a8fbdae13d26dea1c2f50
[research]: https://github.com/pingdotgg/t3code/tree/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f
[agents]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/AGENTS.md
[map]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/port-map.json
[lock]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/upstream.lock.json
[readme]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/README.md
[integration]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/porting/default-c7a3f02e.md
[map-doc]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/porting/port-map.md
[core-lib]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/core/src/lib.rs
[storage-lib]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/storage/src/lib.rs
[codex-process]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/provider/CodexAppServerProcess.ts
[native-http]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/app/src/http.rs
[bridge]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/transport/src/bridge.rs
[cargo]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/Cargo.toml
[selection]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/packages/shared/src/nativeExecutable.ts
[server]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/server.ts
[ws]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/ws.ts
[native-runtime]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/orchestration-v2/nativeRuntimeLayer.ts
[runtime]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/orchestration-v2/runtimeLayer.ts
[selected-persistence]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/persistence/SelectedPersistence.ts
[omdb]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/persistence/Omdb.ts
[native-db]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/apps/server/src/orchestration-v2/NativeDatabase.ts
[storage-cargo]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/storage/Cargo.toml
[porting-planner]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/tools/plan-porting.py
[ci-plan]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/tools/ci_plan.py
[hybrid]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/.github/workflows/hybrid.yml
[migration-guard]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/tools/src/migration.rs
[toolchain]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/toolchain.lock.json
[design-doc]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/internals/t3-code-ls.md
[native-api-doc]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/native-api.md
[ci-doc]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/ci-and-porting.md
[recovery-doc]: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/porting/recovery.md
[pr1]: https://github.com/glopyglerky/t3code-ls/pull/1
