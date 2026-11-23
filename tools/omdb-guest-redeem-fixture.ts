import * as Assert from "node:assert/strict";
// @effect-diagnostics nodeBuiltinImport:off -- The real Node listener supplies the MCP registry address.
import { createServer } from "node:http";
// @effect-diagnostics nodeBuiltinImport:off -- Own the disposable executable copy outside the graph.
import * as Fs from "node:fs/promises";
// @effect-diagnostics nodeBuiltinImport:off -- Resolve the fixture paths before opening the graph.
import * as Path from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  GuestRedeemRequest,
  guestSessionCookieName,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../apps/server/src/auth/ServerSecretStore.ts";
import * as CheckpointStore from "../apps/server/src/checkpointing/CheckpointStore.ts";
import { CloudManagedEndpointRuntime } from "../apps/server/src/cloud/ManagedEndpointRuntime.ts";
import * as Config from "../apps/server/src/config.ts";
import * as ServerEnvironment from "../apps/server/src/environment/ServerEnvironment.ts";
import * as GuestShare from "../apps/server/src/guest/GuestShareService.ts";
import * as GuestHttp from "../apps/server/src/guest/http.ts";
import * as McpSessionRegistry from "../apps/server/src/mcp/McpSessionRegistry.ts";
import * as EventSink from "../apps/server/src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as Runtime from "../apps/server/src/orchestration-v2/selectedRuntimeLayer.ts";
import * as Omdb from "../apps/server/src/persistence/Omdb.ts";
import { RedbClient } from "../apps/server/src/persistence/RedbClient.ts";
import * as Selected from "../apps/server/src/persistence/SelectedPersistence.ts";
import * as ManagedPolicy from "../apps/server/src/policy/ManagedPolicy.ts";
import * as ProviderInstances from "../apps/server/src/provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../apps/server/src/provider/ProviderRegistry.ts";
import * as Settings from "../apps/server/src/serverSettings.ts";
import * as Analytics from "../apps/server/src/telemetry/AnalyticsService.ts";
import * as VcsDriverRegistry from "../apps/server/src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../apps/server/src/vcs/VcsProcess.ts";
import {
  assertRedeemCommit,
  assertRedeemReplay,
  guestStatePageLimit,
  guestStateTables,
} from "./omdb-guest-state.ts";

const host = "env.t3.test";
const encodeRedeem = Schema.encodeSync(Schema.fromJsonString(GuestRedeemRequest));
const decodeRefusal = Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }));

function snapshot(client: RedbClient["Service"]) {
  const rows = (table: string) =>
    client.scan(table, { limit: guestStatePageLimit }).pipe(
      Effect.map((page) => {
        Assert.equal(page.next, null, `fixture table exceeds its bound: ${table}`);
        return page.rows;
      }),
    );

  return client.withReadTransaction(Effect.gen(function* () {
    return {
      events: yield* rows(guestStateTables.events),
      projects: yield* rows(guestStateTables.projects),
      threads: yield* rows(guestStateTables.threads),
      receipts: yield* rows(guestStateTables.receipts),
      outbox: yield* rows(guestStateTables.outbox),
    };
  }));
}

export async function verifyGuestRedeem({
  root,
  databaseExecutable,
  guestExecutable,
  threadEvent,
}: {
  readonly root: string;
  readonly databaseExecutable: string;
  readonly guestExecutable: string;
  readonly threadEvent: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>;
}) {
  Assert.deepEqual(Selected.selection, { kind: "omdb", executable: databaseExecutable });
  const { id: threadId, projectId } = threadEvent.payload;
  await Fs.mkdir(root);
  // Move only this copy to exercise a genuine spawn failure through the selected helper.
  const helperPath = Path.join(root, Path.basename(guestExecutable));
  const unavailablePath = helperPath + ".unavailable";
  await Fs.copyFile(guestExecutable, helperPath);
  await Fs.chmod(helperPath, 0o700);

  const graph = Layer.mergeAll(
    Runtime.layerGuestShare,
    Runtime.layerEventSink,
    Selected.projections,
    Omdb.layerConfig,
  ).pipe(
    Layer.provideMerge(Selected.settings),
    Layer.provide(Layer.mergeAll(
      Layer.mock(CloudManagedEndpointRuntime)({
        inspectConnector: Effect.succeed({
          pid: 1,
          readyConnections: 1,
          hostname: host,
          protocol: "http2",
        }),
      }),
      Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
        getInstance: () => Effect.undefined,
        listInstances: Effect.succeed([]),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Analytics.layer,
      CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)),
      McpProviderSessions.layer,
      McpSessionRegistry.layer.pipe(
        Layer.provide(ServerEnvironment.layer),
        // The MCP registry needs an address. Only the in-process GuestHttp handler receives requests.
        Layer.provide(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    )),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(VcsProcess.layer),
    Layer.provide(Config.layerTest(root, root)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: { T3CODE_TELEMETRY_ENABLED: "false" },
    }))),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, root)),
    Layer.provide(Layer.succeed(HostProcess.Environment, {
      T3_CODE_LS_IMPLEMENTATION: "upstream",
      T3_CODE_LS_DB_EXECUTABLE: databaseExecutable,
      T3_CODE_LS_GUEST_SHARE_EXECUTABLE: helperPath,
    })),
  );

  const open = Effect.gen(function* () {
    const services = yield* Layer.build(graph);
    Assert.ok(Option.isNone(Context.getOption(services, SqlClient.SqlClient)));
    const guest = Context.get(services, GuestShare.GuestShareService);
    const routes = Layer.mergeAll(
      GuestHttp.layer,
      Layer.succeed(GuestShare.GuestShareService, guest),
      NodeHttpServer.layerHttpServices,
    );
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose),
    );
    return {
      guest,
      client: Context.get(services, RedbClient),
      sink: Context.get(services, EventSink.EventSinkV2),
      settings: Context.get(services, Settings.ServerSettingsService),
      projections: Context.get(services, ProjectionStore.ProjectionStoreV2),
      redeem: (credential: string, name: string) => Effect.promise(() =>
        handler(new Request(`https://${host}/api/guest/redeem`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeRedeem({ credential, name }),
        })),
      ),
      session: (shareId: string, cookie: string) => Effect.promise(() =>
        handler(new Request(`https://${host}/api/guest/session?share=${encodeURIComponent(shareId)}`, {
          headers: { cookie },
        })),
      ),
    };
  });
  const run = <A, E>(use: (services: Effect.Success<typeof open>) => Effect.Effect<A, E>) =>
    Effect.runPromise(open.pipe(Effect.flatMap(use), Effect.scoped, Effect.provide(Logger.layer([]))));

  const assertRefusal = Effect.fnUntraced(function* (response: Response, status: number, reason: string) {
    Assert.equal(response.status, status);
    Assert.equal(response.headers.has("set-cookie"), false);
    const body = yield* Effect.promise(() => response.json());
    Assert.equal((yield* decodeRefusal(body)).reason, reason);
  });

  const first = await run(({ client, guest, projections, redeem, settings, sink, session }) =>
    Effect.gen(function* () {
      yield* settings.updateSettings({ guestSharingEnabled: true });
      const at = yield* DateTime.now;
      const iso = DateTime.formatIso(at);
      const projectCommand = CommandId.make("guest-fixture:project");
      yield* sink.commitProjectCommand({
        commandId: projectCommand,
        projectId,
        commandType: "project.create",
        acceptedAt: at,
        event: {
          eventId: EventId.make("guest-fixture:project-event"),
          aggregateKind: "project",
          aggregateId: projectId,
          type: "project.created",
          occurredAt: iso,
          commandId: projectCommand,
          causationEventId: null,
          correlationId: projectCommand,
          metadata: {},
          payload: {
            projectId,
            title: "Guest redeem fixture",
            workspaceRoot: root,
            defaultModelSelection: null,
            scripts: [],
            createdAt: iso,
            updatedAt: iso,
          },
        },
      });
      const threadCommand = CommandId.make("guest-fixture:thread");
      const seeded = yield* sink.commitCommand({
        commandId: threadCommand,
        threadId,
        commandType: "thread.create",
        acceptedAt: at,
        events: [threadEvent],
        effects: [{
          id: "guest-fixture:retained-outbox-row",
          commandId: threadCommand,
          threadId,
          request: { type: "terminal.cleanup" },
        }],
      });
      Assert.equal(seeded.committed, true);
      const { url, share } = yield* guest.create({ threadId });
      const invite = new URL(url);
      Assert.equal(invite.origin, `https://${host}`);
      const credential = invite.hash.slice(1);
      Assert.ok(credential);
      const before = yield* snapshot(client);
      Assert.equal(before.projects.length, 1);
      Assert.equal(before.threads.length, 1);
      Assert.equal(before.outbox.length, 1);
      Assert.equal(share.guestName, null);

      yield* Effect.acquireUseRelease(
        Effect.promise(() => Fs.rename(helperPath, unavailablePath)),
        () => redeem(credential, "Helper unavailable").pipe(
          Effect.flatMap((response) => assertRefusal(response, 403, "unavailable")),
        ),
        () => Effect.promise(() => Fs.rename(unavailablePath, helperPath)),
      );
      Assert.deepEqual(yield* snapshot(client), before);

      const names = ["Guest A", "Guest B"];
      const attempts = yield* Effect.forEach(
        names,
        (name) => redeem(credential, name).pipe(Effect.map((response) => ({ name, response }))),
        { concurrency: "unbounded" },
      );
      Assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [204, 409]);
      const winner = attempts.find(({ response }) => response.status === 204);
      const loser = attempts.find(({ response }) => response.status === 409);
      Assert.ok(winner && loser);
      yield* assertRefusal(loser.response, 409, "used");
      const [cookie, ...extraCookies] = winner.response.headers.getSetCookie();
      Assert.ok(cookie && extraCookies.length === 0, "the winner must set exactly one cookie");
      const [sessionCookie] = cookie.split(";");
      Assert.ok(sessionCookie && sessionCookie.startsWith(`${guestSessionCookieName(share.id)}=`));
      Assert.ok(/;\s*HttpOnly(?:;|$)/iu.test(cookie));
      Assert.ok(/;\s*Secure(?:;|$)/iu.test(cookie));
      Assert.ok(/;\s*SameSite=Strict(?:;|$)/iu.test(cookie));
      Assert.ok(/;\s*Path=\/api\/guest(?:;|$)/iu.test(cookie));

      const after = yield* snapshot(client);
      assertRedeemCommit(before, after, threadId);
      const stored = (yield* projections.getThread(threadId)).guestShare;
      Assert.equal(stored?.id, share.id);
      Assert.equal(stored?.guestName, winner.name);
      Assert.equal((yield* session(share.id, sessionCookie)).status, 204);
      yield* Effect.acquireUseRelease(
        Effect.promise(() => Fs.rename(helperPath, unavailablePath)),
        () => session(share.id, sessionCookie).pipe(
          Effect.flatMap((response) => assertRefusal(response, 403, "unavailable")),
        ),
        () => Effect.promise(() => Fs.rename(unavailablePath, helperPath)),
      );
      Assert.deepEqual(yield* snapshot(client), after);
      return { after, client, credential, sessionCookie, shareId: share.id };
    }),
  );

  const revoked = await run(({ client, redeem, session, guest }) => Effect.gen(function* () {
    Assert.notEqual(client, first.client);
    Assert.deepEqual(yield* snapshot(client), first.after);
    Assert.equal((yield* session(first.shareId, first.sessionCookie)).status, 204);
    yield* assertRefusal(yield* redeem(first.credential, "Replay after reopen"), 409, "used");
    const afterReplay = yield* snapshot(client);
    assertRedeemReplay(first.after, afterReplay);
    const replacement = yield* guest.create({ threadId });
    Assert.notEqual(replacement.share.id, first.shareId);
    const afterRevocation = yield* snapshot(client);
    yield* assertRefusal(yield* session(first.shareId, first.sessionCookie), 403, "inactive");
    Assert.deepEqual(yield* snapshot(client), afterRevocation);
    return afterRevocation;
  }));

  await run(({ client, session }) => Effect.gen(function* () {
    Assert.deepEqual(yield* snapshot(client), revoked);
    yield* assertRefusal(yield* session(first.shareId, first.sessionCookie), 403, "inactive");
    Assert.deepEqual(yield* snapshot(client), revoked);
  }));

  const files = await Fs.readdir(Path.join(root, "userdata"));
  Assert.ok(files.includes("statev2.omdb"));
  Assert.ok(!files.some((file) => /^state(?:v2)?\.sqlite(?:-(?:wal|shm))?$/.test(file)));
  return [
    "GuestHttp with selected omdb owners refuses an unavailable Rust invite helper without writes or a cookie",
    "two concurrent GuestHttp redeems commit one event, projection update and accepted receipt, with one secure cookie and no outbox change",
    "selected Rust session authorization accepts the winning cookie and refuses an unavailable helper without durable changes",
    "reopened omdb preserves the winning cookie and refuses the consumed invite with only a rejected receipt",
    "replacing the share revokes the old cookie before and after another native reopen without writes on denied reads",
  ];
}
