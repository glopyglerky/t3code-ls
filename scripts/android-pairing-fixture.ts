// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - owned hosted fixture only.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { WS_METHODS, ORCHESTRATION_V2_WS_METHODS, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { authenticatePackagedServer, reservePort, startPackagedServer } from "../apps/server/scripts/packaged-server-fixture.ts";

const startupPhases = [
  "starting keybindings runtime",
  "starting server settings runtime",
  "recording startup heartbeat",
  "headless access info",
  "browser open check",
  "waiting for http listener",
  "publishing welcome event",
  "publishing ready event",
  "complete",
] as const;

function readStartupObservations(logPath: string) {
  if (!FS.existsSync(logPath)) return { outputBytes: 0, phases: [], errorCodes: [] };
  const fd = FS.openSync(logPath, "r");
  try {
    const { size } = FS.fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const count = FS.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.subarray(0, count).toString("utf8");
    return {
      outputBytes: size,
      phases: startupPhases.filter((phase) => lines.includes(`startup phase: ${phase}`)),
      errorCodes: [...new Set(lines.match(/\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ENOSPC|ERR_MODULE_NOT_FOUND|SQLITE_BUSY|SQLITE_CANTOPEN)\b/gu))],
    };
  } finally {
    FS.closeSync(fd);
  }
}

/** Only the existing synthetic replay adapter may run in this disposable profile. */
export async function withAndroidPairingFixture(input: {
  temporary: string;
  signal: AbortSignal;
  device: (args: string[]) => void;
  cleanupDevice: (args: string[]) => void;
  execute: () => Promise<unknown>;
  reopen: () => Promise<unknown>;
  record: (receipt: Record<string, unknown>) => void;
}) {
  Assert.equal(process.env.GITHUB_ACTIONS, "true");
  Assert.equal(process.platform, "linux");
  Assert.equal(process.arch, "x64");
  Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"]);
  const bundle = Path.join(input.temporary, "outbox-runtime-server/bin.mjs");
  Assert.equal(FS.realpathSync(bundle), bundle, "Stage an owned packaged server, not a source/home symlink");
  const scratch = FS.mkdtempSync(Path.join(input.temporary, "outbox-pairing-"));
  FS.chmodSync(scratch, 0o700);
  const home = Path.join(scratch, "home");
  const state = Path.join(scratch, "state");
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: Path.join(scratch, "bin"), TMPDIR: Path.join(scratch, "tmp"),
    XDG_CONFIG_HOME: Path.join(home, ".config"), XDG_DATA_HOME: Path.join(home, ".local/share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const sockets = new Set<Net.Socket>();
  const mappings = new Set<number>();
  let server: ReturnType<typeof startPackagedServer> | undefined;
  let proxy: Net.Server | undefined;
  let control: Http.Server | undefined;
  let connected = true;
  let configured = false;
  let reopening = false;
  let offlineChecked = false;
  let dispatchTransition = 0;
  let transition = 0;
  let stopped = false;
  let checkpoint = "stage";
  const receipt: Record<string, unknown> = { schema: 1, status: "running", providerLaunchRequested: false, realProviderLaunchRequested: false,
    bundleSha256: Crypto.createHash("sha256").update(FS.readFileSync(bundle)).digest("hex") };
  const startup: Record<string, unknown> = {};
  receipt.startup = startup;
  const start = async (phase: "initial" | "reopen", port: number) => {
    const logPath = Path.join(scratch, `${phase}-startup.log`);
    const started = startPackagedServer({ bundle, baseDir: state, env, port, logPath, signal: input.signal });
    server = started;
    if (phase === "initial") receipt.serverPid = started.pid;
    let outcome = "ready";
    try {
      await started.ready;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      outcome = message === "Packaged server startup timed out" ? "timeout" :
        /^Packaged server exited during startup /u.test(message) ? "early-exit" : "startup-error";
      throw cause;
    } finally {
      // Keep only fixed phase names and error codes. The scratch log never becomes an artifact.
      startup[phase] = { outcome, ...readStartupObservations(logPath) };
    }
    return started;
  };
  const reverse = (devicePort: number, hostPort: number) => {
    input.device(["reverse", "--no-rebind", `tcp:${devicePort}`, `tcp:${hostPort}`]);
    mappings.add(devicePort);
  };
  const track = (socket: Net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const listen = async (listener: Net.Server) => {
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    Assert.ok(address && typeof address !== "string");
    return address.port;
  };
  try {
    for (const directory of [home, state, env.PATH!, env.TMPDIR!, Path.join(state, "userdata")]) {
      FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    FS.writeFileSync(Path.join(state, "userdata/settings.json"), JSON.stringify({ providerInstances:
      Object.fromEntries(["codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
        .map((driver) => [driver, { driver, enabled: false }])) }), { mode: 0o600 });
    const workspace = Path.join(scratch, "workspace");
    FS.mkdirSync(workspace);
    // Reuse the same recorded adapter as verify-gpui-thread-submit. No installed profile is consulted.
    const settingsPath = Path.join(state, "userdata/settings.json");
    const settings = JSON.parse(FS.readFileSync(settingsPath, "utf8"));
    settings.providerInstances.devReplay = { displayName: "Replay (dev)", driver: "acpRegistry", enabled: true,
      config: { source: "local", commandPath: process.execPath,
        commandArgs: [Path.resolve(import.meta.dirname, "../apps/server/scripts/dev-replay-agent.ts")] } };
    FS.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const port = await reservePort();
    checkpoint = "server-start";
    server = await start("initial", port);
    checkpoint = "server-auth";
    let client = await authenticatePackagedServer(server, input.signal);
    await client.createProject({ projectId: ProjectId.make("t12-dispatch-project"), title: "T12 synthetic project", workspaceRoot: workspace });
    const accessSnapshot = () => client.rpc((rpc) => rpc[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runHead, Effect.map((event) => {
        Assert.ok(Option.isSome(event) && event.value.type === "snapshot");
        return event.value.payload;
      }),
    ));
    const before = await accessSnapshot();
    const existingSessionIds = new Set(before.clientSessions.map((session) => session.sessionId));
    const descriptorResponse = await fetch(server.origin + "/.well-known/t3/environment",
      { signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]), redirect: "error" });
    Assert.ok(descriptorResponse.ok);
    const descriptor = await descriptorResponse.json() as { environmentId: unknown };
    Assert.equal(typeof descriptor.environmentId, "string");
    receipt.environmentId = descriptor.environmentId;
    const issued = await client.request("/api/auth/pairing-token", { label: "T12 installed synthetic Android", scopes: ["orchestration:read", "orchestration:operate"] }) as { id: unknown; credential: unknown };
    Assert.equal(typeof issued.credential, "string");
    const pairingUrl = new URL("http://127.0.0.1:47832/");
    pairingUrl.hash = new URLSearchParams({ token: issued.credential as string }).toString();
    proxy = Net.createServer((downstream) => {
      track(downstream);
      if (!connected || sockets.size > 64) { downstream.destroy(); return; }
      const upstream = track(Net.connect(port, "127.0.0.1"));
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
      downstream.pipe(upstream).pipe(downstream);
    });
    const proxyPort = await listen(proxy);
    const paths = ["/drop-1", "/restore-1", "/drop-2", "/restore-2"];
    control = Http.createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      try {
        Assert.equal(request.headers["content-length"] ?? "0", "0");
        Assert.equal(request.headers["transfer-encoding"], undefined);
        if (request.method === "GET" && request.url === "/config" && !configured) {
          configured = true;
          response.end(JSON.stringify({ environmentId: descriptor.environmentId, pairingUrl: pairingUrl.toString() }));
          return;
        }
        Assert.ok(configured);
        if (request.method === "GET" && request.url === "/reopen-config" && reopening) {
          response.end(JSON.stringify({ environmentId: descriptor.environmentId }));
          return;
        }
        if (transition === paths.length && request.method === "POST") {
          if (request.url === "/drop-dispatch" && dispatchTransition === 0) {
            connected = false;
            input.device(["reverse", "--remove", "tcp:47832"]);
            mappings.delete(47832);
            for (const socket of sockets) socket.destroy();
            dispatchTransition = 1;
          } else if (request.url === "/assert-undispatched" && dispatchTransition === 1 && !offlineChecked) {
            const shell = await client.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(Stream.runHead));
            Assert.ok(Option.isSome(shell) && shell.value.kind === "snapshot");
            Assert.ok(!shell.value.snapshot.threads.some((thread) => thread.id === "t12-dispatch-thread"));
            Assert.ok(shell.value.snapshot.projects.some((project) => project.id === "t12-dispatch-project"));
            // Independent host reads must not find the queued Android task before reconnect.
            offlineChecked = true;
          } else if (request.url === "/restore-dispatch" && dispatchTransition === 1 && offlineChecked) {
            connected = true;
            reverse(47832, proxyPort);
            dispatchTransition = 2;
          } else throw new Error("Invalid dispatch transition");
          response.end("{}");
          return;
        }
        Assert.equal(request.method, "POST");
        Assert.equal(request.url, paths[transition]);
        Assert.ok(transition < paths.length);
        if (transition % 2 === 0) {
          connected = false;
          input.device(["reverse", "--remove", "tcp:47832"]);
          mappings.delete(47832);
          for (const socket of sockets) socket.destroy();
        } else {
          connected = true;
          reverse(47832, proxyPort);
        }
        transition++;
        response.end("{}");
      } catch {
        // Do not echo request data or credentials to the app or retained host output.
        response.statusCode = 409;
        response.end("{}");
      }
    });
    control.requestTimeout = 5_000;
    control.headersTimeout = 5_000;
    control.maxHeadersCount = 16;
    const controlPort = await listen(control);
    reverse(47831, controlPort);
    reverse(47832, proxyPort);
    checkpoint = "installed-pair-reconnect";
    receipt.providerLaunchRequested = true;
    const observedEnvironment = await input.execute();
    Assert.equal(observedEnvironment, descriptor.environmentId);
    Assert.equal(transition, 4);
    Assert.ok(configured);
    Assert.equal(dispatchTransition, 2);
    Assert.ok(offlineChecked);
    const projection = () => client.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: ThreadId.make("t12-dispatch-thread") }));
    const verifyProjection = (value: Awaited<ReturnType<typeof projection>>) => {
      Assert.equal(value.thread.id, "t12-dispatch-thread");
      Assert.equal(value.thread.projectId, "t12-dispatch-project");
      Assert.equal(value.runs.length, 1);
      Assert.equal(value.runs[0]!.status, "completed");
      const users = value.messages.filter((message) => message.role === "user");
      Assert.equal(users.length, 1);
      Assert.equal(users[0]!.id, "t12-dispatch-message");
      Assert.equal(users[0]!.text, "T12 synthetic Android persisted task");
      Assert.equal(users[0]!.runId, value.runs[0]!.id);
      return { runId: value.runs[0]!.id, userMessageCount: 1, runCount: 1 };
    };
    const completed = verifyProjection(await projection());
    const firstAccess = await accessSnapshot();
    const firstMobile = firstAccess.clientSessions.filter((session) => !existingSessionIds.has(session.sessionId));
    Assert.equal(firstMobile.length, 1);
    checkpoint = "durable-command-receipt";
    await server.stop();
    const database = Path.join(state, "userdata/statev2.omdb");
    Assert.ok(FS.existsSync(database));
    Assert.ok(!FS.existsSync(Path.join(state, "userdata/statev2.sqlite")));
    const readReceipt = () => {
      const transactionId = "t12-dispatch-read";
      const requests = [
        { operation: "application_begin", transaction_id: transactionId, mode: "read" },
        { operation: "application_receipts_get", transaction_id: transactionId, command_id: "t12-dispatch-command" },
        { operation: "application_receipts_get", transaction_id: transactionId, command_id: "t12-dispatch-command:initial-message" },
        { operation: "application_rollback", transaction_id: transactionId },
      ];
      const output = ChildProcess.execFileSync(Path.join(input.temporary, "outbox-runtime-server/native-bin/t3-code-ls-db"),
        ["read-only-local", database], { env: {}, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576,
          input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n" });
      const responses = output.trim().split("\n").map((line) => JSON.parse(line));
      Assert.equal(responses.length, 4);
      for (const response of responses) Assert.equal(response.ok, true);
      const launch = responses[1].result;
      Assert.equal(launch.command_id, "t12-dispatch-command");
      Assert.equal(launch.aggregate_id, "t12-dispatch-thread");
      Assert.equal(launch.command_type, "thread.create");
      Assert.equal(launch.status, "accepted");
      Assert.equal(launch.error, null);
      const response = responses[2];
      Assert.equal(response.ok, true);
      Assert.equal(response.result.command_id, "t12-dispatch-command:initial-message");
      Assert.equal(response.result.aggregate_id, "t12-dispatch-thread");
      Assert.equal(response.result.command_type, "message.dispatch");
      Assert.equal(response.result.status, "accepted");
      Assert.equal(response.result.error, null);
      Assert.ok(Number.isSafeInteger(response.result.result_sequence) && response.result.result_sequence > 0);
      return { launch, initialMessage: response.result };
    };
    const durableReceipt = readReceipt();
    checkpoint = "server-reopen";
    server = await start("reopen", port);
    client = await authenticatePackagedServer(server, input.signal);
    Assert.deepEqual(verifyProjection(await projection()), completed);
    reopening = true;
    checkpoint = "reopened-mobile-and-server-convergence";
    Assert.equal(await input.reopen(), descriptor.environmentId);
    Assert.deepEqual(verifyProjection(await projection()), completed);
    // Release the native store again to prove the exact receipt survived both reopen owners.
    const reopenedAccess = await accessSnapshot();
    await server.stop();
    Assert.deepEqual(readReceipt(), durableReceipt);
    receipt.dispatch = { ...completed, commandId: "t12-dispatch-command", messageId: "t12-dispatch-message",
      durableReceipt, clientAndServerReopened: true, offlineAbsenceChecked: true };
    checkpoint = "independent-server-auth-receipt";
    const after = reopenedAccess;
    const mobile = after.clientSessions.filter((session) => session.sessionId === firstMobile[0]!.sessionId);
    Assert.equal(mobile.length, 1, "Reopen must retain the original paired mobile session");
    Assert.notEqual(mobile[0]!.lastConnectedAt, null);
    Assert.ok(!after.pairingLinks.some((link) => link.id === issued.id), "One-time pairing link must be consumed");
    receipt.mobileSession = { sessionId: mobile[0]!.sessionId, method: mobile[0]!.method,
      connectedAtLeastOnce: true, newSessionCount: firstMobile.length, pairingLinkConsumed: true };
    receipt.completedTransportCycles = 2;
    receipt.syntheticReplayOnly = true;
    receipt.status = "passed";
  } catch {
    receipt.status = "failed";
    throw new Error(`Installed pairing fixture failed at ${checkpoint}`);
  } finally {
    const cleanupErrors: string[] = [];
    for (const port of mappings) {
      try { input.cleanupDevice(["reverse", "--remove", `tcp:${port}`]); }
      catch { cleanupErrors.push("reverse mapping"); }
    }
    for (const socket of sockets) socket.destroy();
    control?.closeAllConnections();
    for (const listener of [control, proxy]) if (listener?.listening) {
      try { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); }
      catch { cleanupErrors.push("listener"); }
    }
    try { if (server !== undefined) await server.stop(); stopped = true; }
    catch { cleanupErrors.push("server"); }
    if (stopped) FS.rmSync(scratch, { recursive: true, force: true });
    receipt.checkpoint = checkpoint;
    receipt.scratchRemoved = !FS.existsSync(scratch);
    receipt.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length > 0) receipt.status = "failed";
    input.record(receipt);
    Assert.equal(cleanupErrors.length, 0, "Owned pairing fixture cleanup failed");
  }
}
