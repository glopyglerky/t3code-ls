// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - disposable Linux acceptance runner.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { ORCHESTRATION_V2_WS_METHODS, ProjectId, ThreadId, CommandId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";

const executable = process.argv[2];
const approval = process.argv[3] === "--approval";
Assert.ok(executable && Path.isAbsolute(executable) && (approval ? process.argv.length === 4 : process.argv.length === 3));
const scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "gpui-thread-submit-"));
const root = Path.resolve(import.meta.dirname, "../../..");
const baseDir = Path.join(scratch, "profile");
const workspace = Path.join(scratch, "workspace");
const codexHome = Path.join(scratch, "codex");
const userdata = Path.join(baseDir, "userdata");
const bootstrap = Crypto.randomBytes(32).toString("hex");
const projectId = ProjectId.make("gpui-snapshot-project");
const threadId = ThreadId.make("gpui-fixture-submit-thread");
const commandId = CommandId.make(Crypto.randomUUID());
const messageId = Crypto.randomUUID();
const approvalCommandId = approval ? CommandId.make(Crypto.randomUUID()) : undefined;
let server: ChildProcess.ChildProcess | undefined;
let closed = Promise.resolve();
let startupFailed = false;
try {
  for (const directory of [userdata, workspace, codexHome]) FS.mkdirSync(directory, { recursive: true });
  ChildProcess.execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: workspace, env: { PATH: "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" } });
  FS.writeFileSync(Path.join(userdata, "settings.json"), JSON.stringify({
    providerInstances: {
      ...Object.fromEntries(["claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
        .map((driver) => [driver, { driver, enabled: false }])),
      codex: { driver: "codex", enabled: false },
      devReplay: { displayName: "Replay (dev)", driver: "acpRegistry", enabled: true,
        config: { source: "local", commandPath: process.execPath,
          commandArgs: [Path.join(root, "apps/server/scripts/dev-replay-agent.ts")] } },
    },
  }));
  FS.writeFileSync(Path.join(workspace, "package.json"), '{"name":"synthetic-gpui-fixture"}\n');
  FS.writeFileSync(Path.join(workspace, "tsconfig.json"), '{}\n');
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
        T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
  server.stdout?.resume();
  server.stderr?.resume();
  const selectedServer = server;
  closed = new Promise<void>((resolve) => selectedServer.once("close", () => resolve()));
  server.on("error", () => { startupFailed = true; });
  const fd = server.stdio[3];
  Assert.ok(fd && "write" in fd);
  fd.on("error", () => {});
  fd.end(JSON.stringify({ mode: "desktop", noBrowser: true, port, t3Home: baseDir, host: "127.0.0.1",
    desktopBootstrapToken: bootstrap, shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false, tailscaleServePort: 443 }));
  let descriptor: { environmentId: string } | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    Assert.ok(!startupFailed && server.exitCode === null, "Synthetic server exited before readiness");
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
  const launched = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* makeWsRpcProtocolClient;
    return yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(Crypto.randomUUID()), threadId, projectId,
      title: "GPUI server submission", generateTitle: false,
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: approval ? "approval" : "todo-list" },
      runtimeMode: "approval-required", interactionMode: "default", workspaceStrategy: { type: "root" },
    });
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("45 seconds"))).catch(() => {
    throw new Error("Synthetic empty thread launch failed");
  });
  Assert.equal(launched.threadId, threadId);
  Assert.equal(launched.projection.messages.length, 0);
  Assert.equal(launched.projection.runs.length, 0);
  const snapshot = await fetch(origin + `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { headers, signal: AbortSignal.timeout(15_000) });
  Assert.ok(snapshot.ok);
  const data = await snapshot.json() as { projection: { thread: { id: string; projectId: string }; messages: unknown[]; runs: unknown[] } };
  Assert.equal(data.projection.thread.id, threadId);
  Assert.equal(data.projection.thread.projectId, projectId);
  Assert.equal(data.projection.messages.length, 0);
  Assert.equal(data.projection.runs.length, 0);
  Assert.ok(FS.existsSync(Path.join(userdata, "statev2.omdb")));
  Assert.ok(!FS.existsSync(Path.join(userdata, "statev2.sqlite")));
  await new Promise<void>((resolve, reject) => {
    const view = ChildProcess.spawn("/usr/bin/python3", [
      Path.join(root, "tools/check-gpui-showcase.py"), executable,
      approval ? "--thread-compose-approval" : "--thread-compose",
    ], {
      env: process.env, stdio: ["pipe", "inherit", "inherit"],
    });
    const deadline = setTimeout(() => { view.kill("SIGTERM"); }, 120_000);
    view.once("error", () => { clearTimeout(deadline); reject(new Error("GPUI submit harness could not start")); });
    view.once("close", (code) => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error("GPUI submit view check failed")); });
    view.stdin.on("error", () => {});
    view.stdin.end(JSON.stringify({ port, token, environmentId: descriptor.environmentId, threadId, projectId, commandId, messageId, approvalCommandId }));
  });
  const final = await fetch(origin + `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { headers, signal: AbortSignal.timeout(15_000) });
  Assert.ok(final.ok);
  const accepted = await final.json() as { projection: {
    thread: { id: string; projectId: string };
    messages: { id: string; role: string; text: string; runId: string }[];
    runs: { id: string; status: string }[];
    runtimeRequests: { kind: string; status: string; decision?: string }[];
  } };
  Assert.equal(accepted.projection.thread.id, threadId);
  Assert.equal(accepted.projection.thread.projectId, projectId);
  Assert.equal(accepted.projection.runs.length, 1);
  Assert.equal(accepted.projection.runs[0]?.status, "completed");
  const user = accepted.projection.messages.filter((message) => message.role === "user");
  Assert.equal(user.length, 1);
  Assert.equal(user[0]?.id, messageId);
  Assert.equal(user[0]?.text, "GPUI sends one recorded prompt.");
  Assert.equal(user[0]?.runId, accepted.projection.runs[0]?.id);
  const replyText = approval ? "Created the requested probe file." : "todo list fixture complete";
  Assert.ok(accepted.projection.messages.some((message) =>
    message.role === "assistant" && message.runId === accepted.projection.runs[0]?.id && message.text.includes(replyText),
  ));
  if (approval) {
    Assert.equal(accepted.projection.runtimeRequests.length, 1);
    const request = accepted.projection.runtimeRequests[0];
    Assert.equal(request?.kind, "command");
    Assert.equal(request?.status, "resolved");
    Assert.equal(request?.decision, "accept");
    Assert.ok(!FS.existsSync(Path.join(workspace, ".codex-probe-write-action.txt")));
  }
  console.log(JSON.stringify({ toolkit: "gpui", serverImplementation: "native", transport: "WebSocket JSON RPC",
    commands: approval ? ["message.dispatch", "runtime-request.respond"] : ["message.dispatch"],
    runCount: 1, userMessageCount: 1, refusalWindows: approval ? 0 : 4, normalCommandAndProjectionRoute: true,
    ...(approval ? { approvalDecision: "accept", resolvedRequestCount: 1 } : {}),
    unqualified: ["live providers", "streaming", "durable client identity allocation"],
  }));
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  const terminate = setTimeout(() => { if (server && server.exitCode === null) server.kill("SIGKILL"); }, 8_000);
  try { await closed; } finally { clearTimeout(terminate); FS.rmSync(scratch, { recursive: true, force: true }); }
}
