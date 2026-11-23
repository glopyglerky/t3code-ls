import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

const loopbackServer = () =>
  NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });

const layerMediaPeer = (
  origin: string,
  session: EnvironmentAuth.AuthenticatedSession,
  invalidated: Deferred.Deferred<void>,
) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateWebSocketUpgrade: (request, audience) =>
        audience === "media" &&
        new URL(request.url, "http://127.0.0.1").searchParams.get("wsTicket") === "fixture-media"
          ? Effect.succeed(session)
          : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    }),
    Layer.mock(SessionStore.SessionStore)({
      awaitInvalidation: (sessionId, proofKeyThumbprint) =>
        sessionId === session.sessionId && proofKeyThumbprint === session.proofKeyThumbprint
          ? Deferred.await(invalidated)
          : Effect.never,
    }),
    Layer.succeed(DeviceService.DeviceService, {
      currentReadiness: () =>
        Effect.succeed({
          hostId: LOCAL_DEVICE_HOST_ID,
          hub: { origin },
        }),
    } as DeviceService.DeviceService["Service"]),
  );

const mediaPeer = {
  sessionId: AuthSessionId.make("fixture-media-peer"),
  subject: "fixture-media-peer",
  method: "bearer-access-token",
  proofKeyThumbprint: "fixture-proof-key",
} as const;

it.live("forwards a media chunk and releases the HTTP stream on session invalidation", () =>
  Effect.gen(function* () {
    const invalidated = yield* Deferred.make<void>();
    const upstreamReleased = yield* Deferred.make<void>();
    const frame = Uint8Array.of(0x2a);
    const hubServices = yield* Layer.build(loopbackServer());
    const hub = Context.get(hubServices, HttpServer.HttpServer);
    yield* hub.serve(
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.concat(Stream.succeed(frame), Stream.never).pipe(
            Stream.ensuring(Deferred.succeed(upstreamReleased, undefined)),
          ),
          { contentType: "application/octet-stream" },
        ),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(loopbackServer()),
        Layer.provide(
          layerMediaPeer(
            HttpServer.formatAddress(hub.address),
            { ...mediaPeer, scopes: [AuthOrchestrationReadScope] },
            invalidated,
          ),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const abort = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const path = "/api/device-hub/vendor/serve-sim/helper/test/stream.avcc?wsTicket=fixture-media";
    const response = yield* Effect.promise(() => fetch(`${origin}${path}`, { signal: abort.signal }));
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing media response body");
    expect(yield* Effect.promise(() => reader.read())).toEqual({ done: false, value: frame });
    expect(yield* Deferred.isDone(upstreamReleased)).toBe(false);

    yield* Deferred.succeed(invalidated, undefined);

    const end = yield* Effect.promise(() => reader.read()).pipe(Effect.timeout("5 seconds"));
    expect(end.done).toBe(true);
    yield* Deferred.await(upstreamReleased).pipe(Effect.timeout("5 seconds"));
  }),
);

it.live("preserves binary socket frames until session invalidation closes both ends", () =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })),
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
    const upstreamClosed = Promise.withResolvers<void>();
    hub.on("connection", (socket) => {
      socket.once("close", upstreamClosed.resolve);
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const invalidated = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(loopbackServer()),
        Layer.provide(
          layerMediaPeer(
            `http://127.0.0.1:${address.port}`,
            { ...mediaPeer, scopes: [AuthOrchestrationOperateScope] },
            invalidated,
          ),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const path = "/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=fixture-media";
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(`${origin}${path}`)),
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
    expect(client.readyState).toBe(WebSocket.OPEN);

    const closed = new Promise<void>((resolve) =>
      client.addEventListener("close", () => resolve(), { once: true }),
    );
    yield* Deferred.succeed(invalidated, undefined);
    yield* Effect.promise(() => Promise.all([closed, upstreamClosed.promise])).pipe(
      Effect.timeout("5 seconds"),
    );
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
            Layer.mock(SessionStore.SessionStore)({ awaitInvalidation: () => Effect.never }),
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
