# Cursor adapter fixture host

The host executable accepts a loopback socket address, then bounded NDJSON
`create` and `send` requests on stdin. It runs the existing Rust Connect client,
flushes each text delta and closes the bridge agent before emitting its result.
Invalid or truncated streams exit with status 2 and produce no completed result.

`CursorBridge.integration.test.ts` injects this host behind the existing
`CursorAgentSdkRunner` interface and exercises the real Cursor adapter. A loopback
peer converts the checked-in `simple/cursor_transcript.ndjson` text and terminal
records to the published `sdk.v1` envelopes. It checks CreateAgent, the exact
prompt with delta negotiation, CloseAgent, delta order, one assistant identity,
and the adapter's completed or failed outcome. The SDK loader throws if invoked.

The fixture fixes its run identity from the recording before dispatch. It covers
one text-only turn with a synthetic bridge. General run discovery, approvals,
steering, permissions, cancellation and installed bridge operation need further
qualification. The live application continues to select its SDK runner. The
vendor bridge itself embeds that SDK.

The protocol source is Cursor's MIT-licensed bridge at
`6c9101088c18fab95c73d2dd68ca11d6fbf7d483`. Existing Rust stream semantics and
recording conversion live in the parent package. The host uses `std`, Tokio and
Hyper for local I/O. The stream decoder uses `no_std` with `alloc`.

The hosted `cursor-bridge-adapter.yml` lane builds with the pinned Lustr and
blueFe package and runs the adapter fixture with
`T3_CODE_LS_CURSOR_BRIDGE_EXECUTABLE` naming that exact executable. A standalone
test invocation without that variable skips the fixture.
