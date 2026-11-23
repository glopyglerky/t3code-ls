# Server preview application proof

This T13/J50 case uses the normal authenticated, native-selected packaged web
application and its server-browser preview. It creates a controlled page on an
owned `127.0.0.1` HTTP listener. No Electron bridge, replacement iframe, fake preview
API, response interception, live provider or external website supplies the result.

The proof opens Browser in the normal right panel and enters the page address.
The actual `PreviewView`, `ServerBrowserSurface`, authenticated
`/api/preview-stream/ws` route and `ServerBrowser` owner provide navigation,
control, CDP input and binary image frames. The application must:

- Paint real frames and obtain viewer control for the current thread/tab.
- Follow a page link, report the destination title, and return with the normal
  Back control while the outer application route and page count stay unchanged.
- Deliver pointer input through the canvas to a button whose local HTTP round
  trip and actual button DOM label are independently observed by the fixture listener.
- Close all viewer sockets when the right panel is hidden. No more image frames
  may arrive on those closed sockets. Showing it must reconnect the same preview
  tab and retain the page counter. Close controls are selected from the active
  production tab and checked against the visible surface's stream tab ID and URL;
  they do not depend on script-only document title changes.
- Close that preview tab, detach its stream and open a different tab with fresh
  page state. Final close must release every fixture viewer.

A bounded page animation ensures that a quiet page cannot make a stalled stream
look healthy. Connections, event history, HTTP input, viewport dimensions and
waits are bounded. Socket tickets are never included in the proof summary. The
summary records thread-scoped socket identity checks, binary frame count,
interaction events and lifecycle outcomes. The observed count/DOM-label sequence
must be exactly `1, 2, 1`, establishing retention and reset separately.
`preview-first-click.png`, `preview-reconnected-click.png` and `preview.png` capture
the real canvas at those checkpoints.

Source inspection found the existing visibility cleanup in
`ServerBrowserSurface` already calls both painter stop and client stop. The server
viewer scope stops its CDP screencast and detaches its session. This change adds a
focused component regression and the application case instead of changing that
working ownership design without failure evidence. Hosted execution still decides
whether the inspected lifecycle works through the packaged application.

## Browser acquisition and hosted execution

The hosted preparation script calls the production `makePreviewBrowser` installer.
It uses the existing source pin, archive size/hash checks and safe extraction, then
records the actual executable hash and reported version. That preparation is the
only new network acquisition phase. The application case runs in a new network
namespace with only loopback enabled, after the browser has been staged into its
fresh synthetic home. It cannot download another browser during the case.

The focused `composer-offsets.yml` lane selects
`candidate/t3code-ls-t02-bundled-native-t13-preview-*`. Its existing pinned compiler,
frozen dependencies, native helper build and server/web bundles remain unchanged.
It also selects the existing stream/control tests and the surface browser test.
After those prerequisites, the scoped commands are:

```sh
node apps/server/scripts/prepare-preview-fixture-browser.ts "$PREVIEW_BROWSER_HOME"
sudo -n unshare --net -- bash -euc '
  ip link set dev lo up
  exec runuser -u "$1" -- env \
    T3_CODE_LS_BUNDLED_CLIENT_PROOF=1 T3_CODE_LS_PREVIEW_LIFETIME_PROOF=true \
    T3_CODE_LS_PREVIEW_BROWSER_HOME="$4" T3CODE_SERVER_BROWSER_SANDBOX=0 \
    VITE_T3_CODE_LS_COMPOSER_OFFSETS=rust \
    "$2" apps/web/scripts/verify-hybrid-client.ts "$3" native
' _ "$(id -un)" "$(command -v node)" "$PROOF_DIRECTORY" "$PREVIEW_BROWSER_HOME"
```

The Ubuntu fixture explicitly disables Chrome's process sandbox inside this
loopback-only namespace to avoid changing host AppArmor policy. This is reported
in `previewLifetime.sandbox`; it does not qualify sandboxed launch or change any
product default. No actual user home or installed runtime is opened. The runner
removes its copied browser after stopping the application, and the workflow removes
the owned preparation installation. Small manifests and proof artifacts remain.

## Qualification boundaries

Local checks are syntax, patch and workflow-shell checks only. No local browser,
product build, installer or test ran. The hosted application assertions and new
component regression remain unexecuted until the exact candidate lane passes.

A disconnected viewer establishes stream lifetime, not zero page CPU or stopped
page JavaScript. Hidden panels retain their page intentionally. Browser startup,
CPU/RSS/energy, bitrate, latency comparisons, document visibility/background tabs,
PIP/recording, remote tunnels, storage/passkeys, files/downloads/popups, control
handoff and the other desktop/mobile targets remain separate J50 obligations.
No speedup, platform acceptance or complete browser parity is claimed.

The source oracle remains stock `pingdotgg/t3code` at
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`, with MIT provenance retained.
The mandatory method is SHA-256
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.

## First hosted failure and fixture repair

Exact run `45174188562` built source `8b4c03ac70390c56072bad02d24a73683843b9ac`
and reached real navigation, Back and the first button/HTTP acknowledgement.
The first failure was `hybrid-client-preview.ts:137`: a 90-second wait for
`Close Preview count 1`. Artifact `14820055295` retained ARIA with the navigation
label `Controlled preview first`, while its failure screenshot visibly showed
`Count: 1` and viewer control. The run did not reach hide/reconnect/close acceptance.

The repair keeps navigation title checks but uses the production stream tab ID,
current address and active-tab close control for lifecycle actions. The synthetic
page now reports its actual DOM label and path along with its counter. The expected
`1, 2, 1` states and all original socket, frame, navigation and ownership assertions
remain required. No production title or preview policy changed. Local validation
of this repair remains static; hosted execution of the follow-up is pending.
