// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - owned hosted fixture only.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { authenticatePackagedServer, reservePort, startPackagedServer } from "../apps/server/scripts/packaged-server-fixture.ts";

/** No provider is launched. This stage qualifies installed pairing and transport recovery only. */
export async function withAndroidPairingFixture(input: {
  temporary: string;
  signal: AbortSignal;
  device: (args: string[]) => void;
  cleanupDevice: (args: string[]) => void;
  execute: () => Promise<unknown>;
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
  let transition = 0;
  let stopped = false;
  let checkpoint = "stage";
  const receipt: Record<string, unknown> = { schema: 1, status: "running", providerLaunchRequested: false,
    bundleSha256: Crypto.createHash("sha256").update(FS.readFileSync(bundle)).digest("hex") };
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
    const port = await reservePort();
    checkpoint = "server-start";
    server = startPackagedServer({ bundle, baseDir: state, env, port,
      // Do not retain debug output from a credential-bearing experiment.
      logPath: "/dev/null", signal: input.signal });
    receipt.serverPid = server.pid;
    await server.ready;
    checkpoint = "server-auth";
    const client = await authenticatePackagedServer(server, input.signal);
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
    const issued = await client.request("/api/auth/pairing-token", { label: "T12 installed synthetic Android", scopes: ["orchestration:read"] }) as { id: unknown; credential: unknown };
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
    control = Http.createServer((request, response) => {
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
    const observedEnvironment = await input.execute();
    Assert.equal(observedEnvironment, descriptor.environmentId);
    Assert.equal(transition, 4);
    Assert.ok(configured);
    checkpoint = "independent-server-auth-receipt";
    const after = await accessSnapshot();
    const mobile = after.clientSessions.filter((session) => !existingSessionIds.has(session.sessionId));
    Assert.equal(mobile.length, 1, "Pairing and two reconnects must retain exactly one new mobile session");
    Assert.notEqual(mobile[0]!.lastConnectedAt, null);
    Assert.ok(!after.pairingLinks.some((link) => link.id === issued.id), "One-time pairing link must be consumed");
    receipt.mobileSession = { sessionId: mobile[0]!.sessionId, method: mobile[0]!.method,
      connectedAtLeastOnce: true, newSessionCount: mobile.length, pairingLinkConsumed: true };
    receipt.completedTransportCycles = 2;
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
