import { RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RedbClient } from "../persistence/RedbClient.ts";
import * as NativeProjectionCommitStore from "../persistence/NativeProjectionCommitStore.ts";
import * as NativeProjectionLookupRows from "./NativeProjectionLookupRows.ts";
import { ProjectionLookupResult } from "./ProjectionLookupRows.ts";
import * as NativeProjectionControlRows from "./NativeProjectionControlRows.ts";
import * as NativeProjectionContextRows from "./NativeProjectionContextRows.ts";
import * as NativeProjectionRecordRows from "./NativeProjectionRecordRows.ts";
import * as NativeProjectionRecoveryRows from "./NativeProjectionRecoveryRows.ts";
import * as NativeProjectionShellRows from "./NativeProjectionShellRows.ts";
import * as NativeThreadFind from "./NativeThreadFind.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreApplyEventError,
  ProjectionStoreReadError,
  ProjectionStoreSetupError,
  ProjectionStoreThreadNotFoundError,
  makeProjectionLookups,
  makeRunProviderRecords,
  makeProjectionControls,
  makeProjectionContexts,
  makeProjectionRecovery,
  type ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

/** One complete application projection boundary; every operation uses the same native owner. */
export const make = Effect.gen(function* () {
  const client = yield* RedbClient;
  while (!(yield* client.prepareOutbox).prepared) yield* Effect.yieldNow;
  while (!(yield* client.prepareAuxiliary).prepared) yield* Effect.yieldNow;
  const writer = yield* NativeProjectionCommitStore.make;
  const lookups = makeProjectionLookups(yield* NativeProjectionLookupRows.makeRows);
  const { requireThread: _requireThread, ...publicLookups } = lookups;
  const readTimeline = yield* NativeProjectionRecordRows.makeTimelineIndex;
  const find = yield* NativeThreadFind.make((threadId) =>
    readTimeline(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
  );
  const getThreadRecords = yield* NativeProjectionRecordRows.make;
  const getRunProviderRecords = makeRunProviderRecords(
    getThreadRecords,
    client.withReadTransaction,
  );
  const getRunCardRecords: ProjectionStoreV2Shape["getRunCardRecords"] = Effect.fn(
    "ProjectionStore.getRunCardRecords",
  )(
    function* (threadId, runId, nodeId, cardType) {
      const records = yield* getRunProviderRecords(threadId, runId, nodeId);
      const { turnItems } = yield* getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: [cardType],
      });
      return { ...records, turnItems };
    },
    (effect, threadId) =>
      client
        .withReadTransaction(effect)
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(ProjectionStoreThreadNotFoundError)(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        ),
  );
  const getDelegatedChildControls: ProjectionStoreV2Shape["getDelegatedChildControls"] = Effect.fn(
    "ProjectionStore.getDelegatedChildControls",
  )(
    function* (threadId, { taskIds, windowSize }) {
      const records = yield* getThreadRecords(
        threadId,
        ["messages", "subagents", "providerThreads"],
        { messageRoles: ["user"], delegatedTaskMessagesOnly: true },
      );
      const selection = yield* client.request(
        "application_projections_lookup",
        {
          query: {
            kind: "delegated_child_runs",
            thread_id: threadId,
            task_ids: taskIds,
            window_size: windowSize,
          },
        },
        Schema.Struct({
          ...ProjectionLookupResult.fields,
          ids: Schema.Array(RunId),
          floor_run_id: Schema.optional(RunId),
        }),
      );
      const selected = yield* getThreadRecords(threadId, ["runs"], { runIds: selection.ids });
      const runs = new Map(selected.runs.map((run) => [run.id, run]));
      const requested = new Set(selection.ids);
      const wakes = Map.groupBy(
        records.messages.filter((message) => message.delegatedCompletion !== undefined),
        (message) => message.delegatedCompletion?.parentRunId,
      );
      let parents = selected.runs.map((run) => run.id);
      while (parents.length > 0) {
        const wakeIds: RunId[] = [];
        for (const parent of parents) {
          for (const message of wakes.get(parent) ?? []) {
            if (message.runId === null || requested.has(message.runId)) continue;
            requested.add(message.runId);
            wakeIds.push(message.runId);
          }
        }
        if (wakeIds.length === 0) break;
        const { runs: found } = yield* getThreadRecords(threadId, ["runs"], { runIds: wakeIds });
        for (const run of found) runs.set(run.id, run);
        parents = found.map((run) => run.id);
      }
      return {
        ...records,
        runs: [...runs.values()].toSorted((a, b) => a.ordinal - b.ordinal),
        runsFloor:
          selection.floor_run_id === undefined ? undefined : runs.get(selection.floor_run_id),
      };
    },
    (effect, threadId) =>
      client
        .withReadTransaction(effect)
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(ProjectionStoreThreadNotFoundError)(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        ),
  );
  return {
    ...publicLookups,
    getRunProviderRecords,
    getRunCardRecords,
    getDelegatedChildControls,
    ...makeProjectionControls(yield* NativeProjectionControlRows.makeRows, lookups),
    ...makeProjectionContexts(yield* NativeProjectionContextRows.make, lookups),
    ...makeProjectionRecovery(yield* NativeProjectionRecoveryRows.make),
    ...(yield* NativeProjectionShellRows.make),
    ...(yield* NativeProjectionRecordRows.makeSnapshots),
    ...(yield* NativeProjectionRecordRows.makeTimelinePages),
    ...find,
    getThreadRecords,
    apply: (event) =>
      writer
        .apply(event)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectionStoreApplyEventError({ eventType: event.type, cause }),
          ),
        ),
  } satisfies ProjectionStoreV2Shape;
}).pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

export const layer = Layer.effect(ProjectionStoreV2, make);
