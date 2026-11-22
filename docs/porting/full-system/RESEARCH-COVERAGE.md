# Research coverage and source register

Research date: 2026-11-22. Behavior/performance baseline: pingdotgg/t3code at 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f. The current fork was consulted for migration requirements at 3577878a5e008c8af87a8fbdae13d26dea1c2f50; it is not the performance denominator.

## Coverage

| Scope | Enumerated or captured | Semantic coverage |
|---|---|---|
| Server, protocols and providers | 1,115 selected paths; 138 captured files verified against pinned Git blob IDs | Major ownership and capability families; full selected docs/small modules; selected branches of large adapters and orchestration |
| API and orchestration | 247 RPC methods, 31 streaming; 59 typed HTTP endpoints; 58 public and 16 internal command variants; 49 event variants | Lexical declarations and family mapping; not every request/response field or runtime dispatch |
| MCP and extra HTTP | 93 tool declarations in 15 toolkits; 25 supplementary registration entries | Caller/mode/access model and selected handlers; supplementary entries include separate listeners and SDK registrations and are not an additive active endpoint total |
| Client and platform | 30 capability families; 84 captured sources | 25 full reviews, 46 selected-section reviews, 3 declaration/headings reviews, 10 captured without semantic review |
| CLI | 33 production files in declaration inventory | Selected command/stdio/exit/setup behaviors plus full SSH helper review; not exhaustive signals/service-manager coverage |
| Performance acceptance | 33 earlier storage/lifecycle journeys plus 27 full-product journeys | A proposed 60-journey evaluation design, not executed results |
| Rust stack | Exact repository pins in research/rust-stack/source-pins.json | Platform/UI/terminal/text/Git candidates, primary implementation mechanisms and scoped performance evidence |
| Prior persistence study | SQL/migration/runtime and nonserver storage inventories retained in database appendix | Its own detailed coverage files remain authoritative for that scope |
| Root synthesis | Fork requirements, upstream architecture/auth/remote/Connect docs, stream/search source, provider SDK imports/hooks, historical performance PRs and official transport/platform sources | Architecture and performance hypotheses cross-checked against the reports and pinned primary excerpts |

No builds, tests, benchmarks, migrations, provider turns, installed application state access or product edits ran in this research. Historical measurements are attributed to their original authors and fixtures. A fetched file is not counted as a full semantic review. The root report was reviewed for server, storage and UI overclaims and corrected before delivery.

## Remaining qualification

The principal open implementation proofs are Cursor and Claude native protocol/SDK parity; every platform's input, rich-text accessibility and embedded browser behavior; native widgets/Live Activities and update delivery; complete Git/source-control-host behavior; media/device/SnapShot edge cases; every large adapter/schema branch; and measured end-to-end timing.

These are implementation and validation workstreams in the complete plan. They are not omitted capabilities. A single successful component or one platform's result cannot close them.

## Root primary sources

- Upstream README and full tree: https://github.com/pingdotgg/t3code/tree/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f
- Fork requirements: https://github.com/glopyglerky/t3code-ls/blob/3577878a5e008c8af87a8fbdae13d26dea1c2f50/AGENTS.md
- Remote and authority model: docs/internals/overview.md, connection-runtime.md, remote.md, environment-auth.md and t3-connect.md at the upstream pin
- Streaming: ProviderTextDeltaCoalescer.ts, CodexAdapterV2.ts, ThreadLiveEventCoalescer.ts and LiveStreamBudget.ts under apps/server/src/orchestration-v2 at the upstream pin
- Workspace query contention: apps/server/src/workspace/WorkspaceSearchIndex.ts at the upstream pin
- Cursor/Claude native boundaries: packages/provider-cursor/src/server/CursorAgentSdk.ts and apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at the upstream pin
- Historical terminal attach: https://github.com/pingdotgg/t3code/pull/33942
- Historical mobile launch data: https://github.com/pingdotgg/t3code/pull/35072
- Historical Windows editor handler: https://github.com/pingdotgg/t3code/pull/31033
- Historical full-app PDF first hit: https://github.com/pingdotgg/t3code/pull/33956
- Zed text indexes: https://github.com/zed-industries/zed/pull/19913 and https://zed.dev/blog/zed-decoded-rope-optimizations-part-1
- Zed inspector overhead: https://github.com/zed-industries/zed/pull/64309
- Zed presentation and correction: https://zed.dev/blog/120fps
- Iroh browser limitations: https://docs.iroh.computer/languages/wasm-browser
- Iroh protocol roles: https://docs.iroh.computer/concepts/protocols
- Iroh hooks: https://docs.iroh.computer/connecting/endpoint-hooks
- Iroh 1.5: https://www.iroh.computer/blog/iroh-1-5-0
- irpc 1.0: https://www.iroh.computer/blog/irpc-1-0
- Early data: https://www.iroh.computer/blog/0rtt-api
- Production native transfer example: https://www.iroh.computer/blog/strada-direct-file-transfer
- Apple widget and Live Activity model: https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension and https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
- Android activity/IME limitation: https://github.com/rust-mobile/android-activity/blob/b4ddf059b77be12cdb955d394e65a92e7568d936/README.md

Per-capability primary citations, tool/library revisions and detailed comparison limits are adjacent to their claims in each report. Source manifests retain exact path and revision identities. No runtime result can be inferred from this source register.
