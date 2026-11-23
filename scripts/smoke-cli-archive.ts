#!/usr/bin/env node
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

const runExecutable = Effect.fn("runExecutable")(
  function* (executable: string, args: ReadonlyArray<string>, cwd: string, input?: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        cwd,
        // Isolate system Node and inherited launcher context from the archive smoke check.
        env: {
          PATH: "",
          HOME: cwd,
          USERPROFILE: cwd,
          TMPDIR: cwd,
          TEMP: cwd,
          NO_COLOR: "1",
          T3CODE_TELEMETRY_ENABLED: "false",
        },
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
  if (ready && input.expectNative) yield* smokePipedThread(executable, home, workspace);
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
