import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Etag, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PersistenceTransactions from "../persistence/PersistenceTransactions.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import { watchForkHistory } from "./ForkHistoryInvalidations.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const decodeBounded = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeHistoryPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
const decodeStreamItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const projectId = ProjectId.make("project:compact-transport");
const PARENT = ThreadId.make("thread:compact-transport:parent");
const FORK = ThreadId.make("thread:compact-transport:fork");
const GRANDCHILD = ThreadId.make("thread:compact-transport:grandchild");
const LONG = ThreadId.make("thread:compact-transport:long");
const BODIES = ThreadId.make("thread:compact-transport:bodies");
const parentRun = RunId.make("run:compact-transport:parent");
const longRun = RunId.make("run:compact-transport:long");
const bodiesRun = RunId.make("run:compact-transport:bodies");

const store = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const events = EventSink.layer.pipe(
  Layer.provide(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(OrchestrationEventStore.layer),
);
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadHistoryPage: (...args) => projections.getThreadHistoryPage(...args).pipe(Effect.orDie),
      streamStoredEventsFrom: (input) =>
        input?.threadId === BODIES
          ? Stream.fromIterable(bodiesLiveTail())
          : eventSink.stream({ ...input, bounded: true }).pipe(Stream.orDie),
      watchForkHistory: (id) => watchForkHistory(id, projections, eventSink),
    });
  }),
);

class OrchestrationApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("compact-transport"),
      subject: "compact-transport",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);

function threadCreated(
  id: ThreadId,
  at: DateTime.Utc,
  forkOf?: RunId,
  sourceThreadId = PARENT,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId,
      title: String(id),
      providerInstanceId: provider,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        forkOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : { parentThreadId: sourceThreadId, relationshipToParent: "fork", rootThreadId: PARENT },
      forkedFrom:
        forkOf === undefined ? null : { type: "run", threadId: sourceThreadId, runId: forkOf },
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function runCreated(
  threadId: ThreadId,
  runId: RunId,
  at: DateTime.Utc,
  ordinal = 1,
): OrchestrationV2DomainEvent {
  const rootNodeId = NodeId.make(`node:${runId}`);
  return {
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver: ProviderDriverKind.make("codex"),
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId: provider,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function itemUpdated(
  threadId: ThreadId,
  runId: RunId | null,
  key: string,
  ordinal: number,
  at: DateTime.Utc,
  type:
    | "command_execution"
    | "run_interrupt_request"
    | "run_interrupt_result"
    | "system_notice" = "command_execution",
): OrchestrationV2DomainEvent {
  const base = {
    id: TurnItemId.make(`turn-item:${threadId}:${key}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: key,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const payload: OrchestrationV2TurnItem =
    type === "command_execution"
      ? { ...base, type, input: `echo ${key}`, output: `output ${key}`, exitCode: 0 }
      : { ...base, type, message: key };
  return {
    id: EventId.make(`event:${threadId}:${key}`),
    type: "turn-item.updated",
    threadId,
    ...(runId === null ? {} : { runId }),
    occurredAt: at,
    payload,
  };
}

// A conversation turn whose records (message, checkpoint, subagent) repeat in its turn items.
function bodiesEvents(at: DateTime.Utc): OrchestrationV2DomainEvent[] {
  const event = (key: string, rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">) =>
    ({
      id: EventId.make(`event:${BODIES}:${key}`),
      threadId: BODIES,
      runId: bodiesRun,
      occurredAt: at,
      ...rest,
    }) as OrchestrationV2DomainEvent;
  const item = (key: string, ordinal: number, fields: object) =>
    event(`${key}-item`, {
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`turn-item:${BODIES}:${key}`),
        threadId: BODIES,
        runId: bodiesRun,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        ...fields,
      } as OrchestrationV2TurnItem,
    });
  const message = (key: string, role: "user" | "assistant", text: string) =>
    event(`${key}-message`, {
      type: "message.updated",
      payload: {
        id: MessageId.make(`message:${key === "prompt" ? bodiesRun : `${BODIES}:${key}`}`),
        threadId: BODIES,
        runId: bodiesRun,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
  const files = [{ path: "src/index.ts", kind: "modified", additions: 4, deletions: 2 }];
  return [
    threadCreated(BODIES, at),
    runCreated(BODIES, bodiesRun, at),
    message("prompt", "user", "Please fix the build."),
    item("prompt", 1, {
      type: "user_message",
      messageId: MessageId.make(`message:${bodiesRun}`),
      inputIntent: "turn_start",
      text: "Please fix the build.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    }),
    event("task-record", { type: "subagent.updated", payload: bodiesSubagent(at) }),
    item("task", 2, {
      type: "subagent",
      subagentId: bodiesSubagent(at).id,
      origin: "app_owned",
      driver: "codex",
      providerInstanceId: provider,
      childThreadId: null,
      prompt: bodiesSubagent(at).prompt,
      result: bodiesSubagent(at).result,
    }),
    message("reply", "assistant", "Fixed the import."),
    item("reply", 3, {
      type: "assistant_message",
      messageId: MessageId.make(`message:${BODIES}:reply`),
      text: "Fixed the import.",
      streaming: false,
    }),
    event("checkpoint-record", {
      type: "checkpoint.captured",
      payload: {
        id: CheckpointId.make(`checkpoint:${BODIES}`),
        threadId: BODIES,
        scopeId: CheckpointScopeId.make(`scope:${BODIES}`),
        runId: bodiesRun,
        nodeId: NodeId.make(`node:${bodiesRun}`),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make(`refs/t3/${BODIES}`),
        status: "ready",
        files,
        capturedAt: at,
      },
    }),
    item("checkpoint", 4, {
      type: "checkpoint",
      checkpointId: CheckpointId.make(`checkpoint:${BODIES}`),
      scopeId: CheckpointScopeId.make(`scope:${BODIES}`),
      files,
    }),
  ];
}

function bodiesSubagent(at: DateTime.Utc): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`node:${BODIES}:task`),
    threadId: BODIES,
    runId: bodiesRun,
    parentNodeId: NodeId.make(`node:${bodiesRun}`),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: provider,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Find the failing import.",
    title: null,
    model: null,
    status: "completed",
    result: "It was src/index.ts.",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

// Live after the snapshot: a reply pair, then a subagent update that repeats its prompt.
function bodiesLiveTail(): OrchestrationV2StoredEvent[] {
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const [reply, replyItem] = bodiesEvents(at).filter((event) =>
    String(event.id).includes(":reply-"),
  );
  return [
    reply!,
    replyItem!,
    {
      id: EventId.make(`event:${BODIES}:task-progress`),
      type: "subagent.updated",
      threadId: BODIES,
      runId: bodiesRun,
      occurredAt: at,
      payload: { ...bodiesSubagent(at), progress: "Checked the build." },
    } as OrchestrationV2DomainEvent,
  ].map((event, index) => ({ sequence: 1_000 + index, commandId: null, event }));
}

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = [
    threadCreated(PARENT, at),
    runCreated(PARENT, parentRun, at),
    ...[1, 2, 3].map((n) => itemUpdated(PARENT, parentRun, `parent-${n}`, n, at)),
    threadCreated(FORK, at, parentRun),
    ...[1, 2, 3, 4].map((n) => itemUpdated(FORK, null, `fork-${n}`, n, at)),
    threadCreated(LONG, at),
    runCreated(LONG, longRun, at),
    itemUpdated(LONG, longRun, "request", 1, at, "run_interrupt_request"),
    ...Array.from({ length: 90 }, (_, index) =>
      itemUpdated(LONG, longRun, `tool-${index}`, index + 2, at),
    ),
    itemUpdated(LONG, longRun, "result", 92, at, "run_interrupt_result"),
    ...bodiesEvents(at),
  ];
  for (const event of events) yield* projections.apply(event);
});

const TestLayer = Layer.mergeAll(
  PersistenceTransactions.sqliteLayer,
  management,
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("compact-transport")),
  }),
  Layer.effectDiscard(seed),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
).pipe(Layer.provideMerge(events), Layer.provideMerge(store));

const withHttp = <A>(use: (get: (path: string) => Promise<Response>) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof TestLayer>>();
    const appLayer = HttpApiBuilder.layer(OrchestrationApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          use((path) =>
            handler(
              new Request(`http://environment.test${path}`, {
                headers: {
                  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                },
              }),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

const firstSnapshot = (input: Parameters<typeof subscribeOrchestrationV2Thread>[0]) =>
  subscribeOrchestrationV2Thread(input).pipe(
    Effect.flatMap((stream) => Stream.runHead(stream)),
    Effect.map((head) => {
      if (head._tag !== "Some" || head.value.kind !== "snapshot") throw new Error("No snapshot");
      const decoded = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(head.value))));
      if (decoded.kind !== "snapshot") throw new Error("No snapshot");
      return { raw: head.value, decoded };
    }),
  );

function itemIds(projection: OrchestrationV2ThreadProjection): string[] {
  return projection.turnItems.map((item) => String(item.id));
}

it.layer(TestLayer)("compact bounded snapshot transport", (it) => {
  it.effect("WS: an open run-fork grandchild refreshes inherited text at its child watermark", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const at = yield* DateTime.now;
      const forkRun = RunId.make("run:compact-transport:fork");
      const laterRun = RunId.make("run:compact-transport:after-fork");
      const original = itemUpdated(PARENT, parentRun, "inherited-notice", 4, at, "system_notice");
      if (original.type !== "turn-item.updated" || original.payload.type !== "system_notice") {
        throw new Error("Expected an inherited notice fixture");
      }
      const seeded = yield* eventSink.write({
        events: [
          original,
          runCreated(FORK, forkRun, at),
          threadCreated(GRANDCHILD, at, forkRun, FORK),
          itemUpdated(GRANDCHILD, null, "initial-child-output", 1, at),
        ],
      });
      const childSequence = seeded.at(-1)!.sequence;
      const amended = {
        ...original,
        id: EventId.make("event:compact-transport:ancestor-edit"),
        payload: { ...original.payload, message: "Amended inherited notice" },
      };
      const inheritedText = (projection: OrchestrationV2ThreadProjection) => {
        const row = projection.visibleTurnItems.find(
          (item) =>
            item.visibility === "inherited" &&
            item.sourceThreadId === PARENT &&
            item.sourceItemId === original.payload.id,
        );
        return row?.item.type === "system_notice" ? row.item.message : undefined;
      };

      const input = {
        threadId: GRANDCHILD,
        acceptBoundedSnapshot: true,
        acceptCompactTurnItems: true,
        acceptCompactIds: true,
        requestCompletionMarker: true,
      };
      const open = Effect.fnUntraced(function* (profile: typeof input & {
        acceptHistoryInvalidation?: boolean;
      }) {
        const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const stream = yield* subscribeOrchestrationV2Thread(profile);
        yield* stream.pipe(
          Stream.map((item) => decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(item))))),
          Stream.runForEach((item) => Queue.offer(received, item)),
          Effect.forkScoped,
        );
        const opening = yield* Queue.take(received);
        if (opening.kind !== "snapshot") throw new Error("Expected the opening snapshot");
        assert.deepStrictEqual(yield* Queue.take(received), { kind: "synchronized" });
        return { opening, received };
      });
      const { opening, received } = yield* open({ ...input, acceptHistoryInvalidation: true });
      const legacy = yield* open(input);
      const full = yield* open({
        ...input,
        acceptBoundedSnapshot: false,
        acceptHistoryInvalidation: true,
      });
      assert.equal(opening.snapshotSequence, childSequence);
      assert.isTrue(opening.turnItemsOmitLocalVisible);
      assert.equal(inheritedText(boundedSnapshotProjection(opening)), original.payload.message);

      yield* eventSink.write({
        events: [
          runCreated(PARENT, laterRun, at, 2),
          itemUpdated(PARENT, laterRun, "outside-fork-history", 5, at),
          itemUpdated(LONG, longRun, "unrelated-history", 95, at),
        ],
      });
      yield* TestClock.adjust("1 second");
      assert.isTrue(Option.isNone(yield* Queue.poll(received)));

      yield* eventSink.write({
        events: [
          {
            ...amended,
            id: EventId.make("event:compact-transport:ancestor-edit-interim"),
            payload: { ...amended.payload, message: "Interim inherited notice" },
          },
          amended,
        ],
      });
      const current = yield* projections.getThreadSnapshotWindow(GRANDCHILD, { rowLimit: 20 });
      assert.equal(inheritedText(current.projection), amended.payload.message);
      assert.equal(current.snapshotSequence, childSequence);
      assert.notInclude(JSON.stringify(current.projection), "outside-fork-history");

      yield* TestClock.adjust("1 second");
      const refresh = Option.getOrUndefined(yield* Queue.poll(received));
      assert.deepStrictEqual(
        refresh,
        { kind: "history-invalidated" },
        "The open stream missed the ancestor-only edit",
      );
      assert.deepStrictEqual(encodeStreamItem({ kind: "history-invalidated" }), { kind: "history-invalidated" });
      assert.isTrue(Option.isNone(yield* Queue.poll(received)));
      assert.isTrue(Option.isNone(yield* Queue.poll(legacy.received)));
      assert.isTrue(Option.isNone(yield* Queue.poll(full.received)));

      const childEvents = yield* eventSink.write({
        events: [
          itemUpdated(GRANDCHILD, null, "child-live-output", 2, at),
          itemUpdated(GRANDCHILD, null, "child-next-output", 3, at),
        ],
      });
      yield* TestClock.adjust("1 second");
      for (const childEvent of childEvents) {
        const next = Option.getOrUndefined(yield* Queue.poll(received));
        if (next?.kind !== "event") throw new Error("Expected an ordered child event");
        assert.equal(next.sequence, childEvent.sequence);
        assert.equal(next.event.threadId, GRANDCHILD);
        if (
          next.event.type !== "turn-item.updated" ||
          next.event.payload.type !== "command_execution"
        ) {
          throw new Error("Expected the child command update");
        }
        assert.isUndefined(next.event.payload.output);
        assert.isTrue(next.event.payload.outputOmitted);
      }
      assert.isTrue(Option.isNone(yield* Queue.poll(received)));

      const replay = yield* subscribeOrchestrationV2Thread({
        ...input,
        acceptHistoryInvalidation: true,
        afterSequence: childSequence,
      });
      const catchup = yield* replay.pipe(Stream.take(childEvents.length + 1), Stream.runCollect);
      assert.deepStrictEqual(
        catchup.map((item) => (item.kind === "event" ? item.sequence : item.kind)),
        [...childEvents.map((event) => event.sequence), "synchronized"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("HTTP: fork history view revision changes across an ancestor-only commit", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const at = yield* DateTime.now;
      const parent = ThreadId.make("thread:compact-transport:http-parent");
      const child = ThreadId.make("thread:compact-transport:http-child");
      const cutoff = RunId.make("run:compact-transport:http-cutoff");
      const edit = itemUpdated(parent, cutoff, "inherited-notice", 1, at, "system_notice");
      if (edit.type !== "turn-item.updated" || edit.payload.type !== "system_notice") {
        throw new Error("Expected an inherited notice fixture");
      }
      yield* eventSink.write({
        events: [
          threadCreated(parent, at),
          runCreated(parent, cutoff, at),
          edit,
          threadCreated(child, at, cutoff, parent),
        ],
      });
      const laterRun = RunId.make("run:compact-transport:http-after-fork");
      const base = `/api/orchestration/threads/${encodeURIComponent(child)}`;
      const bounded = () =>
        withHttp(async (get) => {
          const response = await get(`${base}/bounded?compactIds=1`);
          assert.equal(response.status, 200);
          return decodeBounded(await response.text());
        });
      const page = (cursor: string) =>
        withHttp(async (get) => {
          const response = await get(
            `${base}/history?cursor=${encodeURIComponent(cursor)}&compactIds=1`,
          );
          assert.equal(response.status, 200);
          return decodeHistoryPage(await response.text());
        });
      const before = yield* bounded();
      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: before.snapshotSequence,
        sourceThreadId: parent,
        sourceItemId: edit.payload.id,
        position: 0,
        inclusive: true,
      });
      const firstPage = yield* page(cursor);
      assert.isNumber(before.historyViewRevision);
      assert.equal(firstPage.historyViewRevision, before.historyViewRevision);
      assert.include(JSON.stringify(firstPage.items), '"message":"inherited-notice"');

      const [stored] = yield* eventSink.write({
        events: [
          {
            ...edit,
            id: EventId.make("event:compact-transport:http-ancestor-edit"),
            payload: { ...edit.payload, message: "Ancestor revised for HTTP" },
          },
        ],
      });
      const secondPage = yield* page(cursor);
      assert.equal(secondPage.snapshotSequence, before.snapshotSequence);
      assert.notEqual(secondPage.historyViewRevision, before.historyViewRevision);
      assert.equal(secondPage.historyViewRevision, stored!.sequence);
      assert.include(JSON.stringify(secondPage.items), "Ancestor revised for HTTP");
      const after = yield* bounded();
      assert.equal(after.historyViewRevision, secondPage.historyViewRevision);
      assert.equal(after.snapshotSequence, before.snapshotSequence);

      yield* eventSink.write({
        events: [
          runCreated(parent, laterRun, at, 2),
          itemUpdated(parent, laterRun, "http-outside-cutoff", 100, at),
        ],
      });
      const outside = yield* bounded();
      const outsidePage = yield* page(cursor);
      assert.deepStrictEqual(outside.projection, after.projection);
      assert.deepStrictEqual(outsidePage.items, secondPage.items);
      // The ancestry watermark is conservative even when the cutoff excludes new rows.
      assert.notEqual(outside.historyViewRevision, after.historyViewRevision);
      assert.equal(outsidePage.historyViewRevision, outside.historyViewRevision);
      assert.equal(outsidePage.snapshotSequence, before.snapshotSequence);
    }),
  );

  describe.each([
    ["fork", FORK],
    ["long run with a retained interrupt request", LONG],
  ])("%s", (_, threadId) => {
    it.effect("HTTP: legacy, ignored and opted-in requests restore to the same snapshot", () =>
      withHttp(async (get) => {
        const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`;
        const legacyBody = await (await get(base)).text();
        const ignoredBody = await (await get(`${base}?compactTurnItems=yes&unknown=1`)).text();
        const compactResponse = await get(`${base}?compactTurnItems=1`);
        assert.strictEqual(compactResponse.status, 200);
        const compactBody = await compactResponse.text();

        assert.notInclude(legacyBody, "turnItemsOmitLocalVisible");
        assert.strictEqual(ignoredBody, legacyBody);
        assert.isBelow(compactBody.length, legacyBody.length);

        const legacy = decodeBounded(legacyBody);
        const compact = decodeBounded(compactBody);
        assert.isTrue(compact.turnItemsOmitLocalVisible);
        const { turnItemsOmitLocalVisible: _marker, projection: _p, ...compactRest } = compact;
        const { projection: _legacyProjection, ...legacyRest } = legacy;
        assert.deepStrictEqual(compactRest, legacyRest);
        assert.deepStrictEqual(boundedSnapshotProjection(compact), legacy.projection);
        return { legacy, compact };
      }).pipe(
        Effect.tap(({ legacy }) =>
          Effect.sync(() => {
            if (threadId === FORK) {
              const visibility = legacy.projection.visibleTurnItems.map((row) => row.visibility);
              assert.deepStrictEqual(visibility, [
                "inherited",
                "inherited",
                "inherited",
                "synthetic",
                "local",
                "local",
                "local",
                "local",
              ]);
            } else {
              const ids = itemIds(legacy.projection);
              assert.isTrue(legacy.hasMoreHistory);
              assert.strictEqual(ids.at(-1), `turn-item:${LONG}:request`);
              assert.isFalse(
                legacy.projection.visibleTurnItems.some((row) => row.sourceItemId === ids.at(-1)),
              );
            }
          }),
        ),
      ),
    );

    it.effect("HTTP: the ID table is opt-in and decodes to the same snapshot", () =>
      withHttp(async (get) => {
        const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded?compactTurnItems=1`;
        const plainBody = await (await get(base)).text();
        const tableBody = await (await get(`${base}&compactIds=1`)).text();
        const wire = JSON.parse(tableBody);

        assert.notProperty(JSON.parse(plainBody), "ids");
        assert.isArray(wire.ids);
        assert.isNumber(wire.projection.visibleTurnItems[0].item.id);
        assert.isNumber(wire.projection.thread.id);
        assert.isBelow(tableBody.length, plainBody.length);
        const decoded = decodeBounded(tableBody);
        if (threadId === LONG) assert.notProperty(wire, "historyViewRevision");
        assert.deepStrictEqual(decoded, decodeBounded(plainBody));

        // Only the long thread has older history to page.
        if (threadId !== LONG) return;
        assert.isNotNull(decoded.historyCursor);
        const history = `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(decoded.historyCursor ?? "")}`;
        const plainPage = await (await get(history)).text();
        const tablePage = await (await get(`${history}&compactIds=1`)).text();
        assert.isArray(JSON.parse(tablePage).ids);
        const page = decodeHistoryPage(tablePage);
        assert.notProperty(JSON.parse(tablePage), "historyViewRevision");
        assert.isAbove(page.items.length, 0);
        assert.deepStrictEqual(page, decodeHistoryPage(plainPage));
      }),
    );

    it.effect("WS: the ID table is opt-in and decodes to the same snapshot", () =>
      Effect.gen(function* () {
        const input = { threadId, acceptBoundedSnapshot: true, acceptCompactTurnItems: true };
        const plain = yield* firstSnapshot(input);
        const table = yield* firstSnapshot({ ...input, acceptCompactIds: true });

        assert.notProperty(encodeStreamItem(plain.raw), "ids");
        assert.property(encodeStreamItem(table.raw), "ids");
        assert.deepStrictEqual(table.decoded, plain.decoded);
      }),
    );

    it.effect("WS: bounded snapshots stay unchanged unless the client opts in", () =>
      Effect.gen(function* () {
        const legacy = yield* firstSnapshot({ threadId, acceptBoundedSnapshot: true });
        const compact = yield* firstSnapshot({
          threadId,
          acceptBoundedSnapshot: true,
          acceptCompactTurnItems: true,
        });
        const full = yield* firstSnapshot({ threadId, acceptCompactTurnItems: true });

        assert.isUndefined(legacy.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.historyCursor);
        assert.isTrue(compact.decoded.turnItemsOmitLocalVisible);
        assert.isBelow(
          compact.decoded.projection.turnItems.length,
          legacy.decoded.projection.turnItems.length,
        );
        assert.deepStrictEqual(
          boundedSnapshotProjection(compact.decoded),
          legacy.decoded.projection,
        );
        assert.deepStrictEqual(
          {
            ...compact.decoded,
            projection: legacy.decoded.projection,
            turnItemsOmitLocalVisible: undefined,
          },
          { ...legacy.decoded, turnItemsOmitLocalVisible: undefined },
        );
      }),
    );
  });

  describe("deduped bodies", () => {
    const markers = ["textOmitted", "filesOmitted", "promptOmitted", "resultOmitted"];

    it.effect(
      "HTTP: opted-in snapshots blank repeated bodies and restore to the same snapshot",
      () =>
        withHttp(async (get) => {
          const base = `/api/orchestration/threads/${encodeURIComponent(BODIES)}/bounded`;
          const compactBody = await (await get(`${base}?compactTurnItems=1`)).text();
          const dedupedBody = await (await get(`${base}?compactTurnItems=1&dedupeBodies=1`)).text();

          for (const marker of markers) {
            assert.notInclude(compactBody, marker);
            assert.include(dedupedBody, marker);
          }
          assert.isBelow(dedupedBody.length, compactBody.length);
          assert.deepStrictEqual(
            boundedSnapshotProjection(decodeBounded(dedupedBody)),
            boundedSnapshotProjection(decodeBounded(compactBody)),
          );
          // The client sends both opt-ins: bodies restore after the ID table resolves.
          const tabledBody = await (
            await get(`${base}?compactTurnItems=1&dedupeBodies=1&compactIds=1`)
          ).text();
          assert.property(JSON.parse(tabledBody), "ids");
          assert.deepStrictEqual(
            boundedSnapshotProjection(decodeBounded(tabledBody)),
            boundedSnapshotProjection(decodeBounded(compactBody)),
          );
        }),
    );

    it.effect(
      "WS: bounded and full snapshots restore, and the live tail sends each body once",
      () =>
        Effect.gen(function* () {
          const subscribe = (
            input: Partial<Parameters<typeof subscribeOrchestrationV2Thread>[0]>,
          ) =>
            subscribeOrchestrationV2Thread({ threadId: BODIES, ...input }).pipe(
              Effect.flatMap(Stream.runCollect),
              Effect.map((items) =>
                Array.from(items, (item) =>
                  decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(item)))),
                ),
              ),
            );
          const bounded = { acceptBoundedSnapshot: true, acceptCompactTurnItems: true };
          for (const mode of [bounded, {}]) {
            const [plainSnapshot, ...plainTail] = yield* subscribe(mode);
            const [dedupedSnapshot, ...dedupedTail] = yield* subscribe({
              ...mode,
              acceptDedupedBodies: true,
            });
            if (plainSnapshot?.kind !== "snapshot" || dedupedSnapshot?.kind !== "snapshot") {
              throw new Error("No snapshot");
            }
            assert.deepStrictEqual(
              boundedSnapshotProjection(dedupedSnapshot),
              boundedSnapshotProjection(plainSnapshot),
            );
            const payloads = (tail: typeof plainTail) =>
              tail.map((item) => (item.kind === "event" ? item.event.payload : null));
            const [reply, replyItem, progress] = payloads(plainTail);
            assert.deepStrictEqual(payloads(dedupedTail), [
              reply,
              { ...replyItem, text: "", textOmitted: true },
              // The snapshot delivered this subagent's record, so its unchanged bodies repeat.
              { ...progress, prompt: "", promptOmitted: true, result: null, resultOmitted: true },
            ]);
          }
        }),
    );
  });
});
