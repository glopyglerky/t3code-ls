# Run the GPUI desktop showcase

The candidate opens one `hybrid-fixture` workspace in a GPUI window. It reads
the recorded assistant chunks from the existing [synthetic showcase transcript](../../server/scripts/dev-replay/showcase_transcript.ndjson)
and applies them through the shared Rust `TextRevision` model. The window
keeps drafts and results in memory until you close it. The binary has its own
Cargo workspace and opens only with `--fixture showcase`.

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
