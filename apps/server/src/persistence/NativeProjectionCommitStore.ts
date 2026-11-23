import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunJson,
  OrchestrationV2RuntimeRequestJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ProjectionCommitStore,
  ProjectionCommitStoreError,
  applyWithThreadLinkNormalization,
  toProjectionCommitStoreError,
  userInputRequestMatchesCancellation,
  type ProjectionCommitStoreShape,
} from "../orchestration-v2/ProjectionCommitStore.ts";
import { RedbClient } from "./RedbClient.ts";

const encodeEvent = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeProjectionApply = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
  const encoded = yield* encodeEvent(event);
  return {
    event_type: encoded.type,
    thread_id: encoded.threadId,
    occurred_at: encoded.occurredAt,
    payload_json: yield* encodeJson(encoded.payload),
  };
});
const MAX_PROJECTION_BATCH_EVENTS = 16;
const MAX_PROJECTION_BATCH_BYTES = 256 * 1024;
const encodeTime = Schema.encodeEffect(Schema.DateTimeUtcFromString);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);
const UserInputCancellation = Schema.NullOr(
  Schema.Struct({ eligible: Schema.NullOr(Schema.Boolean), payload_json: Schema.String }),
);
const ThreadPayload = Schema.fromJsonString(OrchestrationV2AppThreadJson);
const TurnPayload = Schema.fromJsonString(OrchestrationV2ProviderTurnJson);
const Normalization = Schema.NullOr(
  Schema.Struct({
    kind: Schema.Literals(["thread", "provider_turn"]),
    payload_json: Schema.String,
  }),
);

export const make = Effect.gen(function* () {
  const client = yield* RedbClient;
  while (!(yield* client.prepareProjections).prepared) yield* Effect.yieldNow;
  type ApplyInput = Effect.Success<ReturnType<typeof encodeProjectionApply>>;
  const applyOne = (event: ApplyInput) =>
    client.request("application_projections_apply", { event }, Schema.Null).pipe(Effect.asVoid);
  const store: Omit<ProjectionCommitStoreShape, "applyMany"> = {
    apply: Effect.fnUntraced(
      function* (event) {
        const input = yield* encodeProjectionApply(event);
        if (event.type !== "provider-thread.updated" && event.type !== "provider-turn.updated") {
          return yield* applyOne(input);
        }
        yield* client.withTransaction(
          Effect.gen(function* () {
            const context = yield* client.request(
              "application_projections_normalization",
              { event: input },
              Normalization,
            );
            if (context === null) {
              return yield* applyOne(input);
            }
            // This is the same codec round trip performed by the SQLite writer.
            // Rust chooses the old row and owns every merge and column mutation.
            const payloadJson =
              context.kind === "thread"
                ? yield* Schema.decodeEffect(ThreadPayload)(context.payload_json).pipe(
                    Effect.flatMap(Schema.encodeEffect(ThreadPayload)),
                  )
                : yield* Schema.decodeEffect(TurnPayload)(context.payload_json).pipe(
                    Effect.flatMap(Schema.encodeEffect(TurnPayload)),
                  );
            yield* client.request(
              "application_projections_apply",
              {
                event: {
                  ...input,
                  normalization: {
                    expected_payload_json: context.payload_json,
                    payload_json: payloadJson,
                  },
                },
              },
              Schema.Null,
            );
          }),
        );
      },
      Effect.mapError(toProjectionCommitStoreError("apply")),
    ),
    getThread: Effect.fnUntraced(
      function* (threadId) {
        const payload = yield* client.request(
          "application_projections_read",
          {
            read: { kind: "thread", thread_id: threadId },
          },
          Schema.NullOr(Schema.String),
        );
        return payload === null ? undefined : yield* decodeThread(payload);
      },
      Effect.mapError(toProjectionCommitStoreError("get-thread")),
    ),
    getRun: Effect.fnUntraced(
      function* (threadId, runId) {
        return yield* client.withTransaction(
          Effect.gen(function* () {
            // getThreadRecords decodes its owner even when the selected run is absent.
            const owner = yield* client.request(
              "application_projections_read",
              {
                read: { kind: "thread", thread_id: threadId },
              },
              Schema.NullOr(Schema.String),
            );
            if (owner === null) {
              return yield* new ProjectionCommitStoreError({
                operation: "get-run",
                cause: `No orchestration projection exists for thread ${threadId}.`,
              });
            }
            yield* decodeThread(owner);
            const payload = yield* client.request(
              "application_projections_read",
              {
                read: { kind: "run", thread_id: threadId, record_id: runId },
              },
              Schema.NullOr(Schema.String),
            );
            return payload === null ? undefined : yield* decodeRun(payload);
          }),
        );
      },
      Effect.mapError(toProjectionCommitStoreError("get-run")),
    ),
    userInputCancellationCurrent: Effect.fnUntraced(
      function* ({ threadId, requestId, providerTurnId }) {
        const result = yield* client.request(
          "application_projections_user_input_cancellation",
          {
            thread_id: threadId,
            request_id: requestId,
            provider_turn_id: providerTurnId,
          },
          UserInputCancellation,
        );
        if (result === null) return false;
        // Keep the existing full validation of a selected historical row.
        const request = yield* decodeRequest(result.payload_json);
        return result.eligible ?? userInputRequestMatchesCancellation(request, providerTurnId);
      },
      Effect.mapError(toProjectionCommitStoreError("get-runtime-request")),
    ),
    markApplied: Effect.fnUntraced(
      function* (sequence, updatedAt) {
        yield* client.request(
          "application_projections_mark_applied",
          {
            sequence,
            updated_at: yield* encodeTime(updatedAt),
          },
          Schema.Null,
        );
      },
      Effect.mapError(toProjectionCommitStoreError("mark-applied")),
    ),
    nativeThreadOwned: (input) =>
      input.nativeThreadRef === null
        ? Effect.succeed(false)
        : client
            .request(
              "application_projections_guard",
              {
                guard: {
                  kind: "native_thread_owned",
                  driver: input.driver,
                  provider_instance_id: input.providerInstanceId,
                  native_id: input.nativeThreadRef.nativeId,
                  app_thread_id: input.appThreadId,
                },
              },
              Schema.Boolean,
            )
            .pipe(Effect.mapError(toProjectionCommitStoreError("native-thread-owned"))),
    runCurrent: (input) =>
      client
        .request(
          "application_projections_guard",
          {
            guard: {
              kind: "run_current",
              thread_id: input.threadId,
              run_id: input.runId,
              active_attempt_id: input.activeAttemptId,
              status: input.expectedStatus,
            },
          },
          Schema.Boolean,
        )
        .pipe(Effect.mapError(toProjectionCommitStoreError("run-current"))),
    providerThreadOwner: (input) =>
      client
        .request(
          "application_projections_guard",
          {
            guard: {
              kind: "provider_thread_owner",
              provider_thread_id: input.providerThreadId,
              run_id: input.runId,
              active_attempt_id: input.activeAttemptId,
              expected_last_run_ordinal: input.expectedLastRunOrdinal,
            },
          },
          Schema.Boolean,
        )
        .pipe(Effect.mapError(toProjectionCommitStoreError("provider-thread-owner"))),
    providerThreadUnchanged: (providerThreadId, expectedJson) =>
      client
        .request(
          "application_projections_guard",
          {
            guard: {
              kind: "provider_thread_unchanged",
              provider_thread_id: providerThreadId,
              expected_json: expectedJson,
            },
          },
          Schema.Boolean,
        )
        .pipe(Effect.mapError(toProjectionCommitStoreError("provider-thread-unchanged"))),
    turnItemUnchanged: (turnItemId, expectedJson) =>
      client
        .request(
          "application_projections_guard",
          {
            guard: {
              kind: "turn_item_unchanged",
              turn_item_id: turnItemId,
              expected_json: expectedJson,
            },
          },
          Schema.Boolean,
        )
        .pipe(Effect.mapError(toProjectionCommitStoreError("turn-item-unchanged"))),
    interruptPending: (input) =>
      client
        .request(
          "application_projections_guard",
          {
            guard: {
              kind: "interrupt_pending",
              thread_id: input.threadId,
              request_id: input.requestId,
              result_id: input.resultId,
            },
          },
          Schema.Boolean,
        )
        .pipe(Effect.mapError(toProjectionCommitStoreError("interrupt-pending"))),
  };
  const normalizedApply = applyWithThreadLinkNormalization(store);
  // Thread-link normalization reads before it writes. Standalone calls need the same
  // writer reservation that EventSink already owns for its full commit.
  const apply = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (event.type !== "thread.pull-request-link-updated") return yield* store.apply(event);
    yield* client
      .withTransaction(normalizedApply(event))
      .pipe(Effect.mapError(toProjectionCommitStoreError("apply")));
  });
  return ProjectionCommitStore.of({
    ...store,
    apply,
    applyMany: Effect.fnUntraced(function* (events) {
      let pending: ApplyInput[] = [];
      let pendingBytes = 0;
      const flush = Effect.suspend(() => {
        const batch = pending;
        pending = [];
        pendingBytes = 0;
        if (batch.length === 0) return Effect.void;
        if (batch.length === 1) return applyOne(batch[0]!);
        return client.request("application_projections_apply_many", { events: batch }, Schema.Null);
      });
      for (const event of events) {
        if (
          event.type === "provider-thread.updated" ||
          event.type === "provider-turn.updated" ||
          event.type === "thread.pull-request-link-updated"
        ) {
          yield* flush;
          yield* apply(event);
          continue;
        }
        const encoded = yield* encodeProjectionApply(event);
        const bytes =
          encoded.payload_json.length >= MAX_PROJECTION_BATCH_BYTES
            ? MAX_PROJECTION_BATCH_BYTES + 1
            : Buffer.byteLength(yield* encodeJson(encoded)) + 1;
        if (bytes > MAX_PROJECTION_BATCH_BYTES) {
          yield* flush;
          yield* applyOne(encoded);
          continue;
        }
        if (
          pending.length === MAX_PROJECTION_BATCH_EVENTS ||
          pendingBytes + bytes > MAX_PROJECTION_BATCH_BYTES
        ) {
          yield* flush;
        }
        pending.push(encoded);
        pendingBytes += bytes;
      }
      yield* flush;
    }, Effect.mapError(toProjectionCommitStoreError("apply"))),
  });
});

export const layer = Layer.effect(ProjectionCommitStore, make);
