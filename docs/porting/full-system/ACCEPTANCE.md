# Complete product acceptance

This is an implementation and acceptance plan. It reports no product measurements, completed port, passed gate or release qualification. The controlling scope is the complete Rust product described in [ARCHITECTURE.md](ARCHITECTURE.md), including every existing client, provider, workspace function, hosted service and installation path.

The fixed behavior and performance denominator is stock [pingdotgg/t3code at 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f](https://github.com/pingdotgg/t3code/tree/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f). The fork's current performance is not the denominator. [CURRENT-STATE.md](CURRENT-STATE.md) distinguishes the fork snapshot, integrated upstream revision, research revision and later detected upstream revision. A later detection does not revise this campaign or establish reviewed behavior.

The original journey rows, adverse conditions and behavioral requirements remain normative: [journeys 1-33](research/database/nonserver/performance-acceptance-matrix.md) and [journeys 34-60](research/clients/performance-acceptance-extension.md). The companion [journeys.json](journeys.json) retains their complete conditions and acceptance text and assigns all 60 journeys. [work-packages.json](work-packages.json) maps every researched client and server family to the implementation packages. These are static requirements indexes. They have no implementation status or test result. Historical appendix prose about project scope, implementation sequence or performance thresholds defers to this complete full-system plan. Browser, mobile, relay and task-cache replacement remain in product scope.

## Comparison and evidence contract

Run these configurations as controlled experiments. Record which route actually ran.

| Configuration | What it establishes |
|---|---|
| Pinned stock upstream, optimized normal build and applicable stock client | Primary denominator and behavior oracle |
| Rust domain/server with SQLite control and retained client | Server/scheduling/representation contribution, not completed Rust client scope |
| Same Rust server/domain through omdb/Fjall and omdb/direct redb | Engine contribution with equal operations, layout and acknowledgement guarantees |
| Each Rust client against the same Rust server/store | State, transport and presentation contribution for that platform |
| Complete Rust candidate through normal installed entrypoints | Product acceptance, including process topology, maintenance, idle use, restart and update |

Do not rerun pristine upstream test suites to qualify upstream. Use immutable upstream source as the behavior oracle for differential tests of replacements and adapters. Performance observation of the stock production journey supplies the requested denominator. Controlled provider transcripts must reproduce real captured protocol behavior; no paid provider turn or personal credential is needed.

For each journey, freeze the fixture content, result semantics, visibility, provider transcript/cadence, viewport, network, hardware/filesystem, process topology, build mode, concurrency and durability profile. Define fresh, typical and large/aged corpora. Vary both object count and individual payload size. Keep cold OS cache, cold process with warm filesystem, warm application, invalidated cache and offline cached state separate. Alternate configuration order and retain raw measurements and sufficient repetitions for uncertainty. A handful of observations does not support a p99 claim.

The trace should identify the real critical path. Record input, admission/queue, command decision, durable commit, acknowledgement, effect dispatch, provider arrival, publication, encoding/transport, client application, layout and actual presentation where applicable. Overlapping spans do not simply add. Separate external model, network and identity-provider wait from T3-owned overhead. A CPU render timestamp does not establish that a frame reached the display.

Every applicable journey needs:

- Exact visible results, order, authorization, error behavior, cancellation and cleanup.
- Normal execution through the intended Rust production owner, with no hidden legacy business algorithm.
- p50/p95/p99 user-outcome latency and longest stalls, plus first useful result and final completion where they differ.
- Offered load, queue time, throughput, fairness and cancellation cost for concurrent work.
- Per-process and total CPU, peak/retained memory, allocation work, encoded/network bytes, physical storage I/O and growth.
- Presented/dropped frames for UI work, and energy/idle wakeups/background runtime for relevant native/mobile flows.
- Recovery time and state integrity for the journey's failure cases.

Before candidate results, T00 records an absolute budget and maximum acceptable regression for each applicable interaction/platform profile, together with the minimum practically meaningful improvement on the named target journeys. Derive those values from stock observations and expected interaction quality. Do not invent millisecond limits or claim an improvement percentage from source inspection. Release requires credible improvement on the chosen dominant journeys, no unexplained material regression elsewhere, and bounded steady-state resources.

The [stock startup workflow](../../../.github/workflows/stock-startup.yml) samples J01 for a built Linux server and browser with a fresh profile and no configured agent. It times the server descriptor and web entry, then follows the server's one-time pairing link in headless Chrome. The probe records the authenticated welcome screen and the first usable workspace after normal onboarding. It verifies the browser session and a visible, enabled Add project control. Chrome starts before server timing begins, and the runner leaves filesystem caches unmanaged. Evidence includes raw samples, browser versions and build hashes. Desktop installation, cold browser-process launch and other platform profiles need their own evidence.

#### J01 repeated Linux browser startup

Use the [qualified stock measurement](https://github.com/glopyglerky/t3code-ls/actions/runs/45084626662) for the repeated-trial browser profile. It ran the pinned stock tree with Node `26.13.1` and Chrome and ChromeDriver `157.0.8103.78` on Linux x86-64. All seven fresh homes applied migration 107 and reached an authenticated workspace. The first trial reached the workspace in 5.543 s. The remaining six reached it in 3.482–3.544 s with a median of 3.510 s. Keep the first trial in the receipt as its own observation. The run did not control filesystem cache state.

For this profile, set the repeated-trial median limit at **3.60 s** from server spawn to the visible, authenticated workspace. This rounds the observed repeated-trial maximum up to the next tenth of a second. Allow at most **90 ms** median regression against the paired stock median and require a gain of at least **100 ms** to count improvement on this span. The improvement threshold exceeds the observed 62 ms repeated-trial spread. Every trial must open an authenticated workspace with the expected durable identity and an enabled Add project control.

Before comparing a candidate, repeat the stock control on the same runner profile and alternate stock and candidate trials in at least two batches. Start each server with an empty home and each test with the same browser mode and version. Compare equivalent acknowledgement guarantees separately from stricter durability. Record first trials separately and retain failed trials. If the repeated stock median exceeds its observed envelope, investigate the changed conditions before applying these limits. This sample supplies a median budget for the repeated browser profile. First-run and tail budgets still need measurements.

Correctness gates admit no loss outside the declared durability/failure contract, authority escalation, accidental duplicate uncertain mutation, broken promised capability or unsafe restoration of an older authoritative generation. Non-idempotent external protocols may leave an explicitly unknown outcome. Reconcile or expose that uncertainty; never turn it into an unqualified automatic retry.

### Durability and compatibility are independent dimensions

Label each store/cache/profile by the state it promises to retain and its acknowledgement point. An asynchronous read cache can be disposable. Unsent drafts, accepted command receipts, revocations and pending effects have different contracts. Compare equal durability, including sync/checkpoint work and background maintenance. A stock WAL/NORMAL-matching profile may permit recent acknowledged commits to be lost after an OS crash or power loss. A strict persistence profile has a stronger contract and must be measured separately. Record process-crash guarantees and OS/power-loss limits explicitly; neither profile inherits the other's guarantee or performance result. The [pinned database policy](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/persistence/Sqlite.ts) is the source of the stock failure contract.

Exercise cancellation, process termination, OS restart and power-loss persistence as separate classes. A process-kill result does not prove power-loss durability. Inject interruption before and after commit, effect dispatch, migration publication, update activation and restore markers. Restore must reopen one coherent generation, including required logs/indexes/blobs and references.

Keep existing public JSON behavior for old clients. Negotiate new deltas explicitly. Exercise old/new server-client combinations, missing-base resync, snapshot/replay boundaries, schema refusal and safe upgrade/downgrade behavior. Select a backend before execution. After native activation, the old SQLite source cannot receive fallback writes or replace newer accepted state.

### Platform scope

Use all targets in the canonical port map: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64, browser, ios and android. Resolve supported OS versions, browser engines, device classes and distribution variants from the preserved upstream contract at implementation time. Do not treat those target labels as evidence that a toolkit supports them.

For each journey, mark applicability with a source-based reason. A desktop capture feature need not become a browser feature, but a missing implementation cannot become an invented exclusion. Native input, accessibility, secure storage, browser composition, media, background extensions and packaging need target-specific evidence. WSL, SSH, headless service and remote-only desktop modes require their own relevant variants.

## Complete journey mapping

Every row retains its original ID. The first package listed owns the end-to-end evidence join; the other packages contribute required behavior. T00 applies to every measurement. T01's input/accessibility/lifecycle proofs constrain every affected client package. T16 requires the whole applicable matrix. All original adverse conditions remain required even where this compact table shows only the outcome and measure; the original matrices and JSON retain the complete text.

| ID | Journey | Packages | Required outcome and measurement |
|---|---|---|---|
| J01 | Start a new desktop/server install | T02, T05, T14 | Time to server readiness and usable UI; correct initial identity/credentials; include native process/startup overhead |
| J02 | Reopen a mature workspace | T04, T11, T14 | Time to cached first paint, authoritative shell and selected thread; bound CPU/RSS, distinguish background warming |
| J03 | Resume a long current conversation | T02, T04 | Time to newest meaningful content and interactive composer, stable ordering/cursors, no eager full-history decode |
| J04 | Scroll backward, jump and find within a thread | T04, T03 | p95 page/jump latency and bytes decoded; no duplicates, missing boundaries or inconsistent snapshot |
| J05 | Global/thread search | T04 | Match/rank/snippet parity and p95 latency; measure index freshness after edits/deletes and rebuild visibility |
| J06 | Send one message and stream a response | T02, T03 | Submit-to-durable-accept, first visible response, UI frame budget, disk/CPU per completed turn; correct event/projection/receipt/outbox visibility |
| J07 | Run several agents concurrently | T02, T08, T09 | Tail latency and fairness, throughput at saturation, cancellation cost; no writer starvation or unbounded backlog |
| J08 | Retry after disconnect or ambiguous response | T02, T03, T10 | Exactly intended command effect via receipts/idempotency; replay/reconcile time and bytes, no lost accepted work |
| J09 | Switch provider, resume or fork | T08, T06, T04 | Resume latency and context/history parity; preserve Cursor storage workspace and provider native IDs |
| J10 | Sidebar/project/thread management | T04 | Time to consistent sidebar/UI update and durable mutation; exact rank/tie handling, bounded modified records |
| J11 | Approve work, execute outbox effects, schedule tasks | T09, T08 | Acknowledgment-to-effect latency; correct claims/retries/receipt retention and no accidental duplicate external action |
| J12 | PR/issue workflows and VCS | T06 | Time to usable content; cache-hit/miss split, invalidate linked-worktree refs, retain viewed/review state |
| J13 | CLI while server is running | T14, T02 | End-to-end CLI latency and contention; owner RPC identity/auth/permissions equivalent; no accidental second writer |
| J14 | CLI with server stopped | T14, T05 | Lease acquisition and useful completion time; refuse conflicting owner and preserve targeted home; release on crash |
| J15 | Offline mobile startup and reconnect | T12, T10 | Time to useful offline view; no old-environment leakage, correct discarded cache behavior and reconnect convergence |
| J16 | Mobile draft/outbox durability | T12, T02 | Draft/message recovery and flush latency; partial file corruption isolated, attachment references preserved, no premature cleanup |
| J17 | Mobile database failure and recovery | T12 | Preferences retained and reconciled; startup latency/error behavior; caches may miss without losing settings or drafts |
| J18 | Browser cache quota and connection churn | T11 | Responsive UI and actionable fallback; stale oversized snapshot removed; pruning bounds and retry behavior |
| J19 | Multi-tab browser editing and trust changes | T11, T10 | Cross-tab convergence and write cost; stale unrelated saves cannot restore revoked trust or erase unrelated draft edits |
| J20 | Desktop credential/catalog migration | T14, T10 | Unlock/read/write/startup latency; no silent plaintext downgrade, preserved quarantine/recovery copy |
| J21 | Provider usage dashboard | T08, T15 | Time to usable usage summary, event-loop delay/RSS, bounded row/body decode, correct fork/compaction/account semantics |
| J22 | Import provider projects/history | T08 | Discovery/first-thread/full import time, bounded memory, repeat import idempotency and ownership checks |
| J23 | Inspect SQLite attachment or import browser cookies | T13, T08 | Time to first table/page or import result; readonly source, viewer limits, correct cookie scope and no provider format mutation |
| J24 | First native migration or older-version upgrade | T05, T14 | Time to usable app, progress and peak disk use; source preserved, resumable work, atomic publication of coherent native generation |
| J25 | Service update succeeds | T05, T14 | Total interruption and time to ready; coherent backup/checkpoint and candidate readiness; do not overwrite original trial backup |
| J26 | Failed update/rollback/restart | T05, T14 | Time to recovered usable prior version; marker/manifest prevents partial restore; separate failed-trial rollback from post-commit downgrade |
| J27 | Long-running retention/compaction | T15, T04 | Foreground p95/p99 during maintenance, write amplification, growth/reclamation; preserve required history and bound disk/CPU duty |
| J28 | Doctor/rebuild/repair/backup-restore | T05, T15 | Completion/progress, downtime, peak extra disk; preserve authoritative data, IDs, references and documented recovery guarantees |
| J29 | Environment removal and attachment cleanup | T15, T12, T11, T13, T10 | Correct retained/deleted owned data, independent cleanup completion; no cross-env deletion or dangling live references |
| J30 | Remote relay identity/notification path | T10, T12 | Auth/delivery tail latency under concurrency; one successful replay claim, correct revocation/claim/identity semantics |
| J31 | Offline webhook hold and wake | T09, T10 | Durable hold ack latency, wake-to-delivery, bounded backlog; preserve IDs for ambiguous retry and conditional cap enforcement |
| J32 | Task-cache developer/CI path | T15 | Time to restored task outputs and full command result, R2/D1 work; atomic publication, policy/auth preserved, no duplicate savings |
| J33 | End-to-end representative working day | T16 | Weighted user time, worst-tail interactions, CPU/RSS/storage/energy; no isolated win that makes dominant workflows worse |
| J34 | Discover and install | T14, T11 | Time to readable useful content and correct download action; correct OS/architecture/store, locale/SEO links and graceful release lookup fallback. Measure total transfer and main-thread work, not just WASM render time. |
| J35 | First native desktop launch | T14, T02, T10 | Launch-to-window, launch-to-interactive composer, authoritative workspace ready; process count, peak/retained RSS and startup CPU. Keep cached paint separate from usable authenticated state. |
| J36 | First browser session | T11, T10 | Time to useful and interactive page, asset bytes, parse/compile work, pairing/account correctness, route restoration. A native desktop result cannot substitute for web acceptance. |
| J37 | Type and compose under load | T01, T02, T03 | Key/composition-to-paint p50/p95/p99 and longest stall; caret, selection, exact Markdown source, undo and accessibility parity. No accidental send during composition. |
| J38 | Rich paste and file drop | T13, T12 | Time to editable/visible result and retained bytes; preserve source/context identity, upload progress, size limits and folder-versus-file semantics. Typing must remain responsive. |
| J39 | Stream and scroll a long conversation | T03, T04 | Arrival-to-visible text, frame-time tails, scroll-anchor error, CPU and allocations; no forced follow-end, duplicated rows, incorrect source offsets or stale selection. |
| J40 | Switch and return to work | T04, T11, T12 | Time to stable visible destination and interactive editor; preserve draft, selection, scroll, route and focus; bounded mount/layout/update counts. Do not step through obsolete catch-up states. |
| J41 | Review a large diff | T06 | First useful viewport, scroll/jump/search latency, frame tails and memory; line/anchor correctness, viewed state and cancellation. Preserve existing worker and native-layout advantages. |
| J42 | Edit and save a file | T06 | Edit-to-paint and save-to-confirmation; no editor reset on an echo, correct conflict/readonly outcome, retained unsaved edits and stable selection. |
| J43 | Run Git and worktree actions | T06 | Click-to-usable status and operation completion, process count and filesystem work; same safety, worktree ownership and error/confirmation behavior. Measure warm unchanged refs separately. |
| J44 | Complete PR/issue review | T06 | Time to usable content and immediate mutation feedback, authoritative completion and rollback; correct host/account routing and no duplicate uncertain action. |
| J45 | Interactive terminal during contention | T07 | Input-to-echo and output-to-pixels p50/p95/p99, frames/CPU/RSS and protocol correctness. Preserve terminal mode, query reply routing and alternative screen behavior. |
| J46 | Reconnect and recover terminal | T07, T10 | Attach-to-correct-screen, bytes, recovery time and replay count; exact bounded output/order and no spinning retry, corrupted parser state or unintended shell restart. |
| J47 | Open and search media/documents | T13 | Time to first page/frame/table and first search hit, decode CPU/peak RSS; bounded fetch/cache, format limits, cancellation and correct readonly source behavior. Total scan completion is separate. |
| J48 | Dictate into an existing draft | T13, T12 | Capture-start and stop-to-editable-transcript latency, energy, draft preservation and explicit destination/consent. No automatic send or silent fallback host. |
| J49 | Capture and attach SnapShot | T13, T14 | Shortcut-to-overlay, capture-to-ready-context and focus restoration; correct target workspace, privacy and clipboard semantics. Detailed native capture parity needs separate validation. |
| J50 | Use browser preview | T13, T10 | Input-to-visible-page response, frame latency/bitrate, CPU/RSS/energy; exact origin/tunnel/storage and ownership behavior. Only intended visible streams run; browser engine startup is included. |
| J51 | Use an HTML reply or MCP App | T13, T09 | Time to interactive widget and tool round trip; sandbox, scoped app bridge, user-gesture rules and state lifecycle. Static screenshots or disabled scripting do not satisfy parity. |
| J52 | Control a simulator or device | T13 | Discovery-to-useful-preview and input-to-frame; steady CPU/energy/bitrate, correct visible-session and permission ownership. Closing preview must have the same device-lifetime effect. |
| J53 | Use mobile offline and rotate/fold | T12 | Time to useful offline screen, navigation/scroll stability, retained drafts and convergence on reconnect. Measure native allocations and retained invisible views. |
| J54 | Receive background activity and return | T12, T10 | Delivery-to-visible alert and tap-to-correct-thread, energy/background network; correct permissions, account scope, widget expiry and no live connection requirement added. |
| J55 | Navigate with accessibility tools | T01, T11, T12, T13, T16 | Correct focus order/return, labels/actions/selection and shortcuts without interception conflicts; interaction latency and readable layout. Rendering speed cannot excuse missing semantics. |
| J56 | Change locale, theme and settings | T04, T11, T12, T14 | Visible change and interactive latency, stable forms/caches, correct scoped settings and locks. Font shaping, contrast and native theme consistency remain acceptance requirements. |
| J57 | Automate through CLI | T14 | Process-start-to-result and running-server RPC latency, valid uncontaminated stdout, documented exit statuses and progress on correct stream. Capture child/signal behavior before reproducing it. |
| J58 | Install/update/uninstall every owned package | T14, T05, T12 | Verified install/update-to-ready, download/extract bytes, downtime and recovery; preserve state/credentials, launcher ownership, platform signing, safe rollback and documented uninstall scope. |
| J59 | Return from auth or a shared link | T10, T11, T12, T14 | Time to authorized correct destination, no trust/confused-host regression, recoverable errors, no duplicate onboarding or lost queued draft. Separate external IdP latency from T3-owned overhead. |
| J60 | Complete a cross-device working day | T16 | Weighted task completion, worst-tail interaction, total CPU/RSS/network/storage/energy and recovery. Report every journey separately; aggregate improvement cannot hide a broken capability. |


## Promotion and evidence handling

For every affected capability/target, preserve the outcome, prove normal execution through the intended Rust owner, and meet the frozen performance/failure contract. Component tests establish candidate behavior. Integration and platform acceptance remain separate facts. Retire original implementation only within accepted platform scope, preserve upstream mapping, and retain working clients while required replacement scope remains open.

Use the existing exact-source CI and per-platform receipt schema and locations. At minimum, the evidence must identify source/tree, relevant port record and routes, target/OS/device/browser, compiler route and artifact identity, dependency locks, provider fixture and data-corpus hashes, durability/acknowledgement profile, CI policy/selected gates, expected-versus-observed outputs, failure points, and raw measurement locations. Record exclusions with source-based applicability reasons. Do not add a competing live status register.

Global package T16 requires all 60 journeys on their applicable target profiles. Its working-day aggregates cannot substitute for individual results. A missing route, provider control contract, platform interaction, recovery guarantee or retained T3-owned non-Rust business algorithm blocks the corresponding completion claim.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for package ownership/dependencies and [AGENT-HANDOFF.md](AGENT-HANDOFF.md) for the assignment boundary. No benchmark, product test, provider invocation or platform qualification was performed while authoring this plan.
