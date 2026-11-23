// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalJsonInEffect:off - isolated Node acceptance runner.
// Run with the current Linux x64 native bundle, inside a loopback-only network
// namespace. Pass a new absolute evidence directory outside the checkout.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";
import {
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import {
  authenticatePackagedServer,
  reservePort,
  startPackagedServer,
} from "./packaged-server-fixture.ts";
import { inspectNativeImport, sha256 } from "./provider-import-native-inspection.ts";

const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const argument = process.argv[2];
const encoding = process.argv[3] ?? "plain";
Assert.ok(argument && Path.isAbsolute(argument) && process.argv.length <= 4);
Assert.ok(encoding === "plain" || encoding === "zstd");
const proof = Path.join(FS.realpathSync(Path.dirname(argument)), Path.basename(argument));
const relative = Path.relative(root, proof);
Assert.ok(relative.startsWith(`..${Path.sep}`), "Evidence must be outside the checkout");
FS.mkdirSync(proof, { mode: 0o700 });

const dist = Path.join(root, "apps/server/dist");
const bundle = Path.join(dist, "bin.mjs");
const manifestPath = Path.join(dist, "native-bin", "manifest.json");
const executable = Path.join(dist, "native-bin", "t3-code-ls-db");
// Stock ws.ts dispatches both RPCs. Its importer compares the stored roles and
// texts before repairing the source marker, after a separate history commit.
const stock = "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f";
const git = (...args: string[]) =>
  ChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const report: Record<string, unknown> = { status: "running", checkpoint: "preflight", encoding };
const save = () => FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n");
const checkpoint = (name: string) => {
  report.checkpoint = name;
  save();
};
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Provider import verification interrupted"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

const sessionId = "0251af00-0000-4000-8000-000000000022";
const threadId = `import:codex:${sessionId}`;
const projectId = ProjectId.make("t08-j22-provider-import");
const prompt = "Synthetic Codex prompt";
const response = 'Synthetic Codex reply "café 🧪"';
const changedResponse = "Replacement reply with the same Codex session ID";
const inputCount = { importedCount: 0, skippedCount: 1 };

const startServer = (input: {
  name: string;
  baseDir: string;
  env: NodeJS.ProcessEnv;
  port: number;
}) => startPackagedServer({
  ...input,
  bundle,
  logPath: Path.join(proof, `${input.name}.log`),
  signal: abort.signal,
});
const authenticate = (server: ReturnType<typeof startServer>) =>
  authenticatePackagedServer(server, abort.signal);

function observePackagedHelper(pid: number | undefined, database: string) {
  Assert.ok(pid);
  const proc = `/proc/${pid}/task`;
  for (const task of FS.readdirSync(proc)) {
    try {
      const children = FS.readFileSync(Path.join(proc, task, "children"), "utf8").trim().split(/\s+/u);
      for (const id of children.filter(Boolean)) {
        try {
          if (FS.readlinkSync(`/proc/${id}/exe`) !== executable) continue;
          const args = FS.readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0");
          if (args[1] === "local" && args[2] === database) {
            return { executable: "apps/server/dist/native-bin/t3-code-ls-db", mode: args[1] };
          }
        } catch (error) {
          // An unrelated short-lived child may already have exited.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  Assert.fail("The reopened production server has no packaged omdb application helper");
}

let active: ReturnType<typeof startServer> | undefined;
let scratch: string | undefined;
let firstFailure: unknown;

try {
  checkpoint("preflight");
  Assert.equal(process.platform, "linux");
  Assert.equal(process.arch, "x64");
  const interfaces = OS.networkInterfaces();
  Assert.deepEqual(Object.keys(interfaces), ["lo"], "Run with only loopback in a network namespace");
  const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  Assert.equal(sha256(executable), manifest.files["t3-code-ls-db"]);
  Assert.equal(sha256(manifestPath), sha256(Path.join(root, "bin", "manifest.json")));
  Assert.equal(git("status", "--porcelain", "--untracked-files=normal"), "", "Use a clean candidate checkout");
  report.source = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    stock,
    stockTree: "af9112ce82be93109079ca7b7a89f7182455eca5",
  };
  report.artifacts = {
    bundleSha256: Object.fromEntries(
      FS.readdirSync(dist, { recursive: true })
        .filter((file) => /\.[cm]?js$/u.test(file))
        .sort()
        .map((file) => [file, sha256(Path.join(dist, file))]),
    ),
    nativeManifestSha256: sha256(manifestPath),
    nativeExecutableSha256: sha256(executable),
    toolchainLockSha256: sha256(Path.join(root, "toolchain.lock.json")),
    databaseLockSha256: sha256(Path.join(root, "database.lock.json")),
    node: process.version,
  };
  report.transport = {
    host: "127.0.0.1",
    socket: "/ws",
    methods: [WS_METHODS.agentSessionsScan, WS_METHODS.agentSessionsImport],
    interfaces: ["lo"],
  };
  scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
  const baseDir = Path.join(scratch, "state");
  const workspace = Path.join(scratch, "workspace");
  const home = Path.join(scratch, "home");
  const codexHome = Path.join(home, ".codex");
  const homeBin = Path.join(home, "bin");
  const userdata = Path.join(baseDir, "userdata");
  const database = Path.join(userdata, "statev2.omdb");
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const day = stamp.toISOString().slice(0, 10);
  const sessions = Path.join(codexHome, "sessions", ...day.split("-"));
  for (const directory of [userdata, sessions, homeBin, workspace]) {
    FS.mkdirSync(directory, { recursive: true });
  }
  FS.symlinkSync("/usr/bin/git", Path.join(homeBin, "git"));
  const env = {
    HOME: home,
    PATH: homeBin,
    TMPDIR: Path.join(scratch, "tmp"),
    XDG_CONFIG_HOME: Path.join(home, ".config"),
    XDG_DATA_HOME: Path.join(home, ".local", "share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    CODEX_HOME: codexHome,
    GIT_CONFIG_NOSYSTEM: "1",
    T3_CODE_LS_IMPLEMENTATION: "native",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    NO_COLOR: "1",
  };
  FS.mkdirSync(env.TMPDIR);
  ChildProcess.execFileSync(Path.join(homeBin, "git"), ["init", "--quiet"], { cwd: workspace, env });
  FS.writeFileSync(Path.join(userdata, "settings.json"), JSON.stringify({
    providerInstances: {
      ...Object.fromEntries(
        ["claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
          .map((driver) => [driver, { driver, enabled: false }]),
      ),
      codex: {
        driver: "codex",
        enabled: true,
        config: { setupMode: "existing", homePath: codexHome, binaryPath: Path.join(homeBin, "absent-codex") },
      },
    },
  }));
  const suffix = encoding === "zstd" ? ".jsonl.zst" : ".jsonl";
  const rollout = Path.join(sessions, `rollout-${day}T00-00-00-${sessionId}${suffix}`);
  const writeRollout = (reply: string, mtime: Date): AgentSessionImportSource => {
    const records = [
      { type: "session_meta", payload: { id: sessionId, cwd: workspace, source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] },
      },
    ];
    const contents = records.map((record, index) =>
      JSON.stringify({ timestamp: new Date(stamp.getTime() + index * 1000).toISOString(), ...record }),
    ).join("\n") + "\n";
    FS.writeFileSync(rollout, encoding === "zstd" ? Zlib.zstdCompressSync(contents) : contents);
    FS.utimesSync(rollout, mtime, mtime);
    // The scanner converts bigint file times to whole milliseconds before
    // constructing dates. Node's numeric Stats dates round fractions instead.
    const stats = FS.statSync(rollout, { bigint: true });
    return {
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: sessionId,
      filePath: rollout,
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      device: Number(stats.dev),
      inode: stats.ino.toString(),
      birthtimeMs: Number(stats.birthtimeMs),
    };
  };
  const original = writeRollout(response, stamp);
  const relay = Path.join(scratch, "native-relay.mjs");
  const fault = Path.join(proof, "fault.json");
  const trace = Path.join(proof, "native-relay.ndjson");
  Assert.ok(!/\s/u.test(process.execPath), "The relay requires a Node path without whitespace");
  FS.writeFileSync(relay, `#!${process.execPath}\n` + FS.readFileSync(
    new URL("./provider-import-marker-fixture.mjs", import.meta.url), "utf8",
  ), { mode: 0o700 });
  FS.writeFileSync(Path.join(scratch, "native-relay.json"), JSON.stringify({
    executable, database, threadId, rollout, fault, trace,
  }));
  const relayedEnv = { ...env, T3_CODE_LS_DB_EXECUTABLE: relay };

  const inspect = (closed = false) => inspectNativeImport({ executable, baseDir, threadId, closed });
  const scanAndCheck = (client: WsRpcProtocolClient, existing: boolean) => Effect.gen(function* () {
    const scan = yield* client[WS_METHODS.agentSessionsScan]({});
    Assert.equal(scan.truncated ?? false, false);
    Assert.equal(scan.candidates.length, 1);
    const row = scan.candidates[0]!;
    Assert.equal(row.path, workspace);
    Assert.deepEqual(row.sources, ["codex"]);
    Assert.equal(row.threadCount, 1);
    Assert.equal(row.alreadyImported, existing);
    Assert.equal(row.projectId, existing ? projectId : undefined);
    return row;
  });
  const readTrace = () => FS.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const importInput = { projectId, expectedWorkspaceRoot: workspace };

  checkpoint("packaged scan and project creation");
  active = startServer({
    name: "initial", baseDir, port: await reservePort(),
    env: relayedEnv,
  });
  await active.ready;
  report.command = active.argv;
  const initial = await authenticate(active);
  report.initialCandidate = await initial.rpc((client) => scanAndCheck(client, false));
  Assert.equal((await initial.createProject({ projectId, title: "Synthetic Codex import", workspaceRoot: workspace })).id, projectId);
  const baseline = inspect();
  Assert.equal(baseline.history.threadSequence, 0);
  Assert.equal(baseline.history.threads.length, 0);
  Assert.equal(baseline.runtimeCount, 0);
  report.baseline = baseline;

  checkpoint("import with marker refusal");
  report.firstImport = await initial.rpc((client) => client[WS_METHODS.agentSessionsImport](importInput));
  Assert.deepEqual(report.firstImport, inputCount);
  const receipt = JSON.parse(FS.readFileSync(fault, "utf8"));
  Assert.equal(receipt.nativeRequestForwarded, false);
  Assert.deepEqual(receipt.source, original);
  const operations = readTrace();
  Assert.equal(operations.length, 8);
  const projection = operations[6];
  Assert.equal(projection.operation, "application_commit");
  Assert.equal(projection.committed, true);
  const refusal = operations[7];
  Assert.equal(refusal.operation, "refused-runtime-import");
  Assert.equal(refusal.transactionId, receipt.transactionId);
  Assert.notEqual(refusal.transactionId, projection.transactionId);
  Assert.ok(operations.slice(0, 6).every((event) =>
    event.operation === "application_events_append" && event.transactionId === projection.transactionId,
  ));

  checkpoint("close and independently inspect the partial import");
  await active.stop();
  active = undefined;
  const partial = inspect(true);
  Assert.equal(partial.runtimeCount, 1);
  Assert.deepEqual(partial.resumeCursor, { threadId: sessionId });
  Assert.deepEqual(partial.markers, []);
  const history = partial.history;
  Assert.equal(history.applicationSequence, baseline.history.applicationSequence + 6);
  Assert.equal(history.threadSequence, history.applicationSequence);
  Assert.equal(history.stats.event_count, 6);
  Assert.equal(history.stats.has_create_event, true);
  Assert.deepEqual(history.events.map((event) => event.event_type), [
    "thread.created", "message.updated", "turn-item.updated", "message.updated",
    "turn-item.updated", "provider-thread.updated",
  ]);
  Assert.deepEqual(history.events.map((event) => ({ eventId: event.event_id, sequence: event.sequence })),
    operations.slice(0, 6).map(({ eventId, sequence }) => ({ eventId, sequence })));
  Assert.equal(new Set(history.events.map((event) => event.event_id)).size, 6);
  Assert.equal(history.threads.length, 1);
  Assert.equal(history.threads[0]?.id, threadId);
  Assert.equal(history.threads[0]?.projectId, projectId);
  Assert.equal(history.threads[0]?.historyOrigin, "v1_import");
  Assert.equal(history.providerThreads.length, 1);
  Assert.equal(history.providerThreads[0]?.appThreadId, threadId);
  Assert.equal(history.providerThreads[0]?.nativeThreadRef.nativeId, sessionId);
  const expectedMessages = [
    { role: "user", text: prompt, runId: null },
    { role: "assistant", text: response, runId: null },
  ];
  const messageContent = ({ role, text, runId }: (typeof history.messages)[number]) =>
    ({ role, text, runId });
  Assert.deepEqual(history.events.filter(({ event_type }) => event_type === "message.updated")
    .map(({ payload_json }) => messageContent(JSON.parse(payload_json))), expectedMessages);
  // A generic table scan orders encoded physical keys. The import IDs and turn
  // ordinals provide the logical order for these two independent row checks.
  Assert.deepEqual(history.messages.toSorted((a, b) => a.id.localeCompare(b.id)).map(messageContent),
    expectedMessages);
  Assert.deepEqual(history.turnItems.toSorted((a, b) => a.ordinal - b.ordinal)
    .map(({ type, text, runId }) => ({ type, text, runId })), [
    { type: "user_message", text: prompt, runId: null },
    { type: "assistant_message", text: response, runId: null },
  ]);
  Assert.equal(history.itemCounts.length, 1);
  Assert.deepEqual(history.itemCounts[0]?.item_count, { type: "integer", value: "2" });
  Assert.deepEqual(
    history.metadata.find((row) => row.projection_name?.value === "thread-projections")?.last_sequence,
    { type: "integer", value: String(history.threadSequence) },
  );
  Assert.equal(history.runCount, 0);
  Assert.equal(history.providerSessionCount, 0);
  report.afterFault = partial;

  checkpoint("reopen and import the unchanged rollout");
  active = startServer({ name: "reopened", baseDir, port: await reservePort(), env: relayedEnv });
  await active.ready;
  const reopened = await authenticate(active);
  const reopenedState = inspect();
  Assert.deepEqual(reopenedState.history, history);
  Assert.deepEqual(reopenedState.markers, []);
  const unchanged = await reopened.rpc((client) => Effect.gen(function* () {
    yield* scanAndCheck(client, true);
    return yield* client[WS_METHODS.agentSessionsImport](importInput);
  }));
  Assert.deepEqual(unchanged, { importedCount: 1, skippedCount: 0 });
  const recovered = inspect();
  Assert.deepEqual(recovered.history, history);
  Assert.equal(recovered.runtimeCount, 1);
  Assert.deepEqual(recovered.resumeCursor, partial.resumeCursor);
  Assert.deepEqual(recovered.markers, [original]);
  report.unchanged = { rpc: unchanged, persisted: recovered };

  checkpoint("import a changed rollout with the same session ID");
  const changed = writeRollout(changedResponse, new Date(stamp.getTime() + 30_000));
  Assert.equal(changed.providerSessionId, original.providerSessionId);
  if (encoding === "plain") Assert.notEqual(changed.size, original.size);
  Assert.notEqual(changed.mtimeMs, original.mtimeMs);
  const changedImport = await reopened.rpc((client) => Effect.gen(function* () {
    yield* scanAndCheck(client, true);
    return yield* client[WS_METHODS.agentSessionsImport](importInput);
  }));
  Assert.deepEqual(changedImport, inputCount);
  await active.stop();
  active = undefined;
  const final = inspect(true);
  Assert.deepEqual(final.history, history);
  Assert.equal(final.runtimeCount, 1);
  Assert.deepEqual(final.resumeCursor, partial.resumeCursor);
  Assert.deepEqual(final.markers, [original]);
  report.changed = { identity: changed, rpc: changedImport, persisted: final };

  const witness = (role: string, value: string) => ({
    role,
    text_sha256: Crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
  Assert.deepEqual(readTrace().slice(8), [
    {
      operation: "runtime_recover_import",
      source: original,
      messages: [witness("user", prompt), witness("assistant", response)],
      receipt: { ok: true, result: { recovered: true } },
    },
    {
      operation: "runtime_recover_import",
      source: changed,
      messages: [witness("user", prompt), witness("assistant", changedResponse)],
      receipt: { ok: true, result: { recovered: false } },
    },
  ]);

  checkpoint("reopen with the normal packaged helper selector");
  active = startServer({ name: "packaged-default", baseDir, port: await reservePort(), env });
  await active.ready;
  report.reopenedHelper = observePackagedHelper(active.pid, database);
  const normal = await authenticate(active);
  report.finalCandidate = await normal.rpc((client) => scanAndCheck(client, true));
  await active.stop();
  active = undefined;
  Assert.deepEqual(inspect(true), final);
  report.status = "passed";
  checkpoint("complete");
} catch (error) {
  firstFailure = error;
  report.status = "failed";
  report.firstFailure = error instanceof Error ? error.stack : String(error);
  save();
} finally {
  try {
    await active?.stop();
    if (scratch) FS.rmSync(scratch, { recursive: true, force: true });
    report.fixtureRemoved = scratch ? !FS.existsSync(scratch) : null;
  } catch (error) {
    firstFailure ??= error;
    report.status = "failed";
    report.cleanupFailure = error instanceof Error ? error.stack : String(error);
  }
  save();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
if (firstFailure !== undefined) throw firstFailure;
console.log(`Packaged Codex import recovery passed. Evidence: ${proof}`);
