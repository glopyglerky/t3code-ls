// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - disposable macOS acceptance runner.
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

const executable = process.argv[2];
Assert.ok(executable && Path.isAbsolute(executable) && process.argv.length === 3);
Assert.equal(process.platform, "darwin");
Assert.equal(process.arch, "arm64");
const scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "makepad-thread-snapshot-"));
const root = Path.resolve(import.meta.dirname, "../../..");
const baseDir = Path.join(scratch, "profile");
const workspace = Path.join(scratch, "workspace");
const codexHome = Path.join(scratch, "codex");
const userdata = Path.join(baseDir, "userdata");
const bootstrap = Crypto.randomBytes(32).toString("hex");
const projectId = ProjectId.make("gpui-snapshot-project");
const sessionId = "0251af00-0000-4000-8000-000000000035";
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
  const stamp = new Date(Date.now() - 60_000);
  const day = stamp.toISOString().slice(0, 10);
  const sessions = Path.join(codexHome, "sessions", ...day.split("-"));
  FS.mkdirSync(sessions, { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: sessionId, cwd: workspace, source: "cli" } },
    { type: "event_msg", payload: { type: "user_message", message: "GPUI saved conversation prompt" } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "GPUI server reply café 🦀" }] } },
  ];
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
  server = ChildProcess.spawn(process.execPath,
    [Path.join(root, "apps/server/dist/bin.mjs"), "start", "--bootstrap-fd", "3"], {
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
  const data = await snapshot.json() as { projection: { thread: { id: string }; messages: { text: string }[] } };
  Assert.equal(data.projection.thread.id, threadId);
  Assert.ok(data.projection.messages.some((message) => message.text === "GPUI server reply café 🦀"));
  Assert.ok(FS.existsSync(Path.join(userdata, "statev2.sqlite")));
  Assert.ok(!FS.existsSync(Path.join(userdata, "statev2.omdb")));
  for (const [request, success] of [
    [{ port, token, environmentId: "wrong-environment", threadId }, false],
    [{ port, token: "invalid.fixture.token", environmentId: descriptor.environmentId, threadId }, false],
    [{ port, token, environmentId: descriptor.environmentId, threadId: "missing-fixture-thread" }, false],
    [{ port, token, environmentId: descriptor.environmentId, threadId }, true],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const view = ChildProcess.spawn(executable, ["--thread-snapshot-proof"], {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let oversized = false;
      const timer = setTimeout(() => { view.kill("SIGKILL"); }, 20_000);
      const capture = (chunk: Buffer) => {
        if (output.length + chunk.length > 64 * 1024) { oversized = true; view.kill("SIGKILL"); }
        else output += chunk.toString("utf8");
      };
      view.stdout.on("data", capture);
      view.stderr.on("data", capture);
      view.once("error", () => { clearTimeout(timer); reject(new Error("Makepad snapshot window could not start")); });
      view.once("close", (code) => {
        clearTimeout(timer);
        const marker = success ? "T14 Makepad server snapshot proof passed" : "T14 Makepad server snapshot refusal passed";
        if (code === 0 && !oversized && output.includes(marker) && !output.includes(token)) resolve();
        else reject(new Error("Makepad snapshot window check failed"));
      });
      view.stdin.on("error", () => { /* A failed child closes its input. The close handler reports a safe error. */ });
      view.stdin.end(JSON.stringify(request));
    });
  }
  const digest = (file: string) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
  console.log(JSON.stringify({
    toolkit: "makepad", platform: "darwin-arm64", serverImplementation: "upstream", storage: "sqlite",
    serverSha256: digest(Path.join(root, "apps/server/dist/bin.mjs")), executableSha256: digest(executable),
    workload: "gpui-snapshot-project/codex-three-records", positiveWindows: 1, refusalWindows: 3,
    scope: "authenticated production bounded snapshot route and Makepad widget text after native window draw",
    unqualified: ["native macOS storage", "accessibility", "physical input", "live subscription", "provider submission"],
  }));
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  const terminate = setTimeout(() => { if (server && server.exitCode === null) server.kill("SIGKILL"); }, 8_000);
  try { await closed; } finally { clearTimeout(terminate); FS.rmSync(scratch, { recursive: true, force: true }); }
}
