# CLI and installation compatibility contract

Pinned upstream: `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`.

This review inventories declarations in 33 production `apps/server/src/cli/*.ts` files. It inspects selected handlers in thread, app, SSH helper, progress and installation code. It does not certify every command's complete execution path. `cli-declarations.json` records the exact paths, blob SHAs and inspected declaration lines. The root command registration is in [binCli.ts](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/binCli.ts), reviewed by the server agent.

## Command families

| Family | Current commands and observable purpose | Rust compatibility requirement |
|---|---|---|
| Launch | Default `t3`, `start`, `serve`; explicit working directory; browser opening optional | Preserve configuration precedence, data-directory selection, already-running-owner behavior, readiness and server lifetime |
| Desktop handoff | `app [path]` opens/adds a project in the running local desktop application | Preserve local IPC and project/path behavior; a standalone remote server is not an equivalent target |
| Projects | `project add`, `remove`, `rename`; path/id resolution, title and tracked repositories; removal force option | Preserve safety and ownership, not just parse compatible flags |
| Threads | `thread list`, `start`, `send`, `show`; provider/model/options, worktree/branch, output schema, wait and JSON | Preserve queue semantics, exact output/exit shapes and scriptability |
| Pairing and auth | `pair`; `auth pairing create/list/revoke`; `auth session issue/list/revoke`; `auth connect-device list/approve/revoke` | TTL, labels, subjects, scopes, base URL, token-only/JSON and secret visibility remain distinct |
| Environments | `environment link/list/unlink`; alternative URLs, pairing code, source environment and access grant | Correct host trust and grant scope, revocation and reachable status |
| Setup and Connect | `up`, `connect`, `status`; Connect login/link/status/publish/unlink/logout | Preserve headless OAuth, LAN/Connect choices, service coordination and unlink versus credential-clearing logout |
| Browser | `browser setup` | Install/manage the headless browser on the selected host, retain progress and executable ownership |
| Service | `service install/update/restart/uninstall/status/protect` | Same targeted home and OS service ownership, exact-version/downgrade handling, restart semantics and protection configuration |
| Release lifecycle | `install`, `update [version]`, `uninstall` | Version/channel handling, confirmation/TTY behavior, checksum verification, state backup/recovery and package-manager ownership |
| Operations | `doctor`, `trace summary`, `theme set/clear/show`, `policy show/check/settings/templates`, `triage` | Diagnosis/repair distinction, policy schema/locks, output and exit behavior, correct external agent invocation |
| Agent/private helpers | `acp-mcp-bridge`, `acp-mcp-call`, `__claude-history`, `__speech-worker`, `__ssh-helper`, `__service-preflight`, `__service-launcher` | Keep external protocol and launcher compatibility until all callers migrate; hidden commands can still be required interfaces |

The declaration inventory contains current descriptions and flags for each family. Some internal helper files declare no CLI command. Do not interpret the 33 files as 33 public commands.

Sources: [configuration](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/config.ts), [thread](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/thread.ts), [auth](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/auth.ts), [environments](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/environment.ts), [setup](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/up.ts), [Connect](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/connect.ts), [service](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/service.ts), [doctor](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/doctor.ts).

## Exact semantics worth protecting

### Structured thread automation

`thread start` prints the thread ID. A message of `-` reads stdin. `--wait` waits for a run result. The declaration documents exit 1 for a failed run and exit 2 when it needs an answer. The result still reaches stdout under `--json` before the handler returns the failure, so automation retains the thread ID. The inspected JSON shape includes threadId, runId, status, reply and error, plus output when present.

`--output-schema` accepts a JSON Schema file; `--wait --json` prints the structured output as `output`. A busy thread receives `thread send` as its next turn rather than having current work interrupted. The start options include provider/model, repeated model options, branch/worktree and optional generated title. Machine-readable operation must suppress unrelated setup logs from stdout. [Thread handler](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/thread.ts), [quiet configuration](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/config.ts).

### Human progress and noninteractive operation

The update progress writer defaults to stderr. Interactive output is throttled to roughly ten draws per second, adapts to terminal width and respects `NO_COLOR` and `TERM=dumb`. Noninteractive output uses ordinary lines. JSON/token-only modes have separate quiet-log behavior.

Headless Connect authorization is automatic without a terminal or over SSH. The setup commands distinguish absent route flags from explicit `--no-connect`/`--no-lan`; unnamed routes keep their existing setting. `status --json` reports configuration and does not claim to probe live connectivity. `connect unlink` disables the link but retains stored authorization; `connect logout` clears that authorization. These details affect scripts and recovery. [Progress](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/updateProgress.ts), [Connect](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/connect.ts), [setup/status](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/up.ts).

### SSH launch protocol

The fully reviewed SSH helper has observable numeric and textual protocols:

- `pick-port` checks both bindability and loopback connectivity, because macOS can bind over a wildcard listener. It prints a port or exits 1.
- `wait-ready` probes the root HTTP endpoint. It exits 2 when every attempt was connection-refused and exits 1 for other not-ready outcomes. The launcher interprets that distinction.
- `runtime-port` prints `<pid> <port>` only for a live loopback HTTP server; otherwise it exits 1.
- `keep-server` preserves an exact-version running server at the same or newer version.
- `update-remaining` prints the remaining update-marker wait, if any.
- `home-owned` succeeds while the server owns the home or a boot-service launcher is about to start it.

A rewritten launcher must migrate both sides of these protocols together. Merely replacing the database lock or executable path can break SSH startup. [SSH helper](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/apps/server/src/cli/sshHelper.ts).

## Installer and package behavior

The POSIX and PowerShell scripts choose a platform/architecture and stable, nightly or explicit version. They obtain release checksums, verify the archive, stage extraction under the managed runtime directory, run a version probe and publish a completion marker. They reuse completed downloads and avoid overwriting an unrelated `t3` command. POSIX installation handles shell-specific PATH guidance; PowerShell makes the command available in the current session and separately discusses future PATH persistence.

The public installation guide distinguishes package-manager-owned desktop builds, standalone CLI, npm one-shot execution, WSL server installation, desktop-installed CLI links and mobile stores. Current Intel Mac standalone CLI availability differs from desktop availability. Treat the pinned support matrix as the baseline, not a statement about every future release. [POSIX](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/scripts/install.sh), [PowerShell](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/scripts/install.ps1), [install guide](https://github.com/pingdotgg/t3code/blob/28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f/docs/user/install.md).

Rust can own the executable, updater, validation and installer logic. A one-line shell/PowerShell download bootstrap is still a distribution interface; whether it must be generated from Rust or remain minimal platform glue is a project policy decision. Removing supported installation paths to achieve a source-language percentage would change the product.

## Validation gaps

Signal propagation, pipe closure, all nested help/error formats, every service-manager branch and every provider-specific triage path were not exhaustively traced. The full acceptance matrix includes these behaviors; a Rust implementation must establish its exact baseline before claiming command compatibility. No command was executed against the running T3 installation during this research.

