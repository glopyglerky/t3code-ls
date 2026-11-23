# Run the GPUI desktop showcase

The candidate opens one `hybrid-fixture` workspace in a GPUI window. It reads
the recorded assistant chunks from the existing [synthetic showcase transcript](../../server/scripts/dev-replay/showcase_transcript.ndjson)
and applies them through the shared Rust `TextRevision` model. The window
keeps drafts and results in memory until you close it. The binary has its own
Cargo workspace. The recorded entry opens with `--fixture showcase`; the scoped
application read uses `--thread-snapshot`; the next scoped write uses
`--thread-compose` as described below.

## Build on the hosted Linux x64 runner

Use the verified Lustr and BlueFe toolchain from [toolchain.lock.json](../../../toolchain.lock.json).
Set `CARGO_TARGET_DIR` to a task-owned directory outside the checkout. The
desktop session needs X11, a WGPU-compatible Vulkan device or software driver,
system fonts, and D-Bus with AT-SPI for the accessibility check.

```sh
"$T3_CODE_LS_TOOLCHAIN/bin/lustr" --bluefe-root "$T3_CODE_LS_TOOLCHAIN" \
  test --locked --manifest-path apps/desktop/rust/Cargo.toml

"$T3_CODE_LS_TOOLCHAIN/bin/lustr" --bluefe-root "$T3_CODE_LS_TOOLCHAIN" \
  build --release --locked --manifest-path apps/desktop/rust/Cargo.toml

"$CARGO_TARGET_DIR/release/t3-code-ls-desktop-gpui" --fixture showcase
```

## Check the workspace

1. Confirm the window opens with focus on **Message**. Confirm a screen reader
   exposes that field by name as editable multiline text.
2. Press Ctrl+Enter with an empty draft. Check for the error and confirm focus
   returns to the composer.
3. Type `Replay: showcase` followed by a newline. Submit with Ctrl+Enter. Check
   for the exact-prompt error and confirm the full draft remains editable.
4. Undo the newline. Tab to **Submit message** and press Space. Check that
   **Recorded reply loaded** appears, the composer clears, and focus returns
   to **Message**.
5. Tab through **Submit message** to **Recorded assistant reply**. Read the
   recorded Markdown and verify that the reply is read-only. Press Shift+Tab
   to check the reverse order. Close the window and verify process exit.
6. Repeat with marked CJK input and verify that confirming a composition does
   not submit it. Record focus and selection with the platform's assistive
   technology. Use the Unicode and long-draft cases from the [journey register](../../../docs/porting/full-system/journeys.json)
   to exercise input independently of the accepted fixture prompt.

The test target checks the exact prompt, the recorded assistant text order,
and incomplete transcript refusal. The accepted prompt is the one used by
the [bundled client proof](../../web/scripts/verify-hybrid-client.ts). The stock
comparison pin remains `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, tree
`af9112ce82be93109079ca7b7a89f7182455eca5`, as recorded in the
[acceptance plan](../../../docs/porting/full-system/ACCEPTANCE.md). The GPUI
fixture exercises part of J35, J37, and J55. Equivalent startup and performance
comparison require an authenticated workspace, the same conversation work,
and observed presentation timings. Provider execution, approval, a durable
thread, rich composer tokens, and the normal desktop launcher remain open.
The fixture renders recorded text without executing the transcript's actions.

## Dependency provenance

The [pinned Zed GPUI source](https://github.com/zed-industries/zed/tree/f126950f9d3b62666f97437ae5d4ccac2272c4db/crates/gpui)
documents the platform input handler and AccessKit integration. Its workspace
uses Git revisions for dependencies including wgpu and font-kit. This isolated
candidate uses the published Apache-2.0 GPUI snapshot from Zed
`d2a4fb6ded7c470be25d1541281da3882495b65b`. Both GPUI and the platform backend
use `0.3.12`. The textarea and button come from Apache-2.0
`gpui-base 0.10.0`, from Longbridge's `f697c3133d55c64fa8a5b67926147fb3dadd276d`.
Cargo.lock pins the crate checksums. The T3 source remains MIT.
[Zed license](https://github.com/zed-industries/zed/blob/f126950f9d3b62666f97437ae5d4ccac2272c4db/LICENSE-APACHE),
[published GPUI platform manifest](https://docs.rs/crate/gpui-pre-platform/0.3.12/source/Cargo.toml),
[gpui-base source and license](https://docs.rs/crate/gpui-base/0.10.0/source/).

## Read an application thread

The opt-in `--thread-snapshot` entry reads one bounded snapshot from the selected
Linux loopback server. Pass a JSON object on stdin with `port`, `token`,
`environmentId` and `threadId`. The token stays out of arguments and logs. The
adapter first checks the production environment descriptor, then requests
`/api/orchestration/threads/:threadId/bounded` with bearer authentication and
orchestration protocol 2. It accepts the exact requested thread and renders its
messages as a read-only accessible document.

The adapter has a 16 KiB input limit, a 1 MiB response limit, a 16 KiB header
limit and a five-second deadline per request. It uses plain HTTP on
`127.0.0.1` for this scoped local connection. Remote connections, TLS, streaming,
approvals, live navigation and reconnect remain future increments for that
read-only mode. The separate composer write profile is described below.
The recorded showcase entry remains independently executable.

The existing hosted GPUI workflow now builds the real selected server, creates a
disposable native profile, imports a synthetic Codex session through the
application's normal scan/import RPCs, and opens the native window. Its AT-SPI
check verifies exact prompt/reply text, the requested thread identity and a
read-only document. Wrong environment identity, invalid authentication and a
missing thread each display the bounded read failure. The fixture runs inside a
loopback-only network namespace and removes its profile after both owned
processes close. It uses the stock comparison pin already recorded above.

## Submit one recorded server turn

`--thread-compose` opens the same native composer against an existing selected
empty thread. Its stdin object adds `projectId`, `commandId` and `messageId`
to the four connection fields above. Allocate those two command/message
identities once and retain them with the draft. A refreshed view must reuse
them to reconcile an uncertain result; this candidate does not persist or
allocate durable client identities. No default desktop entrypoint changes.

The worker checks the public environment before sending credentials, then
checks the authenticated projection's exact thread and project. It sends the
retained client's `orchestration.dispatchCommand` JSON WebSocket RPC with
`message.dispatch`, `createdBy=user`, the existing `creationSource=web`
compatibility marker and `start_immediately` mode. The server still owns
current authorization, command receipts, projections, outbox and provider
execution. The client adds no alternate persistence or command path.

This profile starts only an empty thread or reconciles its original accepted
message. The composer makes at most one dispatch attempt per view. It does
not resend after timeout or allocate fresh identities. The displayed result
must contain the selected message ID and exact text, linked to exactly one
completed run in that thread. The draft clears only after that check, and
only if the editor still contains the submitted text without marked IME
input. Refusal and uncertain outcomes retain the draft and disable further
submits in that view. Closing the view cancels unsent work and subsequent
reads when observed; a write already sent still requires reconciliation.
There is no automatic provider interrupt on window close.

Tungstenite 0.29.0 provides the WebSocket handshake and framing under its
MIT/Apache-2.0 licenses. Only the handshake feature is enabled. The endpoint
is fixed to IPv4 loopback with no TLS, redirect, proxy or DNS selection.
The authorization header is marked sensitive for dependency debug output.
Credentials stay on stdin and the bearer header, never in argv or the URL.
The JSON envelope follows the lock-pinned Effect 4.1.3 `Request`/`Exit`
protocol. Input stays within 16 KiB, drafts within 4096 UTF-8 bytes, each
message/frame within 1 MiB, and the RPC receives at most 128 frames and
4 MiB in total. RPC and confirmation polling each have an eight-second
budget; individual existing HTTP reads keep their five-second deadline.
A final in-flight HTTP check can extend the polling budget by its bounded
request time. Cancellation is checked before sending and between reads.
The UI remains responsive while this worker runs.

The deterministic loopback tests check one exact dispatch, a lost
acknowledgement, same-identity reopen, wrong project and cancellation. The
hosted application proof creates a disposable native profile, disables live
providers, and prepares an empty thread with the normal `launchThread` RPC.
Its configured provider is the existing immediately completing `todo-list`
replay. X11 enters a prompt in the real composer; AT-SPI checks refusal keeps
the draft and confirmation exposes the selected thread as a read-only
document. Four rejected environment/token/project/thread cases must leave
zero messages and runs. The accepted case must produce one exact user
message and one completed run through the normal bounded projection route.
Repeated submit is checked without allocating new identities.

After the exact desktop and packaged native server are built, run the
existing loopback-only X11/D-Bus lane with:

```sh
node apps/server/scripts/verify-gpui-thread-submit.ts \
  "$CARGO_TARGET_DIR/debug/t3-code-ls-desktop-gpui"
```

This write increment awaits hosted compilation and execution. It does not
qualify streaming or approval controls, live providers, populated threads,
durable desktop drafts, automatic retry or normal launcher integration.
Project matching is a preflight read; it adds no new atomic server
precondition for concurrent project moves. The recorded showcase and
read-only snapshot routes remain independently executable. The stock pin
remains `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. The mandatory method
SHA-256 is `5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

[Retained command owner](../../../packages/client-runtime/src/operations/commands.ts),
[RPC contracts](../../../packages/contracts/src/rpc.ts),
[server WebSocket authentication](../../server/src/auth/EnvironmentAuth.ts)
and [Tungstenite's pinned source](https://github.com/snapview/tungstenite-rs/tree/v0.29.0)
are the source boundaries used for this adapter.
