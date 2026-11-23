import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const { openDatabaseAsync, secureValues, getItemAsync, setItemAsync, deleteItemAsync } =
  vi.hoisted(() => {
    const secureValues = new Map<string, string>();
    return {
      openDatabaseAsync: vi.fn(),
      secureValues,
      getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
      setItemAsync: vi.fn(async (key: string, value: string) => {
        secureValues.set(key, value);
      }),
      deleteItemAsync: vi.fn(async (key: string) => {
        secureValues.delete(key);
      }),
    };
  });

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("expo-secure-store", () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

async function sqliteDatabase(path = ":memory:") {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA user_version = 1");
  const database = {
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    runAsync: vi.fn(async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).run(...args),
    ),
    getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).get(...args),
    getAllAsync: async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
      await run(database);
    },
    closeAsync: async () => {
      sqlite.close();
    },
  };
  openDatabaseAsync.mockResolvedValueOnce(database);
  return { sqlite, runAsync: database.runAsync };
}

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
        "None",
      );
      expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
        "Some",
      );
    }),
  );
});

describe("mobile preferences recovery", () => {
  const fallbackKey = "t3code.preferences.fallback";
  const preferences = {
    language: "fr",
    themeMode: "dark",
    workspaceSelections: {
      threads: { environmentId: "fixture-environment", threadId: "fixture-thread" },
      settings: "appearance",
    },
  } as const;
  const preferencesLayer = MobilePreferences.layer.pipe(
    Layer.provide(Layer.merge(MobileDatabase.layer, MobileSecureStorage.layer)),
  );
  const loadPreferences = MobilePreferences.MobilePreferencesStore.pipe(
    Effect.flatMap((store) => store.load),
    Effect.provide(preferencesLayer),
  );

  beforeEach(() => {
    openDatabaseAsync.mockReset();
    secureValues.clear();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
  });

  it.effect("loads saved preferences when replay from secure storage fails", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mobile-prefs-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const databasePath = NodePath.join(directory, "preferences.db");

      yield* Effect.promise(() => sqliteDatabase(databasePath));
      yield* MobileDatabase.MobileDatabase.pipe(
        Effect.flatMap((database) =>
          database.savePreferencesJson('{"language":"en","themeMode":"light"}', 1),
        ),
        Effect.provide(MobileDatabase.layer),
      );

      openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));
      yield* MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.savePatch(preferences)),
        Effect.provide(preferencesLayer),
      );
      const fallback = secureValues.get(fallbackKey);
      expect(fallback).toEqual(expect.any(String));

      openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite still unavailable"));
      expect(yield* loadPreferences).toEqual(preferences);

      const { runAsync } = yield* Effect.promise(() => sqliteDatabase(databasePath));
      runAsync.mockRejectedValueOnce(new Error("SQLite repair failed"));
      setItemAsync.mockRejectedValueOnce(new Error("Secure storage is read-only"));
      expect(yield* loadPreferences).toEqual(preferences);
      expect(runAsync).toHaveBeenCalledTimes(1);
      expect(secureValues.get(fallbackKey)).toBe(fallback);
      expect(setItemAsync).toHaveBeenCalledTimes(1);

      yield* Effect.promise(() => sqliteDatabase(databasePath));
      expect(yield* loadPreferences).toEqual(preferences);
      expect(secureValues.has(fallbackKey)).toBe(false);

      yield* Effect.promise(() => sqliteDatabase(databasePath));
      expect(yield* loadPreferences).toEqual(preferences);
    }),
  );

  it.effect("keeps the SQLite preferences when the secure fallback is corrupt", () =>
    Effect.gen(function* () {
      const { sqlite } = yield* Effect.promise(() => sqliteDatabase());
      yield* MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) =>
          Effect.gen(function* () {
            yield* store.savePatch(preferences);
            const corruptFallback = '{"payload":"{","updatedAt":1}';
            secureValues.set(fallbackKey, corruptFallback);
            deleteItemAsync.mockRejectedValueOnce(new Error("Secure storage cleanup failed"));

            expect(yield* store.load).toEqual(preferences);
            expect(secureValues.get(fallbackKey)).toBe(corruptFallback);
            expect(yield* store.load).toEqual(preferences);
            expect(secureValues.has(fallbackKey)).toBe(false);
            expect(
              sqlite.prepare("SELECT payload FROM client_preferences").get()?.payload,
            ).toBe(JSON.stringify(preferences));
          }),
        ),
        Effect.provide(preferencesLayer),
      );
    }),
  );

  it.effect("restores the secure fallback when the SQLite payload is corrupt", () =>
    Effect.gen(function* () {
      const { sqlite } = yield* Effect.promise(() => sqliteDatabase());
      yield* MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) =>
          Effect.gen(function* () {
            yield* store.savePatch({ language: "en" });
            sqlite
              .prepare("UPDATE client_preferences SET payload = ?, updated_at = 2")
              .run(Uint8Array.of(255));
            const payload = JSON.stringify(preferences);
            secureValues.set(fallbackKey, JSON.stringify({ payload, updatedAt: 1 }));

            expect(yield* store.load).toEqual(preferences);
            expect(secureValues.has(fallbackKey)).toBe(false);
            expect(
              sqlite
                .prepare("SELECT payload, updated_at AS updatedAt FROM client_preferences")
                .get(),
            ).toEqual({ payload, updatedAt: 1 });
          }),
        ),
        Effect.provide(preferencesLayer),
      );
    }),
  );
});
