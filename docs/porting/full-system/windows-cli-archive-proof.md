# Windows amd64 CLI archive proof

The `cli-archive-proof.yml` workflow qualifies candidate branches named
`candidate/t3code-ls-t14-windows-cli-*`. Ubuntu runs the existing cross-target
SEA and ZIP builders. A Windows runner compiles the resource monitor, then a
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
that refusal a Windows installer defect. Managed `.cmd` installation,
update/rollback, uninstall, service integration, PTY and Windows signal
semantics, signing and desktop/mobile packaging remain unqualified.

Windows ARM64 appears in the existing SEA target map, native target identities
and archive naming code. That source coverage does not establish available
ARM64 runtime externals, execution, installation or acceptance. This lane
intentionally exercises only amd64.

The focused retained-platform packaging test passed locally. The first hosted
Windows attempt compiled the monitor, then timed out before producing an
archive. The split build follows the [stock packaging route](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/.github/workflows/release-desktop.yml).
The exact archive needs a passing Windows smoke before it qualifies.

The stock product denominator remains
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`; this is no performance comparison.
The mandatory method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.
Existing MIT provenance is preserved.

[Windows runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
and [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)
provide host and packaging context. The pinned repository's builders, selectors
and executed artifact remain the qualification authority.
