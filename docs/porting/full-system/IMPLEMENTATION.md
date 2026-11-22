# Implementation sequence and work packages

This is the execution plan for the architecture in [ARCHITECTURE.md](ARCHITECTURE.md). It defines proposed work, dependencies and acceptance outputs. It does not report completed implementation or successful qualification. Use [CURRENT-STATE.md](CURRENT-STATE.md) for the inspected repository snapshot, [ACCEPTANCE.md](ACCEPTANCE.md) for the complete measurement contract, and [FIRST-SLICE.md](FIRST-SLICE.md) for the initial assignment.

## Keep one set of implementation and qualification records

The existing [port map](../../../port-map.json) owns candidate, integrated, accepted, retired and synced state. The generated porting queue owns source-change discovery and work ordering. The existing exact-source CI receipts and per-platform acceptance receipts own qualification evidence. Work package completion must update those records instead of creating another live checklist.

Follow the repository's [AGENTS.md](https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/AGENTS.md) and [CI and porting policy](https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/docs/ci-and-porting.md). Retain upstream files and capabilities until the replacement runs normally through Rust and has the affected platform evidence. Keep new Rust under its owning application or package. Separate source moves from behavior substitution. A Linux result cannot retire Windows, browser or mobile behavior.

Two qualification details need attention before the first storage substitution. At the inspected fork snapshot, the source guard accepts implementation labels rust and rust-backed-client for accepted routes, while the integrated storage route uses omdb. Reconcile the schema and evidence semantics through [tools/src/migration.rs](https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/tools/src/migration.rs), without relabeling an unqualified route to satisfy a check. The inspected production-change set in [tools/ci_plan.py](https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/tools/ci_plan.py) also omits redb-persistence. Show that storage-only execution changes select the native client flow. A CI policy change itself selects full fork qualification. These are planning findings to recheck at the implementation source revision.

Use the verified packaged Lustr coordinator and produced BlueFe drivers and matching sysroots recorded by the repository. Cargo remains the bootstrap. Keep locked Cargo and frozen pnpm dependencies. Record the real compilation route; rustc-derived BlueFe compatibility does not establish native Lust coverage. Compiler bootstrap/release qualification belongs in the compiler repositories. This document creates no new compiler campaign.

## Candidate roles and execution ownership

| Part | Planned candidate and ownership | Decision gate |
|---|---|---|
| Environment execution | One Rust owner for command decisions, commits, provider/workspace effects and subscriptions | Atomic receipts/events/projections/outbox, bounded scheduling and recovery through production ingress |
| Authoritative native storage | omdb with a prospective backend contract; transactional Fjall first and direct redb as its main competitor | Same domain API, representation and durability; coherent migration, backup, maintenance and recovery |
| Storage control | SQLite behind the same experimental domain operations | Controlled behavior/performance comparison; never native fallback after activation |
| Desktop presentation | GPUI first; Makepad desktop challenger | Whole input, presentation, accessibility, embedded browser and lifecycle outcomes on each supported target |
| Mobile presentation | Makepad with shared Rust state and explicit iOS/Android adapters | Rich input, secure state, offline durability, extensions, background behavior and distribution |
| Browser presentation | Dioxus DOM/WASM with semantic browser elements | Startup, navigation, selection, CSP, workers, caches, accessibility and input |
| External hosts | Browser engines, OS APIs, provider executables and their compatible data formats | Explicit security/lifetime interfaces and dependency inventory |

A toolkit demo does not select a production stack. Keep shared domain/view state independent of a renderer, transport object or database crate. Count retained T3 TypeScript/JavaScript/Swift/Kotlin business behavior as unfinished Rust scope. Inventory native third-party code and generated platform glue separately. Full T3-owned Rust completion does not establish an entirely Rust dependency graph or whole-process memory safety.

## Milestones and dependency order

Dependencies live on the work packages below and in the JSON. Milestones summarize reviewable outcomes; they do not imply strict serialization of independent packages.

| Milestone | Packages | Exit requirement |
|---|---|---|
| M0 Traceable source and measurement contract | T00 | Reconciled generated queue, fixed oracle and budgets, complete ownership mapping, trustworthy qualification selection. |
| M1 Native and browser interface proofs | T01 | Required input, accessibility, browser, terminal and extension behavior demonstrated on actual candidate targets. |
| M2 Durable conversation, history and native state | T02, T04, T03, T05 | Normal Rust conversation/history path, comparable engine results, mixed-protocol recovery and safe native activation. |
| M3 Workspace and terminal completion | T06, T07 | Edit, review, Git/worktree and terminal operations preserve outcomes and failures through actual clients. |
| M4 Provider and automation completion | T08, T09 | Every provider family and automation/tool contract has its own parity and recovery evidence. |
| M5 Remote identity and browser completion | T10, T11 | Connect, trust, guests/peers and the Rust browser preserve authority, storage and route lifecycle. |
| M6 Mobile and integrated media/device completion | T12, T13 | iOS/Android offline/background behavior and every media/browser/device journey work on applicable targets. |
| M7 Native desktop, distribution, maintenance and recovery completion | T14, T15 | All packages, CLI/site entrypoints, updates, steady-state maintenance and recovery satisfy their gates. |
| M8 Complete product qualification and source retirement | T16 | All applicable journeys and targets pass independently before any supported completion claim or scoped retirement. |

T02 is the first executable vertical slice. Dependencies require the production contract and evidence for the current target/profile increment. They do not require premature closure of a predecessor across every target. A retained-client control can use its preserved production interface; a Rust client increment needs the matching input/state/render/lifecycle proof from T01. Complete widgets, mobile extensions and unrelated provider proofs do not block that controlled slice. Full T01 completion gates final platform selection and T16.

T03 can begin after T02's durable JSON-compatible path and the required T04 revision, retained-anchor, snapshot/replay and index interfaces are proven for that profile. It need not wait for every history screen or the entire engine contest. T05 implementation and fault probes follow the same scoped rule. Existing-profile activation still requires all authoritative owners, pending effects, indexes and references in the generation. A partial migration cannot activate.

Workspace, terminal and remote work can proceed where these scoped contracts are ready. No scoped increment closes an entire work package. Each package closes only after its complete applicable capability, failure and platform scope has evidence; T16 joins them all.

## Work package specifications

These packages can become issue bodies or bounded implementation assignments. Each assignment must cite its package ID, journey IDs, exact upstream sources, existing port records, allowed files, dependencies and required evidence. It must own a usable outcome through its production entrypoint. Splitting a package into server-only and client-only tasks does not close it until the combined route works.

The existing-port mappings identify reuse and reconciliation inputs at the inspected fork snapshot. They carry no implementation state. All ten current records have a concrete consuming package outside the source-planning and final-release packages. Recheck their source mappings at the implementation revision.


### T00. Reconcile source ownership and freeze the measurement contract

Milestone M0. Depends on the repository constraints and fixed source identities.

Production entrypoints: port-map.json; upstream.lock.json; tools/plan-porting.py; tools/ci_plan.py; tools/src/migration.rs.

Existing port records: command-and-dispatch-policy, project-commands, guest-share-decisions, provider-recovery, provider-maintenance, codex-structured-generation, codex-process-runtime, redb-persistence, iroh-transport, native-api-component.

Use the existing generated queue to reconcile mapped ports, contracts, retained originals, fork conflicts and clean upstream imports. Keep the research denominator fixed. Assign all 60 journeys, 30 client families and 27 server families to production owners and existing port records. Freeze fixtures, trace boundaries, result equivalence, durability profiles, target budgets and run design before candidate measurement.

Mandatory failure cases:

- Missing or incompatible qualification receipt must widen CI selection.
- A new upstream detection must not silently move the research denominator or imply integration.
- Resolve the accepted-route schema mismatch for the current omdb route using the real source guard and receipt semantics.
- Prove that a storage-only implementation change selects the native client flow. The inspected PRODUCTION_PORTS set does not include redb-persistence. CI policy changes require full fork qualification.

Acceptance evidence:

- Exact source, tree, compiler artifact, dependency lock and CI policy identities.
- A generated queue and CI plan grounded in a verified qualified ancestor, or explicit full qualification when none is available.
- A traceable contract/entrypoint manifest and preregistered per-journey budgets.

Suggested assignment boundaries: One owner for queue, source map and qualification policy changes. A measurement owner can prepare immutable fixtures and trace definitions separately.

### T01. Prove difficult platform interactions in production routes

Milestone M1. Depends on T00.

Production entrypoints: apps/desktop/src/main.ts; apps/mobile/src/Stack.tsx; apps/mobile/modules/t3-composer-editor; apps/web/src/components/ComposerPromptEditorTiptap.tsx; apps/desktop/src/preview/DesktopBrowserHost.ts; apps/mobile/app.config.ts.

Put the shared Rust document/state model through actual composer, terminal, embedded-browser and native-shell entrypoints. Compare GPUI desktop with Makepad desktop using identical state and content; prove Makepad mobile input, accessibility, extension and browser behavior. Exercise Dioxus DOM/WASM with semantic forms and navigation. A selected target proof is a prerequisite for that target, not platform-wide completion. Start the Cursor and Claude native protocol/SDK replacement proofs early, using controlled fixture and source evidence. A blocker in one provider does not block an unrelated controlled conversation proof, but it blocks full Rust completion for that provider.

Mandatory failure cases:

- CJK marked text, UTF-16/byte/grapheme conversion, mixed-direction text, undo and 120k-character drafts where supported.
- Rich-document screen-reader navigation, focus return, scaling and keyboard conflicts.
- Embedded browser clipping, scrolling, popup/file picker, profile isolation, sandboxing and input focus.
- iOS/Android extension lifecycle, process recreation and replacement of mobile OTA/reload assumptions.
- A wrapper protocol around a JavaScript SDK is not evidence of a complete independent native provider interface.

Acceptance evidence:

- Real input-to-presentation traces and semantic accessibility observations on each affected target.
- Working integrated browser content and terminal input, including their lifecycle and cleanup.
- A candidate decision that accounts for licensing, external browser hosts and generated platform glue.

Suggested assignment boundaries: Keep shared text/state contracts under one owner. Desktop GPUI, Makepad and DOM adapters may be assigned separately once those contracts are stable.

Client capability IDs: C05, C07, C12, C17, C18, C22, C23, C26, C27.

Server family IDs: terminal, mcp_apps, preview_browser, devices, provider_runtime.

### T02. Submit, stream, approve, interrupt and reopen a conversation

Milestone M2. Depends on T00, T01.

Required dependency scope:

- T00: Exact source identities, fixed fixture/behavior/durability contract, and trustworthy qualification selection for this increment.
- T01: Only the input/state/render/lifecycle interfaces used by the selected client/profile. A retained-client control uses its existing production interfaces. A Rust client increment requires the corresponding Rust interface proof. Full mobile extensions, every provider and every target are not prerequisites for this scoped slice.

Production entrypoints: orchestration.dispatchCommand; orchestration.subscribeShell; orchestration.subscribeThread; runtime-request.respond; apps/server/src/orchestration-v2; packages/client-runtime; desktop/browser/mobile conversation routes.

Existing port records: command-and-dispatch-policy, project-commands, codex-process-runtime, redb-persistence, native-api-component.

Implement one real conversation path through Rust command ownership, omdb transaction ownership, a controlled captured provider fixture, bounded publication, shared Rust client state and the selected Rust presentation route. Preserve the existing JSON contract first. Commit events, authoritative projections, receipts, indexes and outbox intent atomically. External effects follow commit. Use only an isolated fresh profile until T05 qualifies native activation of existing profiles. Reuse mapped domain/service internals from native-api-component as migration inputs to the normal application route. Its candidate standalone POST /rpc path is not a replacement product or a substitute for the production WebSocket contract.

Mandatory failure cases:

- Disconnect before commit, after commit before acknowledgement and after effect dispatch.
- Duplicate command IDs, failed work inside a coalesced batch, approval rejection, cancellation before provider start and interruption during output.
- Provider completion followed by late finalization, server restart, stale client cursor and slow subscriber.
- No second writer and no retry of an uncertain mutation through another backend.

Acceptance evidence:

- Exact expected visible output, permissions, event order and receipt/effect behavior.
- Submit-to-durable-accept, provider-frame-to-presented-text, acknowledgement-to-effect and reopen-to-current-thread.
- Bounded queues, memory, payloads and encode/decode work under concurrent streams.

Suggested assignment boundaries: One command/transaction owner and one client-state/presentation owner. A third owner can maintain controlled transcript fixtures and recovery evidence without editing the shared contract.

Client capability IDs: C03, C04, C06, C07, C08.

Server family IDs: environment_lifecycle, authorization, orchestration_commands, thread_read_stream, approvals_questions.

### T03. Negotiate revisioned deltas through commit, replay and rendering

Milestone M2. Depends on T02, T04.

Required dependency scope:

- T02: Correct durable JSON-compatible command/stream path for the selected profile.
- T04: Required history revision, retained-anchor, snapshot, replay and index interfaces. Completion of every history/UI case and the entire engine comparison is not required to start this increment.

Production entrypoints: ProviderTextDeltaCoalescer replacement; ThreadStream and WireProjection replacements; connection capability negotiation; shared Rust conversation reducer.

Existing port records: redb-persistence.

Add append, replace and splice semantics only through explicit capability/version negotiation. Persist revisions and chunks with their authoritative header. Update durable event/outbox formats where they retain full prefixes. Reuse encoded bytes only for the same authorized wire representation. Keep old-client JSON behavior intact.

Mandatory failure cases:

- Missing or mismatched base revision, retained-anchor pruning, reordered/duplicate event, completion replacement and stream gap.
- Snapshot recovery during concurrent append and cancellation.
- Old/new client-server combinations and downgrade refusal where schemas are incompatible.
- Slow subscribers cannot retain unbounded chunks or encoded generations.

Acceptance evidence:

- Exact reconstructed state after replay, pruning and restart.
- Per-turn encoded/stored bytes, allocations, frame latency and bounded retained generations for both negotiated and compatibility paths.
- No gain credited to the new protocol when the measured path still writes or sends full prefixes.

Suggested assignment boundaries: One owner for protocol and durable representation evolution. Projection/replay and client application can be separate assignments after schema and recovery rules are fixed.

Client capability IDs: C06, C08, C21.

Server family IDs: orchestration_commands, thread_read_stream.

### T04. Navigate, search and manage large histories with the same storage API

Milestone M2. Depends on T02.

Production entrypoints: orchestration.searchThread; orchestration.searchThreads; orchestration.getThreadFamily; orchestration.getTurnItem; ProjectionStore and thread navigation; projects.mutate; server.getSettings and server.updateSettings.

Existing port records: project-commands, redb-persistence.

Deliver the requested visible history window, fork ancestry, seek/jump, item detail, exact search, sidebar changes and settings through indexed Rust reads and stable client views. Compare transactional Fjall and direct redb behind omdb against a SQLite control with identical domain operations, representation, visibility and acknowledged durability. At the inspected snapshot, omdb is a pinned redb API/engine fork. A Fjall backend requires a prospective backend contract inside that authoritative boundary. Specify transaction scope, snapshots, commit/acknowledgement sequences, error/unknown-outcome semantics and ownership before changing engines. A generic omdb library change belongs in a separately scoped dependency PR with its own source pin and qualification; T3-specific layouts and adapters stay with their application owners. Record exact omdb/redb/Fjall engine and layout identities in each native generation and qualify conversion, reopen, backup and recovery. There is one authoritative store for a selected profile; no parallel independently committed index/database or drop-in crate substitution is assumed.

The pinned omdb source identity is recorded in [CURRENT-STATE.md](CURRENT-STATE.md) and the inspected [storage dependency](https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/crates/storage/Cargo.toml).

Mandatory failure cases:

- Sparse/obsolete cursors, nested forks, retries, superseded items, deletion, late parent changes and concurrent new messages.
- Unicode offsets, punctuation/identifier ranking, stale search generations, cancelled queries and index rebuild visibility.
- Navigation preserves selection, draft, focus and scroll through settings overlays and catch-up.
- Compaction and other writers cannot starve foreground reads.
- Reject a native generation whose engine/layout/schema identity cannot be opened safely. Engine migration must convert a coherent typed state and preserve its transaction/receipt boundary; incompatible files cannot be reused or silently reopened by another engine.

Acceptance evidence:

- Exact results, order, rank/ties, snippets, visibility and source offsets.
- Page/jump/search-to-stable-viewport latency, records and bytes decoded, physical reads, memory and scroll-anchor error.
- Paired engine results under fresh, aged and mixed workloads; no generic SQL-on-redb layer.
- A reviewed prospective omdb backend contract and, if needed, a separately pinned/qualified omdb dependency change. Record current omdb fork, direct redb candidate and Fjall candidate identities without calling the omdb fork a crates.io redb build.

Suggested assignment boundaries: One owner for visible-order/search semantics and differential fixtures. Engine adapters can be separate assignments against the same frozen domain API and durability profile. Client navigation/layout is independently owned after result contracts are fixed. Generic omdb library work has a separate dependency owner and scoped PR; application owners integrate only a verified pinned result.

Client capability IDs: C04, C05, C06, C08, C09, C24.

Server family IDs: thread_read_stream, projects_workspace, checkpoint_fork, settings_maintenance.

### T05. Migrate, activate and recover a coherent native store generation

Milestone M2. Depends on T02, T04.

Required dependency scope:

- T02: Commit, receipt, outbox, process-owner and selected schema identities.
- T04: Required index/reference/reconstruction interfaces for the generation being migrated. Implementation and fault probes may proceed per scope. Existing-profile activation requires all authoritative owners, pending effects and references in that profile; it cannot publish a partial migration.

Production entrypoints: apps/server/src/persistence; apps/server/src/serviceLauncher.ts; desktop/service/SSH lock protocols; CLI doctor and migration routes.

Existing port records: redb-persistence.

Qualify one environment owner or an exclusive offline lease, resumable import, consistent checkpoints, generation manifests, activation fencing and failed-trial restore before activating native authority for existing profiles. Publish a generation only when events, projections, receipts, pending effects, required indexes and referenced assets agree. The preserved SQLite source remains a migration source and cannot become a fallback after native writes.

Mandatory failure cases:

- Kill after each migration/publication/restore stage, low disk, read-only target, corrupt input and legacy identifier collision.
- Concurrent desktop/service/CLI/SSH launch, symlinked store, missing runtime and unsupported schema.
- Candidate schema changes then fails, launcher dies during restore, or a resumed trial attempts to overwrite its original backup.
- Separate failed-trial rollback from a post-commit downgrade.

Acceptance evidence:

- Source preservation, reference integrity, a coherent reopened generation and recovery at the declared visible/durable boundary for the exercised crash class.
- Time to usable state/recovery, progress, downtime and peak additional disk.
- Documented process-crash, OS-restart and power-loss guarantees verified separately for the declared durability profile.

Suggested assignment boundaries: One storage-lifecycle owner owns activation, lock and restore state machines. A fault-injection owner can prepare stage interruption and low-space scenarios against disposable profiles.

Client capability IDs: C21, C27, C29.

Server family IDs: environment_lifecycle, settings_maintenance.

### T06. Edit files, operate Git and complete PR or issue review

Milestone M3. Depends on T04.

Production entrypoints: projects.readFile and projects.writeFile; projects.searchEntries and projects.searchContents; filesystem.*; workspace.*; vcs.* and git.*; review.*; sourceControl.*; pullRequests.*; issues.* and issueTrackers.*; orchestration.launchThread.

Existing port records: project-commands, redb-persistence.

Complete file/tree/search/edit/save, diff review, multi-repository worktrees, checkpoints and host review as visible client journeys backed by the environment workspace owner. Preserve every registered host and its capability differences. Reuse gix where semantics are covered. Explicit Git subprocess paths preserve working behavior during migration; qualify the intended gitr dependency when it can satisfy the same operation and platform matrix. Record retained external Git execution and completed native Rust operation coverage separately. A wrapper or partial Git library cannot establish complete native Git workflow coverage.

Mandatory failure cases:

- External edit during save, save echo, revoked file grant, readonly external file and retained unsaved edits.
- Dirty repositories, hooks/filters/config/credentials, submodules, conflict, linked-worktree invalidation and partial multi-repository rollback.
- Large file/line, Unicode, cancellation, stale status and uncertain remote host mutation.

Acceptance evidence:

- Correct file contents, paths, branch/worktree ownership, checkpoints and host/account routing.
- First usable diff/list, edit-to-paint, save-to-confirmation, status/action latency, process count, CPU and memory.
- Optimistic feedback converges to authoritative completion or visible rollback without duplicated actions.

Suggested assignment boundaries: Files/diff, Git/checkpoints and host review can be separate vertical assignments. Each assignment owns its client route and server operation together; shared workspace identity stays under one owner.

Client capability IDs: C09, C10, C11, C20.

Server family IDs: thread_launch, projects_workspace, files_search_attachments, git_review, source_control, pull_requests, issues, checkpoint_fork.

### T07. Use and reconnect a real terminal under contention

Milestone M3. Depends on T01, T02.

Production entrypoints: terminal.*; subscribeTerminalMetadata; packages/client-runtime/src/state/terminalOutput.ts; packages/client-runtime/src/state/terminalSession.ts; desktop/web/mobile terminal routes.

Implement PTY ownership, terminal state, transport, native/WASM rendering and input as one journey. Preserve the optimized stock Ghostty behavior and bounded attach history. Advance a replay cursor only after the destination accepts the write.

Mandatory failure cases:

- Disconnect inside UTF-8 or control sequence, partial native write rejection, missing/stopped terminal and server restart.
- Burst output, alternate screen, terminal query replies, mouse/focus protocols, IME, paste, resize/DPI and selection.
- Saturated chat/diff/media work, cancellation and reconnect without an unintended new shell.

Acceptance evidence:

- Byte and parser-state equivalence, bounded replay and attach-to-correct-screen.
- Input-to-echo, output-to-pixels, frame tails, process CPU, memory and protocol bytes.

Suggested assignment boundaries: One terminal core/protocol owner. Platform render/input adapters can be separate after the state and write-ack contract is fixed.

Client capability IDs: C12, C13, C20.

Server family IDs: terminal.

### T08. Complete every provider family, session transition, usage view and import

Milestone M4. Depends on T02, T04, T06.

Production entrypoints: provider driver registry and per-instance interfaces; provider.auth.* and provider.install.*; server.refreshProviders and server.updateProvider; provider.switch and thread.fork; agentSessions.scan and agentSessions.import; server.getUsageSummary; packages/provider-*.

Existing port records: provider-recovery, provider-maintenance, codex-structured-generation, codex-process-runtime.

Port each declared provider family and instance lifecycle using its actual protocol, permissions and supported/refused actions. Include setup, accounts/models, resume/fork/steer/rewind, questions, goals/background children, usage and external-history import. Keep provider-owned SQLite/SDK state behind its compatibility contract. Cursor and Claude SDK replacement proofs are explicit release blockers for full T3-owned Rust completion.

Mandatory failure cases:

- Missing/moved provider state, native IDs, account/home isolation, startup/exit races and late child work.
- Correct refusal before file rollback for a provider that cannot restore conversation state.
- Large live-WAL usage sources, giant payload rows, repeat/partial import and corrupt records.
- Vendor-specific approval option IDs, native versus asynchronous questions and provider-specific steering constraints.

Acceptance evidence:

- Per-provider captured transcript conformance through adapter, orchestrator and visible projection.
- Resume/import/first-usable-summary latency, fairness, peak memory and bounded decode work.
- A generic ACP substitute or retained T3 JavaScript SDK controller does not close a richer provider contract.

Suggested assignment boundaries: Assign one provider family or tightly related protocol family per owner. Keep provider registry, capability truth and shared recovery coordination under one integrator.

Client capability IDs: C03, C08, C24, C29.

Server family IDs: provider_runtime, approvals_questions, checkpoint_fork, agent_import, usage_observability.

### T09. Run approvals, delegation, schedules, webhooks and MCP tools safely

Milestone M4. Depends on T02, T06, T08.

Production entrypoints: runtime-request.respond; delegated_task.*; subagent.stop; orchestration.getNativeChildWork; orchestration.stopWorkflow; scheduledTasks.*; webhook HTTP; /mcp and ACP stdio bridge; mcpApps.*.

Existing port records: command-and-dispatch-policy, provider-recovery.

Complete the durable command-to-effect path for approvals, questions, secrets, delegation, plans/goals/workflows, scheduled work and external tool callers. Tool discovery must agree with execution authorization. Preserve thread credential scope, mode ceilings, native child identity and post-turn work.

Mandatory failure cases:

- Restart during claim/effect/finalization, lease loss, duplicate webhook, ambiguous delivery and expiration.
- Timezone/DST transition, host offline, rate/backlog caps and exact-body signature verification.
- Cancelled/changed parent run cannot misroute child completion.
- Denied MCP app tool action or guest/peer request cannot gain general RPC authority.

Acceptance evidence:

- One intended external action or an explicit unresolved/reconciled outcome when the external protocol cannot prove exactly-once execution.
- Acknowledgement-to-effect, due/arrival-to-action, wake/replay time and bounded backlog under contention.
- Permission, receipt-retention, cancellation and cleanup evidence through actual clients or authorized external callers.

Suggested assignment boundaries: Local automation/effect ownership and MCP authorization can be separate assignments. Remote delivery scenarios join T10 and mobile background completion joins T12.

Client capability IDs: C08, C17.

Server family IDs: approvals_questions, delegation_workflows, thread_launch, mcp_tools, mcp_apps, schedules_webhooks.

### T10. Connect remote clients, guests and linked environments with preserved trust

Milestone M5. Depends on T02, T04.

Production entrypoints: auth and connect HTTP; infra/relay; apps/server/src/cloud and apps/server/src/relay; packages/client-runtime/src/connection; guestShare.* and dedicated guest HTTP; peerLinks.*; linked MCP calls.

Existing port records: guest-share-decisions, iroh-transport.

Implement Connect accounts, registration/pairing, token/proof handling, broker/route lifecycle, revocation, notification delivery and host wake. Add LAN, SSH, Tailscale and iroh route adapters without changing environment identity or execution authority. Preserve guest proposals and read-only links, peer scopes and browser-compatible routes.

Mandatory failure cases:

- Concurrent proof consume, expired/revoked credentials, stale endpoint generation and account switch.
- Direct-to-relay route changes, tunnel interruption, offline host, duplicate wake/job and ambiguous mutation delivery.
- Wrong environment, revoked guest link, permission ceiling mismatch and immutable-origin fence failure.

Acceptance evidence:

- Exactly one replay claim where required, correct authorization and no credential/host confusion.
- Connect/resume-to-authoritative-thread, auth and delivery tails, recovery traffic and background energy.
- Iroh byte forwarding alone cannot retire Connect identity, browser access or client lifecycle.

Suggested assignment boundaries: Identity and broker state stay under one owner. Transport routes, guest/peer services and notification/wake delivery can be separate assignments against that authority model.

Client capability IDs: C03, C04, C20, C22, C28, C29.

Server family IDs: environment_lifecycle, authorization, guest_share, peer_links, schedules_webhooks.

### T11. Complete the Rust browser client, storage and hosted entry routes

Milestone M5. Depends on T01, T04, T10.

Production entrypoints: apps/web entry/router; packages/client-runtime; apps/web/src/connection/storage.ts; apps/web/src/composerDraftStore.ts; apps/web/src/browserHistoryStore.ts; pair/connect/welcome/guest routes.

Deliver the browser through Dioxus DOM/WASM with semantic navigation, forms, selection and accessibility. Preserve hosted/local/guest entry, auth callbacks, caches, settings, drafts, multi-tab merge, route history and user-visible denied-storage behavior. All imported capability views remain connected to their owning packages.

Mandatory failure cases:

- IDB denied/full/blocked/closed/versionchange, stale or oversized cache, concurrent tabs and stale build tab.
- A stale unrelated save cannot restore a revoked grant or erase another draft edit.
- Slow CPU/network, WASM load/compile failure, CSP, worker failure, expired deep link and background/resume.

Acceptance evidence:

- First useful and interactive page, correct authorized destination and authoritative freshness.
- Asset/compile bytes and CPU, cross-boundary traffic, memory and input/frame tails.
- Correct offline cache behavior, quota bounds, draft survival and browser screen-reader semantics.

Suggested assignment boundaries: Browser boot/navigation/storage can be one vertical assignment. Feature renderers remain owned with their workspace/terminal/media packages; a browser integrator closes whole-client parity.

Client capability IDs: C03, C04, C05, C06, C07, C09, C11, C12, C13, C14, C15, C17, C18, C20, C21, C23, C24, C28, C29, C30.

Server family IDs: environment_lifecycle, authorization, thread_read_stream, guest_share.

### T12. Complete native mobile offline work, secure state and background integrations

Milestone M6. Depends on T01, T04, T10.

Production entrypoints: apps/mobile/src/Stack.tsx; apps/mobile/src/persistence; apps/mobile/src/state/thread-outbox-storage.ts; apps/mobile/src/connection; apps/mobile/app.config.ts; mobile notification/widget/Live Activity integrations.

Deliver iOS and Android through shared Rust state and Makepad/platform adapters. Preserve cached work, durable drafts/outbox/attachments, preference recovery, secure keys, adaptive navigation, account removal, push, notification actions, widgets and Live Activities. Preserve store/update and app-resume behavior without assuming JavaScript OTA compatibility.

Mandatory failure cases:

- Offline restart, app kill/update mid-write, low-memory recreation, orientation/fold and hardware keyboard changes.
- Database unavailable, newer/older secure preference fallback, failed cleanup and corrupt individual outbox file.
- Foreground silence, notification tap after OS process death, account signout and extension expiry.

Acceptance evidence:

- Recovered unsent content, correct environment scope and one converged send after reconnect.
- Useful-offline-screen, reconnect, tap-to-correct-thread and durable draft-flush latency.
- Native allocations, invisible view retention, energy and background network; separate iOS and Android evidence.

Suggested assignment boundaries: Shared durable mobile state has one owner. iOS and Android extension/input/package adapters can be separate once lifecycle contracts are fixed.

Client capability IDs: C03, C04, C05, C07, C08, C14, C15, C20, C21, C22, C23, C24, C27, C28, C29.

Server family IDs: environment_lifecycle, authorization, thread_read_stream.

### T13. Use attachments, voice, capture, browser content and devices

Milestone M6. Depends on T01, T06, T07, T09, T10, T11, T12.

Production entrypoints: assets.* and attachments.*; voice HTTP and speech stream; desktop SnapShot IPC; preview.* and preview streams/tunnels; mcpApps.*; device.* and device hub proxy; client document/media viewers.

Complete rich paste/drop/camera/share, document/media viewing and search, dictation, SnapShot, integrated previews, scripted HTML/MCP Apps and simulator/device control. Keep real browser engines and OS codecs behind Rust-owned lifecycle/security interfaces. Count startup, native bridge and browser-host costs in the user journey.

Mandatory failure cases:

- Huge/hostile files, format limits, cancellation, grant revocation and source-owned readonly files.
- Microphone denial/loss, app interruption, concurrent draft edits and failed selected speech destination.
- Browser storage/origin isolation, passkeys, files/downloads/popups, control lease, malicious app bridge and remote-loopback routing.
- Device permission denial, hidden/PIP stream, network loss and preview-close/device-lifetime semantics.

Acceptance evidence:

- First page/frame/table/search hit, capture-to-context, stop-to-editable-transcript and input-to-preview-frame.
- Correct target environment/workspace and explicit speech destination; no automatic send or silent host fallback.
- Bounded caches/media streams, CPU/memory/energy/bitrate, permissions and cleanup.

Suggested assignment boundaries: Document/media, voice/capture, browser/MCP App and device control are separate vertical assignments. Each owns server or native-host operation plus all applicable client controls and failure cases.

Client capability IDs: C07, C14, C15, C16, C17, C18, C19, C20, C23, C26, C29.

Server family IDs: files_search_attachments, mcp_tools, mcp_apps, preview_browser, devices, speech.

### T14. Complete native desktop and deliver installation, CLI and updates

Milestone M7. Depends on T05, T08, T10, T11, T12, T13.

Production entrypoints: apps/marketing; scripts/install.sh and scripts/install.ps1; apps/server/src/cli; apps/server/src/serviceLauncher.ts; apps/desktop/src/main.ts; apps/desktop/src/updates/updateMachine.ts; mobile package/store entrypoints; docs/user and docs/operations; apps/desktop complete native view/navigation/window integration.

Existing port records: provider-maintenance.

Deliver Rust-generated static discovery/download pages and progressive controls, signed platform packages, install/first-run, launcher/service ownership, complete CLI, remote-only desktop, SSH/WSL and safe update/uninstall. Preserve localized/help/legal/security links, package-manager ownership and existing state. Run update activation through T05 recovery primitives. The desktop integrator composes every accepted vertical route into one complete GPUI or Makepad desktop client, including windows/panes, navigation, commands, settings, shortcuts and focus. It owns cross-route state, lifecycle, accessibility and client parity on every desktop target. T01 interface proofs do not close whole-desktop integration.

Mandatory failure cases:

- Release API unavailable, incorrect OS/architecture route, signature/checksum failure, interrupted download/extract and unrelated existing t3 command.
- Secure credential/catalog failure, expired callback, headless device flow, conflicting server owner and missing target runtime.
- Piped stdin, JSON/token-only output on success/failure, --wait needs-input, NO_COLOR, TTY differences, signals and private SSH helper frames.
- Switching between feature views, windows, settings and modal commands must preserve drafts, focus, selection, navigation and active environment identity.

Acceptance evidence:

- Useful static content without app runtime, correct downloads and usable signed installation per target.
- Launch-to-interactive composer/current workspace, CLI process/RPC latency and valid stdout/stderr/exit behavior.
- Update-to-ready and recovered prior-version time, downtime, ownership-safe uninstall and retained credentials/state.
- One complete native desktop client with cross-route parity on each desktop target, including native accessibility, shortcuts, window lifecycle and background resource behavior.

Suggested assignment boundaries: CLI/launcher/service, desktop packaging, mobile distribution and static site/docs can be separate assignments. One release owner coordinates version/schema compatibility and activation. One native-desktop integrator owns complete view composition and cross-route parity.

Client capability IDs: C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C23, C24, C25, C26, C27, C28, C29, C30.

Server family IDs: environment_lifecycle, authorization, settings_maintenance.

### T15. Maintain aged state and preserve recovery and developer cache contracts

Milestone M7. Depends on T04, T05, T08, T09, T10.

Production entrypoints: server.runStorageCleanup; server.getDatabaseStorage; server.reclaimDatabaseSpace; doctor/rebuild/backup/restore routes; infra/task-cache; infra/relay maintenance.

Existing port records: redb-persistence.

Qualify sustained retention, compaction, index rebuild, storage cleanup, export/checkpoint and documented restore while foreground work continues. Preserve historical usage facts and pending effects. Port owned task-cache policy/publication/accounting logic while keeping D1/R2/provider contracts distinct from the environment store.

Mandatory failure cases:

- Days of churn, cache eviction, concurrent uploads/updates, low space, corrupt backup and read-only restore target.
- Offline environment removal with drafts/outbox/uploads/incoming shares and partial cleanup failure.
- Competing cache generations, quota exhaustion, interrupted upload/GC and duplicate telemetry receipt.

Acceptance evidence:

- Foreground p95/p99, write amplification, disk growth/reclamation and bounded CPU/I/O duty in steady state.
- Recovered IDs/references/authoritative data, ownership-scoped cleanup and documented progress/downtime.
- Task output restore time, atomic ready-generation publication, policy/auth preservation and no duplicate savings accounting.

Suggested assignment boundaries: Store maintenance/recovery, environment cleanup and remote task-cache services can be separate assignments. No owner may substitute a cache disposal rule for durable draft, permission or accounting state.

Client capability IDs: C21, C24, C27, C29.

Server family IDs: thread_read_stream, settings_maintenance, usage_observability.

### T16. Qualify the complete product and retire only accepted scopes

Milestone M8. Depends on T00, T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15.

Production entrypoints: normal installed desktop/browser/mobile/CLI entrypoints; existing generated CI plan and platform acceptance receipts; port-map.json source-retirement mapping.

Existing port records: command-and-dispatch-policy, project-commands, guest-share-decisions, provider-recovery, provider-maintenance, codex-structured-generation, codex-process-runtime, redb-persistence, iroh-transport, native-api-component.

Run the complete Rust product against pinned stock upstream on all applicable journeys and targets. Complete cross-device working days, aged-state mixed load, recovery and compatibility. Update only canonical port records and their exact-source receipts. Retire upstream implementation only for demonstrated accepted platform scopes, retain its mapping, and continue generated upstream review.

Mandatory failure cases:

- Any unimplemented route, unsupported promised target, T3-owned non-Rust business logic, missing provider contract or unqualified update/recovery path blocks the corresponding completion claim.
- Aggregate speedup cannot conceal a broken journey or material regression.
- An API/component pass cannot establish UI, platform, whole-process memory safety or native Lust coverage.

Acceptance evidence:

- Every applicable journey has output/failure equivalence, normal Rust execution proof and preregistered performance/resource results.
- Exact successful CI and platform receipts, compatibility matrix, source/dependency inventory and attributable release evidence.
- J33 and J60 aggregate results alongside all 58 component journeys, with uncertainty and absolute values.

Suggested assignment boundaries: One release integrator owns the product-wide evidence join and retirement decision. Feature owners supply their scoped receipts; a separate review assignment checks missing scope and unsupported claims.

Client capability IDs: C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25, C26, C27, C28, C29, C30.

Server family IDs: environment_lifecycle, authorization, orchestration_commands, thread_read_stream, provider_runtime, approvals_questions, checkpoint_fork, delegation_workflows, thread_launch, projects_workspace, files_search_attachments, terminal, git_review, source_control, pull_requests, issues, mcp_tools, mcp_apps, schedules_webhooks, guest_share, peer_links, preview_browser, devices, speech, usage_observability, settings_maintenance, agent_import.

## Agent handoff and review rules

The package boundaries support parallel work only when the active task authorizes it. Use the repository's supported worker lifecycle, verified settings and bounded concurrency. Do not create workers for a bounded solo assignment. Give one owner each mutable shared contract, source-map edit, compiler policy and activation state machine. Other assignments consume those contracts and return a focused change/evidence set.

A work assignment should contain the exact source/base identity, targeted capability and journey IDs, production entrypoint, allowed ownership paths, already-satisfied dependencies, explicit failure cases, expected observable outputs, generated qualification plan and stopping conditions. Record first failures and unresolved external protocol requirements. An implementation owner must not change a budget or remove a scenario merely to produce a favorable result.

Review in this order: preserved behavior and authority; genuine production Rust execution; recovery and platform coverage; then performance and resource results. Update canonical port state only when the existing schema and required receipts support the transition. Missing evidence widens qualification. Retain required originals and their provenance until that transition is valid.

The final claim is supported by the complete product path, not a sum of component speedups. Publish J33 and J60 working-day results with every individual journey so a favorable aggregate cannot hide a broken or slower required capability.
