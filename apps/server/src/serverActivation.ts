import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

export class StagedCandidateReadinessError extends Schema.TaggedError<StagedCandidateReadinessError>()(
  "StagedCandidateReadinessError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The staged server candidate was not admitted.";
  }
}

/** Internal stage-owner contract, supplied after isolated verification.
 * The launcher and CLI do not select this preparation route yet. */
export class StagedCandidateStartup extends Context.Reference<{
  readonly inspect: Effect.Effect<void, StagedCandidateReadinessError>;
  readonly reportPrepared: Effect.Effect<void, StagedCandidateReadinessError>;
  readonly awaitAdmission: Effect.Effect<void, StagedCandidateReadinessError>;
} | undefined>("t3/stagedCandidateStartup", { defaultValue: () => undefined }) {}

/** Gate before constructing server layers, whose startup and finalizers can change durable state. */
export const afterStagedCandidateReadiness = Effect.fn("serverActivation.afterStagedCandidateReadiness")(
  function* <A, E, R>(start: Effect.Effect<A, E, R>) {
    const stage = yield* StagedCandidateStartup;
    if (stage !== undefined) {
      yield* stage.inspect;
      yield* stage.reportPrepared;
      yield* stage.awaitAdmission;
    }
    return yield* start;
  },
);

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

export const forkParkedFiber = Effect.fn("serverActivation.forkParkedFiber")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<Fiber.Fiber<A, E>, never, Scope.Scope | R> {
  const activation = yield* ServerActivation;
  if (activation === undefined) {
    return yield* Effect.forkScoped(effect);
  }
  const parked = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkScoped(
    Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
  );
  yield* Deferred.await(parked);
  return fiber;
});

export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);
