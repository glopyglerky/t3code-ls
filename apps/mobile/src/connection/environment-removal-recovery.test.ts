import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Persistence, EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential, BearerConnectionProfile, BearerConnectionRegistration,
  BearerConnectionTarget, RelayConnectionRegistration, RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(), getItemAsync: vi.fn(), setItemAsync: vi.fn(),
}));

import * as SecureStorage from "../persistence/mobile-secure-storage";
import * as Catalog from "./catalog-store";
import * as Storage from "./storage";
import { MobileEnvironmentDataCleanup } from "./environment-owned-data-cleanup";
import { makeEnvironmentRemovalRecovery } from "./environment-removal-recovery";

const removed = EnvironmentId.make("fixture-removed");
const kept = EnvironmentId.make("fixture-kept");
const registration = (environmentId: EnvironmentId) => new RelayConnectionRegistration({
  target: new RelayConnectionTarget({ environmentId, label: "Fixture environment" }),
});

function memoryStorage() {
  const values = new Map<string, string>();
  let failWrite = false;
  const storage = SecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) => Effect.suspend(() => failWrite
      ? Effect.fail(new SecureStorage.MobileSecureStorageError({ operation: "write", key, cause: "fixture unavailable" }))
      : Effect.sync(() => { values.set(key, value); })),
    removeItem: (key) => Effect.sync(() => { values.delete(key); }),
  });
  return { values, storage, failWrites: (fail: boolean) => { failWrite = fail; } };
}

function openStorage(memory: ReturnType<typeof memoryStorage>, clear: (environmentId: EnvironmentId) => Effect.Effect<void, Persistence.ConnectionPersistenceError>) {
  return Effect.gen(function* () {
    const context = yield* Layer.build(Storage.layer.pipe(
      Layer.provide(Layer.succeed(SecureStorage.MobileSecureStorage, memory.storage)),
      Layer.provide(Layer.succeed(MobileEnvironmentDataCleanup, { clear })),
    ));
    return {
      registrations: Context.get(context, Persistence.ConnectionRegistrationStore),
      targets: Context.get(context, Persistence.ConnectionTargetStore),
      cleanup: Context.get(context, Persistence.EnvironmentOwnedDataCleanup),
    };
  });
}

const failedCleanup = () => new Persistence.ConnectionPersistenceError({
  operation: "clear-environment", message: "Fixture cleanup unavailable.",
});

describe("mobile durable environment removal", () => {
  it.effect("retains a failed removal and resumes it before a fresh storage instance can relink", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      const data = new Map([[removed, ["old queued message", "old draft"]], [kept, ["kept queued message", "kept draft"]]]);
      let refuse = true;
      let attempts = 0;
      const clear = (environmentId: EnvironmentId) => Effect.suspend(() => {
        attempts += 1;
        return refuse ? Effect.fail(failedCleanup()) : Effect.sync(() => { data.delete(environmentId); });
      });
      const first = yield* openStorage(memory, clear);
      yield* first.registrations.register(registration(removed), []);
      yield* first.registrations.register(registration(kept), []);
      yield* first.registrations.remove(removed);
      expect((yield* first.targets.list).map((target) => target.environmentId)).toEqual([kept]);
      expect(Exit.isFailure(yield* Effect.exit(first.cleanup.clear(removed)))).toBe(true);
      const pending = JSON.parse(memory.values.get(Catalog.CONNECTION_CATALOG_KEY)!);
      expect(pending.environmentRemovals.pending).toEqual([{ environmentId: removed, sequence: 1 }]);

      const blocked = yield* openStorage(memory, clear);
      expect(Exit.isFailure(yield* Effect.exit(blocked.registrations.register(registration(removed), [])))).toBe(true);
      expect(data.get(removed)).toEqual(["old queued message", "old draft"]);
      refuse = false;
      const reopened = yield* openStorage(memory, clear);
      expect(data.has(removed)).toBe(false);
      expect(data.get(kept)).toEqual(["kept queued message", "kept draft"]);
      expect(JSON.parse(memory.values.get(Catalog.CONNECTION_CATALOG_KEY)!).environmentRemovals.pending).toEqual([]);
      yield* reopened.registrations.register(registration(removed), []);
      data.set(removed, ["new linked draft"]);
      const completedAttempts = attempts;
      yield* reopened.cleanup.clear(removed);
      expect(data.get(removed)).toEqual(["new linked draft"]);
      expect(attempts).toBe(completedAttempts);
    }).pipe(Effect.scoped),
  );

  it.effect("does not run destructive cleanup when the secure removal write fails", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      let cleaned = false;
      const store = yield* openStorage(memory, () => Effect.sync(() => { cleaned = true; }));
      yield* store.registrations.register(new BearerConnectionRegistration({
        target: new BearerConnectionTarget({ environmentId: removed, label: "Fixture", connectionId: "fixture-connection" }),
        profile: new BearerConnectionProfile({
          connectionId: "fixture-connection", environmentId: removed, label: "Fixture",
          httpBaseUrl: "https://fixture.invalid", wsBaseUrl: "wss://fixture.invalid",
        }),
        credential: new BearerConnectionCredential({ token: "synthetic-fixture-only" }),
      }), []);
      const before = memory.values.get(Catalog.CONNECTION_CATALOG_KEY);
      memory.failWrites(true);
      expect(Exit.isFailure(yield* Effect.exit(store.registrations.remove(removed)))).toBe(true);
      expect(memory.values.get(Catalog.CONNECTION_CATALOG_KEY)).toBe(before);
      expect((yield* store.targets.list).map((target) => target.environmentId)).toEqual([removed]);
      expect(cleaned).toBe(false);
      memory.failWrites(false);
      yield* store.registrations.remove(removed);
      const removedCatalog = JSON.parse(memory.values.get(Catalog.CONNECTION_CATALOG_KEY)!);
      expect(removedCatalog.credentials).toEqual([]);
      expect(removedCatalog.profiles).toEqual([]);
      expect(removedCatalog.environmentRemovals.pending).toEqual([{ environmentId: removed, sequence: 1 }]);
    }).pipe(Effect.scoped),
  );

  it.effect("serializes relink behind the old cleanup and preserves data written by the new link", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const data = new Map([[removed, "old queued message"]]);
      const store = yield* openStorage(memory, (environmentId) => Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        data.delete(environmentId);
      }));
      yield* store.registrations.register(registration(removed), []);
      yield* store.registrations.remove(removed);
      const cleanup = yield* Effect.forkChild(store.cleanup.clear(removed));
      yield* Deferred.await(started);
      const relink = yield* Effect.forkChild(store.registrations.register(registration(removed), []).pipe(
        Effect.andThen(Effect.sync(() => { data.set(removed, "new linked message"); })),
      ));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cleanup);
      yield* Fiber.join(relink);
      expect(data.get(removed)).toBe("new linked message");
      expect((yield* store.targets.list).map((target) => target.environmentId)).toEqual([removed]);
    }).pipe(Effect.scoped),
  );

  it.effect("a delayed receipt cannot settle a newer removal or clear a relinked environment", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      const catalog = yield* Catalog.make().pipe(Effect.provideService(SecureStorage.MobileSecureStorage, memory.storage));
      let cleared = 0;
      const recovery = yield* makeEnvironmentRemovalRecovery(catalog).pipe(
        Effect.provideService(MobileEnvironmentDataCleanup, { clear: () => Effect.sync(() => { cleared += 1; }) }),
      );
      yield* catalog.update(() => ({ ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        environmentRemovals: { sequence: 2, pending: [{ environmentId: removed, sequence: 2 }] },
      }));
      yield* recovery.settle({ environmentId: removed, sequence: 1 });
      expect(cleared).toBe(0);
      expect((yield* catalog.read).environmentRemovals?.pending[0]?.sequence).toBe(2);
      yield* catalog.update((document) => ({ ...document, targets: [registration(removed).target] }));
      yield* recovery.settle({ environmentId: removed, sequence: 2 });
      expect(cleared).toBe(0);
      expect((yield* catalog.read).targets[0]?.environmentId).toBe(removed);
    }).pipe(Effect.scoped),
  );
});
