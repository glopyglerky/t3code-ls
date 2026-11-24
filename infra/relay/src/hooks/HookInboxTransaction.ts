import * as Effect from "effect/Effect";

/** SQLite storage includes direct SQL and alarms in the same transaction. */
export const commitStorage = Effect.fn("HookInboxObject.commitStorage")(function* <A, E, R>(
  storage: Pick<DurableObjectStorage, "transaction">,
  effect: Effect.Effect<A, E, R>,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<R>());
  return yield* Effect.promise((signal) =>
    storage.transaction(() => runPromise(effect, { signal })),
  );
});

interface Alarm<E, R> {
  readonly get: () => Effect.Effect<number | null, E, R>;
  readonly set: (at: number) => Effect.Effect<unknown, E, R>;
}

export const scheduleBy = Effect.fn("HookInboxObject.scheduleBy")(function* <E, R>(
  alarm: Alarm<E, R>,
  at: number,
) {
  const current = yield* alarm.get();
  if (current === null || current > at) yield* alarm.set(at);
});

/** Keep the production hold, target update and alarm publication under one owner. */
export const commitHold = <E, R, EA, RA>(
  storage: Pick<DurableObjectStorage, "transaction">,
  hold: Effect.Effect<number | null, E, R>,
  alarm: Alarm<EA, RA>,
) => commitStorage(storage, Effect.gen(function* () {
  const dueAt = yield* hold;
  yield* Effect.annotateCurrentSpan({ "relay.inbox.stored": dueAt !== null });
  if (dueAt === null) return false;
  yield* scheduleBy(alarm, dueAt);
  return true;
}));
