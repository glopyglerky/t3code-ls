# Interactive HTML application proof

This T13/J51 fixture exercises an HTML reply through the existing authenticated,
packaged browser application. It does not establish full MCP App parity.

The controlled ACP provider selects the `Interactive HTML` model. Unlike its
recorded scenarios, it uses its own provider-issued `T3_ACP_MCP_ENDPOINT` and
`T3_ACP_MCP_AUTHORIZATION` with the production `mcpToolSession` client. It initializes
one real MCP session, calls `html_render` once with a self-contained synthetic page,
and closes a stateful session before reporting success. Its ACP tool update carries
the actual result; the existing ACP adapter, HTML publisher, signed asset owner and
browser renderer remain responsible for storage, projection, authorization and
rendering. Endpoint redirects are refused, requests have ten-second deadlines, and
the scoped operation has a thirty-second deadline. Credentials and signed URLs are
excluded from the proof summary.

The normal browser proof creates a supervised thread through the composer. It
requires one completed run and one projected `t3-code.html_render` item. It then
checks the signed HTML response and interacts with the rendered document:

- A counter changes and a submitted local form produces its calculated result.
- The sandbox allows scripts and forms, omits same-origin permission, and reports
  an opaque origin. The publisher's real theme bootstrap is present and receives
  the host theme.
- Expanding content resizes the inline frame through the production message bridge.
- The real full-screen dialog creates a distinct frame. Its controls and resize
  messages leave the inline frame's state and size intact.
- Closing detaches the dialog frame. Reopening starts fresh state, and closing
  again leaves the inline controls usable.

There are no external assets, navigation destinations, live provider calls, fake
App APIs, intercepted responses or replacement HTML documents. The existing proof
owns the synthetic profile and loopback server. No production behavior correction
was needed from the source inspection; this change adds application evidence.

## Hosted execution

Use the existing pinned compiler, frozen dependencies, native helper build and
packaged application in `.github/workflows/composer-offsets.yml`. A candidate branch
named `candidate/t3code-ls-t02-bundled-native-t13-html-*` selects this proof. Integrated
native candidates select it as well. After those prerequisites, the executable
browser invocation is:

```sh
T3_CODE_LS_HTML_INTERACTION_PROOF=true \
T3_CODE_LS_BUNDLED_CLIENT_PROOF=1 \
VITE_T3_CODE_LS_COMPOSER_OFFSETS=rust \
node apps/web/scripts/verify-hybrid-client.ts "$PROOF_DIRECTORY" native
```

The workflow also runs `scripts/dev-replay-agent.test.ts` and the production
`AcpMcpStdioBridge.test.ts`. The added replay checks refuse absent or external MCP
sessions before publishing and keep synthetic credentials out of returned frames.
Preserve the existing proof JSON, application hashes, screenshot and server logs.
A populated `htmlInteraction` result records the checked bridge and lifecycle
outcomes; a screenshot alone is insufficient.

## Source and qualification boundaries

The behavior oracle remains stock `pingdotgg/t3code` at
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, with its retained MIT provenance. The
application owners are `HtmlRender`, `AcpMcpStdioBridge`, the ACP adapter,
`HtmlRenderFrame`, `HtmlRenderDialog` and `HtmlRenderDocument`. This proof follows
the mandatory method SHA-256
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

Local validation covers syntax, workflow shell syntax, self-contained fixture
inputs and patch hygiene. A bounded dependency-free ACP process check also parsed
all recorded scenarios, advertised the HTML model and selected it without running
a tool. The actual browser run and application acceptance await
the hosted lane. No latency, resource or stock-performance improvement is claimed.

Full MCP Apps require a provider runtime implementing `runtime.mcpApps`; the ACP
replay runtime does not supply that capability. App initialization, app-specific
resources and tools, malicious bridge cases, link/shortcut gesture policies,
downloads, remote environments, mobile and desktop hosts, and performance remain
separate J51 qualification work. This slice does not change port acceptance state,
renderer selection, application authority or default shipping behavior.
