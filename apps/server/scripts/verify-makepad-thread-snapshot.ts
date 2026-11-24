// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - disposable macOS acceptance runner.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { WS_METHODS, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";

if (process.argv.length === 3 && process.argv[2] === "--help") {
  process.stdout.write("Usage: node verify-makepad-thread-snapshot.ts /absolute/makepad [--history] [--server-executable /absolute/packaged/t3]\n");
  process.exit(0);
}
const executable = process.argv[2];
Assert.ok(executable && Path.isAbsolute(executable));
let historyMode = false;
let serverExecutable: string | undefined;
for (let index = 3; index < process.argv.length; index++) {
  const option = process.argv[index];
  if (option === "--history" && !historyMode) historyMode = true;
  else if (option === "--server-executable" && serverExecutable === undefined) {
    const value = process.argv[++index];
    Assert.ok(value && Path.isAbsolute(value), "Expected an absolute packaged server executable");
    FS.accessSync(value, FS.constants.X_OK);
    serverExecutable = value;
  } else Assert.fail("Unknown or repeated fixture option");
}
if (Path.extname(import.meta.filename) === ".mjs") {
  Assert.ok(serverExecutable, "The standalone fixture requires --server-executable");
}
Assert.equal(process.platform, "darwin");
Assert.equal(process.arch, "arm64");
const root = Path.resolve(import.meta.dirname, "../../..");
// The standalone bundle carries this exact fixture next to itself. Development
// continues to read the repository fixture and launch the development server.
const historyFixturePath = Path.extname(import.meta.filename) === ".ts"
  ? Path.join(root, "packages/client-runtime/rust/host/fixtures/saved-history.json")
  : Path.join(import.meta.dirname, "saved-history.json");
const historyFixture = JSON.parse(FS.readFileSync(historyFixturePath, "utf8")) as {
  sessionId: string; turnCount: number; promptPrefix: string; replyPrefix: string;
};
Assert.equal(historyFixture.turnCount, 40);
const scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "makepad-thread-snapshot-"));
const baseDir = Path.join(scratch, "profile");
const workspace = Path.join(scratch, "workspace");
const codexHome = Path.join(scratch, "codex");
const userdata = Path.join(baseDir, "userdata");
const bootstrap = Crypto.randomBytes(32).toString("hex");
const projectId = ProjectId.make("gpui-snapshot-project");
const sessionId = historyFixture.sessionId;
const threadId = `import:codex:${sessionId}`;
let server: ChildProcess.ChildProcess | undefined;
let closed = Promise.resolve();
try {
  for (const directory of [userdata, workspace, codexHome]) FS.mkdirSync(directory, { recursive: true });
  ChildProcess.execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: workspace, env: { PATH: "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" } });
  FS.writeFileSync(Path.join(userdata, "settings.json"), JSON.stringify({
    providerInstances: {
      ...Object.fromEntries(["claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
        .map((driver) => [driver, { driver, enabled: false }])),
      codex: { driver: "codex", enabled: true,
        config: { setupMode: "existing", homePath: codexHome, binaryPath: Path.join(scratch, "absent-codex") } },
    },
  }));
  const stamp = DateTime.toEpochMillis(Effect.runSync(DateTime.now)) - (historyMode ? 120_000 : 60_000);
  const day = DateTime.formatIso(DateTime.makeUnsafe(stamp)).slice(0, 10);
  const sessions = Path.join(codexHome, "sessions", ...day.split("-"));
  FS.mkdirSync(sessions, { recursive: true });
  const conversation = historyMode ? Array.from({ length: historyFixture.turnCount }, (_, turn) => [
    { type: "event_msg", payload: { type: "user_message", message: `${historyFixture.promptPrefix}${String(turn).padStart(3, "0")}` } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: `${historyFixture.replyPrefix}${String(turn).padStart(3, "0")}` }] } },
  ]).flat() : [
    { type: "event_msg", payload: { type: "user_message", message: "GPUI saved conversation prompt" } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "GPUI server reply café 🦀" }] } },
  ];
  const records = [{ type: "session_meta", payload: { id: sessionId, cwd: workspace, source: "cli" } }, ...conversation];
  FS.writeFileSync(Path.join(sessions, `rollout-${day}T00-00-00-${sessionId}.jsonl`),
    records.map((record, index) => JSON.stringify({
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(stamp + index * 1000)), ...record,
    })).join("\n") + "\n");
  const reservation = Net.createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address();
  Assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  server = ChildProcess.spawn(serverExecutable ?? process.execPath,
    [...(serverExecutable === undefined ? [Path.join(root, "apps/server/dist/bin.mjs")] : []), "start", "--bootstrap-fd", "3"], {
      cwd: workspace,
      env: { HOME: scratch, PATH: "/usr/bin:/bin", CODEX_HOME: codexHome,
        T3_CODE_LS_IMPLEMENTATION: "upstream", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
  server.stdout?.resume();
  server.stderr?.resume();
  const selectedServer = server;
  closed = new Promise<void>((resolve) => selectedServer.once("close", () => resolve()));
  server.on("error", () => {});
  const fd = server.stdio[3];
  Assert.ok(fd && "write" in fd);
  fd.on("error", () => {});
  fd.end(JSON.stringify({ mode: "desktop", noBrowser: true, port, t3Home: baseDir, host: "127.0.0.1",
    desktopBootstrapToken: bootstrap, shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false, tailscaleServePort: 443 }));
  let descriptor: { environmentId: string } | undefined;
  for (let attempt = 0; attempt < 240; attempt++) {
    Assert.equal(server.exitCode, null, "Synthetic server exited before readiness");
    try {
      const response = await fetch(origin + "/.well-known/t3/environment", { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        descriptor = Schema.decodeUnknownSync(Schema.Struct({ environmentId: Schema.String }))(
          await response.json(),
        );
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  Assert.ok(descriptor && typeof descriptor.environmentId === "string", "Synthetic server never became ready");
  const exchanged = await fetch(origin + "/oauth/token", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap, subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token" }),
  });
  Assert.ok(exchanged.ok);
  const { access_token: token } = await exchanged.json() as { access_token: string };
  Assert.equal(typeof token, "string");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-t3-orchestration-protocol": "2" };
  const project = await fetch(origin + "/api/projects/mutate", {
    method: "POST", headers, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ type: "project.create", commandId: Crypto.randomUUID(), projectId,
      title: "GPUI snapshot project", workspaceRoot: workspace }),
  });
  Assert.ok(project.ok);
  const ticketReply = await fetch(origin + "/api/auth/websocket-ticket", { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
  Assert.ok(ticketReply.ok);
  const { ticket } = await ticketReply.json() as { ticket: string };
  const socket = Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`)
    .pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(Layer.provide(socket), Layer.provide(RpcSerialization.layerJson));
  const imported = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* makeWsRpcProtocolClient;
    yield* client[WS_METHODS.agentSessionsScan]({});
    return yield* client[WS_METHODS.agentSessionsImport]({ projectId, expectedWorkspaceRoot: workspace });
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("45 seconds"))).catch(() => {
    // A transport exception can contain the one-use WebSocket ticket URL.
    throw new Error("Synthetic provider import RPC failed");
  });
  Assert.deepEqual(imported, { importedCount: 1, skippedCount: 0 });
  const snapshot = await fetch(origin + `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { headers, signal: AbortSignal.timeout(15_000) });
  Assert.ok(snapshot.ok);
  type Row = { sourceItemId: string; item: { text: string } };
  const data = await snapshot.json() as { snapshotSequence: number; hasMoreHistory: boolean; historyCursor: string | null;
    projection: { thread: { id: string }; messages: { text: string }[]; visibleTurnItems: Row[] } };
  Assert.equal(data.projection.thread.id, threadId);
  if (historyMode) {
    Assert.equal(data.hasMoreHistory, true, "History fixture must exceed its first page");
    let rows = data.projection.visibleTurnItems;
    let cursor = data.historyCursor;
    const visited = new Set<string>();
    for (let page = 0; cursor !== null; page++) {
      Assert.ok(page < 8 && !visited.has(cursor), "Synthetic history did not advance");
      visited.add(cursor);
      const response = await fetch(origin + `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(cursor)}&view=conversation`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      Assert.ok(response.ok);
      const older = await response.json() as { snapshotSequence: number; items: Row[]; nextCursor: string | null; hasMoreHistory: boolean };
      Assert.equal(older.snapshotSequence, data.snapshotSequence);
      Assert.equal(older.hasMoreHistory, older.nextCursor !== null);
      rows = [...older.items, ...rows];
      cursor = older.nextCursor;
    }
    Assert.equal(new Set(rows.map((row) => row.sourceItemId)).size, 80);
    Assert.deepEqual(rows.map((row) => row.item.text), Array.from({ length: 40 }, (_, turn) => [
      `${historyFixture.promptPrefix}${String(turn).padStart(3, "0")}`, `${historyFixture.replyPrefix}${String(turn).padStart(3, "0")}`,
    ]).flat());
  } else Assert.ok(data.projection.messages.some((message) => message.text === "GPUI server reply café 🦀"));
  Assert.ok(FS.existsSync(Path.join(userdata, "statev2.sqlite")));
  Assert.ok(!FS.existsSync(Path.join(userdata, "statev2.omdb")));
  for (const [scenario, request, success] of [
    ["wrong environment", { port, token, environmentId: "wrong-environment", threadId }, false],
    ["invalid token", { port, token: "invalid.fixture.token", environmentId: descriptor.environmentId, threadId }, false],
    ["missing thread", { port, token, environmentId: descriptor.environmentId, threadId: "missing-fixture-thread" }, false],
    ["authenticated thread", { port, token, environmentId: descriptor.environmentId, threadId }, true],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const view = ChildProcess.spawn(executable, [historyMode ? "--thread-history-proof" : "--thread-snapshot-proof"], {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let oversized = false;
      const timer = setTimeout(() => { view.kill("SIGKILL"); }, historyMode ? 45_000 : 20_000);
      const capture = (chunk: Buffer) => {
        if (output.length + chunk.length > 64 * 1024) { oversized = true; view.kill("SIGKILL"); }
        else output += chunk.toString("utf8");
      };
      view.stdout.on("data", capture);
      view.stderr.on("data", capture);
      view.once("error", () => { clearTimeout(timer); reject(new Error("Makepad snapshot window could not start")); });
      view.once("close", (code, signal) => {
        clearTimeout(timer);
        const kind = historyMode ? "history" : "snapshot";
        const marker = success ? `T14 Makepad server ${kind} proof passed` : `T14 Makepad server ${kind} refusal passed`;
        if (code === 0 && !oversized && output.includes(marker) && !output.includes(token)) resolve();
        else {
          const reason = [
            "Makepad history proof timed out", "History widget does not match checked records",
            "Expected a bounded first page", "Oldest record was not paged", "Missing native history control",
            "Incomplete history", "Missing ordered history record", "Missing safe history refusal",
            "T14 Makepad server history refusal passed", "T14 Makepad server history proof passed",
          ].find((diagnostic) => output.includes(diagnostic));
          reject(new Error(
            `Makepad ${kind} check failed for ${scenario} (exit ${code ?? signal}, ${oversized ? "output exceeded bound" : reason ?? "no expected proof marker"})`,
          ));
        }
      });
      view.stdin.on("error", () => { /* A failed child closes its input. The close handler reports a safe error. */ });
      view.stdin.end(JSON.stringify(request));
    });
  }
  const digest = (file: string) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
  process.stdout.write(JSON.stringify({
    toolkit: "makepad", platform: "darwin-arm64", serverImplementation: "upstream", storage: "sqlite",
    serverPackaging: serverExecutable === undefined ? "development" : "cli-archive",
    serverSha256: digest(serverExecutable ?? Path.join(root, "apps/server/dist/bin.mjs")), executableSha256: digest(executable),
    fixtureDriverSha256: digest(process.argv[1]!), historyFixtureSha256: digest(historyFixturePath),
    workload: historyMode ? "shared-saved-history/40-turns/80-records" : "gpui-snapshot-project/codex-three-records", positiveWindows: 1, refusalWindows: 3,
    scope: historyMode ? "production bounded snapshot plus opaque history pages and native load-older command" : "authenticated production bounded snapshot route and Makepad widget text after native window draw",
    unqualified: ["native macOS storage", "accessibility", "physical input", "live subscription", "provider submission"],
  }) + "\n");
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  const terminate = setTimeout(() => { if (server && server.exitCode === null) server.kill("SIGKILL"); }, 8_000);
  try { await closed; } finally { clearTimeout(terminate); FS.rmSync(scratch, { recursive: true, force: true }); }
}
