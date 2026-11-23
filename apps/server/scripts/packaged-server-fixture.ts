// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - isolated packaged application checks.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import * as Readline from "node:readline";
import * as Util from "node:util";
import { ORCHESTRATION_PROTOCOL_HEADER, ORCHESTRATION_PROTOCOL_VERSION, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";

export async function reservePort() {
  const reservation = Net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    Assert.ok(address && typeof address !== "string");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }
}

export function startPackagedServer(input: {
  bundle: string;
  logPath: string;
  signal: AbortSignal;
  baseDir: string;
  env: NodeJS.ProcessEnv;
  port: number;
}) {
  const bootstrap = Crypto.randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${input.port}`;
  const args = [input.bundle, "start", "--bootstrap-fd", "3", "--log-level", "debug"];
  const child = ChildProcess.spawn(process.execPath, args, {
    cwd: input.baseDir,
    env: input.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<void>();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("error", ready.reject);
  child.once("exit", (code, signal) =>
    ready.reject(new Error(`Packaged server exited during startup (${code ?? signal})`)),
  );
  for (const stream of [child.stdout, child.stderr]) {
    Assert.ok(stream);
    Readline.createInterface({ input: stream }).on("line", (line) => {
      const cleaned = Util.stripVTControlCharacters(line)
        .replaceAll(bootstrap, "[REDACTED]")
        .replace(/([#?&](?:token|wsTicket)=)[^\s&"'<>]+/gu, "$1[REDACTED]")
        .replace(/(\/api\/hooks\/[^/\s]+\/)[^\s?"'<>]+/gu, "$1[REDACTED]");
      FS.appendFileSync(input.logPath, cleaned + "\n");
      if (cleaned.includes("startup phase: complete")) ready.resolve();
    });
  }
  const fd = child.stdio[3];
  Assert.ok(fd && "write" in fd);
  fd.on("error", ready.reject);
  fd.end(JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port: input.port,
    t3Home: input.baseDir,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }));
  const timer = setTimeout(() => ready.reject(new Error("Packaged server startup timed out")), 120_000);
  const abortStartup = () => ready.reject(input.signal.reason);
  if (input.signal.aborted) abortStartup();
  else input.signal.addEventListener("abort", abortStartup, { once: true });
  return {
    ready: ready.promise.finally(() => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abortStartup);
    }),
    origin,
    bootstrap,
    pid: child.pid,
    argv: [Path.basename(process.execPath), "apps/server/dist/bin.mjs", ...args.slice(1)],
    stop: async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      const pid = child.pid;
      if (pid === undefined) return;
      const killGroup = () => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      if (signal === "SIGKILL" && child.exitCode === null && child.signalCode === null) killGroup();
      else child.kill("SIGTERM");
      const kill = setTimeout(killGroup, 8_000);
      const deadline = Promise.withResolvers<void>();
      const timeout = setTimeout(() => deadline.reject(new Error("Owned server did not close")), 12_000);
      try {
        await Promise.race([exited, deadline.promise]);
        return { code: child.exitCode, signal: child.signalCode };
      } finally {
        clearTimeout(kill);
        clearTimeout(timeout);
      }
    },
  };
}

// Use the desktop bootstrap, token exchange and typed WebSocket RPC client
// from the controlled server flow in verify-background-live.ts.
export async function authenticatePackagedServer(
  server: ReturnType<typeof startPackagedServer>,
  signal: AbortSignal,
) {
  const send = async (path: string, body?: URLSearchParams | string, headers?: Record<string, string>) => {
    const result = await fetch(server.origin + path, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    Assert.ok(result.ok, `${path} returned HTTP ${result.status}`);
    return result.json();
  };
  const { access_token } = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await send("/oauth/token", new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: server.bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    })),
  );
  const headers = {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  return {
    createProject: (project: { projectId: ProjectId; title: string; workspaceRoot: string }) =>
      send("/api/projects/mutate", JSON.stringify({
        type: "project.create",
        commandId: Crypto.randomUUID(),
        ...project,
      }), headers),
    async rpc<A, E>(use: (client: WsRpcProtocolClient) => Effect.Effect<A, E>) {
      const { ticket } = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
        await send("/api/auth/websocket-ticket", undefined, headers),
      );
      const url = new URL("/ws", server.origin);
      url.protocol = "ws:";
      url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
      url.searchParams.set("wsTicket", ticket);
      const socket = Socket.layerWebSocket(url.toString()).pipe(
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      );
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(socket),
        Layer.provide(RpcSerialization.layerJson),
      );
      return Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeWsRpcProtocolClient;
          return yield* use(client);
        }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("45 seconds")),
        { signal },
      );
    },
  };
}
