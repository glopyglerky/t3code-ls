# Run the Claude adapter through the Rust stdio host

T01 and T08 share this controlled test. The production `ClaudeAdapterV2` receives
a test runner through `ClaudeAgentSdkQueryRunner.open`. The runner starts the
Rust `claude_stdio_host` Cargo test executable, which starts a deterministic
child using `ClaudeStdioSession`. The adapter still owns approval presentation,
steering state, result ownership, and the terminal event.

The test makes SDK `query()` throw if called. The bridge launch accepts an
explicit Cargo test executable and gives it a temporary working directory and
environment. The bridge starts only its own executable as the child. The child
asserts the exact user and `now` steer frames, including Unicode, whitespace,
null and omitted fields, and distinct UUIDs. It runs no tools and opens no
network connections.

The child withdraws an approval and reuses its wire request ID for a distinct
tool use. The adapter emits cancellation for the first request. The Rust host
refuses its late decision and writes the denial for the current ticket. The
task-notification result leaves the foreground turn active. During interrupt,
the child sends a foreign acknowledgment, then two copies of the foreground
result, and then the matching acknowledgment. The adapter retains the foreground
result and emits one terminal event for the interrupted turn.

## Run the fixture

Run from the repository root on Unix with the pinned Rust compiler route, a
frozen pnpm install, and `CARGO_TARGET_DIR` on the approved build filesystem.

```sh
cargo test --locked -p t3-code-ls-core --test claude_stdio_control --test claude_stdio_host

fixture="$(
  cargo test --locked -p t3-code-ls-core --test claude_stdio_host --no-run --message-format=json |
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const artifact = readFileSync(0, "utf8").trim().split("\n").map(JSON.parse)
        .find((entry) => entry.target?.name === "claude_stdio_host" && entry.executable);
      if (!artifact) process.exit(1);
      process.stdout.write(artifact.executable);
    '
)" &&
test -x "$fixture" &&
T3_CLAUDE_STDIO_FIXTURE="$fixture" pnpm exec vp test run --project t3 \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  -t "runs ClaudeAdapterV2 against the Rust stdio host" --maxWorkers=1
```

The adapter test runs only when `T3_CLAUDE_STDIO_FIXTURE` is set. Confirm that
Vitest reports one passing test for the filtered run.

## Source and limits

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
adapter callback for one approval-required session. Production selection and
per-platform qualification remain open.

## Developer check

Linux x86_64 ran the focused Rust tests with bootstrap Rust 1.99.1. All four
control tests and the standalone host fixture passed. The host test executable
had SHA-256
`878a654f022ae917c4db3ffefdc1d153a0a9dcc130e827b121bfd1dd3bde04c4`.

Node 26.13.0 and Vitest 5.0.5 ran the process-backed adapter test successfully
with the pinned SDK package from the existing dependency cache. The offline
frozen install stopped because it lacked `hono` metadata. The developer run
used cached dependencies from another checkout, so the hosted run still needs
to bind the complete frozen dependency set and packaged Lustr/BlueFe compiler.

An explicit missing executable failed the fixture at startup. The existing
approval-cancellation test also passed. The server typecheck returned the same
108 error diagnostics on the base and the candidate with the same cached
dependencies.
