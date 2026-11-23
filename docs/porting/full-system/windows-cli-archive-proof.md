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

The [diagnostic run](https://github.com/glopyglerky/t3code-ls/actions/runs/45185058912)
found that both spellings named the same regular file by device and inode.
Native realpath resolved them to the same path within the fixture home. Default
synchronous realpath returned different paths. The fixture now uses native
realpath for its same-file assertion, matching the installer. It also continues
to require matching file identities and the original lifecycle assertions.

## Uninstall exit observation after native realpath correction

Exact run `45186197034` at
`ccea992431b5d1146b1865b85b2da8a4892baa4f` passed every install invariant and
executed the version shim. Its first failure was the uninstall result:
`exitZero` and `stderrEmpty` were false, while both owned removal reports and
launcher absence were true. The earlier failure stopped before observing the
actual detached runtime removal. The native-realpath correction and its earned
install evidence remain unchanged.

This follow-up emits `WINDOWS_MANAGED_UNINSTALL_CHECKS` with the numeric exit code
and booleans classifying the first 16 KiB of stderr, with a truncation flag, for missing-batch, system path/file, access,
command syntax/lookup, runtime warning and unhandled/spawn-child error classes.
An unclassified-stderr flag preserves the unknown case. It never prints captured
stderr, tokens or full paths. The synchronous-only catch around production
`spawnWindowsRemoval(...).unref()` is a possible asynchronous failure seam, but
this run has not shown which stderr class occurred and no product change follows
from that hypothesis.

Before deciding the command result, the fixture now completes its original bounded
observation of the owned runtime directory and reports whether it actually
vanished. `WINDOWS_MANAGED_PRESERVATION_CHECKS` separately reports original state,
AppData and unrelated-file equality. It does not retry uninstall or delete the
runtime itself to satisfy the observation. Exit zero, empty stderr, actual removal
and every preservation check are still required. A warning or failed command
cannot become a passing lifecycle result merely because removal completed.

Local syntax and diagnostic-class checks do not execute a Windows command. The
exact hosted follow-up is still required to establish the failure mechanism and
any subsequent product correction. The existing Windows archive workflow and
`--expect-upstream` smoke invocation remain the qualification path.

The exact classifier was checked with dependency-free synthetic missing-batch,
unhandled spawn/ENOENT, runtime warning and unknown/truncated strings. These cases
only validate the diagnostic distinctions. They neither reproduce the Windows
failure nor qualify a production repair. Exact proof artifact `14824705843`
was read and matched to source `ccea992431b5d1146b1865b85b2da8a4892baa4f`.

## Self-removing Windows shim continuation

Exact run [45188572016](https://github.com/glopyglerky/t3code-ls/actions/runs/45188572016)
at `cf96f4ff9cfa046759ebd24057e2e0ee0a01e77c` isolated the failure:
cmd reported only `The batch file cannot be found.`, with exit 1. Launcher
removal, detached runtime removal, and all preservation checks passed. The
executable removes its own installed `.cmd` during uninstall; the old batch
line then requires cmd to resume from the removed file.

The standalone CLI installer, updater and PowerShell installer now emit
`"<executable>" %* & exit /b` as one parsed line. The explicit batch exit has no
numeric argument, so it does not intentionally overwrite the child's status.
Microsoft documents [cmd command sequencing](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)
and [exit /b](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/exit).
Actual status propagation and self-deletion behavior require the Windows oracle
below; documentation and local syntax checks do not qualify them.

`scripts/windows-shim-oracle.mjs` runs on actual Windows cmd with Node 26.12.1
and no installed product or package dependencies. It reproduces legacy
self-deletion at exit zero, checks ordinary legacy statuses, then requires the
new line to preserve exits 0, 1, 2 and 130 both with and without self-deletion.
It also requires exact controlled argument forwarding, empty stderr for every
new-shim case and the expected file-removal state. It uses a bounded owned temp
folder, never installs a command or changes PATH, and removes its fixtures in
`finally`. The focused archive workflow runs this oracle before compilation:

```sh
node scripts/windows-shim-oracle.mjs
```

Fresh archive smoke still requires the actual installed shim's exact new bytes,
real version invocation, zero/empty-stderr uninstall, observed runtime removal,
and unchanged unrelated files and synthetic user state. No diagnostic is removed
or treated as success. Its invocation remains `node scripts/smoke-cli-archive.ts
--archive <zip> --expect-version <version> --expect-upstream`.

Ownership recognition accepts both the original generated line and the exact
new tail. Legacy owned shims remain replaceable and removable; executing an old
shim to uninstall can still show its old continuation failure until it is
rewritten by install/update. Wrappers with extra commands, status-masking tails
or desktop arguments remain outside this recognition. Desktop launchers are
unchanged. This slice retains the stock T3 source/provenance pin
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` and MIT license.

The Windows oracle and packaged lifecycle remain unexecuted locally. Root owns
the exact hosted candidate run and acceptance decision.
