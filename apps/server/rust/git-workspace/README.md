# Native repository discovery trial

This Linux candidate handles path discovery, HEAD, exact remote branch reads and local branch names for rename collision checks within the Git workspace service when `T3_CODE_LS_GIT_WORKSPACE_EXECUTABLE` names the absolute path to the trial executable. The service retains its discovery cache and reads refs fresh so fetches and deletions are visible. Git handles status, the richer branch-list response and mutations. Explicit upstream mode uses the retained service.

The trial opens the repository with strict local configuration and rejects untrusted directories. The helper returns the physical worktree root, common directory, and current branch. Bare repositories, Git configuration overrides, includes, unreadable configuration, and failed helpers use the existing Git discovery. Global configuration and repository trust parity still need qualification before this route becomes a default.

`local-branch-names ABSOLUTE_DIRECTORY` reads local refs for automatic rename collision checks. It returns a sorted JSON array, with a 16 MiB output bound. The service preserves its existing case folding, ancestor checks and suffix selection. Symbolic branch refs, unreadable objects, non-UTF-8 names and output beyond the bound return `null`, which selects the retained Git read. The actual rename remains a Git operation.

The implementation uses `Repository::references().local_branches()` and checks each direct target with `try_find_header`. The pinned [reference iterator](https://github.com/GitoxideLabs/gitoxide/blob/dd39fb66e3b1551c9fe849043e39b357a9799ca1/gix/src/reference/iter.rs) merges loose and packed refs. Names are sorted bytewise to match `for-each-ref`'s default order. The selected-driver fixture compares both readers after packing and adding new loose refs, in linked worktrees and with Unicode names. It also verifies automatic rename collision results and configuration/symbolic fallback.

The crate uses the Gitoxide `gix` 0.90.0 release from commit `dd39fb66e3b1551c9fe849043e39b357a9799ca1`, an ancestor of research commit `732cc157a1481fe9180fa30d926ad2dcf0a8d5d6`. It enables SHA-1 and SHA-256 support and uses the release under its MIT or Apache-2.0 license. [Gitoxide ancestry](https://github.com/GitoxideLabs/gitoxide/compare/dd39fb66e3b1551c9fe849043e39b357a9799ca1...732cc157a1481fe9180fa30d926ad2dcf0a8d5d6)

This executable uses `std` for repository files and process I/O. Its crate forbids authored unsafe code. Dependency safety and other platforms require separate qualification.

The `Workspace file editing` workflow builds the locked helper and compares its result with the retained Git service. The fixture uses real linked worktrees and checks the commands issued by the selected route.
