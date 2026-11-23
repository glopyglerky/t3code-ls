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
const stop = process.argv[3] === "--stop";
const approval = process.argv[3] === "--approval";
const databaseExecutable = stop ? process.argv[4] : undefined;
Assert.ok(executable && Path.isAbsolute(executable) && (stop ? process.argv.length === 5 : approval ? process.argv.length === 4 : process.argv.length === 3));
if (stop) Assert.ok(databaseExecutable && Path.isAbsolute(databaseExecutable));
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
const stopCommandId = stop ? CommandId.make(Crypto.randomUUID()) : undefined;
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
  const { environmentId } = descriptor;
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
  const submitThroughWindow = (mode: string, command: CommandId, message: string) => new Promise<void>((resolve, reject) => {
    const view = ChildProcess.spawn("/usr/bin/python3", [
      Path.join(root, "tools/check-gpui-showcase.py"), executable,
      mode,
    ], {
      env: process.env, stdio: ["pipe", "inherit", "inherit"],
    });
    const deadline = setTimeout(() => { view.kill("SIGTERM"); }, 120_000);
    view.once("error", () => { clearTimeout(deadline); reject(new Error("GPUI submit harness could not start")); });
    view.once("close", (code) => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error("GPUI submit view check failed")); });
    view.stdin.on("error", () => {});
    view.stdin.end(JSON.stringify({ port, token, environmentId, threadId, projectId,
      commandId: command, messageId: message, approvalCommandId, stopCommandId }));
  });
  type SubmissionProjection = {
    thread: { id: string; projectId: string };
    messages: { id: string; role: string; text: string; runId: string }[];
    runs: { id: string; status: string }[];
    runtimeRequests: { kind: string; status: string; decision?: string }[];
  };
  const currentProjection = async () => {
    const response = await fetch(origin + `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
      { headers, signal: AbortSignal.timeout(15_000) });
    Assert.ok(response.ok);
    const { projection } = await response.json() as { projection: SubmissionProjection };
    Assert.equal(projection.thread.id, threadId);
    Assert.equal(projection.thread.projectId, projectId);
    return projection;
  };
  const replyText = approval ? "Created the requested probe file." : "todo list fixture complete";
  const findCompletedRun = (projection: SubmissionProjection, id: string, prompt: string) => {
    const users = projection.messages.filter((message) => message.role === "user" && message.id === id);
    Assert.equal(users.length, 1);
    Assert.equal(users[0]?.text, prompt);
    const runs = projection.runs.filter((run) => run.id === users[0]?.runId);
    Assert.equal(runs.length, 1);
    Assert.equal(runs[0]?.status, "completed");
    Assert.ok(projection.messages.some((message) =>
      message.role === "assistant" && message.runId === runs[0]?.id && message.text.includes(replyText),
    ));
    return runs[0]!.id;
  };
  if (stop) {
    await submitThroughWindow("--thread-compose-stop", commandId, messageId);
    const interrupted = await currentProjection();
    Assert.equal(interrupted.runs.length, 1);
    Assert.equal(interrupted.runs[0]?.status, "interrupted");
    Assert.equal(interrupted.messages.filter((row) => row.role === "user").length, 1);
    const reopened = await currentProjection();
    Assert.deepEqual(reopened, interrupted);
    // All windows have closed. Release the synthetic server's database owner before offline inspection.
    server.kill("SIGTERM");
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        closeDeadline = setTimeout(() => reject(new Error("Synthetic server did not release its database")), 15_000);
      })]);
    } finally {
      if (closeDeadline) clearTimeout(closeDeadline);
    }
    Assert.ok(databaseExecutable);
    const transaction = "gpui-stop-receipt-inspection";
    const requests = [
      { operation: "application_begin", transaction_id: transaction, mode: "read" },
      { operation: "application_scan", transaction_id: transaction,
        table: "orchestration_command_receipts", after: null, limit: 200 },
      { operation: "application_rollback", transaction_id: transaction },
      { operation: "shutdown" },
    ];
    const output = ChildProcess.execFileSync(databaseExecutable,
      ["read-only-local", Path.join(userdata, "statev2.omdb")], {
        input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
        env: {}, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      });
    const responses = output.trim().split("\n").map((line) => JSON.parse(line) as {
      ok: boolean; result: { rows: { row: Record<string, { value: unknown }> }[]; next: string | null };
    });
    Assert.equal(responses.length, requests.length);
    for (const response of responses) Assert.equal(response.ok, true);
    const page = responses[1]!.result;
    Assert.equal(page.next, null, "Synthetic receipt inspection must cover the complete table");
    const stopReceipts = page.rows.filter(({ row }) => row.command_type?.value === "run.interrupt");
    Assert.equal(stopReceipts.length, 1);
    const receipt = stopReceipts[0]!.row;
    Assert.equal(receipt.command_id?.value, stopCommandId);
    Assert.equal(receipt.aggregate_id?.value, threadId);
    Assert.equal(receipt.status?.value, "accepted");
    console.log(JSON.stringify({ toolkit: "gpui", serverImplementation: "native",
      commands: ["message.dispatch", "run.interrupt"], runCount: 1, status: "interrupted",
      selectedProvider: "devReplay/todo-list", liveProvider: false, interruptReceiptCount: 1 }));
  } else {
    await submitThroughWindow(approval ? "--thread-compose-approval" : "--thread-compose", commandId, messageId);
    const accepted = await currentProjection();
    const initialRun = findCompletedRun(accepted, messageId, "GPUI sends one recorded prompt.");
    Assert.equal(accepted.runs.length, 1);
    Assert.equal(accepted.messages.filter((message) => message.role === "user").length, 1);
    if (approval) {
      Assert.equal(accepted.runtimeRequests.length, 1);
      const request = accepted.runtimeRequests[0];
      Assert.equal(request?.kind, "command");
      Assert.equal(request?.status, "resolved");
      Assert.equal(request?.decision, "accept");
      Assert.ok(!FS.existsSync(Path.join(workspace, ".codex-probe-write-action.txt")));
    } else {
      const secondMessage = Crypto.randomUUID();
      await submitThroughWindow("--thread-compose-follow-up", CommandId.make(Crypto.randomUUID()), secondMessage);
      const reopened = await currentProjection();
      Assert.equal(reopened.runs.length, 2);
      Assert.equal(reopened.messages.filter((message) => message.role === "user").length, 2);
      Assert.equal(findCompletedRun(reopened, messageId, "GPUI sends one recorded prompt."), initialRun);
      Assert.notEqual(findCompletedRun(reopened, secondMessage, "GPUI sends a follow-up in the same thread."), initialRun);
      for (const message of accepted.messages) {
        Assert.deepEqual(reopened.messages.find((row) => row.id === message.id), message);
      }
    }
    console.log(JSON.stringify({ toolkit: "gpui", serverImplementation: "native", transport: "WebSocket JSON RPC",
      commands: approval ? ["message.dispatch", "runtime-request.respond"] : ["message.dispatch"],
      runCount: approval ? 1 : 2, userMessageCount: approval ? 1 : 2, refusalWindows: approval ? 0 : 4,
      normalCommandAndProjectionRoute: true, followUpInSameThread: !approval,
      ...(approval ? { approvalDecision: "accept", resolvedRequestCount: 1 } : {}),
      ...(approval ? {} : { streaming: "original ACP partial before completed run; same message identity final/reopen; later unsent draft retained" }),
      unqualified: ["live providers", "general stream recovery and delta negotiation", "durable client identity allocation"],
    }));
  }
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  const terminate = setTimeout(() => { if (server && server.exitCode === null) server.kill("SIGKILL"); }, 8_000);
  try { await closed; } finally { clearTimeout(terminate); FS.rmSync(scratch, { recursive: true, force: true }); }
}
