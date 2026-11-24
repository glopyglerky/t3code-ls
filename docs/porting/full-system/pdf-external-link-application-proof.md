# External PDF link application proof

The integrated source already implements external HTTP(S) PDF annotations. The
retained PDF-link change `42f0c977c5` supplies link geometry, scheme filtering and
accessible anchors in `PdfViewer`. `PdfDocumentRevision` forwards explicit clicks
to the existing `useOpenLink` preference, modifier and environment policy. The
stock oracle `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` contains the same path.
This slice adds missing application evidence without duplicating that behavior or
changing the user's launch preference.

The normal signed Files preview opens a synthetic two-page PDF. Its internal link
jumps to page two with pointer and keyboard input. In the focused external case,
the same PDF also contains a link to an owned `127.0.0.1` listener. The destination
is an inert page with a unique title and no script or external assets.

The packaged browser uses the stock fresh-profile `system` link preference. The
real `useOpenLink` and `LocalApi.shell.openExternal` therefore open an actual new
browser page. No fake desktop API, mocked popup, intercepted response or direct
navigation substitutes for the link activation. The proof requires:

- Zero destination requests and no new browser pages during document loading,
  both internal jumps and a bounded idle interval with the external link visible.
- A pointer activation and a keyboard Enter activation, each producing one actual
  destination request and the destination's visible heading.
- A null opener, an unchanged outer application route and unchanged PDF page
  position. The document stays on page one after each external activation.
- No unexpected destination paths or non-loopback HTTP(S) requests during the
  case, with only the two owned destination pages closed by the fixture.

The companion real-PDF component test checks that the HTTPS link is accessible,
passive until activation and delivered once to its launch callback. A `mailto:`
annotation produces no actionable link. This component test does not claim an
HTTPS network handshake or replace the real application case.

## Hosted execution

The existing `composer-offsets.yml` packaged PDF lane selects
`candidate/t3code-ls-t02-bundled-native-t13-pdf-external-*`. It uses the locked
compiler/dependencies and actual web/server/native bundles. Its runtime invocation
runs in a fresh network namespace with only loopback enabled:

```sh
sudo -n unshare --net -- bash -euc '
  ip link set dev lo up
  exec runuser -u "$1" -- env T3_CODE_LS_BUNDLED_CLIENT_PROOF=1 \
    T3_CODE_LS_PDF_LINK_PROOF=true T3_CODE_LS_PDF_EXTERNAL_LINK_PROOF=true \
    T3_CODE_LS_PDF_EXTERNAL_ONLY_PROOF=true \
    VITE_T3_CODE_LS_COMPOSER_OFFSETS=rust \
    "$2" apps/web/scripts/verify-hybrid-client.ts "$3" native
' _ "$(id -un)" "$(command -v node)" "$PROOF_DIRECTORY"
```

The dedicated scope is explicit and cannot be combined with another selected
proof scope. Completion requires the built native application, Rust composer,
signed-asset HTTP 200, both internal jumps, the exact external result and the
initial durable native snapshot/inspection. It returns before unrelated terminal
or later conversation qualification. Ordinary and integrated scopes retain their
full terminal and recovery checks.

The workflow checks `pdfExternalOnly`, `pdfLinks.external`, both activations,
exactly two requests, passive loading and opener isolation. The existing PDF
browser suite runs before the dedicated application case as its related owner
check, so a later generic terminal failure cannot suppress that component result. Keep the proof JSON, signed-asset status and existing bundle
identities. The listener and its pages are scoped and closed on success or failure.
Only the synthetic project's fixture file is updated with the allocated URL.

## Scope and remaining evidence

Local validation is static syntax, workflow-shell and patch checks. No local
browser, product build or test ran. The added application and component assertions
remain pending until the exact hosted candidate passes.

The existing 50 MiB document read, 2,000-page cap, page rendering budget,
virtualization, cancellation and signed-resource ownership remain unchanged.
There is no new PDF scripting, action scheme, native system-browser bridge or
automatic external navigation. Live HTTPS/TLS, saved app-link preferences,
modifier policies, Electron/OS browser launch, remote environments, mobile,
resource measurements and complete J47 parity remain separate qualification work.
No latency or performance improvement is claimed. MIT provenance is retained.
The mandatory research method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

## Routed qualification follow-up

Exact run `45175793823`, on
`candidate/t3code-ls-t02-bundled-native-t13-pdf-external-20261123` at
`75b4f5dea87f684cd444b4f54e5316ec820bf120`, populated every external PDF result
successfully: signed HTTP 200, both internal jumps, both explicit destination pages,
two destination requests, passive loading and null opener. Artifact `14818508800`
records those results. The overall run still failed because the common fixture
later accumulated an unrelated `fixture-reattach` terminal marker failure and
threw it at completion. The later PDF component step was skipped.

The dedicated scope uses `T3_CODE_LS_PDF_EXTERNAL_ONLY_PROOF=true`. Both the
focused PDF browser suite and the packaged, loopback-only fixture passed at
`fe50f40b690af841d54d74e09b3328854d180be1`.
[External link qualification](https://github.com/glopyglerky/t3code-ls/actions/runs/45178148470)
