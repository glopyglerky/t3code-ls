# Upstream T3 server and provider capability research

## Decision-relevant findings

The all-Rust destination should preserve the environment as the execution and state owner, with typed command processing, one authoritative transaction owner, bounded subscriptions, per-instance provider state machines, and explicit filesystem/process owners. The useful performance opportunities are reductions in repeated work across these owners. Merely translating the current SQL or TypeScript line by line does not establish a faster product.

The pinned baseline already batches provider work, coalesces streams, bounds retained output, caches status, uses native search, and avoids several expensive provider startup paths. A proposed improvement must be compared against those mechanisms. The strongest source-supported residual opportunities identified here are full-prefix text materialization/encoding, shared wire encodings, remaining whole-history navigation work, and search refresh lock contention. They remain hypotheses until measured on complete user journeys.

Cursor and Claude are substantial native-port risks. Cursor relies on a JavaScript SDK, native modules, SDK-specific hooks and native checkpoint storage internals. Claude relies on SDK control, hooks, settings and transcript APIs beyond prompt streaming. Retaining their current T3 JavaScript adapters is an intermediate stage, not a completed Rust port. Codex app-server, ACP, Pi RPC, Muse MSP and OpenCode HTTP/events have clearer native protocol boundaries. No external SDK internals or live provider conformance were audited in this task.

## Baseline and coverage

All source observations use pingdotgg/t3code at [28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f](https://github.com/pingdotgg/t3code/tree/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f). The source checkout's working HEAD differed; immutable git objects and pinned GitHub file retrieval were used. No user database was read and no product files, builds, tests, migrations or benchmarks were run.

| Coverage item | Result | Meaning |
|---|---:|---|
| Selected source paths mechanically enumerated | 1,115 | Server, contracts, provider/protocol/SSH families and docs; includes metadata/generated schemas and provider-testing package |
| Source files captured during research | 138 | Git blob identities and links are retained here; raw captures are omitted; capture does not mean every line semantically reviewed |
| Declared RPC methods | 247 | Every declared method assigned to a capability family; 0 unassigned |
| Streaming RPC declarations | 31 | Lexical stream flag |
| Typed HTTP endpoints | 59 | Auth, Connect, MCP OAuth, orchestration, projects, PRs, voice, webhooks and metadata |
| Supplementary HTTP registration entries | 25 | 22 HttpRouter.add matches, 2 preview router.add calls, 1 MCP SDK registration; includes separate CLI callback listener |
| Public/internal command variants | 58 / 16 | Top-level orchestration command discriminants |
| Domain event variants | 49 | Top-level event discriminants |
| MCP tool declarations | 93 | All 15 toolkit tools.ts files; three imported name constants resolved |
| Provider baseline capability declarations | 12 | Includes OpenCode 1/2 and generic ACP/flavor overrides; not evaluated runtime capabilities |
| Server capability families | 27 | Proposed Rust owners, actual entrypoints, invariants and evidence in capability-map.json |

The HTTP counts must not be summed into an asserted active public endpoint count. SDK routes may expand into several HTTP operations; conditional features and separate listeners matter. RPC names do not cover provider-internal protocols. MCP tools are exposed according to caller identity, mode, feature and capabilities; 93 does not mean every session can invoke all 93.

Semantically reviewed material includes the complete core internal architecture/provider/auth/terminal/device/speech/connection docs, selected small stream/executor modules, actual capability objects, selected adapter and command paths, and prior exhaustive persistence enumeration. The 668 KB Orchestrator, 641 KB Claude adapter, 480 KB ACP adapter and other large sources were reviewed selectively. Source-control host driver implementations, all browser/device/speech branches, every request/response schema field and third-party SDK internals remain outside complete semantic coverage. The client/CLI/platform and Rust stack agents cover additional scopes separately.

The machine evidence comprises source-inventory.json, source-manifest.json, coverage.json, api-contract-inventory.json, direct-http-route-inventory.json, mcp-tool-inventory.json, provider-capability-declarations.json, provider-protocol-map.json and capability-map.json. The prior server persistence report is under ../database/server/server-findings.md, with its separate SQL/migration coverage.

Primary contract sources: [RPC](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/contracts/src/rpc.ts), [HTTP](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/contracts/src/environmentHttp.ts), [orchestration](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/contracts/src/orchestrationV2.ts).

## Owners and user capability families

The environment owns provider processes, Git/files, PTYs, checkpoints and durable state. Browser, desktop, mobile and CLI clients are independently versioned users of that environment. LAN, Tailscale, SSH and Connect change routing; they do not move execution or credentials to the client. Environment identity survives routes and restarts. A repository identity can correlate clones but does not route work across environments. [Overview](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/overview.md), [remote architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/remote.md).

| User outcome | Current entrypoint/owner | Proposed Rust owner and parity requirements |
|---|---|---|
| Start server, connect clients, maintain environment identity | server.ts, bootstrap.ts, metadata/WS, CLI root | Environment supervisor; atomic ID/recovery publication; client compatibility, service/process ownership and independently fresh data |
| Pair/revoke/authorize clients and outside agents | Auth HTTP, RpcAuthorization, MCP OAuth | Authorization service; exact permissions/audiences; one-time redemption; conditional renewal; revocation fanout |
| Create/manage threads; send, queue, steer, interrupt, retry | dispatchCommand, Orchestrator, ThreadCommandExecutor | Typed command engine; ordered per-thread decisions, global deletion coordination, atomic receipt/events/projections/outbox |
| Read shell/history/search/items/diffs and live output | ProjectionStore, ThreadStream, WireProjection | Indexed read model plus bounded stream service; exact visibility, pagination, sequence and snapshot fences |
| Use providers, accounts, models, setup and maintenance | Built-in drivers, ProviderSessionManager, provider RPC | Per-instance provider actors; truthful capabilities; exact process/account isolation; owned installer updates |
| Answer approvals, questions and elicitation | RuntimeRequestService, native adapter callbacks | Persisted request state plus callback owner; live and asynchronous question workflows kept distinct |
| Revert, fork, merge and switch provider | CheckpointCapture/Rollback, context handoff | Checkpoint coordinator; native rollback preflight; exact ancestor/history semantics; portable summary is not native hidden state |
| Delegate and manage background/native workflow work | RunExecution/Finalization, RemoteDelegation | Delegation coordinator; child identity independent of current parent run; restart followers and idempotent completion delivery |
| Launch worktrees/PRs/tasks with progress and retry | ThreadLaunchService, prepared-run commands | Preparation state machine; explicit stage ownership; cancellation and cleanup only for owned artifacts |
| Create/clone/import projects and task folders | projects/workspace/projectClone RPC | Project/workspace identity owner; multi-repository layout, scratch promotion, settings/scripts and shared links preserved |
| Browse/read/write/search files and attach data | projects/filesystem/assets/attachments RPC | Workspace/attachment services; ignore/path/symlink rules; ownership claims and signed file identity |
| Operate shared terminals | terminal RPC and Manager | PTY owner; byte ordering, retained-tail replay, UTF-8 boundaries, input authorization and query-response suppression |
| Operate Git and review diffs | vcs/git/review RPC, GitVcsDriver | Repository owner; hooks/config/auth/submodules/worktrees and external edit reconciliation |
| Use host repositories, PRs and issues | sourceControl/pullRequests/issues RPC | Host-specific adapters; remote mutations, local review state, credentials, rate limits and routing trust |
| Expose T3 tools and embedded MCP apps | /mcp, ACP bridge, McpToolAccess, mcpApps RPC | MCP service and app broker; discovery separate from authorization, thread credentials, mode ceilings and model context |
| Run schedules and webhooks while clients are absent | ScheduledTaskService and raw webhook HTTP | Durable deadline/dispatch owner; stale-generation checks, exact-body signatures, dedup/coalescing/rate/queue controls |
| Share a thread with a guest | guestShare RPC and dedicated guest routes | HMAC/thread-share owner; proposals, revocation and no general RPC/session authority |
| Link environments and operate remote work | peerLinks RPC, forwarded MCP, remote follower | Link/token/forwarding owner; namespaces, ceilings, immutable origin fence, receiver-owned expiry and recovery |
| Browse/control previews and device sessions | preview/device RPC, streams/tunnels/proxies | Browser/device supervisors; remote authority, profile/lease/billing/lifecycle and authenticated transport |
| Dictate into drafts | voice HTTP and speech worker | Speech/model owner; explicit target grants, verified downloads and cancellation/native resource lifetime |
| Inspect usage/resources/diagnostics and manage settings | server/provider RPC | Configuration, telemetry and maintenance owners; bounded sensitive logs, atomic settings, ownership-safe cleanup/import/update |

The detailed JSON splits these into 27 families and lists all 247 method assignments. Those assignments categorize research; they do not replace the normative authorization table in [RpcAuthorization](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/auth/RpcAuthorization.ts).

The source-control registry contains GitHub, Cursor Origin, GitLab, GitCafe, TanStack Source, Forgejo, Bitbucket and Azure DevOps; TanStack Source is feature-gated. Standalone Linear joins issue APIs supplied by host drivers. A GitHub-only rewrite would lose upstream capability. This task enumerated the registry and contracts, not every remote host branch. [Definitions](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/sourceControl/sourceControlDefinitions.ts), [issue registry](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/issue/IssueTrackerRegistry.ts).

## Command, effect and stream semantics

A command receipt acknowledges accepted intent committed with events, authoritative projections and outbox work. Provider/process/Git effects run after that decision. External completion is a different state transition. Provider output re-enters the same ordered state machine. Per-thread execution prevents conflicting decisions; destructive cross-thread history planning takes the global deletion lock before thread locks. Rust actors may reduce coordination overhead but must preserve these relationships. [Thread executor](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadCommandExecutor.ts), [Orchestrator](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/Orchestrator.ts), [effect worker](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/EffectWorker.ts).

Turn completion is distinct from checkpoint/diff finalization. Background commands, subagents, workflows and native goals can continue or wake a session after its foreground turn settles. Updates must route by child/native identity, not whichever run happens to be current. Stop-before-native-start, provider failure and process exit each need distinct cleanup paths for tools, questions and children. Upstream explicitly warns that hand-written provider frames are guesses; real captured transcripts replayed through adapter, orchestrator and projections are its conformance model. [Provider integration rules](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/adding-a-provider.md).

The wire contract includes receipt/idempotency identity, nullable/omitted fields, sequencing, replay cursors, capability negotiation and cancellation. Reconnection does not automatically replay mutations. Cached data and cursor advance together only after application; old scopes cannot overwrite successor state. Shell snapshots deliberately omit inactive child families and older settled rows when negotiated, so absence is not deletion. [Connection runtime](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/connection-runtime.md).

## Providers: native boundary and hard parity cases

There are 11 registered provider drivers. OpenCode 1 and 2 are distinct implementations under one driver family. ACP Registry uses a generic adapter with negotiated capabilities; Grok, fx, Kiro and Antigravity add protocol flavors. The raw capability objects are captured separately because handshakes and provider versions can change the effective support. [Driver registry](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/builtInDrivers.ts), [adapter interface](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-core/src/server/ProviderAdapter.ts).

| Provider | Actual current boundary | Rust port obligations |
|---|---|---|
| Codex | App-server child stdio JSON-RPC; generated and patched schemas | Requests, notifications and server requests; multi-native-turn goals; asynchronous questions; strong IDs; native fork/rollback |
| Claude | First-party JS query/session SDK spawning installed Claude Code | Full control protocol, hooks, settings, transcript/fork and background-task semantics; direct native parity not yet proven |
| Cursor | First-party JS Agent SDK, native-module SQLite store, T3 NDJSON worker and patched hooks | Native API/protocol plus exact storage/checkpoint/shell-hook behavior; largest observed unresolved boundary |
| Generic ACP / Registry | External agent process and ACP handshake/client requests | Registry install/auth/launch, delayed config options, permission option IDs, file/terminal requests, capability-driven fallback behavior |
| Grok / fx | ACP flavors | Grok interject/cancel/process-group behavior; fx model/history/MCP/subagent behavior |
| Kiro | ACP flavor plus private extensions | Fork metadata, tool-completion steering, versioned hook opt-in and attachment limitations |
| Antigravity | ACP flavor with per-instance profiles and continuation repair | Authentication/profile leases, native read repair, post-settle background wakeups, no native conversation rollback |
| Pi | Installed CLI JSON RPC mode and native session files/CLI fork | Extensions/trust/policy preserved; fork uses destination cwd; runtime mode change requires process restart |
| OpenCode 1 | Per-thread HTTP chat server; directory-scoped MCP | Separate shared idle helper; externally owned server behavior; project-scope approval translation |
| OpenCode 2 | Per-instance multi-directory HTTP server, typed client and SSE | Subscribe before work; per-thread MCP names/deny-other-thread rule; session approval semantics and unreadable event handling |
| Muse | MSP via SDK spawnMspConnection launching muse serve | Command/request/notification/server requests; schema-v1 handshake; capability/mode/path/cancellation semantics |

Pinned transport sources: [Codex client](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/effect-codex-app-server/src/client.ts), [ACP runtime](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-acp/src/server/AcpSessionRuntime.ts), [Pi RPC](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-pi/src/server/rpc.ts), [OpenCode 2 client](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-opencode/src/server/v2/OpenCode2Client.ts), [Muse SDK boundary](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-muse/src/server/sdk.ts).

### Cursor is more than a streamed agent prompt

Cursor's loader uses createRequire to retain adjacent Webpack chunks and native modules for both @cursor/sdk and @cursor/sdk/sqlite. The runner opens a ref-counted SqliteLocalAgentStore per workspace. Agent shell output is exposed through an SDK patch's Symbol hook; background shell handling has another hook. Native rewind enumerates runs, locates the first unwound run's checkpoint blob, reads its bytes and re-saves that content-addressed root as the agent head. A generic ACP adapter does not cover these features. [Loader](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-cursor/src/server/sdk.ts), [runner L468,620–669,1084–1135](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-cursor/src/server/CursorAgentSdk.ts).

Its worker protocol is T3's own wrapper around those SDK calls. Keeping that TS worker would leave T3 behavior unported. The external provider may remain a separately installed proprietary executable, but that is not evidence that a suitable complete native interface exists today. The next proof must identify a vendor-supported native API or qualify a Rust protocol/storage implementation against real Cursor behavior. SDK internal schemas/licensing were not examined here.

Upstream already shares one worker across sessions and text generation; its comment attributes roughly 250 MB baseline to the SDK, avoiding one copy per session. Idle workers exit. It already shares and disposes workspace store handles. Those savings cannot be claimed as new Rust gains. [Process runner L705–740](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-cursor/src/server/CursorAgentSdkProcessRunner.ts).

Cursor supports native rollback/resume/steer but does not expose native approval requests or native fork. Muse supports native approval IDs and structured questions but lacks native rollback/fork/resume. These must not be collapsed into one generic missing-feature statement. [Cursor adapter](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-cursor/src/server/adapter.ts), [Muse adapter](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-muse/src/server/adapter.ts).

### Claude has a broad SDK control contract

The adapter imports query, forkSession, getSessionMessages, getSubagentMessages and resolveSettings. It uses setModel, applyFlagSettings, setPermissionMode, stopTask, backgroundTasks, MCP status/resource/reconnect, interrupt, permission callbacks, hooks and elicitation. It controls SDK child spawning, descendants, process exit and stderr completion. Its native SDK initialization has a separate timeout; MCP registration follows initialization and has its own deadline. Resume-at-message and transcript-backed child information matter for forks, rollback and workflows. [Claude adapter imports/interface/control paths](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts).

A direct Rust client for the installed Claude process is plausible but must prove these APIs, setting precedence, hook callbacks and transcript behavior. Replacing query streaming alone is insufficient. The current source declares an SDK dependency; it does not prove that every consumed interface is a stable public wire protocol.

### Capability details that affect architecture

Codex asynchronous question notifications are persisted as message-answer requests and survive turn completion, process exit and restart; native blocking question callbacks are different. A goal can emit several native turns inside one T3 run. Claude goals lack equivalent SDK events and use synthetic command output plus Stop/transcript evidence. Native approvals must retain provider option IDs.

Pi must fork via its native CLI using the destination cwd because an RPC session switch retains the source cwd. Antigravity's inability to roll back native conversation means a file revert must be refused before touching files; its children lack native session IDs and remain read-only. OpenCode 1 project-level “always” permissions are not the same as OpenCode 2 session permission rules. Active Kiro/Grok steering has tool-completion constraints. [Provider constraints](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/providers.md), [Antigravity adapter](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts).

Portable handoff is a compact selected history summary, not cloned provider hidden state, permissions or tool state. It can be full-context or provider-delta; merge-back uses child delta. V1 import summaries have a separate budget. Thread/attachment boundaries must remain intact. [Context handoffs](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/context-handoffs.md).

## Existing optimizations and residual performance opportunities

### Text accumulation and wire representation

ProviderTextDeltaCoalescer clones its Map on append and stores accumulated text. Draining emits the current full prefix at the configured cadence; completion can replace final text. Codex consumes these updates into node and turn-item snapshots and emits message.updated on completion. This does not prove two full message writes per provider token. JavaScript string concatenation may use ropes, so source syntax alone does not prove an eager byte copy on each append. [Coalescer L109–122](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts), [Codex flush L4066–4125](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).

A Rust owner-local mutable accumulator plus immutable revisions/chunks could reduce map clones and full-prefix materialization. At each required full-prefix encoding, total encoded text across m equal growing updates is proportional to 1+2+...+m; a revisioned append representation encodes additions once plus snapshots/replacements. This is a representation argument, not a measured upstream timing. Compatibility clients still requiring full prefixes keep that cost on their path. Any durable event/outbox containing full prefixes must change too to realize the storage gain; adding chunk storage beside unchanged full records is insufficient.

LiveStreamBudget calculates JSON.stringify plus UTF-8 size once per immutable event and caches the result in a WeakMap across subscribers. Actual wire encoding remains another step. An encode-once cache keyed by exact negotiated wire/authorization shape can combine size accounting with immutable shared bytes. It must be bounded so slow subscribers do not pin every version. [Budget L25–35](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/LiveStreamBudget.ts).

Already present and mandatory baseline:

- Thread live coalescing at 50 ms, maximum 512 pending entries, same-entity replacement with insertion/sequence barriers.
- Live budget of 1,000 items / 8 MiB; in-flight bytes retained until RPC acknowledgement; overflow causes explicit recovery instead of unbounded buffering.
- Replay caps of 128 events / 1 MiB and bounded snapshot fallback.
- Wire body deduplication, compact identities, omission of duplicate local visible items and caps on large tool/checkpoint payloads.
- Assistant paragraph-mode incremental scanning, 400 ms emissions / 800 ms idle flush; turn mode suppresses intermediate output.

Sources: [ThreadLiveEventCoalescer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts), [LiveStreamBudget](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/LiveStreamBudget.ts), [WireProjection](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/WireProjection.ts), [assistantStreaming](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/assistantStreaming.ts).

### Search and repository coordination

WorkspaceSearchIndex documents that fff picker locks can be held by watcher work for long periods. It already calls the asynchronous native API so the JavaScript event loop remains responsive and keeps an old index while refreshing. A Rust implementation using the same long exclusive lock does not remove that delay. A useful experiment is immutable query generations with short update/publish critical sections, preserving exact ranking, ignore/symlink behavior, stale-generation handling and cancellation. [WorkspaceSearchIndex L904 and L1180 vicinity](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/workspace/WorkspaceSearchIndex.ts).

Current caps include 25,000 entries, 15-second scan budget, 250 ms content-search budget, 100 matches per file, 4 MiB git-grep output, and a short symlink cache. Directory traversal already uses typed directory entries to avoid a stat call per child. Preserve those constraints where they define behavior; measure search's first correct useful result during refresh and streaming load.

Git status already has per-cwd singleflight/queued refresh, distinct local and remote caches, branch-coherence checks, HEAD-parent-directory watches that tolerate atomic replacement, and failure backoff. Checkpoint capture already scans each tracked repository once and captures changed scopes with bounded concurrency. The residual scan is one status per tracked repository per turn, not a naive full snapshot of every repository on every update. [VcsStatusBroadcaster](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/vcs/VcsStatusBroadcaster.ts), [CheckpointCaptureService](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/CheckpointCaptureService.ts).

A dirty-repository journal may reduce redundant scans only if a generation fence proves the required unchanged state and watch overflow, filesystem/network anomalies, external tools and missed events trigger reconciliation. Absence of a watcher event is not proof of cleanliness. This is a conditional design opportunity, not a currently established correctness shortcut.

### History and command facts

The prior persistence report verifies that ordinary bounded snapshots no longer decode every run. It identifies remaining full-index paths around fork ancestry, certain search jumps/cursor fallbacks/media lookups and folded history. A weighted visible-order structure, compact command facts and fork spans can remove specific repeated derivations. An ordered KV alone does not implement rank/select; counted blocks/tree nodes are required. Visibility updates, superseded attempts, ordinal ties, ancestor cutoffs, rollback timing and late parent changes create maintenance costs. No universal logarithmic claim is justified for every history mode. See the prior history-index-design-critique.md and pinned [ProjectionStore](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/orchestration-v2/ProjectionStore.ts).

### Process/logging/startup

Muse already moves Linux cwd/PATH resolution into an env trampoline to avoid a stuck mount freezing the main runtime during libuv spawn. Its initialization is bounded and cancellation waits for native shutdown. Cursor already lazy-loads and shares its heavy SDK worker. Provider NDJSON logging filters hot token/duplicate frames and bounds structural traversal before redaction. Codex resume paths already avoid unnecessary snapshots and diff notifications where supported. These are existing gains, not reasons to promise that a Rust translation is automatically faster. [Muse boundary](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/provider-muse/src/server/sdk.ts), [logger](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/provider/EventNdjsonLogger.ts).

## Security, remote and automation semantics that must survive

Authorization must be applied before calling handlers and again where a mutable runtime-mode ceiling could race a command. Empty permission sets are authoritative; unknown response permissions can be ignored, while grant inputs are strict. Terminal/orchestration operation permission can already confer machine-level execution; weaker application fences cannot pretend to sandbox full-access agents. Invalid DPoP must not fall back to bearer. Outside MCP tokens have restricted audiences and cannot escape via ordinary WS. [Authentication](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/environment-auth.md), [MCP access](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/mcp/McpToolAccess.ts).

Guest credentials are HMAC/thread-share grants, not normal sessions. Replacement/archive revokes them; guest writes are proposals. Signed asset URLs bind canonical path and file device/inode identity and recheck at open; atomic file replacement requires a new URL. An issued signed URL's lifetime is not identical to the minting session's later revocation. Projects organize files rather than impose a universal filesystem sandbox.

Peer links authenticate to the receiving environment's /mcp and store its credential locally. Caller mode limits only narrow access. Limited-origin threads and their forks/children cannot mutate unrelated threads, projects/settings/schedules or use receiver links, and setup scripts are skipped; full-access links are not falsely described as fenced. Idempotency keys are namespaced per caller before forwarding. The receiver owns expiry. Forwarded waits use at most 50-second chunks. Existing remote tasks have startup followers and retain stop/read paths when the linking-side feature is disabled. [Remote architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/remote.md), [RemoteDelegation](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/peer/RemoteDelegation.ts).

Webhook signatures use exact request bytes with a 1 MiB cap. A claimed relay ID, receive timestamp and trace are trusted only after relay proof verification. A token mismatch is indistinguishable from an unknown hook. Queue/rate/coalescing state and dispatch ownership survive restart. The interval from claim acquisition through handing work to the dispatch owner is protected against interruption; recovery preserves the prompt already sent for running work. A faster transient in-memory queue cannot replace these records. [Webhook route](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/scheduledTasks/webhookRoute.ts), [ScheduledTaskService](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/scheduledTasks/ScheduledTaskService.ts).

## Terminal, device, preview and speech boundaries

The environment owns each PTY independently of client attachment. Output is incremental, and persistence coalesces a mutable buffer at execution time. Server retention is bounded by line and byte limits; clients retain a smaller tail. Restore skips partial UTF-8 prefixes, terminal query responses are removed from retained history, and replay detaches the input writer so old escape sequences cannot generate fresh input. A Rust PTY parser/renderer must preserve this complete loop, not just render a shell demo. [Terminal architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/terminal-runtime.md).

Device support spans local, SSH, EAS and Simlock hosts, with host identity part of device identity. Hub installation and agent-device automation permissions are separate. Native helper failures are process-isolated. EAS cleanup stops only owned sessions and enforces billing/idle limits. Simlock uses the agent-device gateway's actual bound session/cwd/TTL. The authenticated hub proxy allowlists routes and exposes typed device actions instead of arbitrary exec. Video paths include platform-specific H264/AVCC, SEMU/WebRTC and fallback behavior; proxies must not transform streamed media. [Device architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/devices.md), [proxy](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/device/DeviceHubProxy.ts).

Preview support includes browser profiles, automation, streamed frames and uploads, localhost tunneling, file HTML sandboxing and MCP HTML host messages. A server rewrite needs a real browser host for website execution. This task reviewed selected transport/authentication paths and toolkit contracts, not every browser operation. [ServerBrowserStream](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/preview/ServerBrowserStream.ts), [PreviewTunnel](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/preview/PreviewTunnel.ts), [HTML host bridge](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/shared/src/htmlRender.ts).

Speech transcription updates the draft rather than dispatching a turn. A request's environment/provider/model grant cannot silently send audio elsewhere. Local workers are isolated; cancellation retains resource ownership until native work stops. Model downloads use catalog hashes and must not remove foreign-owned caches. Optional VAD degradation is distinct from provider/audio fallback. [Voice architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/internals/voice-input.md).

## Rust port proof obligations

Start with one complete conversation path: accepted command, real protocol fixture, native state transition, authoritative commit, bounded live event, client application, history read, approval/interrupt and restart/reconnect. Preserve the JSON contracts initially; negotiate revisioned deltas separately. Compare source-equivalent SQLite control, native redb and transactional Fjall through the same Rust domain operations and the same durability. External provider generation time must be reported separately.

Each provider then needs replay fixtures for every supported shared scenario and provider-specific traps: immediate Stop, delayed config advertisement, default-model sentinel, background wake after settle, child update during a later run, usage-limit classification, terminal failure/exit cleanup, canonical paths and account isolation. Full live binary conformance is a distinct gate. Generic ACP success does not qualify Cursor or Claude.

Qualify automation and remote recovery independently: duplicate webhook, stale task generation, remote delegation completion after restart, limited link origin, token expiry/revocation, ambiguous provider response and slow-stream overflow. No uncertain mutation should be repeated by swapping transport or storage owner.

The result of this research is a bounded, source-grounded capability plan and set of performance hypotheses. It is not a complete conformance audit, a running port, or evidence of a speedup. The remaining key uncertainties are Cursor/Claude native control parity, full platform/client presentation parity, exact remote host implementations, and measured end-to-end critical paths.

