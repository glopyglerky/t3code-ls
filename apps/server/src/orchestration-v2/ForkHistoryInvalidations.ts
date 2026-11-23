import type { OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { EventSinkV2 } from "./EventSink.ts";
import { inheritedRunFork, type ProjectionStoreV2 } from "./ProjectionStore.ts";

const MAX_SOURCES = 32;
const MAX_PENDING_RUNS = 64;
const COALESCE_WINDOW = "50 millis";

/** Undefined means the event does not affect the inherited turn-item projection. */
function historyRun(event: OrchestrationV2DomainEvent): RunId | null | undefined {
  switch (event.type) {
    case "turn-item.updated":
    case "run-attempt.created":
    case "run-attempt.updated":
      return event.payload.runId;
    case "run.created":
    case "run.updated":
      return event.payload.id;
    default:
      return undefined;
  }
}

export const watchForkHistory = Effect.fn("ForkHistoryInvalidations.watch")(
  function* (
    threadId: ThreadId,
    projections: Pick<ProjectionStoreV2["Service"], "getThread" | "getRun">,
    events: Pick<EventSinkV2["Service"], "observeCommittedThreadEvents">,
  ) {
    const readThread = (id: ThreadId) =>
      projections.getThread(id).pipe(
        Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)),
      );
    let thread = yield* readThread(threadId);
    if (thread === null || thread.deletedAt !== null) return null;

    const sources = new Map<ThreadId, { readonly cutoff: RunId; readonly imported: boolean }>();
    while (sources.size < MAX_SOURCES) {
      const fork = inheritedRunFork(thread);
      if (fork === null || fork.threadId === threadId || sources.has(fork.threadId)) break;
      const parent = yield* readThread(fork.threadId);
      if (parent === null) break;
      sources.set(fork.threadId, {
        cutoff: fork.runId,
        imported: parent.historyOrigin === "v1_import",
      });
      thread = parent;
    }
    if (sources.size === 0) return null;

    const wake = yield* Queue.sliding<void>(1);
    let pending = new Map<ThreadId, Set<RunId>>();
    let pendingCount = 0;
    let dirty = false;
    const observers = new Map<ThreadId, (event: OrchestrationV2DomainEvent) => void>();
    for (const [sourceId, source] of sources) {
      observers.set(sourceId, (event) => {
        if (dirty) return;
        const runId = historyRun(event);
        if (runId === undefined || (runId === null && !source.imported)) return;
        if (runId === null || runId === source.cutoff) {
          dirty = true;
        } else {
          const runs = pending.get(sourceId) ?? new Set<RunId>();
          if (runs.has(runId)) return;
          if (pendingCount === MAX_PENDING_RUNS) {
            // A full mailbox conservatively reloads the bounded child view.
            dirty = true;
          } else {
            runs.add(runId);
            pending.set(sourceId, runs);
            pendingCount += 1;
          }
        }
        Queue.offerUnsafe(wake, undefined);
      });
    }
    yield* events.observeCommittedThreadEvents(observers);

    return Stream.fromEffectRepeat(
      Effect.gen(function* () {
        yield* Queue.take(wake);
        yield* Effect.sleep(COALESCE_WINDOW);
        yield* Queue.clear(wake);
        const runsBySource = pending;
        const needsRefresh = dirty;
        pending = new Map();
        pendingCount = 0;
        dirty = false;
        if (needsRefresh) return true;

        for (const [sourceId, runIds] of runsBySource) {
          const source = sources.get(sourceId);
          if (source === undefined) continue;
          const cutoff = yield* projections.getRun(sourceId, source.cutoff);
          if (cutoff === undefined) continue;
          for (const runId of runIds) {
            const run = yield* projections.getRun(sourceId, runId);
            if (run !== undefined && run.ordinal <= cutoff.ordinal) return true;
          }
        }
        return false;
      }),
    ).pipe(
      Stream.filter((changed) => changed),
      Stream.map(() => ({ kind: "history-invalidated" as const })),
    );
  },
);
