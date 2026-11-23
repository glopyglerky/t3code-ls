# Native repository discovery trial

This Linux candidate handles path discovery, HEAD, exact local and remote branch reads and local branch names for rename collision checks within the Git workspace service when `T3_CODE_LS_GIT_WORKSPACE_EXECUTABLE` names the absolute path to the trial executable. The service retains its discovery cache and reads refs fresh so fetches and deletions are visible. Git handles status, the richer branch-list response and mutations. Explicit upstream mode uses the retained service.

The trial opens the repository with strict local configuration and rejects untrusted directories. The helper returns the physical worktree root, common directory, and current branch. Bare repositories, Git configuration overrides, includes, unreadable configuration, and failed helpers use the existing Git discovery. Global configuration and repository trust parity still need qualification before this route becomes a default.

`local-branch-names ABSOLUTE_DIRECTORY` reads local refs for automatic rename collision checks. It returns a sorted JSON array, with a 16 MiB output bound. The service preserves its existing case folding, ancestor checks and suffix selection. Symbolic branch refs, unreadable objects, non-UTF-8 names and output beyond the bound return `null`, which selects the retained Git read. The actual rename remains a Git operation.

`has-local-ref ABSOLUTE_DIRECTORY refs/heads/NAME` checks the exact local branch for diff base lookup and fetch materialization. A tag or a descendant branch cannot satisfy the lookup. Git still performs the fetch and ref mutation.

The branch-list implementation uses `Repository::references().local_branches()` and checks each direct target with `try_find_header`. The pinned [reference iterator](https://github.com/GitoxideLabs/gitoxide/blob/dd39fb66e3b1551c9fe849043e39b357a9799ca1/gix/src/reference/iter.rs) merges loose and packed refs. Names are sorted bytewise to match `for-each-ref`'s default order. The selected-driver fixture compares both readers after packing and adding new loose refs, in linked worktrees and with Unicode names. It also verifies automatic rename collision results and configuration/symbolic fallback.

The crate uses the Gitoxide `gix` 0.90.0 release from commit `dd39fb66e3b1551c9fe849043e39b357a9799ca1`, an ancestor of research commit `732cc157a1481fe9180fa30d926ad2dcf0a8d5d6`. It enables SHA-1 and SHA-256 support and uses the release under its MIT or Apache-2.0 license. [Gitoxide ancestry](https://github.com/GitoxideLabs/gitoxide/compare/dd39fb66e3b1551c9fe849043e39b357a9799ca1...732cc157a1481fe9180fa30d926ad2dcf0a8d5d6)

This executable uses `std` for repository files and process I/O. Its crate forbids authored unsafe code. Dependency safety and other platforms require separate qualification.

The `Workspace file editing` workflow builds the locked helper and compares its result with the retained Git service. The fixture uses real linked worktrees and checks the commands issued by the selected route.

## Optional packaged route

Build the Linux x64 archive with `T3_CODE_LS_BUNDLE_GIT_WORKSPACE=1`. This adds
`t3-code-ls-git-workspace` to the existing `native-bin` manifest with its SHA-256.
The build uses the existing locked isolated crate and pinned Lustr/BlueFe route.
The runtime flag `T3_CODE_LS_BUNDLED_GIT_WORKSPACE=1` selects that package-owned
helper in the normal `GitVcsDriverCore` layer. Selection verifies the Linux target,
regular executable and manifest identity with the same verifier as the optional
PTY host. A missing, damaged or mismatched selected artifact refuses startup.
The runtime flag is separate from the build flag; neither is a default.

An explicit `T3_CODE_LS_IMPLEMENTATION=upstream` retains Git. A selected bundled
helper cannot also have a source-tree executable override. Existing configuration
checks and `null`/failed read fallbacks still apply after artifact selection.
Git continues to own mutations and the rich branch response.

The `Native CLI archive proof` workflow accepts
`candidate/t3code-ls-t06-gix-packaged-*`. It builds the actual archive, checks
optional artifact staging and runs `verify-packaged-git-workspace.ts` in a
loopback-only network namespace. The runner executes a byte-identical copy of
the extracted SEA entry, with no helper override. It invokes authenticated
`vcs.listRefs` through the normal WebSocket and compares local names and HEAD
with the installed Git oracle for a root, nested directory and linked worktree.
Bare repositories must fail the normal application's retained work-tree admission
before the helper is reached. Included-configuration work trees exercise Core Git
discovery after the helper returns `null`.
`GIT_CONFIG_COUNT` and explicit upstream mode bypass native discovery. Separate
copied-artifact trials reject a changed helper and a wrong-target manifest before
helper execution. The original extracted entry, helper and manifest must remain
unchanged.

Successful `execve` and `chdir` records bind the RPC observations to the packaged
helper and working directories. The fixture traces only synthetic profiles and
passes its bootstrap credential on a pipe. Its owned process group is stopped
before reading traces or changing a copied artifact. The tracer uses
[`--kill-on-exit`](https://github.com/strace/strace/blob/v6.8/doc/strace.1.in)
to prevent tracees surviving a failed tracer. Tracing is attribution evidence,
not a performance measurement. The receipt records source/tree, archive member
hashes, toolchain and Gitoxide lock hashes, and the actual Git and tracer versions.
The fixture removes its disposable profiles and copied package while retaining
small logs and the proof receipt.

This slice qualifies only these packaged reads when that hosted proof passes.
It does not establish full J43, global configuration/trust parity, another
platform, or an end-to-end speedup. Stock T3
`28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` remains the product denominator;
the installed Git is the bounded branch/discovery oracle. The method pin is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.
No dependency, compiler or engine pin changes are made.

### Packaged proof correction

Run `45170785193` at `a7b42a4ee67e5c9f36dbe1326f503f40047cbf8e`
built the archive and passed four optional artifact tests. The application RPC
proof then failed on its bare-repository expectation. Its retained trace shows
the packaged helper executing for the root, nested directory and linked worktree,
followed by the normal work-tree detector refusing the bare directory. This was
an incorrect fixture expectation, not complete packaged-read qualification.

The production `GitWorkflowService.listRefs` asks `VcsDriverRegistry` to detect a
Git work tree before calling Core. Stock T3's
[`GitVcsDriver.detectRepository`](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/vcs/GitVcsDriver.ts#L750)
uses `rev-parse --is-inside-work-tree --show-toplevel --git-common-dir` and returns
no repository after a nonzero exit or a first line other than `true`. The RPC
therefore returns `isRepo: false` for a valid bare Git database. Direct Core
component fallback is a different boundary.

The corrected proof executes that exact retained Git admission oracle for every
location and keeps independent fixture expectations: only the bare case may be
refused. It requires the normal registry probe for every location, the packaged
helper for each applicable work tree, no helper at the refused bare repository,
and no Core fallback for applicable native reads. Included configuration must
show both helper execution and Core fallback; configuration override and retained
mode must show Core fallback without helper execution. Registry probes and Core
discovery are counted separately. A per-location checkpoint and saved oracle/RPC
fields identify the first mismatch even when the run stops before a phase ends.
The corrected hosted execution remains required.
