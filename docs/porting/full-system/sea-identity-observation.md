# SEA identity observation prerequisite

The bootstrap recognizes `t3 __sea-identity` before `loadCliMain` or service
launcher loading. It reads only the embedded `binMain.mjs` bytes and the actual
server package name/version. It does not evaluate that asset, resolve sidecars,
start the application, open a listener, select a profile or invoke a provider.
It writes one JSON observation to stdout. This output grants no readiness or
lease-transfer authority.

The `t3-sea-identity-v1` frame includes package name/version, PID, platform,
architecture, Node version, SEA status, asset name/size/SHA-256 and
`serving: false`. Non-SEA execution, extra arguments, missing/empty assets,
assets over the 128 MiB probe budget and output failures refuse with exit 78.
No asset override or ordinary CLI fallback is available for this command.
The package identity is bundled from `apps/server/package.json`, never inferred
from an installed directory name or a caller-supplied version.

`node --test tools/sea-identity.test.mjs` checks bootstrap dispatch using controlled
module hooks. It simulates SEA and the entrypoint predicate, keeps actual package
identity and hashes real raw fixture bytes. Its embedded application throws if
evaluated. It refuses unexpected bootstrap imports and tests negative paths.
This source fixture does not prove bundling, executable SEA startup, process
identity, physical locks, timeout termination or reap.

## Proposed forward-owner command

The next protocol addition is a fieldless
`{"operation":"forward_owner_observe_entry"}` frame on the existing forward
owner. It must require a prior `forward_owner_bind_entry` in that same owner
lifetime. An unbound request refuses without staging or launching anything.
There is no caller-selected executable, asset, version, digest or environment.

Before launch, repeat the existing saved-receipt, selection, marker, runtime and
read-only catalog checks under the existing selection, home and database locks.
Close the catalog snapshot before spawning. Verify the retained immutable entry
against the receipt's `target_entry_sha256`, then launch that descriptor only,
with fixed `__sea-identity` arguments, empty environment and no inherited
database descriptor. No installed-path execution or retry fallback is allowed.

The physical owner must inspect `/proc/<owned-child-pid>/exe` while that exact
child is alive, checking its device/inode against the retained image, required
seals and receipt-bound executable digest. The JSON PID and `sea: true` are
claims to compare with that independent observation. They are insufficient
process-identity evidence alone. Package name/version must match independently
qualified package metadata; the asset digest remains an observation until bound
to independently qualified build evidence. A runtime directory version alone
does not establish the package version.

Reuse the existing bounded process owner after its lifecycle contract supports
this check: fixed timeout, bounded stdout/stderr, strict single-frame decoding,
empty stderr, checked exit status and explicit kill plus awaited reap on every
failure/cancellation path. Keep all physical locks and the retained image until
reap is observed. Lost output, identity races, timeout and uncertain completion
cannot produce success or admit another child before reconciliation. A future
bounded handshake must keep the probe inspectable until the parent has checked
the real running image; this one-shot prerequisite has no such handshake yet.

After reap, recheck the existing receipt, selection, marker, immutable entry and
catalog, closing the snapshot again. Only then report `observed: true`,
`reaped: true`, `serving: false` and the observed identity. Do not modify receipts,
selection, catalog fences or ownership. Do not unseal, recover, serve, transfer
leases or report readiness. A failed observation leaves the serving fence intact.

## Why launch remains unimplemented

On this source base, `redb_isolated_trial.rs::run_forward_process` is test-only,
discards output and has no process-identity observation callback.
`verify_intent_helper` bounds pipes and time, but its timeout drops a
`kill_on_drop` child without explicitly awaiting reap. The TypeScript launcher
does not own the Rust forward owner's locks. Reusing those paths unchanged
would not prove immutable running identity and reap under the retained owners.
Adding a separate supervisor would bypass the requested existing owners.

This patch therefore supplies the early probe prerequisite only. Actual launch
requires an extension of the existing supervisor and a bounded probe handshake,
then hosted Linux tests against a real single-asset SEA. Relative asset loading,
ordinary startup, installed acceptance and other platforms remain unqualified.
The existing forward-owner protocol, permanent catalog fences, port status,
stock source pins and MIT license remain unchanged.
