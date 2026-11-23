#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The signal fixture records the exact POSIX child exit.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { nativeArtifactFiles, nativeFile, nativeHash } from "../tools/native-artifacts.mjs";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const executableEnvironment = (cwd: string) => ({
  PATH: "",
  HOME: cwd,
  USERPROFILE: cwd,
  TMPDIR: cwd,
  TEMP: cwd,
  // Windows needs the OS directory even when host Node and user PATH are isolated.
  ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  ...(process.env.windir === undefined ? {} : { windir: process.env.windir }),
  ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
  NO_COLOR: "1",
  T3CODE_TELEMETRY_ENABLED: "false",
});

const runExecutable = Effect.fn("runExecutable")(
  function* (
    executable: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    environment: Readonly<NodeJS.ProcessEnv> = {},
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        cwd,
        // Isolate system Node and inherited launcher context from the archive smoke check.
        env: { ...executableEnvironment(cwd), ...environment },
        extendEnv: false,
        ...(input === undefined ? {} : { stdin: { stream: Stream.encodeText(Stream.make(input)) } }),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(60)),
);

const smokeSessionOutput = Effect.fn("smokeSessionOutput")(function* (
  executable: string,
  contentDir: string,
  home: string,
  expectNative = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const nativeDir = path.join(contentDir, "native-bin");
  const dbFile = nativeFile("db", target);
  const db = path.join(nativeDir, dbFile);
  if (expectNative) {
    yield* Effect.try({
      try: () => {
        if (!nativeArtifactFiles(nativeDir, target).includes(dbFile)) {
          throw new Error("archive contains an upstream-only manifest");
        }
      },
      catch: (cause) =>
        new CliArchiveSmokeError({ step: "verifying the bundled Rust helper", detail: String(cause) }),
    });
  }

  const state = path.join(home, "userdata");
  const attachments = path.join(state, "attachments");
  yield* fs.makeDirectory(attachments, { recursive: true });
  // Reuse the scripted auth fixture: resolving config sweeps this abandoned upload.
  const abandoned = path.join(attachments, "abandoned.part");
  yield* fs.writeFileString(abandoned, "");
  yield* fs.utimes(abandoned, 1_577_836_800, 1_577_836_800);

  const subject = "archive-smoke";
  const issued = yield* runExecutable(
    executable,
    [
      "auth",
      "session",
      "issue",
      "--base-dir",
      home,
      "--subject",
      subject,
      "--ttl",
      "5m",
      "--token-only",
    ],
    home,
  );
  const token = /^([\w-]+)\.[\w-]+\r?\n(?:\r?\n)?$/.exec(issued.stdout);
  const claims = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ sid: Schema.NonEmptyString })),
  )(Buffer.from(token?.[1] ?? "", "base64url").toString("utf8"));
  if (
    issued.exitCode !== 0 ||
    issued.stderr !== "" ||
    Option.isNone(claims) ||
    (yield* fs.exists(abandoned))
  ) {
    // Never print the captured streams from commands that handle a session token.
    return yield* new CliArchiveSmokeError({
      step: "issuing a token from the extracted archive",
      detail: `exit ${String(issued.exitCode)}. Expected only a bearer token on stdout, empty stderr and removal of the stale upload.`,
    });
  }

  const session = Schema.Struct({
    sessionId: Schema.Literal(claims.value.sid),
    subject: Schema.Literal(subject),
    method: Schema.Literal("bearer-access-token"),
  });
  const listed = yield* runExecutable(
    executable,
    ["auth", "session", "list", "--base-dir", home, "--json"],
    home,
  );
  const jsonList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Tuple([session])))(
    listed.stdout,
  );
  if (
    listed.exitCode !== 0 ||
    listed.stderr !== "" ||
    Option.isNone(jsonList) ||
    listed.stdout.includes(issued.stdout.trim())
  ) {
    return yield* new CliArchiveSmokeError({
      step: "listing sessions from the extracted archive",
      detail: `exit ${String(listed.exitCode)}. Expected one JSON session on stdout, no token and empty stderr.`,
    });
  }

  if (!expectNative) {
    if (!(yield* fs.exists(path.join(state, "statev2.sqlite"))) ||
        (yield* fs.exists(path.join(state, "statev2.omdb")))) {
      return yield* new CliArchiveSmokeError({ step: "checking retained session storage",
        detail: "Expected the explicitly selected retained SQLite store and no omdb store." });
    }
    yield* Effect.log("[cli-smoke] Retained session token-only and JSON output passed with empty stderr.");
    return;
  }

  const transactionId = "archive-smoke";
  const requests = [
    { operation: "application_begin", transaction_id: transactionId, mode: "read" },
    {
      operation: "application_auth_read",
      transaction_id: transactionId,
      request: { kind: "session_get", session_id: claims.value.sid },
    },
    { operation: "application_rollback", transaction_id: transactionId },
  ];
  const persisted = yield* runExecutable(
    db,
    ["read-only-local", path.join(state, "statev2.omdb")],
    home,
    requests.map((request) => JSON.stringify(request) + "\n").join(""),
  );
  const reply = <S extends Schema.Decoder<unknown>>(result: S) =>
    Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), result }));
  const responses = Schema.decodeUnknownOption(
    Schema.Tuple([
      reply(Schema.Struct({ transaction_id: Schema.Literal(transactionId) })),
      reply(session),
      reply(Schema.Struct({ rolled_back: Schema.Literal(true) })),
    ]),
  )(persisted.stdout.trimEnd().split("\n"));
  if (
    persisted.exitCode !== 0 ||
    persisted.stderr !== "" ||
    Option.isNone(responses) ||
    (yield* fs.exists(path.join(state, "statev2.sqlite")))
  ) {
    return yield* new CliArchiveSmokeError({
      step: "reading the issued session through the bundled Rust helper",
      detail: `exit ${String(persisted.exitCode)}. Expected the same session in omdb and no SQLite state file.`,
    });
  }
  yield* Effect.log(
    `[cli-smoke] Native session token and JSON output passed. Rust helper SHA-256 ${nativeHash(db)}.`,
  );
});

const smokeInstalledLifecycle = Effect.fn("smokeInstalledLifecycle")(function* (
  contentDir: string,
  home: string,
  expectedVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionDir = path.join(home, "runtime", "versions", expectedVersion);
  const executable = path.join(versionDir, "t3");
  const binDir = path.join(home, "fixture-bin");
  const launcher = path.join(binDir, "t3");
  const unrelated = path.join(binDir, "keep.txt");
  const preservedState = path.join(home, "userdata", "lifecycle.keep");
  const stateContents = "Synthetic retained user state.\n";
  const unrelatedContents = "Synthetic unrelated command directory entry.\n";
  const foreignLauncher = "Synthetic launcher owned by another application.\n";
  const environment = {
    T3CODE_HOME: home,
    T3CODE_INSTALL_BIN_DIR: binDir,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_RUNTIME_DIR: path.join(home, ".runtime"),
  };
  const unitFile = path.join(environment.XDG_CONFIG_HOME, "systemd", "user", "t3code.service");
  const run = (args: ReadonlyArray<string>, entry = executable) =>
    runExecutable(entry, args, home, undefined, environment);
  const require = (condition: boolean, step: string, detail: string) =>
    condition ? Effect.void : new CliArchiveSmokeError({ step, detail });

  yield* fs.makeDirectory(path.dirname(versionDir), { recursive: true });
  yield* fs.copy(contentDir, versionDir);
  yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${expectedVersion}\n`);
  yield* fs.makeDirectory(binDir);
  yield* fs.makeDirectory(environment.XDG_CONFIG_HOME);
  yield* fs.makeDirectory(environment.XDG_RUNTIME_DIR);
  yield* fs.makeDirectory(path.dirname(preservedState), { recursive: true });
  yield* fs.writeFileString(preservedState, stateContents);
  yield* fs.writeFileString(unrelated, unrelatedContents);
  yield* fs.writeFileString(launcher, foreignLauncher);

  const refused = yield* run(["install"]);
  yield* require(
    refused.exitCode === 1 && refused.stdout === "" &&
      refused.stderr.includes("Another t3 is already at") &&
      (yield* fs.readFileString(launcher)) === foreignLauncher &&
      !(yield* fs.exists(path.join(home, "runtime", "launchers"))),
    "refusing an unrelated installed launcher",
    `exit ${String(refused.exitCode)}. Expected refusal with the foreign file intact and no launcher receipt.`,
  );
  yield* fs.remove(launcher);

  const installed = yield* run(["install"]);
  yield* require(
    installed.exitCode === 0 && installed.stderr === "" &&
      installed.stdout.includes(`Installed t3 ${expectedVersion} at ${launcher}.`) &&
      (yield* fs.readLink(launcher)) === executable &&
      (yield* fs.readFileString(path.join(home, "runtime", "launchers"))).trim() === launcher,
    "installing the archive's standalone launcher",
    `exit ${String(installed.exitCode)}. Expected the exact runtime link and recorded launcher.`,
  );
  const version = yield* run(["--version"], launcher);
  const extractedVersion = yield* runExecutable(path.join(contentDir, "t3"), ["--version"], home);
  yield* require(
    version.exitCode === 0 && version.stderr === "" &&
      extractedVersion.exitCode === 0 && version.stdout === extractedVersion.stdout &&
      version.stdout.includes(expectedVersion),
    "running the installed launcher",
    `exit ${String(version.exitCode)}. Expected the archive version through its installed launcher.`,
  );

  const service = yield* run(["service", "status", "--base-dir", home]);
  yield* require(
    service.exitCode === 0 && service.stdout.includes("Status: not installed") &&
      !(yield* fs.exists(unitFile)),
    "checking the disposable home's service state",
    `exit ${String(service.exitCode)}. Expected an uninstalled service before removing this fixture runtime.`,
  );
  yield* smokeSessionOutput(executable, versionDir, home);
  const database = path.join(home, "userdata", "statev2.omdb");
  const before = yield* Effect.sync(() => nativeHash(database));
  const uninstalled = yield* run(["uninstall", "--base-dir", home, "--yes"], launcher);
  yield* require(
    uninstalled.exitCode === 0 && uninstalled.stderr === "" &&
      uninstalled.stdout.includes(`Removed ${launcher}.`) &&
      !(yield* fs.exists(path.join(home, "runtime"))) &&
      Option.isNone(yield* fs.readLink(launcher).pipe(Effect.option)) &&
      !(yield* fs.exists(launcher)) &&
      !(yield* fs.exists(unitFile)) &&
      (yield* fs.readFileString(preservedState)) === stateContents &&
      (yield* fs.readFileString(unrelated)) === unrelatedContents &&
      (yield* Effect.sync(() => nativeHash(database))) === before,
    "uninstalling only the fixture launcher and runtime",
    `exit ${String(uninstalled.exitCode)}. Expected removal of the runtime and recorded launcher with user state and unrelated bytes intact.`,
  );
  const inspected = yield* runExecutable(
    path.join(contentDir, "native-bin", nativeFile("db", "linux-x64")),
    ["read-only-local", database],
    home,
    `${JSON.stringify({ operation: "application_migrations" })}\n`,
  );
  const migrations = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  })))(inspected.stdout);
  yield* require(
    inspected.exitCode === 0 && inspected.stderr === "" && Option.isSome(migrations) &&
      migrations.value.result.length > 0 &&
      (yield* Effect.sync(() => nativeHash(database))) === before,
    "reopening the preserved native state after uninstall",
    `exit ${String(inspected.exitCode)}. Expected a readable, byte-identical native application database.`,
  );
  yield* Effect.log("[cli-smoke] Installed launcher ran, foreign launcher was refused, and uninstall preserved reopenable native state and unrelated files.");
});

const smokeWindowsInstalledLifecycle = Effect.fn("smokeWindowsInstalledLifecycle")(function* (
  contentDir: string,
  home: string,
  expectedVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = path.join(home, "runtime");
  const versionDir = path.join(runtime, "versions", expectedVersion);
  const executable = path.join(versionDir, "t3.exe");
  const launcher = path.join(home, "fixture-bin", "t3.cmd");
  const unrelated = path.join(home, "fixture-bin", "keep.txt");
  const retained = path.join(home, "userdata", "lifecycle.keep");
  const archiveExecutable = path.join(contentDir, "t3.exe");
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const comspec = path.join(systemRoot, "System32", "cmd.exe");
  // Only child-process lookup changes: OS utilities support the stock detached
  // remover; system Node and installed user commands remain out of this PATH.
  const environment = {
    T3CODE_HOME: home, T3CODE_INSTALL_BIN_DIR: path.dirname(launcher),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: path.join(systemRoot, "System32"), ComSpec: comspec,
  };
  const require = (condition: boolean, step: string, checks?: Readonly<Record<string, boolean>>) => condition ? Effect.void :
    new CliArchiveSmokeError({ step, detail: checks === undefined
      ? "The disposable Windows managed lifecycle invariant failed."
      : `Safe field checks: ${JSON.stringify(checks)}` });
  // Node's executable spelling and realPath can differ from the harness's path
  // spelling. Preserve the generated script shape and compare its actual target.
  const windowsPath = (value: string) => {
    const normalized = NodePath.win32.normalize(value);
    return (normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized).toLowerCase();
  };
  const sameFile = (left: string, right: string): boolean => {
    try {
      const first = NodeFS.statSync(left, { bigint: true });
      const second = NodeFS.statSync(right, { bigint: true });
      return first.isFile() && second.isFile() && first.dev === second.dev && first.ino === second.ino &&
        NodePath.win32.isAbsolute(left) && NodePath.win32.isAbsolute(right) &&
        // The installed receipt uses the native Windows realpath result.
        windowsPath(NodeFS.realpathSync.native(left)) === windowsPath(NodeFS.realpathSync.native(right));
    } catch { return false; }
  };
  const snapshot = (root: string): string => {
    const files: Array<[string, string]> = [];
    const walk = (directory: string, prefix: string) => {
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const relative = prefix + entry.name;
        const target = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) { files.push([relative + "/", "directory"]); walk(target, relative + "/"); }
        else if (entry.isFile()) files.push([relative, nativeHash(target)]);
        else throw new Error("The owned lifecycle fixture contains an unexpected entry.");
      }
    };
    walk(root, "");
    return JSON.stringify(files);
  };
  const run = (args: ReadonlyArray<string>) => runExecutable(executable, args, home, undefined, environment);
  // A .cmd file must run through cmd.exe. Quote only controlled literal arguments
  // and disable delayed expansion; no shell is used for ordinary archive checks.
  const runShim = (args: ReadonlyArray<string>) => Effect.try({
    try: () => {
      if ([launcher, ...args].some((value) => /[%"\r\n\u0080-\uffff]/u.test(value))) throw new Error("Unsupported controlled shim argument.");
      const command = `""${launcher}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
      const result = NodeChildProcess.spawnSync(comspec, ["/d", "/v:off", "/s", "/c", command], {
        cwd: home, env: { ...executableEnvironment(home), ...environment },
        windowsVerbatimArguments: true, windowsHide: true,
        encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
    },
    catch: () => new CliArchiveSmokeError({ step: "running the owned Windows cmd launcher", detail: "The bounded cmd invocation failed." }),
  });

  yield* fs.makeDirectory(path.dirname(versionDir), { recursive: true });
  yield* fs.copy(contentDir, versionDir);
  yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${expectedVersion}\n`);
  yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
  yield* fs.makeDirectory(environment.APPDATA, { recursive: true });
  yield* fs.makeDirectory(environment.LOCALAPPDATA, { recursive: true });
  yield* smokeSessionOutput(executable, versionDir, home, false);
  yield* fs.writeFileString(retained, "Synthetic retained managed Windows state.\n");
  yield* fs.writeFileString(unrelated, "Synthetic unrelated binary-directory entry.\n");
  const foreign = '@echo off\r\n"foreign-runtime.exe" %*';
  yield* fs.writeFileString(launcher, foreign);
  const sessionsBefore = yield* run(["auth", "session", "list", "--base-dir", home, "--json"]);
  const originalChecks = { exitZero: sessionsBefore.exitCode === 0, stderrEmpty: sessionsBefore.stderr === "" };
  yield* require(Object.values(originalChecks).every(Boolean), "reading the original managed Windows sessions", originalChecks);
  const stateBefore = yield* Effect.sync(() => snapshot(path.join(home, "userdata")));
  const appDataBefore = yield* Effect.sync(() => snapshot(path.join(home, "AppData")));

  const refused = yield* run(["install"]);
  const refusalChecks = {
    exitOne: refused.exitCode === 1, stdoutEmpty: refused.stdout === "",
    foreignDiagnostic: refused.stderr.includes("Another t3 is already at"),
    foreignShimUnchanged: (yield* fs.readFileString(launcher)) === foreign,
    noOwnershipReceipt: !(yield* fs.exists(path.join(runtime, "launchers"))),
    userDataUnchanged: (yield* Effect.sync(() => snapshot(path.join(home, "userdata")))) === stateBefore,
    unrelatedFileUnchanged: (yield* fs.readFileString(unrelated)) === "Synthetic unrelated binary-directory entry.\n",
  };
  yield* require(Object.values(refusalChecks).every(Boolean), "refusing a foreign Windows shim without an ownership receipt", refusalChecks);
  yield* fs.remove(launcher);
  const installed = yield* run(["install"]);
  const generated = `@echo off\r\ngoto t3_shim_end 2>nul || "${executable}" %*`;
  const recorded = yield* fs.readFileString(path.join(runtime, "launchers")).pipe(Effect.option);
  const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
  const receipts = Option.isSome(recorded) ? recorded.value.split(/\r?\n/u).filter(Boolean) : [];
  const shim = Option.isSome(contents) ? /^@echo off\r\n"([^"\r\n]+)" %\* & exit \/b$/u.exec(contents.value) : null;
  const prefix = `Installed t3 ${expectedVersion} at `;
  const report = installed.stdout.split(/\r?\n/u).find((line) => line.startsWith(prefix) && line.endsWith("."));
  const reportedLauncher = report?.slice(prefix.length, -1);
  const installChecks = {
    exitZero: installed.exitCode === 0,
    stderrEmpty: installed.stderr === "",
    expectedVersionReport: report !== undefined,
    reportedLauncherSameFile: reportedLauncher !== undefined && sameFile(reportedLauncher, launcher),
    shimReadable: Option.isSome(contents),
    generatedShimStructure: shim !== null && Option.isSome(contents) && shim[0] === contents.value,
    shimTargetSameExecutable: shim !== null && sameFile(shim[1]!, executable),
    receiptReadable: Option.isSome(recorded),
    exactlyOneReceipt: receipts.length === 1,
    receiptNamesSameLauncher: receipts.length === 1 && sameFile(receipts[0]!, launcher),
  };
  const spellingChecks = {
    shimLiteralMatchesConstructedPath: Option.isSome(contents) && contents.value === generated,
    reportLiteralMatchesConstructedPath: installed.stdout.includes(`${prefix}${launcher}.`),
    receiptLiteralMatchesConstructedPath: receipts.length === 1 && receipts[0] === launcher,
  };
  yield* Effect.sync(() => { process.stdout.write(`WINDOWS_MANAGED_INSTALL_CHECKS ${JSON.stringify({ ...installChecks, ...spellingChecks })}\n`); });
  yield* require(Object.values(installChecks).every(Boolean), "installing the exact managed t3.cmd and its ownership receipt", installChecks);
  const canonicalLauncher = yield* fs.realPath(launcher);
  const canonicalRuntime = yield* fs.realPath(runtime);
  const version = yield* runShim(["--version"]);
  const versionChecks = { exitZero: version.exitCode === 0, stderrEmpty: version.stderr === "", expectedVersion: version.stdout.includes(expectedVersion) };
  yield* require(Object.values(versionChecks).every(Boolean), "running the managed Windows shim", versionChecks);
  const uninstalled = yield* runShim(["uninstall", "--base-dir", home, "--yes"]);
  const runtimePresentAtExit = yield* fs.exists(runtime);
  const removed = uninstalled.stdout.split(/\r?\n/u).filter((line) => line.startsWith("Removed ") && line.endsWith("."))
    .map((line) => line.slice("Removed ".length, -1));
  const deferred = " will be removed once t3 exits.";
  const scheduled = uninstalled.stdout.split(/\r?\n/u).filter((line) => line.endsWith(deferred)).map((line) => line.slice(0, -deferred.length));
  const uninstallChecks = {
    exitZero: uninstalled.exitCode === 0,
    stderrEmpty: uninstalled.stderr === "",
    ownedLauncherRemovalReported: removed.some((target) => windowsPath(target) === windowsPath(canonicalLauncher) || windowsPath(target) === windowsPath(launcher)),
    ownedRuntimeCleanupReported: scheduled.some((target) => windowsPath(target) === windowsPath(canonicalRuntime) || windowsPath(target) === windowsPath(runtime)),
    launcherAbsent: !(yield* fs.exists(launcher)),
  };
  const stderrTruncated = uninstalled.stderr.length > 16 * 1024;
  const diagnostic = uninstalled.stderr.slice(0, 16 * 1024).replace(/\r\n/gu, "\n").trim();
  const stderrClasses = {
    onlyMissingBatchFile: !stderrTruncated && /^The batch file cannot be found\.$/iu.test(diagnostic),
    containsMissingBatchFile: /The batch file cannot be found\./iu.test(diagnostic),
    systemFileNotFound: /The system cannot find the (?:file|path) specified\./iu.test(diagnostic),
    accessDenied: /Access is denied\./iu.test(diagnostic),
    unhandledChildErrorEvent: /Unhandled ['"]error['"] event|Emitted ['"]error['"] event/iu.test(diagnostic),
    spawnEnoent: /\bspawn\b[\s\S]*\bENOENT\b/iu.test(diagnostic),
    spawnEacces: /\bspawn\b[\s\S]*\b(?:EACCES|EPERM)\b/iu.test(diagnostic),
    spawnEinval: /\bspawn\b[\s\S]*\bEINVAL\b/iu.test(diagnostic),
    cleanupScheduleDiagnostic: /Could not schedule removal of/iu.test(diagnostic),
    commandSyntaxError: /The syntax of the command is incorrect\.|was unexpected at this time\./iu.test(diagnostic),
    commandNotRecognized: /not recognized as an internal or external command/iu.test(diagnostic),
    batchTerminationPrompt: /Terminate batch job/iu.test(diagnostic),
    runtimeWarning: /\b(?:DeprecationWarning|ExperimentalWarning|Warning):/u.test(diagnostic),
  };
  // Observe the actual detached result even when the enclosing cmd reports an
  // error after t3 has printed its removal messages. Failure stays failure.
  const removal = yield* fs.exists(runtime).pipe(
    Effect.flatMap((exists) => exists ? Effect.fail(new CliArchiveSmokeError({ step: "observing detached Windows runtime removal", detail: "The runtime still exists after the uninstall command exited." })) : Effect.void),
    Effect.retry({ times: 200, schedule: Schedule.spaced("100 millis") }),
    Effect.option,
  );
  const runtimeRemovalObserved = Option.isSome(removal);
  yield* Effect.sync(() => { process.stdout.write(`WINDOWS_MANAGED_UNINSTALL_CHECKS ${JSON.stringify({
    exitCode: uninstalled.exitCode, ...uninstallChecks, ...stderrClasses, stderrTruncated,
    unclassifiedStderr: diagnostic.length > 0 && !Object.values(stderrClasses).some(Boolean),
    runtimePresentAtExit, runtimeRemovalObserved,
  })}\n`); });
  const preservationChecks = {
    unrelatedFileUnchanged: (yield* fs.readFileString(unrelated)) === "Synthetic unrelated binary-directory entry.\n",
    userDataByteIdentical: (yield* Effect.sync(() => snapshot(path.join(home, "userdata")))) === stateBefore,
    appDataByteIdentical: (yield* Effect.sync(() => snapshot(path.join(home, "AppData")))) === appDataBefore,
  };
  yield* Effect.sync(() => { process.stdout.write(`WINDOWS_MANAGED_PRESERVATION_CHECKS ${JSON.stringify(preservationChecks)}\n`); });
  yield* require(Object.values(uninstallChecks).every(Boolean), "scheduling owned Windows runtime removal after shim uninstall", uninstallChecks);
  yield* require(runtimeRemovalObserved, "observing detached Windows runtime removal", { runtimeRemovalObserved });
  yield* require(Object.values(preservationChecks).every(Boolean), "preserving original Windows state and unrelated files through detached cleanup", preservationChecks);
  const reopened = yield* runExecutable(archiveExecutable, ["auth", "session", "list", "--base-dir", home, "--json"], home, undefined, environment);
  const reopenChecks = { exitZero: reopened.exitCode === 0, stderrEmpty: reopened.stderr === "", identicalSessionJson: reopened.stdout === sessionsBefore.stdout };
  yield* require(Object.values(reopenChecks).every(Boolean), "reopening retained sessions after Windows managed uninstall", reopenChecks);
  const proof = { version: expectedVersion, installedShim: true, foreignShimRefused: true,
    ownershipReceipt: true, shimVersionRan: true, shimUninstallRan: true, detachedRemovalObserved: true,
    runtimePresentAtExit, originalStatePreserved: true, sessionsReopened: true, unrelatedFilePreserved: true,
    appDataUnchanged: true, serviceInstallRequested: false, pathOrRegistryCommandRequested: false };
  yield* Effect.sync(() => { process.stdout.write(`WINDOWS_MANAGED_LIFECYCLE ${JSON.stringify(proof)}\n`); });
});

const smokePipedThread = Effect.fn("smokePipedThread")(function* (
  executable: string,
  home: string,
  workspace: string,
) {
  const project = yield* runExecutable(
    executable,
    ["project", "add", workspace, "--base-dir", home],
    workspace,
  );
  if (project.exitCode !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "adding the replay project from the CLI archive",
      detail: `exit ${String(project.exitCode)}\n${project.stderr}`,
    });
  }

  const message = "Replay a recorded question from stdin.\nSecond line: λ 🚀";
  const started = yield* runExecutable(
    executable,
    [
      "thread",
      "start",
      workspace,
      "-",
      "--base-dir",
      home,
      "--provider",
      "devReplay",
      "--model",
      "question",
      "--wait",
      "--json",
    ],
    workspace,
    message,
  );
  const wait = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        threadId: Schema.NonEmptyString,
        runId: Schema.NonEmptyString,
        status: Schema.Literal("waiting"),
        reply: Schema.Null,
        error: Schema.Null,
      }),
    ),
  )(started.stdout);
  if (
    started.exitCode !== 2 ||
    Option.isNone(wait) ||
    !started.stderr.includes("is waiting for an answer") ||
    started.stderr.includes("\u001b")
  ) {
    return yield* new CliArchiveSmokeError({
      step: "starting a recorded question from stdin with --wait --json",
      detail: `exit ${String(started.exitCode)}\n${started.stdout}${started.stderr}`,
    });
  }

  const shown = yield* runExecutable(
    executable,
    ["thread", "show", wait.value.threadId, "--base-dir", home, "--json"],
    workspace,
  );
  const history = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        thread: Schema.Struct({ pendingRequestCount: Schema.Int }),
        messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      }),
    ),
  )(shown.stdout);
  if (
    shown.exitCode !== 0 ||
    shown.stderr !== "" ||
    Option.isNone(history) ||
    history.value.thread.pendingRequestCount !== 1 ||
    !history.value.messages.some((entry) => entry.role === "user" && entry.text === message)
  ) {
    return yield* new CliArchiveSmokeError({
      step: "reading the exact piped prompt and pending question from the running server",
      detail: `exit ${String(shown.exitCode)}\n${shown.stdout}${shown.stderr}`,
    });
  }
  yield* Effect.log("[cli-smoke] Piped Unicode prompt preserved, with JSON waiting status and exit 2.");
});

const smokeThreadTerminal = Effect.fn("smokeThreadTerminal")(function* (
  executable: string,
  home: string,
  workspace: string,
) {
  const quote = (argument: string) => `'${argument.replaceAll("'", "'\\''")}'`;
  for (const [model, exitCode, text] of [
    ["todo-list", 0, "todo list fixture complete"],
    ["question", 2, "is waiting for an answer"],
  ] as const) {
    const command = [
      executable, "thread", "start", workspace, "Fixture message from a real terminal", "--base-dir", home,
      "--provider", "devReplay", "--model", model, "--wait",
    ].map(quote).join(" ");
    // util-linux script allocates the PTY. Check all three streams from inside it.
    const result = yield* runExecutable(
      "/usr/bin/script",
      ["-q", "-e", "-c", `test -t 0 && test -t 1 && test -t 2 && exec ${command}`, "/dev/null"],
      workspace,
      "",
    );
    if (
      result.exitCode !== exitCode ||
      result.stderr !== "" ||
      !result.stdout.includes(text) ||
      result.stdout.includes("\u001b")
    ) {
      return yield* new CliArchiveSmokeError({
        step: `waiting for the ${model} replay from a real terminal with NO_COLOR`,
        detail: `exit ${String(result.exitCode)}\n${result.stdout}${result.stderr}`,
      });
    }
  }
  yield* Effect.log("[cli-smoke] PTY wait returned exit 0 on success and exit 2 on a question, with no ANSI escapes.");
});

const smokeThreadFailure = Effect.fn("smokeThreadFailure")(function* (
  executable: string,
  home: string,
  workspace: string,
) {
  const started = yield* runExecutable(
    executable,
    [
      "thread",
      "start",
      workspace,
      "Replay a recorded failed turn",
      "--base-dir",
      home,
      "--provider",
      "devReplay",
      "--model",
      "failed-turn",
      "--wait",
      "--json",
    ],
    workspace,
  );
  const result = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        threadId: Schema.NonEmptyString,
        runId: Schema.NonEmptyString,
        status: Schema.Literal("failed"),
        reply: Schema.Null,
        error: Schema.NonEmptyString,
      }),
    ),
  )(started.stdout);
  if (
    started.exitCode !== 1 ||
    Option.isNone(result) ||
    result.value.error !== "Internal error" ||
    !started.stderr.includes(`Thread ${result.value.threadId} stopped with status failed`) ||
    started.stderr.includes("\u001b")
  ) {
    return yield* new CliArchiveSmokeError({
      step: "waiting for the recorded provider failure with --wait --json",
      detail: `exit ${String(started.exitCode)}\n${started.stdout}${started.stderr}`,
    });
  }
  yield* Effect.log("[cli-smoke] Failed turn returned exit 1, JSON run identity and a stderr diagnostic.");
});

const smokeThreadWaitInterrupt = Effect.fn("smokeThreadWaitInterrupt")(function* (
  executable: string,
  home: string,
  workspace: string,
) {
  const prompt = "Fixture question retained after the CLI wait is interrupted.";
  const result = yield* Effect.tryPromise({
    try: async (abort) => {
      const child = NodeChildProcess.spawn(
        executable,
        ["thread", "start", workspace, prompt, "--base-dir", home,
          "--provider", "devReplay", "--model", "question", "--wait"],
        { cwd: workspace, env: executableEnvironment(workspace), stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const lines = NodeReadline.createInterface({ input: child.stderr });
      const accepted = async () => {
        for await (const line of lines) {
          const threadId = /^Thread (\S+)$/u.exec(line)?.[1];
          if (threadId !== undefined) return threadId;
        }
        throw new Error("The CLI closed before printing the accepted thread ID.");
      };
      const killOwnedWaiter = () => child.kill("SIGKILL");
      abort.addEventListener("abort", killOwnedWaiter, { once: true });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      try {
        const threadId = await Promise.race([
          accepted(),
          exited.then(() => { throw new Error("The CLI stopped before the interrupt."); }),
        ]);
        if (!child.kill("SIGINT")) throw new Error("The CLI refused SIGINT.");
        return { threadId, ...await exited, stdout };
      } finally {
        abort.removeEventListener("abort", killOwnedWaiter);
        lines.close();
        if (child.exitCode === null && child.signalCode === null) killOwnedWaiter();
        await exited.catch(() => undefined);
      }
    },
    catch: (error) => new CliArchiveSmokeError({ step: "interrupting the owned CLI waiter", detail: String(error) }),
  }).pipe(Effect.timeout(Duration.seconds(20)));
  if ((result.signal !== "SIGINT" && result.code !== 130) || result.stdout !== "") {
    return yield* new CliArchiveSmokeError({
      step: "checking that the CLI waiter exits on SIGINT",
      detail: "Expected a shell interrupt status and empty stdout.",
    });
  }

  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
    thread: Schema.Struct({ pendingRequestCount: Schema.Int }),
    messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
  })));
  for (let attempt = 0; attempt < 20; attempt++) {
    const shown = yield* runExecutable(
      executable, ["thread", "show", result.threadId, "--base-dir", home, "--json"], workspace,
    );
    const history = decode(shown.stdout);
    if (shown.exitCode === 0 && Option.isSome(history) && history.value.thread.pendingRequestCount === 1) {
      const users = history.value.messages.filter((message) => message.role === "user");
      if (users.length === 1 && users[0]?.text === prompt) {
        yield* Effect.log("[cli-smoke] SIGINT stopped the CLI wait while the accepted turn continued to its question.");
        return;
      }
      break;
    }
    yield* Effect.sleep(Duration.millis(150));
  }
  return yield* new CliArchiveSmokeError({
    step: "reading the accepted turn after interrupting the CLI",
    detail: "Expected the unchanged prompt and its pending question from the running server.",
  });
});

const smokeSshHelper = Effect.fn("smokeSshHelper")(function* (
  executable: string,
  home: string,
  port: number,
  pid: number,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const runtime = path.join(home, "userdata", "server-runtime.json");
  const badRuntime = path.join(home, "fixture-nonloopback-runtime.json");
  yield* fs.writeFileString(badRuntime, JSON.stringify({ pid, port, origin: "http://fixture.invalid" }));
  const cases = [
    { args: ["runtime-port", runtime], exitCode: 0, stdout: `${pid} ${port}` },
    { args: ["runtime-port", badRuntime], exitCode: 1, stdout: "" },
    { args: ["wait-ready", String(port), "3000", "500"], exitCode: 0, stdout: "" },
    { args: ["pick-port", path.join(home, "fixture-unset-port"), String(port), "1"], exitCode: 1, stdout: "" },
  ];
  for (const test of cases) {
    const actual = yield* runExecutable(executable, ["__ssh-helper", ...test.args], home);
    if (actual.exitCode !== test.exitCode || actual.stdout !== test.stdout || actual.stderr !== "") {
      return yield* new CliArchiveSmokeError({
        step: `checking private SSH helper output for ${test.args[0]}`,
        detail: `exit ${String(actual.exitCode)} with ${String(actual.stdout.length)} stdout characters and ${String(actual.stderr.length)} stderr characters`,
      });
    }
  }
  yield* Effect.log("[cli-smoke] Private SSH helper output matched the live loopback runtime and refused an occupied port.");
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
  readonly expectNative: boolean;
  readonly expectUpstream: boolean;
}) {
  if (input.expectNative && input.expectUpstream) {
    return yield* new CliArchiveSmokeError({ step: "selecting archive qualification", detail: "Choose exactly one implementation expectation." });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
  // Windows can briefly retain executable locks; cleanup retries but must not fail a successful smoke check.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );

  // Windows bsdtar reads zip; Git Bash's GNU tar does not.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  if (input.expectUpstream) {
    const target = `${platform}-${yield* HostProcess.Architecture}`;
    const nativeDir = path.join(contentDir, "native-bin");
    const manifest = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
      implementation: Schema.Literal("upstream"), target: Schema.Literal(target),
      selection: Schema.Literal("explicit-upstream"),
    })))(yield* fs.readFileString(path.join(nativeDir, "manifest.json")));
    const files = nativeArtifactFiles(nativeDir, target);
    if (Option.isNone(manifest) || files.length !== 1 || files[0] !== "manifest.json") {
      return yield* new CliArchiveSmokeError({ step: "checking retained archive selection", detail: "Expected the explicit upstream manifest for this host with no native replacement components." });
    }
  }
  const bundledLibatomic = path.join(contentDir, "lib/libatomic.so.1");
  for (const required of [
    executable,
    path.join(contentDir, "client/index.html"),
    ...(platform === "linux" ? [bundledLibatomic, `${bundledLibatomic}.LICENSE`] : []),
  ]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  // The runner has libatomic installed; fresh Ubuntu servers do not.
  if (platform === "linux") {
    const ldd = yield* spawner.string(ChildProcess.make("ldd", [executable]));
    // Older glibc prints the path as given, newer prints it resolved; compare both resolved.
    const loaded = /libatomic\.so\.1 => (\/.*) \(0x[0-9a-f]+\)/.exec(ldd)?.[1];
    if (
      loaded === undefined ||
      (yield* fs.realPath(loaded)) !== (yield* fs.realPath(bundledLibatomic))
    ) {
      return yield* new CliArchiveSmokeError({
        step: "checking that t3 loads the bundled libatomic",
        detail: ldd,
      });
    }
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir);
  if (version.exitCode !== 0 || (input.expectUpstream && version.stderr !== "") || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  if (input.expectUpstream) {
    const help = yield* runExecutable(executable, ["--help"], contentDir);
    if (help.exitCode !== 0 || help.stderr !== "" || !help.stdout.includes("serve") || !help.stdout.includes("project") || help.stdout.includes("\u001b")) {
      return yield* new CliArchiveSmokeError({ step: "reading bundled CLI help", detail: "Expected useful plain stdout and empty stderr." });
    }
    const install = yield* runExecutable(executable, ["install"], contentDir);
    if (install.exitCode !== 1 || install.stdout !== "" || !install.stderr.includes("Only the standalone t3 can install itself")) {
      return yield* new CliArchiveSmokeError({ step: "refusing archive-local installation outside its managed runtime", detail: "Expected exit 1 with actionable stderr and empty stdout." });
    }
  }

  // The service launcher loads outside the embedded CLI; without T3CODE_HOME it exits right away.
  const launcher = yield* runExecutable(executable, ["__service-launcher"], contentDir);
  if (
    launcher.exitCode !== 1 ||
    launcher.stdout !== "" ||
    !launcher.stderr.includes("T3CODE_HOME is required")
  ) {
    return yield* new CliArchiveSmokeError({
      step: "running __service-launcher",
      detail: `exit ${String(launcher.exitCode)}\n${launcher.stdout}${launcher.stderr}`,
    });
  }

  if (input.expectNative || input.expectUpstream) {
    yield* smokeSessionOutput(executable, contentDir, path.join(scratch, "auth-home"), input.expectNative);
  }

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  const workspace = path.join(scratch, "replay-workspace");
  if (input.expectNative || input.expectUpstream) {
    const replay = yield* path.fromFileUrl(
      new URL("../apps/server/scripts/dev-replay-agent.ts", import.meta.url),
    );
    const settings = path.join(home, "userdata");
    yield* fs.makeDirectory(settings, { recursive: true });
    yield* fs.makeDirectory(workspace);
    yield* fs.writeFileString(
      path.join(settings, "settings.json"),
      JSON.stringify({
        providerInstances: {
          devReplay: {
            displayName: "Replay (dev)",
            driver: "acpRegistry",
            config: { source: "local", commandPath: process.execPath, commandArgs: [replay] },
          },
        },
      }),
    );
  }
  const server = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
      {
        cwd: contentDir,
        env: {
          ...executableEnvironment(home),
          TMPDIR: scratch,
          TEMP: scratch,
          T3CODE_HOME: home,
          // The archive has a release channel built in, so its events would
          // look like a real new install.
          T3CODE_TELEMETRY_ENABLED: "false",
        },
        extendEnv: false,
      },
    ),
  );
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)]),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // Probes can hang during server initialization; bound each request as SSH readiness does.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  const ready = yield* pollUntilReady.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
  if (ready && input.expectUpstream) {
    yield* Effect.gen(function* () {
      const page = yield* httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`));
      const html = yield* page.text;
      const descriptor = yield* httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/.well-known/t3/environment`));
      const protocol = Schema.decodeUnknownOption(Schema.Struct({
        environmentId: Schema.NonEmptyString,
        orchestrationProtocolVersion: Schema.Literal(ORCHESTRATION_PROTOCOL_VERSION),
      }))(yield* descriptor.json);
      if (page.status !== 200 || !html.includes("<html") || !html.includes("<script") || descriptor.status !== 200 || Option.isNone(protocol)) {
        return yield* new CliArchiveSmokeError({ step: "reading bundled web and protocol output", detail: "Expected a bundled HTML application and the current environment protocol." });
      }
      yield* Effect.log(`[cli-smoke] Bundled web HTML and environment protocol ${String(ORCHESTRATION_PROTOCOL_VERSION)} passed.`);
    }).pipe(Effect.timeout(Duration.seconds(10)));
  }
  if (ready && (input.expectNative || input.expectUpstream)) {
    yield* smokePipedThread(executable, home, workspace);
    yield* smokeThreadFailure(executable, home, workspace);
    if (input.expectNative && platform === "linux") {
      yield* smokeThreadTerminal(executable, home, workspace);
      yield* smokeThreadWaitInterrupt(executable, home, workspace);
      yield* smokeSshHelper(executable, home, port, Number(server.pid));
    }
  }
  yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  if (!ready) {
    return yield* new CliArchiveSmokeError({
      step: "serving from the extracted archive",
      detail: `no 200 from / within 30s\n${stdout}${stderr}`,
    });
  }
  if (input.expectNative && platform === "linux") {
    yield* smokeInstalledLifecycle(contentDir, path.join(scratch, "lifecycle-home"), input.expectVersion);
  }
  if (input.expectUpstream && platform === "win32") {
    yield* smokeWindowsInstalledLifecycle(contentDir, path.join(scratch, "managed lifecycle home"), input.expectVersion);
  }
  if (input.expectUpstream) {
    yield* Effect.log(`[cli-smoke] Retained executable SHA-256 ${nativeHash(executable)}. Archive SHA-256 ${nativeHash(input.archive)}.`);
  }
  yield* Effect.log(
    `[cli-smoke] ${root}: --version and __service-launcher passed, and serve answered on ${String(port)}.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
    expectUpstream: Flag.Boolean("expect-upstream").pipe(
      Flag.withDescription("Check the explicit retained host manifest, session/CLI streams, piped replay and bundled web protocol."),
      Flag.withDefault(false),
    ),
    expectNative: Flag.Boolean("expect-native").pipe(
      Flag.withDescription("Check token-only and JSON output against the archive's Rust database."),
      Flag.withDefault(false),
    ),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
