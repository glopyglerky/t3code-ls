# Shared Dioxus browser binding

This existing Wasm asset contains opt-in pairing, welcome, thread-find and guest
name controls. It pins Dioxus `0.8.0-alpha.3`, wasm-bindgen `0.2.130` and the
locked host dependencies. OS/browser effects remain in the Wasm DOM adapter;
this crate uses `std` and does not establish a no_std or other-platform result.

`VITE_T3_CODE_LS_GUEST_NAME_RENDERER=dioxus` selects the semantic guest name form.
Its boundary contains only the initial name, pending/error status and a name
submission callback. GuestPage retains the invite credential, JavaScript trim,
HTTP redemption, session check and join transition. Rust uses the browser String
trim predicate for matching blank-input feedback, a bounded native input, a
labelled form and mount-owned listeners. A local synchronous pending gate prevents
duplicate submissions before the application status update arrives. Name edits
made while pending survive rejection. Disposal clears the DOM, listeners and
renderer; late module results and late HTTP completions cannot rejoin a stale
form. Wasm load failure offers the retained form. Default builds keep that form.

The `Rust composer browser proof` workflow accepts
`candidate/t3code-ls-t11-dioxus-guest-*`. It builds this asset through the pinned
Lustr/BlueFe route, runs the guest browser suites for retained and selected
renderers, then exercises the built `/guest` application through the existing
isolated server/browser runner. The packaged proof hashes the actual served Wasm,
checks focus, maximum length, blank refusal, trimmed submission, pending duplicate
refusal, a lost HTTP response, an explicit rejection and retry, then cookie-backed
session reopen without another redemption. A fresh document with the Wasm request
blocked must offer working retained controls. Component cases also cover route
teardown during HTTP and module loading.

Guest HTTP responses and the stream in that packaged UI fixture are synthetic
browser routes. They deliberately do not qualify server authorization, real invite
consumption, native persistence or Connect deployment. The current native guest
fixture (`tools/omdb-guest-redeem-fixture.ts`) invokes GuestHttp's in-process web
handler with controlled dependencies; its listener exists only for MCP registry
identity. It is not a packaged guest provisioner. No production permissions or
credential checks are changed to make this UI test possible.

The stock product comparison remains T3
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, GuestPage blob
`9cc690491d3290c5dfbc0f927a1f633cdfec6837`. The port map tracks the integrated
source `c7a3f02e3851923ced8ebd000db79f641e11b038`, blob
`7ac90687b227c41b8e77f7707eaf95199b81cac6`. The newer stock form localizes the
labels. The hosted English fixture leaves that localization unqualified. MIT
provenance is preserved. The mandatory method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

The hosted browser check passed the retained form, the Dioxus form, and the
explicit Wasm-load fallback. Full T10/T11/J59 acceptance still requires the
packaged guest authorization route and broader client qualification.
[Hosted browser check](https://github.com/glopyglerky/t3code-ls/actions/runs/45186542668)
