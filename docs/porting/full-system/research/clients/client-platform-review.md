# Full client, UX and platform research for a Rust T3 Code

Pinned upstream: `pingdotgg/t3code@28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. Reviewed through immutable Git objects. No source checkout changes, application-state access, benchmark execution or product changes.

## Decision

A complete Rust T3 Code needs a shared application core and several client hosts. A desktop chat window plus a Rust server would leave a large part of the product behind. The required product includes browser use without installing an app, iOS and Android, a scriptable CLI, native desktop integration, background notifications, hosted account and pairing flows, interactive browser content, release and recovery tooling, installers, and the public download site.

The practical target is Rust-owned application logic with shared domain, protocol, text, cache and state-transition code, compiled natively and to WASM where appropriate. Keep explicit browser and OS adapters. Browser engines, platform text systems, audio/video decoders, provider executables and provider-owned formats remain external dependencies. If "entirely Rust" also forbids those components, preserving the current product is not a credible claim. The code inventory identifies the dependencies that must be integrated, replaced with equivalent components, or explicitly decided, rather than silently dropped.

The native desktop and mobile renderers should share semantic models, not force every platform into one lowest-common-denominator widget set. Web still requires DOM or equivalent accessible browser interaction. The public site should keep useful static HTML. A Rust-generated site can replace Astro without making visitors download and start the main application's WASM runtime.

These are architecture recommendations, not measured performance claims. Framework compatibility and dependency selection belong to the parallel engine/toolkit research.

## What was examined

The scoped filename inventory includes 5,385 paths across web, mobile, desktop, CLI, contracts, client runtime, scripts and selected docs. A separate complete apps tree adds the marketing app and contains 6,296 paths at this revision: desktop 332, marketing 105, mobile 1,911, server 1,766 and web 2,182. These counts are filenames, including assets/tests/generated material; they are not counts of reviewed implementations.

Source captures cover manifests, entrypoints, contracts, selected renderers/native modules, user docs, release/setup docs, installers and selected CLI handlers. The source ledger distinguishes full-file review, selected implementation sections, declaration-only CLI inventory and captured-but-unreviewed files. The capability map covers 30 families. It does not claim every route, every provider capability or every native implementation is fully audited.

The earlier non-server ownership study remains relevant: [the nonserver ownership review](../database/nonserver/nonserver-review.md) and its 33-journey matrix. Its earlier decision to leave owned client components outside the project is superseded by the expanded full-Rust scope. Its ownership and durability facts remain requirements. Provider-owned formats and cloud services remain separate compatibility boundaries even when their T3-owned adapters are rewritten in Rust.

## Stock is already optimized

A performance plan must start from the current implementation.

| Area | Verified current mechanism | Consequence for a Rust design |
|---|---|---|
| Startup | Web imports Clerk only when cloud configuration requires it; local startup avoids that dependency. Chat navigation preserves the chat view through modal overlays. | Compare complete cold and warm startup and actual route transitions. Do not count removal of a dependency that the measured path never loads. |
| Conversation timeline | LegendList virtualization, memoized rows, scroll anchors and distinct height classes for very large messages. | Native rendering must preserve visible position and bound work to visible/changed content. "React rerenders everything" is an invalid baseline. |
| Streaming Markdown | Completed blocks are cached; only the final growing block is reparsed/rerendered on the supported incremental path. Special semantics fall back to whole-text processing. | A Rust parser should preserve the block/offset model and improve remaining parsing, conversion and layout work. Reparse-all native code can lose. |
| Web diffs | A shared pool uses 2–6 workers, AST LRU 240, a 30-second idle lifetime and a 1,000-character line-highlighting limit. | A synchronous native highlighter would regress responsiveness. Preserve cancellation, bounded caches and large-line handling. |
| iOS diffs | Printable-ASCII fixed-pitch measurement; native TextKit for tabs/Unicode; thread-local measurement; 128 cached drawn layouts; clipped glyph drawing. Full payload decoding/preparation runs off the main thread and discards obsolete queued work. | Native Rust must be compared with an already-native text/layout path. Full-document transfer, layout and retention deserve separate measurement. |
| Terminal | Official libghostty-vt C ABI in WASM, Canvas2D style/background runs, dirty-row repaint and animation-frame coalescing. React does not own the hot render loop. | An Alacritty/Rust terminal is a compatibility and measured-rendering choice, not a demonstrated language speedup. |
| Mobile terminal bridge | Serialized native writes, newest-pending-snapshot coalescing, cursor advance only after acceptance, bounded replay after a partially applied failed write. | Preserve ordering and recovery while reducing bridge/copy cost. Dropping output is not an optimization. |
| Mobile updates | Draft/outbox flush precedes reload; the app checks safe background state again after flushing and leaves failed work queued. | Native packaging must retain recoverable local work and define its own safe installation/restart contract. |

Sources: [startup](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/main.tsx), [route identity](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/routes/_chat.tsx), [timeline](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/chat/MessagesTimeline.tsx), [Markdown](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/ChatMarkdown.tsx), [diff pool](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/DiffWorkerPoolProvider.tsx), [iOS layout](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/modules/t3-review-diff/ios/ReviewDiffCodeLayout.swift), [iOS diff view](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/modules/t3-review-diff/ios/T3ReviewDiffView.swift), [terminal architecture](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/terminal/ghostty/README.md), [terminal renderer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/terminal/ghostty/renderer.ts), [mobile writer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/features/terminal/terminalOutputWriter.ts), [mobile updates](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/features/updates/app-updates.ts).

## Successful upstream changes and what they teach

The following merged changes are in the ancestry of the pinned baseline. Numbers are upstream-reported historical results, not measurements reproduced for this research and not forecasts for the Rust application.

| Change | Reported result | Verified mechanism | Design implication |
|---|---|---|---|
| [PR 33942, commit c9f0caca](https://github.com/pingdotgg/t3code/commit/c9f0caca1b2cdc1ce77154f092ea5ef03c6f5f0d) | Large-history terminal attach fixture through the real client reducer, 5,555 → 751 ms median, 7.4× | Client requests only the bounded history it retains, 512 KiB by default, and server trims before transfer. | Avoid sending bytes a client will immediately discard. This did not measure a hands-on client or real relay. The narrow-history gain was negligible. |
| [PR 35072, commit 8b2763f6](https://github.com/pingdotgg/t3code/commit/8b2763f638241b1be5ddf334d4f3aac8de8114b3) | About 85% less launch data per environment; this row claims bytes saved, not startup elapsed time | Provider catalog digests and status deltas; retain held catalogs until the cwd-specific list arrives. Regression documentation budgets the first provider list below 1 KiB for a provider with 250 commands and 200 skills. | Separate identity/status from large catalogs; preserve cached-data validity and eventual refresh. Reported readiness work combined PRs, so do not attribute its whole benefit to this change. |
| [PR 31033, commit 1c8143cd](https://github.com/pingdotgg/t3code/commit/1c8143cd09f3da9de093efee50856ef0b56fc61e) | Windows remote-editor handler fixture, about 2.5 s → 62.5 ms, 17 editors and 58 PATH entries | Share directory listings across probes and use concurrency 8. | Reuse expensive filesystem discovery and bound parallelism. The primary PR explicitly excludes an end-to-end Electron run or recording; a faster visible picker is the intended benefit, not a measured UI result. |
| [PR 33956, commit a03f7185](https://github.com/pingdotgg/t3code/commit/a03f7185f2aa59466f44cfe113d1807c9733290c) | Long-PDF first find, 3.1× median | Publish and measure the first matching page before the full scan finishes; cancel stale extraction. | Measure time to the requested outcome as well as total completion. Do not wait for unrelated work. |
| [PR 35071, commit 2482b03a](https://github.com/pingdotgg/t3code/commit/2482b03a01cf998a26cddbff65c5e5b0b0f39b38) | Commit reports fewer round trips and overlapping thread load/socket connection; no numeric result asserted here | Commit metadata and affected connection/shell paths reviewed; detailed implementation is covered by server/transport research. | Native transport must compete with the current overlapping path, not sequential historical startup. |

The scope qualifications above come from the primary PR descriptions for [33942](https://github.com/pingdotgg/t3code/pull/33942), [35072](https://github.com/pingdotgg/t3code/pull/35072) and [31033](https://github.com/pingdotgg/t3code/pull/31033), reviewed by the parent researcher. The research reviewed commit metadata and selected patches. This publication retains the metadata and primary PR links; raw patches are omitted. Current selected-source presence checks are stored separately in `pinned-optimization-presence.json`.

Recent ancestry also includes moving image bytes outside mobile draft JSON, resumed-thread catch-up batching, isolated composer-footer changes and PR saved-data/read-ahead work. Those were found in commit inventory, with metadata captured. Their complete patches were not reviewed here, and no extra numeric benefit is claimed.

## User interactions that constrain replacement choices

### Text is a correctness boundary

The web composer is a rich Markdown editor with exact source mapping, inline chips, multi-format clipboard, undo grouping and explicit IME handling. The native iOS composer uses marked-text state to avoid sending during composition, native selection and pasteboard APIs, stale-event protection and accessibility elements for chips. Source offsets may use UTF-16 while Rust strings use UTF-8. Neither byte offsets nor grapheme indexes can be substituted silently.

A common Rust document model can reduce duplicate interpretation and make incremental updates explicit. Native hosts still need correct composition, caret, selection, keyboard shortcuts, clipboard formats, context menus and accessibility. CJK, combining marks, surrogate pairs, mixed-direction paragraphs and very large pasted text belong in acceptance. Native text control behavior should be the default reference for platform interaction. [Web composer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/components/ComposerPromptEditorTiptap.tsx), [iOS composer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift), [composer user contract](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/composer.md).

### Terminal replacement includes more than glyphs

Retain shell/environment selection, terminal identity, PTY geometry, stopped-terminal resume, sequence resets, bounded history, alternate-screen behavior, mouse/focus reporting, reply routing, CJK composition, clipboard, platform selection behavior and reconnect replay.

The retained-output code tracks parser state at a trimmed boundary and avoids replaying a trailing incomplete control sequence. Screen/scrollback clear is distinct from resetting all terminal modes. Client writes have length bounds and avoid splitting surrogate pairs. Query replies can be marked so multiple attached viewers do not all answer the same server query. These semantics must survive a different terminal engine. This study does not assert support for every Kitty extension or inline terminal-image protocol. [Terminal contract](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/contracts/src/terminal.ts), [retained buffer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/client-runtime/src/state/terminalOutput.ts), [surface input/render lifecycle](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/web/src/terminal/ghostty/surface.ts), [terminal docs](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/terminal.md).

### Browser content remains part of the product

HTML replies can contain scripts and render on web, desktop and mobile. MCP Apps can call their allowed tools, send thread messages, follow the theme and use controlled fullscreen/navigation behavior. A screenshot or native HTML-like renderer is not equivalent.

Preview behavior also differs by host. Desktop can render a remote environment's loopback page locally through a tunnel. Streamed remote tabs remain available, and mobile can use a native local WebView with host-specific storage. Loopback routing must never fall back silently to the wrong device. User/agent input ownership, clipboard, uploads/downloads, popups, annotations and sandbox restrictions are observable requirements. Root owns the transport/security design. [HTML/MCP contract](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/html-renders.md), [preview behavior](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/remote-access.md), [desktop IPC](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/packages/contracts/src/ipc.ts).

### Mobile is a native operating-system integration

Current mobile has native diff and text rendering, native terminal code, native composer handling, hardware keyboard integration, share input, local durable queues, camera/audio permissions, app links, encrypted credentials, Live Activities, widgets and platform navigation. An ordinary mobile web page will not cover those behaviors.

The config includes app variants and URL schemes, verified thread links, passkey/associated-domain settings, tablet layout, predictive back and widget extension configuration. The release path separates compatible OTA updates by native-runtime fingerprint. A native Rust product needs its own store-compatible update plan, with versioned local-state migration and safe queued-work recovery. [Mobile config](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/app.config.ts), [app entry](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/App.tsx), [navigation](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/mobile/src/Stack.tsx), [notifications](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/mobile-notifications.md), [release runbook](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/operations/release.md).

### Installation and command-line behavior are user capabilities

The installers verify SHA-256, stage a version, execute its version probe, publish a completion marker and preserve unrelated commands. The current standalone CLI covers human setup and machine automation; there are private protocols used by service and SSH launchers. Replacing the executable must preserve JSON/exit/output conventions and installation ownership. Detailed findings are in `cli-contract.md`. [Install behavior](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/install.md), [POSIX installer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/scripts/install.sh), [Windows installer](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/scripts/install.ps1).

## Plausible full-journey wins against current stock

These are hypotheses with explicit mechanisms and measurements, not established speedups.

1. **Cold desktop launch to usable workspace.** A native host may reduce process, JavaScript initialization, memory and asset cost. Measure click-to-usable composer and mature-workspace restoration, including auth, cached state and server readiness. Track provider discovery separately from the foreground startup path. Browser preview creation must be measured separately, since it still requires a browser engine.

2. **Long live conversation while typing.** Share a compact typed projection, retain immutable completed blocks, send changed segments and cache layout independently of transport batches. Measure key-to-paint and token-arrival-to-paint, tail frame times, allocations and retained RSS while several threads stream. Preserve stock virtualization and source/citation offsets. Avoid promising large gains from Markdown parsing alone.

3. **Large file/diff review.** Keep text in a reusable buffer, apply incremental edits, calculate only visible layout and send compact changes to native views. Measure first useful viewport, scrolling, jump-to-line, select/copy, search and save with concurrent external updates. Stock already uses workers and native layout, so the opportunity is remaining full-payload conversion, cross-boundary transfer and unnecessary layout.

4. **Reconnect and switch between environments.** A shared Rust state core can retain typed snapshots, merge deltas once and resume only visible demand. Measure time to a stable authoritative view, network bytes and CPU across many environments. Current provider digests and catch-up batching set the baseline. Cached first paint and authoritative completion are separate outcomes.

5. **Terminal streaming with chat and preview active.** Bounded byte buffers, direct parser access and minimal bridge copies may reduce CPU/allocations and latency under contention. Measure PTY output-to-pixels, input echo, dropped frames, reconnect time and CPU/RSS. Respect all output/reply semantics and the existing history cap.

6. **Attachment-heavy mobile draft and send.** Use durable file references, incremental metadata writes, bounded transforms and resumable uploads. Measure paste/camera-to-visible attachment, typing latency, background flush and reopen recovery. Image bytes are already being moved out of draft JSON in stock; compare the pinned implementation.

7. **Idle battery and background behavior.** Demand-driven subscriptions, bounded timers and resource release can reduce background CPU and network usage. Measure hidden and visible workspace states, many environments, widgets and live activities. Preserve notifications without holding unnecessary live connections, as the current design already intends.

8. **Install and update.** A smaller native distribution may reduce download/extract/startup time. Measure full verified install and update with rollback and existing state, not executable size alone. Keep service, package-manager, desktop and mobile ownership rules separate.

The performance acceptance extension contains 27 additional journeys, numbered 34–60, to accompany the earlier 33. Set absolute budgets from measured stock behavior and product expectations before judging candidates. A weighted average must not conceal regressions in typing, terminal control, offline recovery, accessibility or updates.

## Remaining audit gaps

The filename inventory is broader than implementation review. Complete screen-state, Android native-renderer, media-codec, device-streaming, SnapShot, screen-reader and OS-version matrices still require dedicated implementation validation. The current work identifies their owners and observable contracts. It does not certify parity for any Rust toolkit.

Successful historical commits provide specific design evidence. They do not prove that their original ratios still apply to the full pinned application. The current reports should be read as a capability and architecture basis for implementation, with every performance claim explicitly separated from future acceptance.

