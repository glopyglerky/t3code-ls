# Run the Claude adapter through the Rust stdio host

T01 and T08 share this controlled test. The production `ClaudeAdapterV2` receives
a test runner through `ClaudeAgentSdkQueryRunner.open`. After validating the
options, the runner starts the `t3-code-ls-claude-stdio` executable. The helper
owns one `ClaudeStdioSession` and starts the deterministic test child. The
adapter owns approval presentation, steering state, result ownership, and the
terminal event.

The child asserts the exact user and `now` steer frames, including Unicode,
whitespace, null and omitted fields, and distinct UUIDs. It runs no tools and
opens no network connections. The adapter test rejects an unsupported
permission mode before the child starts and makes SDK `query()` throw if called.

The child withdraws an approval and reuses its wire request ID for a distinct
tool use. The adapter cancels the first request. The helper refuses the late
answer and forwards the denial for the current ticket. A task-notification
result leaves the foreground turn active. During interrupt, the child sends a
foreign acknowledgment, two copies of the foreground result, and the matching
acknowledgment. The adapter keeps the foreground result and emits one terminal
event.

## Run the checks

Use the [Claude stdio workflow](../../../.github/workflows/claude-stdio.yml)
with the pinned Lustr and BlueFe compiler and frozen pnpm dependencies. The
workflow builds the helper with
`build --locked -p t3-code-ls-core --features claude-stdio-helper --bin t3-code-ls-claude-stdio`.
It builds `claude_stdio_host` separately as the deterministic provider executable.

Set `T3_CLAUDE_STDIO_HELPER` and `T3_CLAUDE_STDIO_FIXTURE` to the absolute
executable paths reported by Cargo. Run the adapter test from the repository
root.

```sh
pnpm exec vp test run --project t3 --maxWorkers 1 \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  -t "runs ClaudeAdapterV2 against the Rust stdio host"
```

On Linux, pass the same paths to the helper contract check.

```sh
node apps/server/scripts/check-claude-stdio-helper.mjs contract \
  "$T3_CLAUDE_STDIO_HELPER" "$T3_CLAUDE_STDIO_FIXTURE"
```

The vendor workflow uses the same helper with the pinned Anthropic executable
in a fresh profile and a separate network namespace. It verifies the
initialization receipt, the executable and parent in `/proc`, and reaping
after close. The `initialize-only` profile refuses turn commands.

## Helper protocol

The parent sends one JSON object per line over stdin. The first line supplies
`type: "open"`, version `1`, a `session` or `initialize-only` profile, and
absolute `program`, `cwd`, and `home` paths. The caller selects the executable
and supplies isolated directories. The helper uses fixed stream-JSON arguments
and clears the child's inherited environment. Provider stderr stays in the session.

A matching initialization reply produces `ready` with the protocol version
and child PID. A failure reports its stage and code. The `session` profile
accepts user frames, permission decisions, interrupt requests, and pulls.
`close` returns the child status after reaping. EOF and SIGTERM also close the
direct child. The helper bounds startup frames at 8 KiB, subsequent frames
at 256 KiB, pending requests and queued events at 16 each, the initialization
wait at 15 seconds, and pipe writes at 2 seconds. The parent owns the isolated
directories and must drain its replies or close the session.

## Source and limits

- Helper patch base `83dcf23366f6675f93284bcb3cfefe251e3e1bcf`, tree
  `3b16a2b46c911a2857b3f50b6627afc8084d9cfe`.

- Fork base `ed028459c046a487f6e7e0287ec985ffd01e160d`, tree
  `bad51fb35d1bee7f142a6b7023e2286f0d979732`. Rust host introduced by
  `194e9ca8751d334ca72b049c4162baf1dd608f08`.
- Stock comparison `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, tree
  `af9112ce82be93109079ca7b7a89f7182455eca5`. The adapter history includes
  `0b02be3d5f` for late-read steering and `03920ad8aa` for Claude exit with
  pending background work. The fork reuses its existing adapter and recorded
  `claude_background_wake_before_queued_prompt` result evidence.
- The lockfile pins Anthropic Claude Agent SDK `0.3.321`. The inspected
  `sdk.d.ts` has SHA-256
  `a770e964aa5ba76adf24f4927f5ba5bbd4113ab08ecda5a8ddc71f106d7f9487`.
  The fixture uses its user message, permission callback, and permission result
  contracts. The package carries Anthropic's license. The fixture copies no
  proprietary implementation.
- Research method SHA-256
  `5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

The production SDK runner still owns CLI acquisition and version provenance,
merged configuration and native sandbox policy, hooks, permission rules and
suggestions, MCP and elicitation, account and model changes, resume and fork,
background tasks, and restart and shutdown behavior. The fixture verifies the
adapter callback for one approval-required session. Production selection,
descendant-process supervision, and per-platform qualification remain open.

## Previous Cargo test bridge checks

Linux x86_64 ran the focused Rust tests with bootstrap Rust 1.99.1. All four
control tests and the standalone host fixture passed. The host test executable
had SHA-256
`878a654f022ae917c4db3ffefdc1d153a0a9dcc130e827b121bfd1dd3bde04c4`.

Node 26.13.0 and Vitest 5.0.5 ran the process-backed adapter test successfully
with the pinned SDK package from the existing dependency cache. The offline
frozen install stopped because it lacked `hono` metadata. The hosted replay
subsequently passed with frozen dependencies and the pinned packaged Lustr/BlueFe
compiler at `38ac46c13bc2cd4b332c231fcfe5fc5fe7c65a46`.
[Hosted adapter replay](https://github.com/glopyglerky/t3code-ls/actions/runs/45115372585)

An explicit missing executable failed the fixture at startup. The existing
approval-cancellation test also passed. The server typecheck returned the same
108 error diagnostics on the base and the candidate with the same cached
dependencies.


## Controlled packaged selection candidate

`T3_CODE_LS_BUNDLE_CLAUDE_STDIO=1` adds the optional `claude-stdio` helper to
`tools/build-native.mjs`. It uses the existing pinned compiler, target, manifest,
SHA-256 validation and native staging path. The default package is unchanged.
A prebuilt bundle selected with that flag must already contain the helper.

At runtime, `T3_CODE_LS_CLAUDE_STDIO_SYNTHETIC` is a bounded JSON object in the
server environment. It contains `version: 1`, an exact `instanceId` matching
`claude-stdio-synthetic-[a-z0-9-]+`, an absolute deterministic Cargo test executable
`program` named `claude_stdio_host-<hex>`, an absolute task-owned isolated
`directory`, and `expectedOptions`. The latter is the captured SDK query options
without the three callback functions. Preserve omitted fields, Unicode and nulls.
No real provider, credentials, live profile or real prompt is admitted by this
candidate's qualification contract. The executable name is an accident guard,
not attestation of the program; the qualification owner must bind its Cargo
artifact and hash to the captured synthetic source.

The existing `createClaudeAdapterV2` selects this runner for that exact instance
before discovering a vendor executable. The selector JSON is removed from the
selected query environment so captured options cannot recursively contain their
own selection payload. Package helper target/hash/executable
checks happen before adapter creation. The helper acknowledges protocol version 1
before the first user frame. Exact option equality is checked before helper spawn.
The selected profile requires permission mode `default`, a fresh `fixture` session
and matching cwd, and refuses resume, MCP, hooks and permission bypass. A missing,
incompatible or mismatched helper fails the selected instance. There is no SDK
retry following a selected failure or an uncertain user-frame delivery.

The old adapter test and selected path share `ClaudeStdioRunner.ts`. That runner
translates SDK user frames and the Rust helper's `message`, `background`,
`permission`, `withdrawn` and `interrupted` events. It preserves approval ticket
identity, callback cancellation, offer acknowledgement, interrupt acknowledgement,
terminal ownership and close/reap. It does not implement SDK settings, transcript,
account, fork, model, MCP or background-management APIs. Calls outside the bounded
profile are refused. These capabilities and all ordinary instances retain the
existing SDK production selection. This opt-in is a controlled candidate, not a
normal-user SDK replacement or platform acceptance claim. No port state is promoted.

### Required isolated orchestration gate

This patch has not run a packaged conversation or reopen. The root build owner
must apply the exact-base patch to its own candidate and use the pinned
Lustr/BlueFe and frozen dependencies. Run the focused checks first:

```sh
node --test tools/native-packaging.test.mjs
pnpm exec vp test run --project t3 --maxWorkers 1 \
  apps/server/src/orchestration-v2/Adapters/ClaudeStdioSelection.test.ts
pnpm exec vp test run --project t3 --maxWorkers 1 \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  -t "runs ClaudeAdapterV2 against the Rust stdio host"
```

Retain the existing helper and fixture artifact extraction in `claude-stdio.yml`.
Build the package with `T3_CODE_LS_BUNDLE_CLAUDE_STDIO=1`. Use
`apps/server/scripts/packaged-server-fixture.ts`'s `startPackagedServer`,
`authenticatePackagedServer` and typed WebSocket RPC helpers, with a fresh profile,
loopback-only binding, stripped credentials and an external network fence.
Configure one synthetic Claude provider through the ordinary provider registry.
Capture the exact callback-free options from the controlled harness and bind them
to that instance; do not relax equality to make arbitrary settings pass. If the
packaged adapter unconditionally supplies MCP options, keep this candidate refused
until a narrowly controlled, source-backed no-MCP synthetic profile is implemented.
Do not discard MCP for ordinary Claude instances.

The current adapter child requires a prompt, steer, approval withdrawal/reissue,
background notification and interrupt. It is not a one-answer conversation fixture.
Add a separately selected deterministic child scenario for one captured prompt and
one assistant response containing exact `Claude 🌱 café é\n  終了 🛠️` text. Assert the
complete string, including decomposed accent, newline and spaces, in the actual
event store and projection. Dispatch through packaged the typed orchestration command RPC
and the normal provider registry, not an injected replay adapter or direct runner.
Stop and await the owned server, reopen the same isolated store, and require the
same assistant text, message identity and single terminal event without another
child spawn or prompt. Keep this gate outstanding until its harness and observed
receipt exist. A component test does not satisfy it.

In separate fresh profiles, missing helper, wrong target, hash change, symlink and
unsupported selected options must fail before a prompt or synthetic child marker.
An ordinary nonselected instance must still select the SDK without a real query.
Retain source/tree, toolchain, package/manifest/fixture hashes, selected instance,
event-store/reopen assertions and exact failures. Remove owned generated targets,
dependencies and isolated profiles after preserving concise receipts. This patch
adds no workflow trigger, publication, installation or live-profile action.

### Packaged refusal and next conversation condition

`apps/server/scripts/verify-packaged-claude-stdio.ts` is an executable refusal
and reopen gate for an extracted native Linux x64 package containing the optional
helper. Run it using the same Node runner and loopback-only network namespace as
`verify-packaged-git-workspace.ts`, with three absolute arguments: a fresh evidence
directory outside source, the extracted package entry, and the Cargo-reported
`claude_stdio_host-<hex>` executable. The root build owner supplies the package
built with `T3_CODE_LS_BUNDLE_CLAUDE_STDIO=1`, pinned compiler and frozen dependencies.
No new workflow trigger or live-provider run is added.

The gate uses `packaged-server-fixture.ts` for desktop bootstrap authentication
and typed WebSocket RPC. All ordinary providers are disabled in fresh settings.
It creates one synthetic provider instance, launches one empty thread, dispatches
one exact Unicode message and requires a failed run with no assistant response.
It checks the native manifest and hashes, a names-only controlled-runner refusal
witness, the native event store's exact user message and single failed terminal
update, and the unchanged messages/runs after stopping and reopening the same
isolated store. It checks the stopped store again and refuses any helper or
provider execution attempt in the owned process trace. Profiles are removed
in `finally`; concise evidence remains. A failure never retries dispatch.

This is deliberately a refusal gate. `ProviderSessionManager` registers an
MCP session before the turn; `ClaudeAdapterV2` reads it and
`claudeMcpQueryOverrides` supplies `mcpServers`. The selector forbids this setting.
The runner still compares every callback-free option exactly. Its refusal witness
contains differing option names only, never values, environment or MCP credentials.
A missing/moved helper or an earlier provider failure cannot produce that witness.
The bounded baseline options in this gate are intentionally incomplete and are
not a captured conversation option set. The gate must see `mcpServers` among the
differences. It cannot pass by silently dropping that setting.

The Rust child now has a separate `packaged-conversation` scenario, selected only
by that task-owned marker in its isolated cwd. It requires exactly one Unicode
prompt `Claude 🌱 café é\n  終了 🛠️`, echoes the user, emits one assistant message
and one foreground result with that same complete text, then requires EOF.
It creates its process marker exclusively, so duplicate processes fail. The
existing approval/steer child and recordings retain their contracts.

The direct next condition is an explicitly controlled no-MCP synthetic session
at the existing session/adapter boundary, preserving MCP for ordinary instances.
Then capture its actual callback-free options, retain exact equality, and extend
this harness to require the assistant text and identity plus one completed terminal
event in projection, native store and reopen, with one helper/child and no second
prompt. Do not label the refusal gate, the prepared child, or an unrun harness a
packaged conversation pass. Missing helper, wrong target/hash, symlink and unsupported
options checks remain required alongside the existing selector and manifest tests.

This increment is source-only until the root build owner records its exact
candidate, package/helper/fixture hashes, toolchain and observed run receipt.
T08 and all platform/provider acceptance gates remain open. MIT and stock
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` provenance are preserved.
