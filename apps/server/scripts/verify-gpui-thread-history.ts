// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - disposable Linux acceptance runner.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { WS_METHODS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";

if (process.argv[2] === "--help") {
  console.log("Usage: node verify-gpui-thread-history.ts /absolute/gpui --server-executable /absolute/packaged/t3");
  process.exit(0);
}
const executable = process.argv[2];
const serverExecutable = process.argv[4];
Assert.ok(executable && Path.isAbsolute(executable));
Assert.ok(process.argv.length === 5 && process.argv[3] === "--server-executable");
Assert.ok(serverExecutable && Path.isAbsolute(serverExecutable));
FS.accessSync(executable, FS.constants.X_OK);
FS.accessSync(serverExecutable, FS.constants.X_OK);
Assert.equal(process.platform, "linux");
const root = Path.resolve(import.meta.dirname, "../../..");
// The standalone bundle carries this exact fixture next to itself. Development
// reads the repository fixture. Both paths require a packaged native server.
const historyFixturePath = Path.extname(import.meta.filename) === ".ts"
  ? Path.join(root, "packages/client-runtime/rust/host/fixtures/saved-history.json")
  : Path.join(import.meta.dirname, "saved-history.json");
const historyFixture = JSON.parse(FS.readFileSync(historyFixturePath, "utf8")) as {
  sessionId: string; turnCount: number; promptPrefix: string; replyPrefix: string;
};
Assert.equal(historyFixture.turnCount, 40);
const scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "gpui-thread-history-"));
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
  const stamp = new Date(Date.now() - 120_000);
  const day = stamp.toISOString().slice(0, 10);
  const sessions = Path.join(codexHome, "sessions", ...day.split("-"));
  FS.mkdirSync(sessions, { recursive: true });
  const conversation = Array.from({ length: historyFixture.turnCount }, (_, turn) => [
    { type: "event_msg", payload: { type: "user_message", message: `${historyFixture.promptPrefix}${String(turn).padStart(3, "0")}` } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: `${historyFixture.replyPrefix}${String(turn).padStart(3, "0")}` }] } },
  ]).flat();
  const records = [{ type: "session_meta", payload: { id: sessionId, cwd: workspace, source: "cli" } }, ...conversation];
  FS.writeFileSync(Path.join(sessions, `rollout-${day}T00-00-00-${sessionId}.jsonl`),
    records.map((record, index) => JSON.stringify({
      timestamp: new Date(stamp.getTime() + index * 1000).toISOString(), ...record,
    })).join("\n") + "\n");
  const reservation = Net.createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address();
  Assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  server = ChildProcess.spawn(serverExecutable,
    ["start", "--bootstrap-fd", "3"], {
      cwd: workspace,
      env: { HOME: scratch, PATH: "/usr/bin:/bin", CODEX_HOME: codexHome,
        T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
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
      if (response.ok) { descriptor = await response.json(); break; }
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
  Assert.equal(data.hasMoreHistory, true, "Fixture must exceed its first page");
  const expected = Array.from({ length: historyFixture.turnCount }, (_, turn) => [
    `${historyFixture.promptPrefix}${String(turn).padStart(3, "0")}`,
    `${historyFixture.replyPrefix}${String(turn).padStart(3, "0")}`,
  ]).flat();
  const newest = data.projection.visibleTurnItems.map((row) => row.item.text);
  Assert.ok(newest.length > 0 && newest.length < expected.length);
  Assert.deepEqual(newest, expected.slice(-newest.length));
  Assert.ok(FS.existsSync(Path.join(userdata, "statev2.omdb")));
  Assert.ok(!FS.existsSync(Path.join(userdata, "statev2.sqlite")));
  const checkPath = Path.extname(import.meta.filename) === ".ts"
    ? Path.join(root, "tools/check-gpui-history.py")
    : Path.join(import.meta.dirname, "check-gpui-history.py");
  await new Promise<void>((resolve, reject) => {
    const view = ChildProcess.spawn("/usr/bin/python3", [checkPath, executable], {
      env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stopRequested = false;
    let oversized = false;
    let forcedStop: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      view.kill("SIGTERM");
      forcedStop = setTimeout(() => view.kill("SIGKILL"), 10_000);
    }, 180_000);
    const capture = (chunk: Buffer) => {
      if (output.length + chunk.length > 64 * 1024) { oversized = true; view.kill("SIGKILL"); return; }
      output += chunk.toString("utf8");
      if (!stopRequested && output.includes("T14 STOP OWNED SERVER\n")) {
        stopRequested = true;
        // The checker requests this only after observing the newest page in a second window.
        selectedServer.kill("SIGTERM");
        const killTimer = setTimeout(() => selectedServer.kill("SIGKILL"), 8_000);
        void closed.then(() => {
          clearTimeout(killTimer);
          view.stdin.end("SERVER STOPPED\n");
        });
      }
    };
    view.stdout.on("data", capture);
    view.stderr.on("data", capture);
    view.once("error", () => { clearTimeout(timer); reject(new Error("GPUI history check could not start")); });
    view.once("close", (code) => {
      clearTimeout(timer);
      if (forcedStop) clearTimeout(forcedStop);
      if (code === 0 && !oversized && stopRequested && output.includes("T14 GPUI history X11 AT-SPI passed") && !output.includes(token)) resolve();
      else {
        // Only forward the fixed stage and source line, never subprocess output.
        const failure = /^T14 history check: (initial-refusal|complete|page-refusal) line ([1-9][0-9]{0,3})$/mu.exec(output);
        const checkpoint = failure ? ` at ${failure[1]} line ${failure[2]}` : "";
        reject(new Error(`GPUI history X11/AT-SPI check failed${checkpoint} (exit ${code})`));
      }
    });
    view.stdin.on("error", () => {});
    view.stdin.write(JSON.stringify({ connection: { port, token, environmentId: descriptor.environmentId, threadId },
      newest, expected, snapshotSequence: data.snapshotSequence,
      prefixes: [historyFixture.promptPrefix, historyFixture.replyPrefix] }) + "\n");
  });
  const digest = (file: string) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
  console.log(JSON.stringify({
    toolkit: "gpui", platform: `linux-${process.arch}`, serverImplementation: "native", storage: "omdb",
    serverPackaging: "cli-archive", serverSha256: digest(serverExecutable), executableSha256: digest(executable),
    fixtureDriverSha256: digest(process.argv[1]!), historyFixtureSha256: digest(historyFixturePath),
    workload: "shared-saved-history/40-turns/80-records", positiveWindows: 1, refusalWindows: 4,
    scope: "bounded newest page, X11 keyboard Load older, AT-SPI exact text/order/thread/focus, failed page retains rows",
    unqualified: ["macOS", "Windows", "live subscription", "provider submission", "normal desktop launcher"],
  }));
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  const terminate = setTimeout(() => { if (server && server.exitCode === null) server.kill("SIGKILL"); }, 8_000);
  try { await closed; } finally { clearTimeout(terminate); FS.rmSync(scratch, { recursive: true, force: true }); }
}
