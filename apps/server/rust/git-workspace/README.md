# Native repository discovery trial

This Linux candidate handles path discovery, HEAD and exact remote branch reads within the Git workspace service when `T3_CODE_LS_GIT_WORKSPACE_EXECUTABLE` names the absolute path to the trial executable. The service retains its discovery cache and reads remote refs fresh so fetches and deletions are visible. Git still handles status, branch enumeration, and mutations. Explicit upstream mode uses the retained service.

The trial opens the repository with strict local configuration and rejects untrusted directories. The helper returns the physical worktree root, common directory, and current branch. Bare repositories, Git configuration overrides, includes, unreadable configuration, and failed helpers use the existing Git discovery. Global configuration and repository trust parity still need qualification before this route becomes a default.

The crate uses the Gitoxide `gix` 0.90.0 release from commit `dd39fb66e3b1551c9fe849043e39b357a9799ca1`, an ancestor of research commit `732cc157a1481fe9180fa30d926ad2dcf0a8d5d6`. It enables SHA-1 and SHA-256 support and uses the release under its MIT or Apache-2.0 license. [Gitoxide ancestry](https://github.com/GitoxideLabs/gitoxide/compare/dd39fb66e3b1551c9fe849043e39b357a9799ca1...732cc157a1481fe9180fa30d926ad2dcf0a8d5d6)

The `Workspace file editing` workflow builds the locked helper and compares its result with the retained Git service. The fixture uses real linked worktrees and checks the commands issued by the selected route.
