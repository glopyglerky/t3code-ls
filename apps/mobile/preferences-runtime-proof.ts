// Explicit synthetic APK entry. The ordinary app, connection and provider runtime are never loaded.
import { registerRootComponent, requireNativeModule } from "expo";
import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createElement, useEffect, useState } from "react";
import { Text } from "react-native";
import * as MobileDatabase from "./src/persistence/mobile-database";
import * as MobilePreferences from "./src/persistence/mobile-preferences";
import * as MobileSecureStorage from "./src/persistence/mobile-secure-storage";

const fallbackKey = "t3code.preferences.fallback";
const legacyKey = "t3code.preferences";
const checkpointKey = "t3code.preferences.proof.checkpoint";
const settings = { language: "fr", themeMode: "dark", baseFontSize: 19,
  workspaceSelections: { settings: "appearance" } } as const;
const payload = JSON.stringify(settings);
const faultSql = `
CREATE TRIGGER t12_preferences_insert BEFORE INSERT ON client_preferences
BEGIN SELECT RAISE(FAIL, 'T12 controlled write fault'); END;
CREATE TRIGGER t12_preferences_update BEFORE UPDATE ON client_preferences
BEGIN SELECT RAISE(FAIL, 'T12 controlled write fault'); END;`;
const clearSql = `DROP TRIGGER IF EXISTS t12_preferences_insert;
DROP TRIGGER IF EXISTS t12_preferences_update;`;
const layer = MobilePreferences.layer.pipe(
  Layer.provide(Layer.merge(MobileDatabase.layer, MobileSecureStorage.layer)),
);
const load = () => Effect.runPromise(MobilePreferences.MobilePreferencesStore.pipe(
  Effect.flatMap((store) => store.load), Effect.provide(layer),
));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function equal(actual: unknown, expected: unknown, checkpoint: string) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) throw new Error(checkpoint);
}
interface NativeProof {
  getOutboxRuntimeProofPhase(): string | null;
  recordOutboxRuntimeProof(result: string): void;
}

async function run(native: NativeProof): Promise<string> {
  const phase = native.getOutboxRuntimeProofPhase();
  const report: Record<string, unknown> = { schema: 1, fixture: "T12/J17-preferences", phase,
    status: "failed", checkpoint: "phase" };
  let db: SQLite.SQLiteDatabase | undefined;
  try {
    if (!["preferences-seed", "preferences-held", "preferences-recover", "preferences-clean"].includes(phase ?? "")) {
      throw new Error("Unknown preferences phase");
    }
    db = await SQLite.openDatabaseAsync("t3code-client.db", { useNewConnection: true });
    const row = () => db!.getFirstAsync<{ payload: string; updatedAt: number }>(
      "SELECT payload, updated_at AS updatedAt FROM client_preferences WHERE singleton = 1",
    );
    const faults = () => db!.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 't12_preferences_%' ORDER BY name",
    );
    if (phase === "preferences-seed") {
      // Refuse occupied storage. Root must install this separate package on its disposed emulator.
      equal(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name = 'client_preferences'"), null, "occupied database");
      equal(await SecureStore.getItemAsync(fallbackKey), null, "occupied fallback");
      equal(await SecureStore.getItemAsync(legacyKey), null, "occupied legacy");
      equal(await SecureStore.getItemAsync(checkpointKey), null, "occupied checkpoint");
      equal(await load(), {}, "initial preferences");
      await db.runAsync("INSERT INTO client_preferences VALUES (1, '{}', 1)");
      await db.execAsync(faultSql);
      report.checkpoint = "save-under-fault";
      equal(await Effect.runPromise(MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.savePatch(settings)), Effect.provide(layer),
      )), settings, "save fallback");
      const raw = await SecureStore.getItemAsync(fallbackKey);
      if (raw === null) throw new Error("fallback absent");
      const fallback = JSON.parse(raw) as { payload: string; updatedAt: number };
      equal(fallback.payload, payload, "saved fallback payload");
      if (!Number.isSafeInteger(fallback.updatedAt) || fallback.updatedAt <= 1) throw new Error("fallback timestamp");
      equal(await row(), { payload: "{}", updatedAt: 1 }, "write was not blocked");
      // Corrupt SQLite with a newer timestamp to exercise the imported corrupt-row repair.
      await db.execAsync(clearSql);
      await db.runAsync("UPDATE client_preferences SET payload = ?, updated_at = ? WHERE singleton = 1",
        "{", fallback.updatedAt + 1000);
      await db.execAsync(faultSql);
      await SecureStore.setItemAsync(checkpointKey, raw);
    }
    const retained = await SecureStore.getItemAsync(checkpointKey);
    if (retained === null) throw new Error("seed checkpoint absent");
    const expected = JSON.parse(retained) as { payload: string; updatedAt: number };
    equal(expected.payload, payload, "checkpoint settings");
    if (phase === "preferences-seed" || phase === "preferences-held") {
      report.checkpoint = "held-replay";
      equal(await faults(), [{ name: "t12_preferences_insert" }, { name: "t12_preferences_update" }], "persistent faults");
      equal(await row(), { payload: "{", updatedAt: expected.updatedAt + 1000 }, "corrupt row before replay");
      equal(await SecureStore.getItemAsync(fallbackKey), retained, "fallback before replay");
      equal(await load(), settings, "exact fallback after failed replay");
      equal(await SecureStore.getItemAsync(fallbackKey), retained, "fallback retained byte for byte");
      equal(await row(), { payload: "{", updatedAt: expected.updatedAt + 1000 }, "failed replay changed row");
    } else {
      report.checkpoint = "authoritative-replay";
      if (phase === "preferences-recover") {
        equal(await faults(), [{ name: "t12_preferences_insert" }, { name: "t12_preferences_update" }], "faults missing before recovery");
        equal(await SecureStore.getItemAsync(fallbackKey), retained, "fallback missing before recovery");
        await db.execAsync(clearSql);
      } else {
        // Assert durable cleanup BEFORE loading, so this phase cannot silently repair the previous one.
        equal(await faults(), [], "fault cleanup across reopen");
        equal(await SecureStore.getItemAsync(fallbackKey), null, "fallback cleanup across reopen");
        equal(await row(), expected, "SQLite authority across reopen");
      }
      equal(await load(), settings, "recovered settings");
      equal(await row(), expected, "authoritative payload and timestamp");
      equal(await SecureStore.getItemAsync(fallbackKey), null, "fallback cleanup");
      equal(await SecureStore.getItemAsync(legacyKey), null, "legacy cleanup");
      equal(await faults(), [], "fault cleanup");
      if (phase === "preferences-clean") {
        await db.runAsync("DELETE FROM client_preferences WHERE singleton = 1");
        await SecureStore.deleteItemAsync(checkpointKey);
        equal(await row(), null, "synthetic row cleanup");
        equal(await SecureStore.getItemAsync(checkpointKey), null, "checkpoint cleanup");
        equal(await load(), {}, "empty after cleanup");
      }
    }
    report.settings = settings;
    report.updatedAt = expected.updatedAt;
    report.checkpoint = "complete";
    report.status = "passed";
  } catch (error) {
    // Only synthetic assertion labels, never native error details or auth state.
    report.failure = error instanceof Error && error.message.length < 100
      ? error.message : "Preferences fixture failed";
  } finally {
    try { await db?.closeAsync(); }
    catch { report.status = "failed"; report.checkpoint = "close"; report.failure = "Fixture connection close failed"; }
  }
  native.recordOutboxRuntimeProof(JSON.stringify(report));
  return String(report.status);
}

let proof: Promise<string> | undefined;
function PreferencesProof() {
  const [status, setStatus] = useState("running");
  useEffect(() => {
    proof ??= run(requireNativeModule<NativeProof>("T3NativeControls"));
    void proof.then(setStatus, () => setStatus("failed"));
  }, []);
  return createElement(Text, null, `T12/J17 preferences: ${status}`);
}
registerRootComponent(PreferencesProof);
