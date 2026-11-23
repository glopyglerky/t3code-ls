import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

const loopbackServer = () =>
  NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });

it.effect("preserves binary input and admission frames through the real socket proxy", () =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of server.clients) client.terminate();
              server.close(() => resolve());
            }),
        ),
    );
    if (!hub.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    hub.on("connection", (socket) => {
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationOperateScope],
              }),
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Layer.provide(
          Layer.succeed(DeviceService.DeviceService, {
            currentReadiness: () =>
              Effect.succeed({
                hostId: LOCAL_DEVICE_HOST_ID,
                hub: { origin: `http://127.0.0.1:${address.port}` },
              }),
          } as DeviceService.DeviceService["Service"]),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const frames: number[][] = [];
    const received = Promise.withResolvers<void>();
    client.addEventListener("error", () => received.reject(new Error("Proxy failed")));
    client.addEventListener("message", ({ data }) => {
      frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
      if (frames.length === 1) {
        client.send(Uint8Array.of(0x03, 1));
        client.send(Uint8Array.of(0x03, 2));
      } else if (frames.length === 3) received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    expect(frames).toEqual([[0x83], [0x03, 1], [0x03, 2]]);
  }),
);

it.live("closes an upstream socket that is still connecting without an unhandled error", () =>
  Effect.gen(function* () {
    const dialed = Promise.withResolvers<NodeNet.Socket>();
    // Accepts the connection and never answers the WebSocket handshake.
    const hub = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer((socket) => dialed.resolve(socket));
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    // Handshake headers, as Simlock's routes send, select the `ws` package over the global WebSocket.
    const upstream = yield* Socket.makeWebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: { authorization: "Bearer test" },
    }).pipe(Effect.provide(DeviceHubProxy.upstreamWebSocketConstructor));
    const reading = yield* Effect.forkChild(
      Effect.scoped(Effect.flatMap(upstream.reader, ({ pull }) => pull)),
    );
    const connection = yield* Effect.promise(() => dialed.promise);
    const abandoned = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    yield* Fiber.interrupt(reading);
    yield* Effect.promise(() => abandoned);
  }),
);

it.live("closes the WebRTC viewer while keeping the simulator and thread session", () =>
  Effect.gen(function* () {
    const simulator = {
      id: "fixture-simulator",
      name: "Simulator",
      version: "iOS 26",
      platform: "ios" as const,
      booted: true,
      physical: false,
    };
    const vendor = "/vendor/serve-sim";
    const attachPath = `${vendor}/grid/api/start`;
    const closePath = `${vendor}/helper/${simulator.id}/webrtc/close`;
    const driverCalls: Array<{ method: string; url: string; body?: unknown }> = [];
    const hubServices = yield* Layer.build(loopbackServer());
    const hub = Context.get(hubServices, HttpServer.HttpServer);
    yield* hub.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { method, url } = request;
        const call: (typeof driverCalls)[number] = { method, url };
        driverCalls.push(call);
        if (method === "POST") call.body = yield* request.json;
        if (method === "GET" && url === "/api/devices") {
          return HttpServerResponse.jsonUnsafe({ simulators: [simulator], emulators: [] });
        }
        if (method === "POST" && url === attachPath) {
          return HttpServerResponse.jsonUnsafe({ ok: true });
        }
        if (method === "POST" && url === closePath) {
          return HttpServerResponse.jsonUnsafe({ closed: true });
        }
        return HttpServerResponse.empty({ status: 404 });
      }),
    );

    const origin = HttpServer.formatAddress(hub.address);
    const http = yield* HttpClient.HttpClient;
    const hostId = LOCAL_DEVICE_HOST_ID;
    const unexpectedOperation = Effect.die("Unexpected host operation");
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: "node",
      hub: { origin },
      run: () => unexpectedOperation,
      devices: makeDeviceHubOperations({
        hostId,
        origin,
        http,
        run: () => unexpectedOperation,
        platformAvailable: (platform) => Effect.succeed(platform === "ios"),
      }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      releaseAgentSession: () => unexpectedOperation,
    };
    const host = DeviceHost.DeviceHost.of({
      id: hostId,
      label: "Local",
      summary: Effect.succeed({
        id: hostId,
        label: "Local",
        kind: "local",
        hubInstalled: true,
        agentDeviceInstalled: false,
        platforms: [{ platform: "ios", available: true }],
      }),
      platformAvailability: (platform) =>
        Effect.succeed({ platform, available: platform === "ios" }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => unexpectedOperation,
      current: Effect.succeed(ready),
      stopAgent: unexpectedOperation,
      stop: unexpectedOperation,
    });
    const devices = yield* DeviceService.makeWithHosts(new Map([[hostId, host]])).pipe(
      Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })),
    );
    const threadId = ThreadId.make("viewer-close");
    const session = yield* devices.open({
      threadId,
      hostId,
      deviceId: simulator.id,
      platform: simulator.platform,
    });

    const authRequests: Array<{ url: string; audience: string }> = [];
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(loopbackServer()),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.succeed(DeviceService.DeviceService, devices),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateWebSocketUpgrade: (request, audience) =>
                Effect.sync(() => {
                  authRequests.push({ url: request.url, audience });
                  return {
                    sessionId: AuthSessionId.make("viewer-close"),
                    subject: "viewer-close",
                    method: "browser-session-cookie" as const,
                    scopes: [AuthOrchestrationReadScope],
                  };
                }),
            }),
          ),
        ),
      ),
    );
    const appServer = Context.get(services, HttpServer.HttpServer);
    const appOrigin = HttpServer.formatAddress(appServer.address);
    const appPath = `/api/device-hub${closePath}?hostId=${hostId}`;
    const viewerClose = { sessionId: "fixture-viewer" };
    const response = yield* HttpClientRequest.post(`${appOrigin}${appPath}`).pipe(
      HttpClientRequest.bodyJson(viewerClose),
      Effect.flatMap(http.execute),
    );

    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual({ closed: true });
    expect(authRequests).toEqual([{ url: appPath, audience: "media" }]);
    expect(driverCalls).toEqual([
      { method: "GET", url: "/api/devices" },
      { method: "POST", url: attachPath, body: { udid: simulator.id } },
      { method: "POST", url: closePath, body: viewerClose },
    ]);
    const state = yield* devices.state;
    expect(state.sessions).toEqual([session]);
    expect(state.devices).toEqual([{ ...simulator, hostId }]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer))),
);
