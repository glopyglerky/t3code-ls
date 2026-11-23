# Makepad desktop input candidate

This T01 candidate opens one synthetic plain-text draft in the desktop app.
Makepad owns editing, focus, undo history and provisional IME text. The
shared `t3-code-ls-client-text` crate stores committed UTF-8 and the UTF-16
anchor and head in selection order. Submission validates the current widget
text. It reports the accepted byte count locally, with a 4096-byte cap and
no account, provider, server or persistent draft.

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

The local disk-reserve guard refused the compiler probe. The GUI proof
awaits a host build. Synthetic events begin after AppKit translation. Real
input-method behavior, including nonempty AppKit replacement ranges, needs
a separate test. Rich content, accessibility, packaging, other platforms,
and the packaged Lustr and blueFe route remain outside this evidence.

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
