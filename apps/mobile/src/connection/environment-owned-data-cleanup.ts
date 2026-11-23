import type { EnvironmentId } from "@t3tools/contracts";
import { Persistence } from "@t3tools/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** The storage owner requires the real data owners before it can settle a removal. */
export class MobileEnvironmentDataCleanup extends Context.Service<
  MobileEnvironmentDataCleanup,
  { readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void, Persistence.ConnectionPersistenceError> }
>()("mobile/connection/MobileEnvironmentDataCleanup") {}

export const clearEnvironmentOwnedData = Effect.fn("mobile.clearEnvironmentOwnedData")(
  function* (
    environmentId: EnvironmentId,
    cleanup: {
      readonly clearOutbox: (environmentId: EnvironmentId) => Promise<void>;
      readonly clearDrafts: (environmentId: EnvironmentId) => Promise<void>;
      readonly clearErrors: (environmentId: EnvironmentId) => void;
    },
  ) {
    const failed = (data: string) => new Persistence.ConnectionPersistenceError({
      operation: "clear-environment",
      message: `The environment was removed, but its ${data} could not be cleared from this device.`,
    });
    const results = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => cleanup.clearOutbox(environmentId),
          catch: () => failed("queued messages"),
        }),
        Effect.tryPromise({
          try: () => cleanup.clearDrafts(environmentId),
          catch: () => failed("drafts"),
        }),
        Effect.try({
          try: () => cleanup.clearErrors(environmentId),
          catch: () => failed("composer errors"),
        }),
      ].map((clear) => Effect.exit(clear)),
      { concurrency: "unbounded" },
    );
    for (const result of results) {
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
    }
  },
);
