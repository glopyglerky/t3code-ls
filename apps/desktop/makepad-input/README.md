# Makepad desktop input candidate

This T01/T14 candidate opens one plain-text draft or reads a saved server
conversation in a native Makepad window.
Makepad owns editing, focus, undo history and provisional IME text. The
shared `t3-code-ls-client-text` crate stores committed UTF-8 and the UTF-16
anchor and head in selection order. Submission validates the current widget
text. It reports the accepted byte count locally, with a 4096-byte cap and
no provider action or persistent draft. The opt-in snapshot route below
reads the existing application without submitting a message.

## Run the candidate

Use native arm64 macOS with a logged-in graphical session, the macOS SDK
and the repository's Rust 1.99.1 bootstrap toolchain. Set `CARGO_TARGET_DIR`
to an absolute directory on the approved build filesystem. Run from the
repository root.

```sh
cargo run --locked --manifest-path apps/desktop/makepad-input/Cargo.toml
```

You can also run `pnpm --filter @t3tools/desktop start:makepad-input`. Click
the editor and enter a synthetic draft. Press Command+Enter or click
**Submit locally**. Empty and over-limit input stays available for editing.

## Run the input proof

For a fresh dependency cache, run
`cargo fetch --locked --manifest-path apps/desktop/makepad-input/Cargo.toml`.
Run the offline proof from the same cache. Use a plain shell without Makepad
Studio, remote control or stdin hosting enabled.

```sh
cargo run --locked --offline --manifest-path apps/desktop/makepad-input/Cargo.toml -- --proof
```

Expect `T01 Makepad input proof passed` on stdout and a closed window. The
proof sends synthetic Makepad events through the native window's widget
dispatch. It checks empty-submit refusal, reverse selection over emoji and
combining text, CJK preedit updates, submit refusal during composition,
cancellation, commit, focus loss, refocus and submission of changed
mixed-script text. It checks the shared draft and the visible status widget.

The earlier hosted Makepad run `45115372931` exercised this input replay
through a real window after AppKit translation. It does not establish the
new snapshot path. Real input-method behavior, including nonempty AppKit
replacement ranges, needs a separate test. Rich content, accessibility,
packaging, other platforms, and packaged Lustr/blueFe remain unqualified.

## Read a saved application thread

Run `t3-code-ls-makepad-input --thread-snapshot` with one JSON object on
stdin, then close stdin. Supply exactly `port`, `token`, `environmentId`
and `threadId`. Keep this object out of shell history and process arguments.
The existing OAuth exchange supplies the token. The reader accepts only
IPv4 loopback and checks the public environment descriptor before sending
a bearer to the production `/api/orchestration/threads/:id/bounded` route.
It verifies the returned thread identity and displays title, thread ID,
snapshot sequence and ordered message text in a scrolling label.

The `std` host reader is owned by
`packages/client-runtime/rust/host/server_snapshot.rs`, reused from GPUI
commit `04ebd088ebd43aa75930c52b2d138d68cb81fec4`. The portable `no_std`
core stays dependency-free. The host adds the root application's locked
`serde_json` parser. Limits match GPUI: 16 KiB input, 1 MiB HTTP reply,
16 KiB headers, 200 messages, five seconds per GET, and no redirects,
compressed transfer or compact ID table. Failure displays one generic
message without printing the token or response. Local demo submission
still stays local.

The hosted workflow builds the supported explicitly retained server on
macOS. This does not bypass the Linux-only native storage qualification.
It creates an isolated profile, exchanges a synthetic bootstrap credential,
creates a project, imports the same three-record Codex conversation used
by GPUI through normal scan/import RPCs, and opens four Makepad windows.
Wrong environment, wrong credential and missing thread must refuse. The
valid window checks the selected label's actual text and message order
after native drawing, then closes. Credentials travel through pipes.
The runner bounds child output and time, suppresses raw failure output,
removes its profile, and records backend and binary hashes.

On an admitted arm64 macOS graphical runner, after the frozen application
bundle and locked Makepad candidate are built, run from the checkout:

```sh
node apps/server/scripts/verify-makepad-thread-snapshot.ts \
  "$CARGO_TARGET_DIR/debug/t3-code-ls-makepad-input"
```

`--thread-snapshot-proof` is the synthetic window harness used by this
runner. It does not establish accessibility, physical input, streaming,
provider submission, reconnect or durable client state. Native storage
on macOS remains separate. The new reader tests and window proof await
hosted execution. No local product compilation or hardware access ran.
The mandatory method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

## Source provenance

The stock comparison remains `pingdotgg/t3code` at
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. Its composer guards Enter during
composition. The retained stock clients continue to use their existing
entrypoints. [Stock composer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/ComposerPromptEditorTiptap.tsx#L1315)

The candidate pins public Makepad commit
`888d1b501ff41d0084ddd5417446b7341d5f873e`, tree
`15cfa5f5ae56f6571d276fc02f4e55790d48d7ea`. It is an ancestor of the
retained pin `506ec05105b9adb08d1d21f9879df181b5244ea7`. At the retained
pin, the new HAL presents ordinary AppKit composition commits and preedit
updates to the widget with the same `replace_last` flag. The intervening
pre-HAL snapshot `a50b071d5be4af864d7f936a9c8af4812268fe8e` failed Cargo
resolution because its platform manifest names an absent local `naga`
package. The selected ancestor includes that package and distinguishes the
ordinary AppKit commit, preedit and cancel paths in source.
[Retained HAL intake](https://github.com/makepad/makepad/blob/506ec05105b9adb08d1d21f9879df181b5244ea7/platform/src/event/hal_intake.rs#L503-L520)
[Selected AppKit delegate](https://github.com/makepad/makepad/blob/888d1b501ff41d0084ddd5417446b7341d5f873e/platform/src/os/apple/macos/macos_delegates.rs#L842-L987)

The candidate uses the dependency's public widget API under Makepad's
published MIT license. The host adapter needs Makepad's standard library,
AppKit and Metal paths. The widget handles grapheme navigation, including
combining characters. The shared `no_std` crate uses `alloc`, checks UTF-8
boundaries before converting to UTF-16, and never normalizes the draft.
[Makepad license](https://github.com/makepad/makepad/blob/888d1b501ff41d0084ddd5417446b7341d5f873e/LICENSE)
[Unicode text segmentation](https://www.unicode.org/reports/tr29/tr29-49.html)

## Load older saved conversation records

`--thread-history` uses the same four-field stdin connection object. It
opens the production bounded snapshot, preserves the server's opaque
`historyCursor`, and enables **Load older history**. Each click runs the
read on a worker while the native window remains responsive. A successful
page prepends its records in returned order; the reader never sorts by
page-local positions or decodes the cursor. The original
`--thread-snapshot` mode remains available.

The first history profile accepts local user and assistant message rows.
Each row must bind both source and item thread IDs to the selected thread,
with matching source/item identity and unique message identity. The
reader checks the environment again before every authenticated page and
requires the snapshot sequence to remain unchanged. A changed saved
conversation needs a fresh open. Inherited/synthetic rows, work records,
omitted bodies and compact IDs are explicit unsupported cases for this
profile. They remain future integration work, rather than being silently
shown as complete history.

Retention is capped at 500 records, eight accepted pages including the
initial snapshot, 4096 bytes per opaque cursor, 2 MiB of serialized retained
rows and 2 MiB of rendered text. The existing per-response and request-time
limits still apply. These are logical bounds, not measured RSS or allocator
limits. Hitting a bound refuses the page and preserves already shown text.
The view does not evict records or claim unbounded full-history support.
Malformed, duplicate, overlapping or wrong-scope pages also preserve the
view and disable further paging. No automatic retry follows refusal.

The shared loopback fixture covers an 80-record conversation across three
pages, exact percent encoding, next-page refusal, a later cursor cycle,
changed sequence and wrong-thread scope. The shared declarative workload
is `packages/client-runtime/rust/host/fixtures/saved-history.json`: forty
turns, each with a distinct user prompt and assistant reply. The application
runner imports those records through real scan/import RPCs and confirms
all server pages before opening the Makepad history window. Its native
proof checks the first page is incomplete, invokes the same command as the
visible button, waits for each worker, and verifies all 80 records in order.

```sh
node apps/server/scripts/verify-makepad-thread-snapshot.ts \
  "$CARGO_TARGET_DIR/debug/t3-code-ls-makepad-input" --history
```

Both toolkits can use `Connection::history`, `History::text`,
`History::has_older` and `History::load_older` from the same host source.
For GPUI application parity, import this exact workload on its selected
server backend, require an incomplete initial page, then assert all eighty
ordered records through the native history control and the existing AT-SPI
harness. The GPUI control and that application proof remain unimplemented
in this branch. The Makepad proof still uses the supported retained macOS
server backend and does not qualify native storage. Neither new history
runtime path has been executed locally.
