#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The signal fixture records the exact POSIX child exit.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
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

const smokeNativeSessionOutput = Effect.fn("smokeNativeSessionOutput")(function* (
  executable: string,
  contentDir: string,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const nativeDir = path.join(contentDir, "native-bin");
  const dbFile = nativeFile("db", target);
  const db = path.join(nativeDir, dbFile);
  yield* Effect.try({
    try: () => {
      if (!nativeArtifactFiles(nativeDir, target).includes(dbFile)) {
        throw new Error("archive contains an upstream-only manifest");
      }
    },
    catch: (cause) =>
      new CliArchiveSmokeError({ step: "verifying the bundled Rust helper", detail: String(cause) }),
  });

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
  yield* smokeNativeSessionOutput(executable, versionDir, home);
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
}) {
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
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
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

  if (input.expectNative) {
    yield* smokeNativeSessionOutput(executable, contentDir, path.join(scratch, "auth-home"));
  }

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  const workspace = path.join(scratch, "replay-workspace");
  if (input.expectNative) {
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
          PATH: "",
          HOME: home,
          USERPROFILE: home,
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
  if (ready && input.expectNative) {
    yield* smokePipedThread(executable, home, workspace);
    yield* smokeThreadFailure(executable, home, workspace);
    if (platform === "linux") {
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
  yield* Effect.log(
    `[cli-smoke] ${root}: --version and __service-launcher passed, and serve answered on ${String(port)}.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
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
