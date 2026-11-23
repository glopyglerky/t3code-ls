#!/usr/bin/env node
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Sqlite from "node:sqlite";
import * as Contracts from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunchService from "../apps/server/src/orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../apps/server/src/project/ManagedProjectFolders.ts";
import * as Metrics from "../apps/server/src/observability/Metrics.ts";
import * as ThreadManagementService from "../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../apps/server/src/orchestration-v2/Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../apps/server/src/orchestration-v2/UserFacingErrors.ts";
import * as SecretRequests from "../apps/server/src/secrets/SecretRequests.ts";
import * as ManagedPolicy from "../apps/server/src/policy/ManagedPolicy.ts";
import * as DueHint from "../apps/server/src/scheduling/DueHint.ts";
import * as Scheduler from "../apps/server/src/scheduling/Scheduler.ts";
import * as Schedule from "../apps/server/src/scheduledTasks/Schedule.ts";
import * as WebhookTemplate from "../apps/server/src/scheduledTasks/webhookTemplate.ts";
import * as WebhookFilter from "../apps/server/src/scheduledTasks/webhookFilter.ts";
import * as WebhookVerification from "../apps/server/src/scheduledTasks/webhookVerification.ts";
import * as ScheduledTaskService from "../apps/server/src/scheduledTasks/ScheduledTaskService.ts";
import * as NativeScheduledRows from "../apps/server/src/scheduledTasks/NativeScheduledRows.ts";
import * as SqliteScheduledRows from "../apps/server/src/scheduledTasks/SqliteScheduledRows.ts";
import * as Rows from "../apps/server/src/scheduledTasks/ScheduledRows.ts";
import * as Transactions from "../apps/server/src/persistence/PersistenceTransactions.ts";
import * as ServerSecretStore from "../apps/server/src/auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../apps/server/src/environment/ServerEnvironment.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../apps/server/src/cloud/config.ts";
import * as RelayDeliveryProof from "../apps/server/src/scheduledTasks/RelayDeliveryProof.ts";
import * as WebhookRoute from "../apps/server/src/scheduledTasks/webhookRoute.ts";
import { createFixture } from "./database-fixture.mjs";
import { exportSqliteState } from "./export-sqlite-state.mjs";
import {
  createMigratedSqlite,
  finishProof,
  hash,
  loadUpstream,
  nativeRequest,
  normalized,
  withNative,
  withSqlite,
} from "./redb-domain-fixture.mjs";

const [executable, proofPath] = process.argv.slice(2);
Assert.ok(executable && Path.isAbsolute(executable), "Pass an absolute native database executable");
await FS.access(executable, FS.constants.X_OK);
const at = "2026-11-10T12:00:00.000Z";
const stock = {
  commit: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f",
  root_tree: "af9112ce82be93109079ca7b7a89f7182455eca5",
};
const originalCitationOffsets = loadUpstream(
  "packages/shared/src/assistantCitations.ts",
  { ...Contracts, Option, Schema },
  ["splitsSurrogatePair"],
  stock,
);
const originalDedupe = loadUpstream(
  "apps/server/src/scheduledTasks/webhookDedupe.ts",
  {
    NodeCrypto: Crypto,
    ...Contracts,
    Effect,
    Schema,
    SqlClient,
    ...WebhookTemplate,
  },
  [
    "acceptWebhookDedupe",
    "acceptImmediateWebhookDedupe",
    "releaseWebhookReplay",
    "decodePendingTask",
    "encodePendingTask",
    "decodePendingRequest",
    "dedupeError",
  ],
  stock,
);
const original = loadUpstream(
  "apps/server/src/scheduledTasks/ScheduledTaskService.ts",
  {
    ...Contracts,
    Cause,
    Context,
    Digest,
    Mac,
    SecureRandom,
    ...originalCitationOffsets.module,
    DateTime,
    Effect,
    NodeSqliteClient,
    Exit,
    Duration,
    Metric,
    Layer,
    Option,
    PubSub,
    Ref,
    Result,
    Schema,
    Semaphore,
    Stream,
    SqlClient,
    ThreadLaunchService,
    ManagedProjectFolders,
    Metrics,
    ThreadManagementService,
    OrchestratorDispatchError,
    userFacingDispatchErrorMessage,
    SecretRequests,
    ManagedPolicy,
    DueHint,
    Scheduler,
    ...Schedule,
    ...WebhookTemplate,
    ...originalDedupe.module,
    ...WebhookFilter,
    ...WebhookVerification,
  },
  ["layer", "ScheduledTaskService"],
  stock,
);
const fixture = await createFixture();
const checks = [];

function serviceScenario(kind, { exercise, holdLaunch = false } = {}) {
  let time = Date.parse(at),
    random = 0;
  const workers = new Map(),
    launches = [];
  const clock = {
    currentTimeMillisUnsafe: () => time,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    sleep: () => Effect.never,
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layerDigest,
    NodeCrypto.layerMac,
    Layer.succeed(SecureRandom.SecureRandom, {
      randomBytes: (count) => Effect.sync(() => new Uint8Array(count).fill(++random)),
      uuidV4: () =>
        Effect.sync(() => `00000000-0000-4000-8000-${String(++random).padStart(12, "0")}`),
    }),
    Layer.succeed(Scheduler.Scheduler, {
      register: (name, work) =>
        Effect.gen(function* () {
          const context = yield* Effect.context();
          workers.set(name, work.pipe(Effect.provideContext(context)));
        }),
    }),
    Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
      launch: (input) =>
        Effect.sync(() => {
          launches.push(normalized(input));
          return { threadId: `thread:${launches.length}`, resumed: false };
        }).pipe(holdLaunch ? Effect.andThen(Effect.never) : (effect) => effect),
      isNonGitProject: () => Effect.succeed(false),
    }),
    Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
      namedProjectsRoot: "/fixture/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getThreadShell: () =>
        Effect.succeed({ projectId: "project:test", archivedAt: null, deletedAt: null }),
    }),
    Layer.succeed(SecretRequests.SecretRequests, {}),
    ManagedPolicy.layerTest(),
  );
  const serviceTag =
    kind === "upstream"
      ? original.module.ScheduledTaskService
      : ScheduledTaskService.ScheduledTaskService;
  const serviceLayer =
    kind === "upstream"
      ? original.module.layer
      : kind === "native"
        ? ScheduledTaskService.layerWithRows.pipe(
            Layer.provide(NativeScheduledRows.layer),
            Layer.provide(Transactions.redbLayer),
          )
        : ScheduledTaskService.layer;
  const input = (commandId, overrides = {}) =>
    Schema.decodeUnknownEffect(Contracts.ScheduledTaskUpsertInput)({
      commandId,
      title: "Fixture task",
      prompt: "Read {{body.value}}",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId: "project:test",
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...overrides,
    });
  return Effect.gen(function* () {
    const service = yield* serviceTag;
    if (exercise) {
      return yield* exercise({
        service,
        workers,
        launches,
        input,
        advanceClock: (ms) => {
          time += ms;
        },
      });
    }
    const result = {};
    result.initial = yield* service.list();
    Assert.equal(result.initial.tasks.length, 2);
    const saved = yield* service.upsert(yield* input("create"));
    result.created = saved;
    result.edited = yield* service.upsert(
      yield* input("create", { title: "Edited", prompt: "Run fixture" }),
    );
    result.disabled = yield* service.setEnabled({ id: saved.task.id, enabled: false });
    result.enabled = yield* service.setEnabled({ id: saved.task.id, enabled: true });
    result.ran = yield* service.runNow({ id: saved.task.id });
    Assert.equal(result.ran.task.runCount, 1);
    result.afterRun = yield* service.upsert(yield* input("create", { title: "After run" }));
    Assert.equal(result.afterRun.task.runCount, 1);
    const bound = yield* service.upsert(
      yield* input("bound", { threadId: "bound:thread", threadMode: "continue" }),
    );
    yield* service.moveThreadTasks({ threadIds: ["bound:thread"], projectId: "project:moved" });
    result.moved = (yield* service.list()).tasks.find((t) => t.id === bound.task.id);
    yield* service.deleteForThread("bound:thread");
    Assert.ok(!(yield* service.list()).tasks.some((t) => t.id === bound.task.id));
    const hook = (yield* service.upsert(
      yield* input("hook", {
        schedule: {
          type: "webhook",
          dedupe: {
            replayKey: "{{headers.delivery-id}}",
            coalesceKey: "{{body.group}}",
            coalesceWindowSeconds: 10,
          },
        },
      }),
    )).task;
    const request = (delivery, value) => ({
      hookId: hook.id,
      token: hook.webhook.path.split("/").at(-1),
      method: "POST",
      path: "/",
      query: "",
      headers: { "content-type": "application/json", "delivery-id": delivery },
      bodyText: JSON.stringify({ group: "same", value }),
      body: new TextEncoder().encode(JSON.stringify({ group: "same", value })),
      relayDeliveryId: delivery,
    });
    if (kind === "native") {
      const rows = yield* NativeScheduledRows.make;
      const incomplete = "legacy-claim-without-admission";
      yield* rows.write(
        { kind: "claim_relay", relay_delivery_id: incomplete, task_id: hook.id, seen_at: at },
        Rows.AnyRows,
      );
      const priorLaunches = launches.length;
      const results = yield* Effect.all(
        [request(incomplete, "retained"), request(incomplete, "retained")].map((delivery) =>
          service.triggerWebhook(delivery),
        ),
        { concurrency: "unbounded" },
      );
      for (const reply of results) {
        Assert.deepEqual(reply, {
          _tag: "unresolved",
          deliveryId: `delivery:relay:${incomplete}`,
        });
      }
      Assert.equal(launches.length, priorLaunches);
      const claim = yield* rows.write(
        { kind: "claim_relay", relay_delivery_id: incomplete, task_id: hook.id, seen_at: at },
        Rows.AnyRows,
      );
      Assert.deepEqual(claim, [], "An unresolved retry must preserve the original claim");
    }
    result.accepted = yield* service.triggerWebhook(request("first", "one"));
    result.coalesced = yield* service.triggerWebhook(request("second", "two"));
    result.duplicate = yield* service.triggerWebhook(request("second", "two"));
    Assert.equal(result.accepted.outcome, "accepted");
    Assert.equal(result.coalesced.outcome, "coalesced");
    Assert.equal(result.duplicate.outcome, "duplicate");
    result.pendingLog = yield* service.listWebhookDeliveries({
      id: hook.id,
      acceptAnyOutcome: true,
    });
    time += 11_000;
    yield* workers.get("webhook-coalescing");
    let completed;
    for (let attempt = 0; attempt < 500; attempt++) {
      completed = (yield* service.list()).tasks.find((t) => t.id === hook.id);
      if (completed.lastRunStatus === "succeeded" && completed.runCount === 1) break;
      yield* Effect.yieldNow;
    }
    Assert.equal(completed.runCount, 1);
    Assert.equal(completed.lastRunStatus, "succeeded");
    result.completed = completed;
    result.finalLogs = yield* service.listWebhookDeliveries({
      id: hook.id,
      acceptAnyOutcome: true,
    });
    result.delivery = yield* service.getWebhookDelivery({
      id: hook.id,
      deliveryId: "delivery:relay:first",
      acceptAnyOutcome: true,
    });
    const rotated = yield* service.rotateWebhookToken({ id: hook.id });
    Assert.notEqual(rotated.task.webhook.path, hook.webhook.path);
    result.rotated = rotated;
    result.deleted = yield* service.delete({ id: hook.id });
    Assert.equal(
      (yield* service.listWebhookDeliveries({ id: hook.id, acceptAnyOutcome: true })).deliveries
        .length,
      0,
    );
    result.final = yield* service.list();
    result.launches = launches;
    return normalized(result);
  }).pipe(
    Effect.provide(serviceLayer.pipe(Layer.provide(dependencies))),
    Effect.provideService(Clock.Clock, clock),
  );
}

function rowScenario(rows, transaction) {
  const read = (query) => rows.read(query, Rows.AnyRows);
  const write = (mutation) => rows.write(mutation, Rows.AnyRows);
  return Effect.gen(function* () {
    const result = {};
    result.initial = yield* read({ kind: "deliveries", task_id: "seed:a" });
    Assert.deepEqual(
      result.initial.map((r) => r.delivery_id),
      ["third", "first", "last"],
    );
    yield* transaction(
      Effect.gen(function* () {
        yield* write({
          kind: "patch_task",
          task_id: "seed:a",
          expected: {},
          different: {},
          patch: { last_run_status: "running", last_run_at: "started", webhook_token: "rotated" },
          increment_run_count: false,
        });
        const old = (yield* read({ kind: "tasks", task_id: "seed:a" }))[0];
        yield* write({
          kind: "save_task",
          row: {
            ...old,
            title: "Edit",
            last_run_status: "never",
            run_count: 0,
            webhook_token: "stale",
            next_run_at: "late",
          },
          require_existing: true,
          kept_schedule_json: old.schedule_json,
          secret_changed: false,
        });
        result.preserved = yield* read({ kind: "tasks", task_id: "seed:a" });
        Assert.equal(result.preserved[0].webhook_token, "rotated");
        Assert.equal(result.preserved[0].last_run_status, "running");
        result.stale = yield* write({
          kind: "patch_task",
          task_id: "seed:a",
          expected: { last_run_at: "stale" },
          different: {},
          patch: { last_run_status: "failed" },
          increment_run_count: true,
        });
        Assert.deepEqual(result.stale, []);
        result.claim = yield* write({
          kind: "claim_relay",
          relay_delivery_id: "same",
          task_id: "seed:a",
          seen_at: at,
        });
        result.replay = yield* write({
          kind: "claim_relay",
          relay_delivery_id: "same",
          task_id: "seed:a",
          seen_at: at,
        });
        Assert.equal(result.claim.length, 1);
        Assert.equal(result.replay.length, 0);
        yield* write({ kind: "prune_deliveries", task_id: "seed:a", bucket: "main", limit: 1 });
        result.retained = yield* read({ kind: "deliveries", task_id: "seed:a" });
        Assert.deepEqual(
          result.retained.map((r) => r.delivery_id),
          ["third"],
        );
        const exit = yield* Effect.exit(
          transaction(
            Effect.gen(function* () {
              yield* write({ kind: "delete_tasks", task_id: "seed:a" });
              return yield* Effect.fail("rollback");
            }),
          ),
        );
        Assert.ok(Exit.isFailure(exit));
        Assert.equal((yield* read({ kind: "tasks", task_id: "seed:a" })).length, 1);
      }),
    );
    return normalized(result);
  });
}

function immediateRelayRequest(task, relayDeliveryId, value) {
  const bodyText = JSON.stringify({ value });
  return {
    hookId: task.id,
    token: task.webhook.path.split("/").at(-1),
    method: "POST",
    path: "/hook",
    query: "",
    headers: { "content-type": "application/json", "delivery-id": relayDeliveryId },
    bodyText,
    body: new TextEncoder().encode(bodyText),
    relayDeliveryId,
  };
}

function waitFor(read, check, description) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (check(value)) return value;
      yield* Effect.yieldNow;
    }
    Assert.fail(description);
  });
}

class RelayFixtureApi extends HttpApi.make("environment").add(
  Contracts.EnvironmentHttpApi.groups.webhooks,
) {}

const signedRelayHttp = Effect.fn("signedRelayHttp")(function* (service, keys) {
  const clock = yield* Clock.Clock;
  const environmentId = Contracts.EnvironmentId.make("relay-fixture-env");
  const issuer = "https://relay.fixture.test";
  const secrets = new Map([
    [CLOUD_MINT_PUBLIC_KEY, keys.publicKey],
    [RELAY_ISSUER_SECRET, issuer],
  ]);
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(RelayFixtureApi).pipe(
        Layer.provide(WebhookRoute.layer),
        Layer.provide(RelayDeliveryProof.layer),
        Layer.provide(Layer.succeed(ScheduledTaskService.ScheduledTaskService, service)),
        Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.succeed(Option.map(
            Option.fromUndefinedOr(secrets.get(name)),
            (value) => new TextEncoder().encode(value),
          )),
        })),
        Layer.provide(Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        })),
        Layer.provide(HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        )),
        Layer.provide([NodeServices.layer, NodeCrypto.layerSignature]),
    ),
    Layer.succeed(Clock.Clock, clock),
  );
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(() => dispose()),
  );
  return Effect.fn("postSignedRelay")(function* (task, delivery, status, outcome) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const deliveryId = delivery.relayDeliveryId;
    const proof = yield* signRelayJwt({
      privateKey: keys.privateKey,
      typ: RELAY_HOOK_DELIVERY_TYP,
      payload: {
        iss: issuer,
        aud: `t3-env:${environmentId}`,
        sub: environmentId,
        jti: `proof:${deliveryId}`,
        iat: now,
        exp: now + 600,
        environmentId,
        deliveryId,
        receivedAt: at,
        hookId: task.id,
      },
    }).pipe(Effect.provide(NodeCrypto.layerSignature));
    const result = yield* Effect.promise(() => handler(new Request(
      new URL(task.webhook.path, "http://environment.fixture.test"),
      {
        method: delivery.method,
        body: delivery.body,
        headers: {
          ...delivery.headers,
          [RELAY_HOOK_DELIVERY_HEADER]: proof,
          "x-t3-relay-delivery-id": deliveryId,
          "x-t3-relay-received-at": at,
        },
      },
    )));
    Assert.equal(result.status, status);
    Assert.equal(result.headers.get("x-t3-hook-outcome"), outcome);
    const id = `delivery:relay:${deliveryId}`;
    Assert.deepEqual(
      yield* Effect.promise(() => result.json()),
      status === 202 ? { deliveryId: id } : { error: "delivery_unresolved", deliveryId: id },
    );
  });
});

async function proveDurableImmediateRelay() {
  const keys = Crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const withDurableNative = (use) =>
    withNative(executable, fixture, use, undefined, { durableRelayWebhooks: true });
  const { task, uncertain, ready, prompt } = await withDurableNative(() =>
    serviceScenario("native", {
      holdLaunch: true,
      exercise: ({ service, launches, input, advanceClock }) =>
        Effect.gen(function* () {
          const rows = yield* NativeScheduledRows.make;
          const post = yield* signedRelayHttp(service, keys);
          const schedule = { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } };
          const task = (yield* service.upsert(yield* input("durable-hook", { schedule }))).task;
          const uncertain = immediateRelayRequest(task, "possibly-sent", "first");
          const ready = immediateRelayRequest(task, "committed-before-start", "a".repeat(70_000));
          const [readPending, readLog] = [
            (delivery) =>
              rows.read(
                {
                  kind: "pending",
                  delivery_id: `delivery:relay:${delivery}`,
                  first: true,
                },
                Rows.PendingRows,
              ),
            (delivery) =>
              service.getWebhookDelivery({
                id: task.id,
                deliveryId: `delivery:relay:${delivery}`,
                acceptAnyOutcome: true,
              }),
          ];
          yield* post(task, uncertain, 202, "accepted");
          yield* waitFor(
            readPending(uncertain.relayDeliveryId),
            ([row]) => row?.state === "relay_running" && launches.length === 1,
            "Immediate work never reached the normal worker without a scheduler tick",
          );
          yield* post(task, ready, 202, "accepted");
          const [entry] = yield* readPending(ready.relayDeliveryId);
          Assert.equal(entry.state, "relay_ready");
          const prompt = JSON.parse(entry.request_json);
          Assert.ok(prompt.length > 64 * 1024 && prompt.includes("a".repeat(70_000)));
          const { delivery } = yield* readLog(ready.relayDeliveryId);
          Assert.equal(delivery.outcome, "accepted");
          Assert.equal(delivery.pendingWindow, false);
          Assert.ok(prompt.startsWith(delivery.renderedPrompt));
          Assert.equal(delivery.renderedPrompt.length, 64 * 1024);
          const replay = yield* rows.read(
            {
              kind: "has_replay",
              task_id: task.id,
              replay_key: Crypto.createHash("sha256").update(ready.relayDeliveryId).digest("hex"),
              now: Date.parse(at),
            },
            Rows.AnyRows,
          );
          Assert.equal(replay.length, 1);
          Assert.deepEqual(
            yield* rows.write(
              {
                kind: "claim_relay",
                relay_delivery_id: ready.relayDeliveryId,
                task_id: task.id,
                seen_at: at,
              },
              Rows.AnyRows,
            ),
            [],
          );
          yield* post(task, ready, 202, "duplicate");
          advanceClock(60_000);
          yield* service.upsert(
            yield* input("durable-hook", { prompt: "Edited while queued", schedule }),
          );
          return { task, uncertain, ready, prompt };
        }),
    }),
  );
  await withDurableNative(() =>
    serviceScenario("native", {
      exercise: ({ service, launches, workers, advanceClock }) =>
        Effect.gen(function* () {
          const rows = yield* NativeScheduledRows.make;
          const post = yield* signedRelayHttp(service, keys);
          const deliveryId = `delivery:relay:${ready.relayDeliveryId}`;
          const unresolvedId = `delivery:relay:${uncertain.relayDeliveryId}`;
          advanceClock(120_000);
          yield* workers.get("webhook-coalescing");
          const current = yield* waitFor(
            service.list().pipe(Effect.map(({ tasks }) => tasks.find(({ id }) => id === task.id))),
            (task) => task?.runCount === 1 && task.lastRunStatus === "succeeded",
            "Ready work did not complete after reopening the selected native store",
          );
          Assert.equal(current.prompt, "Edited while queued");
          Assert.equal(launches.length, 1);
          Assert.equal(launches[0].commandId, `scheduled-task:${task.id}:webhook:${deliveryId}`);
          Assert.equal(
            launches[0].initialMessage.messageId,
            `scheduled-task-message:${task.id}:webhook:${deliveryId}`,
          );
          Assert.equal(launches[0].initialMessage.text, prompt);
          Assert.deepEqual(
            yield* rows.read(
              {
                kind: "pending",
                delivery_id: deliveryId,
                first: true,
              },
              Rows.PendingRows,
            ),
            [],
          );
          const [unresolved] = yield* rows.read(
            {
              kind: "pending",
              delivery_id: unresolvedId,
              first: true,
            },
            Rows.PendingRows,
          );
          Assert.equal(unresolved.state, "relay_unresolved");
          Assert.equal(unresolved.request_json, "");
          const { delivery } = yield* service.getWebhookDelivery({
            id: task.id,
            deliveryId: unresolvedId,
            acceptAnyOutcome: true,
          });
          Assert.equal(delivery.outcome, "dispatch_failed");
          Assert.match(delivery.error, /could not be confirmed/);
          yield* post(task, uncertain, 500, "unresolved");
          yield* post(task, ready, 202, "duplicate");
          yield* rows.write(
            { kind: "prune_relays", before: "2026-11-13T00:00:00.000Z" },
            Rows.AnyRows,
          );
          yield* post(task, uncertain, 500, "unresolved");
          yield* workers.get("webhook-coalescing");
          Assert.equal(launches.length, 1);
        }),
    }),
  );
}

try {
  const source = Path.join(fixture.root, "source.sqlite"),
    exported = Path.join(fixture.root, "source.ndjson");
  await createMigratedSqlite(source);
  const database = new Sqlite.DatabaseSync(source);
  try {
    for (const id of ["seed:z", "seed:a"])
      database
        .prepare(`INSERT INTO scheduled_tasks
      (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,thread_mode,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count)
      VALUES (?, 'Imported task', 'Read fixture', 0, '{"type":"interval","everyMs":60000}', 'project:test', NULL, 'new_thread', '{"type":"root"}', '{"instanceId":"codex","model":"fixture"}', 'full-access', 'default', 'user', 'web', ?, ?, NULL, NULL, 'never', NULL, 0)`)
        .run(id, at, at);
    for (const id of ["last", "first", "third"])
      database
        .prepare(`INSERT INTO scheduled_task_webhook_deliveries
      (delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json,rendered_prompt,error)
      VALUES (?, 'seed:a', ?, 'POST', '', '{}', '', 0, 0, 'accepted', 0, '[]', NULL, NULL)`)
        .run(id, at);
  } finally {
    database.close();
  }
  const sourceHash = hash(await FS.readFile(source));
  exportSqliteState({ source, destination: exported });
  nativeRequest(executable, fixture, "initialize", {
    operation: "import_sqlite_application",
    path: exported,
  });
  const upstreamPath = Path.join(fixture.root, "upstream.sqlite"),
    sqlitePath = Path.join(fixture.root, "retained.sqlite");
  await FS.copyFile(source, upstreamPath);
  await FS.copyFile(source, sqlitePath);
  const expected = await withSqlite(upstreamPath, () => serviceScenario("upstream"));
  const retained = await withSqlite(sqlitePath, () => serviceScenario("sqlite"));
  const actual = await withNative(executable, fixture, () => serviceScenario("native"));
  Assert.deepEqual(retained, expected, "Retained SQLite service matches immutable upstream");
  Assert.deepEqual(actual, expected, "Native scheduled service matches immutable upstream");
  checks.push(
    "Real ScheduledTaskService matches immutable upstream and retained SQLite for CRUD, due scheduling, run counters, thread moves and deletion",
  );
  checks.push(
    "Real webhook path preserves relay claims, replay dedupe, coalescing, request replacement, dispatch, log detail, token rotation and deletion",
  );
  checks.push(
    "Concurrent native retries of a claim without durable admission stay unresolved, retain the claim and launch no work",
  );
  const sqlRows = await withSqlite(sqlitePath, (sql) =>
    Effect.gen(function* () {
      return yield* rowScenario(yield* SqliteScheduledRows.make, (body) =>
        sql.withTransaction(body),
      );
    }),
  );
  const nativeRows = await withNative(executable, fixture, (client) =>
    Effect.gen(function* () {
      return yield* rowScenario(yield* NativeScheduledRows.make, (body) =>
        client.withTransaction(body),
      );
    }),
  );
  Assert.deepEqual(nativeRows, sqlRows);
  checks.push(
    "Imported rowid tie order, settings/run CAS, token races, retention buckets, repeat claims and nested rollback agree between SQLite and native rows",
  );
  await withNative(executable, fixture, () =>
    Effect.gen(function* () {
      const rows = yield* NativeScheduledRows.make;
      const tasks = yield* rows.read({ kind: "tasks", task_id: "seed:a" }, Rows.TaskRows);
      Assert.equal(tasks[0].webhook_token, "rotated");
      Assert.equal(tasks[0].last_run_status, "running");
    }),
  );
  checks.push(
    "Reopening preserves native task state and does not rebuild indexes from stale imported rows",
  );
  await proveDurableImmediateRelay();
  await withNative(executable, fixture, (client) =>
    Effect.gen(function* () {
      const unopted = yield* Effect.result(client.prepareScheduled);
      Assert.ok(Result.isFailure(unopted));
      Assert.equal(unopted.failure.kind, "incompatible_store");
    }),
  );
  checks.push(
    "The signed relay HTTP route retains its full prompt before acknowledgement, recovers ready work once, returns 500 for ambiguous claims, and fences unopted readers",
  );
  await finishProof({
    executable,
    fixture,
    proofPath,
    checks,
    oracles: [original.source, originalDedupe.source, originalCitationOffsets.source],
    oracleCommit: stock.commit,
    sourceHash,
    sourcePaths: [
      "apps/server/src/scheduledTasks/ScheduledTaskService.ts",
      "apps/server/src/scheduledTasks/webhookDedupe.ts",
      "apps/server/src/scheduledTasks/ScheduledRows.ts",
      "apps/server/src/scheduledTasks/SqliteScheduledRows.ts",
      "apps/server/src/scheduledTasks/NativeScheduledRows.ts",
      "apps/server/src/scheduledTasks/redb_scheduled_rows.rs",
      "apps/server/src/persistence/RedbClient.ts",
      "crates/storage/src/bin/t3-code-ls-db.rs",
    ],
  });
} finally {
  await fixture.close();
}
