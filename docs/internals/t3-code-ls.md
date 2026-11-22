# t3code-ls design and divergence

## One application

The original T3 Code server and clients remain the product. The fork replaces
implementation behind existing services and public contracts. Required source
stays at its upstream path until the Rust replacement runs in the real
application and passes the affected behavior and platform gates.

The restored application source comes from `d29a94f`; the overlay preserves the
later Rust work on `0be60f8`. Source recovery does not certify the historical
application. [Recovery evidence](../porting/recovery.md) records current checks.
The root Cargo workspace coexists with upstream's pnpm workspace. The port map
assigns preserved crates to application domains; moves are separate from behavior
changes. There is no second vendored application or permanent legacy tree.

## Contracts and integration

Server adapters preserve upstream authorization, request and response schemas,
errors, cancellation and event ordering. Policy, project, guest-share, recovery,
maintenance and Unix Codex runtime/generation code already have native callers.
Choose an implementation before execution. Never retry an uncertain effect
through another backend. Default native selection is restricted to Linux GNU x86_64 with GLIBC 2.39 or
newer. Other hosts retain the original implementation. Explicit native overrides
fail through their existing error contracts; `T3_CODE_LS_IMPLEMENTATION=upstream`
selects the original backend for controlled comparisons before effects begin.

`crates/app` is preserved experimental native service work. Its JSON-RPC HTTP
protocol and raw Codex events do not implement the existing clients' WebSocket
and orchestration contracts. Its tests cannot qualify the normal application.

## Persistence and transport

The selected native route uses the pinned omdb fork through one transaction owner
for events, projections, command receipts, outbox and the remaining application
repositories. The port map records this as `redb-persistence`, integrated, with
platform acceptance still separate. Shared orchestration and provider execution
remain in the retained application graph; native storage alone is not a Rust
server replacement.

SQLite remains the migration source, immutable comparison and upstream-selected
implementation on unqualified targets. Native activation fences older SQLite
servers and the retained configuration refuses an activated home. An old SQLite
file is not a current rollback target after native writes. The
[cutover record](../porting/redb-cutover.md) and
[port map](../../port-map.json) describe the actual boundary and evidence.

The [full-system implementation guide](../porting/full-system/README.md) proposes
typed storage, streaming and whole-system comparisons behind the authoritative
omdb boundary. Its engine candidates do not change production selection.

Iroh currently forwards authenticated bytes. Connect identity, pairing,
authorization, browser/desktop/mobile connection lifecycle and reconnect behavior
remain in the inherited application. Replacing those responsibilities requires
separate acceptance through the same client messages.

## Compilers and evidence

`toolchain.lock.json` pins the application compiler package and its actual
producer identities. Full Rust runs through Lustr's compatibility coordinator
and rustc-derived BlueFe. `lust-toolchain.json` separately pins native Lust's
supported subset. A compatibility build does not establish native Lustr coverage.
Application CI consumes verified artifacts; compiler bootstrap belongs upstream.

The port map distinguishes candidate, integrated, accepted, retired and synced.
Tests qualify their exercised behavior and platforms. A Linux component result
cannot retire Windows code, prove a browser Wasm build or replace a mobile UI.
`check-source` validates source retention and migration records, never the
absence of other languages. Source mappings survive retirement so future
upstream changes still identify affected Rust modules.

`upstream.lock.json` separates detected nightly, integrated source and qualified
application revisions. Updating a pin does not incorporate behavior. Differential
reference checkouts live outside the product tree. Existing licenses, reference
pins and source history remain intact. Workspace-owned Rust forbids unsafe code;
upstream dependencies, OS interfaces and external providers remain separate
boundaries, so no whole-stack memory-safety claim follows.

