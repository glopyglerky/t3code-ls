# T11 composed browser subset

The opt-in `candidate/t3code-ls-t02-bundled-native-t11-dioxus-composed-*` lane in
`.github/workflows/composer-offsets.yml` builds one normal browser package with
Dioxus pairing/setup, find, thread links, Send/Stop, ordinary approval and assistant
text selected together. Rust composer offsets and draft reconciliation are also
selected.

The lane uses `verify-hybrid-client.ts` with the existing isolated synthetic replay
provider and native omdb store. It pairs through the real form, checks two-tab draft
reconciliation, sends and stops formatted streaming text, follows a thread-read
link to that stopped thread and browser history with an unsent draft, approves the pinned recorded request,
restarts its owned server against the same store, checks the exact approval receipt,
finds the completed reply and reopens the stopped thread and its draft. It records
three unique launch commands and one Stop command. Existing verification helpers
own the navigation, reconciliation, approval, Stop and assistant-text assertions.

After the workflow builds the package, repeat the runner with the same selectors.

```sh
export T3_CODE_LS_BUNDLED_CLIENT_PROOF=1
export VITE_T3_CODE_LS_COMPOSER_OFFSETS=rust VITE_T3_CODE_LS_DRAFT_RECONCILIATION=rust
export VITE_T3_CODE_LS_PAIRING_RENDERER=dioxus VITE_T3_CODE_LS_THREAD_FIND_RENDERER=dioxus
export VITE_T3_CODE_LS_THREAD_LINK_RENDERER=dioxus VITE_T3_CODE_LS_COMPOSER_SUBMIT_RENDERER=dioxus
export VITE_T3_CODE_LS_APPROVAL_RENDERER=dioxus VITE_T3_CODE_LS_ASSISTANT_TEXT_RENDERER=dioxus
for renderer in dioxus dioxus-fallback; do
  T3_CODE_LS_BROWSER_COMPOSITION_PROOF="$renderer" \
  T3_CODE_LS_COMPOSER_SUBMIT_PROOF="$renderer" T3_CODE_LS_COMPOSER_STOP_PROOF=true \
  T3_CODE_LS_APPROVAL_PROOF="$renderer" T3_CODE_LS_ASSISTANT_TEXT_PROOF=true \
  T3_CODE_LS_ASSISTANT_INLINE_PROOF=true \
    node apps/web/scripts/verify-hybrid-client.ts "$RUNNER_TEMP/composed-$renderer" native
done
```

The second run uses a new synthetic profile and blocks the shared pairing Wasm
before its first navigation. All affected retained fallbacks must remain usable
through the same journey. Rust text Wasm remains available, so draft reconciliation
and composer offsets must still execute Rust. The individual drafts lane covers the blocked text binding.

Receipts are `composed-<renderer>/native/proof.json` and `summary.json`, retained
under the existing `built-composer-proof` artifact with application/module hashes.
`composition`, `composerStop`, `threadNavigation`, `historyFind`, `draftMerge` and
`approvalReceipt` describe the observed scope. A receipt is valid only after the
workflow actually passes on the identified source and package.

The package uses the existing React application shell and router. Full T11
qualification still requires the remaining browser views, offline storage, storage
denial and accessibility. Both composed runs require hosted execution.
