import type { EnvironmentId } from "@t3tools/contracts";
import { type ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";

import type { CatalogStore } from "./catalog-store";
import { MobileEnvironmentDataCleanup } from "./environment-owned-data-cleanup";

type PendingRemoval = NonNullable<ConnectionCatalogDocument["environmentRemovals"]>["pending"][number];

export const reserveEnvironmentRemoval = Effect.fn("mobile.reserveEnvironmentRemoval")(
  function* (document: ConnectionCatalogDocument, environmentId: EnvironmentId) {
    const removals = document.environmentRemovals ?? { sequence: 0, pending: [] };
    if (removals.pending.some((removal) => removal.environmentId === environmentId)) return document;
    if (removals.sequence === Number.MAX_SAFE_INTEGER) {
      return yield* new ConnectionTransientError({
        reason: "remote-unavailable", detail: "The local environment removal sequence is exhausted.",
      });
    }
    const sequence = removals.sequence + 1;
    return { ...document, environmentRemovals: {
      sequence,
      pending: [...removals.pending, { environmentId, sequence }],
    } };
  },
);

export const makeEnvironmentRemovalRecovery = Effect.fn("mobile.makeEnvironmentRemovalRecovery")(
  function* (catalog: CatalogStore) {
    const ownedData = yield* MobileEnvironmentDataCleanup;
    const settle = Effect.fn("mobile.settleEnvironmentRemoval")((removal: PendingRemoval) =>
      catalog.updateEffect((document) => {
        const removals = document.environmentRemovals;
        const pending = removals?.pending ?? [];
        if (removals === undefined || document.targets.some((target) => target.environmentId === removal.environmentId) ||
          !pending.some((candidate) => candidate.environmentId === removal.environmentId && candidate.sequence === removal.sequence)) {
          return Effect.succeed(document);
        }
        // Keep the catalog lock while the old owners delete, so a new link cannot install midway.
        return ownedData.clear(removal.environmentId).pipe(Effect.as({
          ...document,
          environmentRemovals: {
            sequence: removals.sequence,
            pending: pending.filter((candidate) => candidate.environmentId !== removal.environmentId || candidate.sequence !== removal.sequence),
          },
        }));
      }),
    );
    const recover = Effect.fn("mobile.recoverEnvironmentRemoval")(function* (environmentId: EnvironmentId) {
      const removal = (yield* catalog.read).environmentRemovals?.pending.find((candidate) => candidate.environmentId === environmentId);
      if (removal !== undefined) yield* settle(removal);
    });
    const clear = Effect.fn("mobile.clearRemovedEnvironmentData")(function* (environmentId: EnvironmentId) {
      yield* catalog.updateEffect((document) =>
        document.targets.some((target) => target.environmentId === environmentId)
          ? Effect.succeed(document)
          : reserveEnvironmentRemoval(document, environmentId),
      );
      yield* recover(environmentId);
    });
    const beforeRegister = Effect.fn("mobile.completeRemovalBeforeRelink")((environmentId: EnvironmentId) =>
      recover(environmentId).pipe(Effect.mapError(() => new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "Local environment removal is still pending. Its queued messages and drafts must be cleared before reconnecting.",
      }))),
    );
    const pending = (yield* catalog.read).environmentRemovals?.pending ?? [];
    yield* Effect.forEach(pending, (removal) => settle(removal).pipe(
      Effect.catch((error) => Effect.logWarning("Could not finish local environment removal after reopen.", {
        environmentId: removal.environmentId,
        error,
      })),
    ), { discard: true });
    return {
      beforeRegister,
      settle,
      clear: (environmentId: EnvironmentId) => clear(environmentId).pipe(Effect.mapError((error) =>
        new Persistence.ConnectionPersistenceError({ operation: "clear-environment", message: error.message }),
      )),
    };
  },
);
