# Windows amd64 CLI archive proof

The `cli-archive-proof.yml` workflow runs on focused Windows and integrated
candidate branches. Ubuntu runs the existing cross-target SEA and ZIP builders.
A Windows runner compiles the resource monitor, then a
Windows runner exercises the assembled archive. The jobs check source and
artifact hashes at both transfers. The workflow uses unsigned test artifacts.
The existing Linux native job remains selected for its original branches.

The lane pins Node 26.12.1, Rust 1.99.1, frozen pnpm dependencies and the
resource monitor's Cargo lock. It explicitly selects the retained upstream
service implementation for `win32-x64`. This follows the current platform
selector, which does not qualify native service helpers on Windows. Cargo
builds the resource monitor through the bootstrap compiler. The recorded
Lustr/blueFe source pin does not establish Windows compiler or service-helper
qualification.

The archive evidence records the source commit, Node version, actual Rust
compiler output, amd64 PE identity, ZIP signature and hashes of the executable,
archive, resource monitor, compiler source declarations and retained selection.
The smoke runner extracts the ZIP with Windows' system tar and runs its own
`t3.exe` with an empty PATH and a disposable home. Only the required Windows
OS environment is retained. The archive itself runs without host Node;
the deterministic replay provider deliberately uses the test runner's absolute
Node executable.

`--expect-upstream` requires an explicit retained manifest with no replacement
helpers. It checks the actual CLI version and useful help on stdout, empty
success stderr, token-only auth output, JSON session listing and a retained
SQLite file without omdb. Serving must return the bundled HTML application
and current environment protocol. The same recorded Unicode prompt, pending
question and failed-turn checks used by the native lane exercise project and
thread commands against the running server. They require exits 2 and 1,
valid JSON on stdout and actionable plain stderr respectively.

Running `install` directly from an extracted archive is outside the managed
`runtime/versions/<version>` layout. The runner checks that existing refusal
is exit 1, empty stdout and an actionable stderr message. It does not label
that refusal a Windows installer defect. The following managed lifecycle extension
is implemented but awaits its own hosted qualification. Update/rollback, service
integration, PTY and Windows signal semantics, signing and desktop/mobile packaging
remain unqualified.

Windows ARM64 appears in the existing SEA target map, native target identities
and archive naming code. That source coverage does not establish available
ARM64 runtime externals, execution, installation or acceptance. This lane
intentionally exercises only amd64.

The first hosted Windows attempt timed out after compiling the monitor. The
split build follows the stock packaging route. The Windows monitor compilation,
Ubuntu archive build, exact-byte transfer and Windows smoke all passed at
`622cefe41a037172978fdd7d8e6407d0ba03fa37`.
[Stock packaging](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/.github/workflows/release-desktop.yml)
· [Windows archive run](https://github.com/glopyglerky/t3code-ls/actions/runs/45174991784)

The stock product denominator remains
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`; this is no performance comparison.
The mandatory method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.
Existing MIT provenance is preserved.

[Windows runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
and [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)
provide host and packaging context. The pinned repository's builders, selectors
and executed artifact remain the qualification authority.

## Managed Windows launcher lifecycle

The retained Windows smoke now additionally copies the real extracted package into
an owned `runtime/versions/<version>` under a fresh home containing spaces. It uses
only `install`, `--version`, `uninstall --base-dir ... --yes` and auth session
commands. No boot service is installed or registered, no update command runs, and
no persistent PATH, registry or system configuration command is executed.

Source ownership follows `cli/install.ts`, `cli/uninstall.ts` and
`cloud/pinnedRuntime.ts`. Install refuses an occupied foreign launcher, writes a
specific generated `t3.cmd`, and records the canonical target in `runtime/launchers`.
Uninstall rechecks that ownership. Since Windows cannot unlink the running
executable, its existing detached `cmd.exe` remover waits before removing the
runtime directory. These owners are exercised as shipped; this slice adds no
installation implementation or alternative state authority.

The fixture requires all of the following:

- A foreign shim stays byte-identical after exit-1 refusal, with no launcher receipt
  and no state or unrelated-file change.
- Installation writes the exact generated shim and exactly one matching ownership
  receipt. Running that `.cmd` through absolute `cmd.exe` reports the expected
  archive version, with successful exit and empty stderr.
- The same `.cmd` runs uninstall. The launcher disappears and the command reports
  deferred runtime removal. The test then observes the runtime directory vanish
  through up to 200 bounded checks, spaced by 100 milliseconds. The harness does
  not delete it to satisfy that observation.
- The entire seeded synthetic `userdata` tree remains byte-identical. A real
  retained SQLite session listing reopens from the untouched extracted package and
  matches the original listing. An unrelated bin-directory file and the synthetic
  AppData tree remain unchanged.

The child environment redirects HOME, USERPROFILE, APPDATA, LOCALAPPDATA and all
T3 paths to the disposable fixture. Only the managed lifecycle child PATH contains
Windows System32 so the stock remover can resolve its OS utilities. This is not a
persistent PATH change and does not expose host Node. All existing archive checks
still use their original empty-PATH isolation. Commands through the `.cmd` have a
60-second timeout and bounded captured output. Auth tokens, session JSON and state
contents are not printed.

After all assertions, `WINDOWS_MANAGED_LIFECYCLE` emits one machine-readable receipt
without paths or credentials. The Windows archive job requires its version,
ownership, shim execution, observed detached removal, state reopening and file
preservation fields, then retains `managed-lifecycle.json` with the archive hashes.
The small receipt also records whether runtime removal had already finished at
command exit. It does not claim a separately observed detached process exit or
universal host-state audit.

The scoped hosted invocation remains:

```sh
node scripts/smoke-cli-archive.ts --archive "$ARCHIVE" \
  --expect-version "$VERSION" --expect-upstream
```

The managed extension selects only when the executing platform is Windows and
`--expect-upstream` is set. Linux native lifecycle and the previous retained Windows
archive assertions remain unchanged. Local validation is static syntax, workflow
structure and patch checks; no local product build, Windows command or test ran.
Runtime qualification of this extension is pending on the exact candidate.
The existing scratch finalizer removes the owned fixture after observation, while
the hosted job cleans its package/dependency staging. Only bounded proof artifacts
remain. Actual installer distribution, signing, service registration and Windows
ARM64 still require their own qualification.

## Managed install oracle diagnostics

Exact run `45179869859` built the monitor and archive from
`e5e85ff2dcb590af4b3864b0ef719212f47da0a0`, passed the original retained smoke and
seeded the managed state. It then failed the combined shim/receipt assertion.
The receipt file was successfully read before that assertion, but artifact
`14818754973` contains no captured install fields. It does not establish which
individual comparison failed or demonstrate a production installer defect.

The production installer uses the running executable's path spelling and records
a canonical launcher path. The original fixture compared those with its constructed
path spelling, including a literal stdout path and literal shim bytes. The repaired
oracle still requires the exact generated two-line structure, one ownership receipt,
and the actual shim commands. It verifies targets using Windows path semantics,
canonical filesystem paths and matching regular-file identity. Different path
spellings cannot redirect the expected executable or launcher to another file.

`WINDOWS_MANAGED_INSTALL_CHECKS` emits booleans for each required exit, stderr,
version-report, reported-launcher, generated-shim and ownership-receipt check. It
also records literal-spelling comparisons separately. A failure reports these
required booleans rather than captured streams or full paths. The later version
and uninstall checks likewise report their fields. Removal messages are compared
with the known canonical or original owned paths, since the shim has already been
removed when they are checked. No install, shim or uninstall production policy
changed. The exact first failing field remains unconfirmed until the follow-up
Windows run supplies these diagnostics.

Local checks cover syntax, patch hygiene and a dependency-free test of the exact
fixture path normalizer against slash, case and extended-path spellings and a
different target. This is not a Windows executable test or a product build. The
hosted lifecycle and detached-removal result remain pending.

## Isolated receipt target follow-up

Exact run `45182822417`, at
`a40bca62e7800ac5722eed70068508314a430842`, narrowed the failure to
`receiptNamesSameLauncher: false`. Exit status, empty stderr, reported path,
generated shim structure and executable identity, readable receipt and exactly
one receipt all passed. Proof artifact `14822347922` binds that exact source.
Both literal shim and reported-path comparisons passed;
the literal receipt comparison did not. No target path was retained, so these
results still do not identify whether the cause is receipt formatting,
canonicalization or an actual wrong target.

The production CLI provides `NodeServices.layer`. Pinned
`@effect/platform-node` and `@effect/platform-node-shared` 4.1.2 source archives
were read and verified against their lockfile SHA-512 values. The path layer wraps
the platform's `node:path`. On Windows, Effect's `realPath` uses Node's native
realpath implementation. The fixture's previous probe uses default synchronous
realpath. This source distinction motivates checking both implementations; it
does not establish which failed in the hosted run.

`WINDOWS_MANAGED_RECEIPT_CHECKS` adds safe booleans for basename, whitespace/BOM,
control characters, absolute/namespace/UNC/URL and slash forms, drive agreement,
normalized equality, Effect/Node path resolution agreement, default and native
canonical resolution, regular-file status and device/inode identity. A cleaned
candidate is probed only for diagnosis; whitespace or BOM is not silently accepted.
The required receipt equality and the real install/uninstall ownership checks
remain unchanged.

The only possible path fragment is `fixtureSuffix`. It is emitted only after
native canonical resolution establishes that the target is inside the owned home,
and every segment belongs to a small allowlist of fixture layout literals and the
validated public version. Otherwise it is null. Full captured paths, command
streams, tokens and session contents are never emitted by these diagnostics.
No product path, receipt, retention or removal policy changed in this follow-up.
The exact receipt defect or fixture assumption remains pending the next hosted
observations; no native or Windows product build ran locally. Fetched package
source stayed in memory and no dependency installation or retained cache was made.

The exact suffix-disclosure code was checked with dependency-free synthetic paths:
known owned launcher/runtime layouts were accepted, while another home, an unknown
filename/version and unresolved input returned null. This checks disclosure
filtering only and grants no Windows install or lifecycle qualification.
