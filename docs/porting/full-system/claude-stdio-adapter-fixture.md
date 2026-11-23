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
