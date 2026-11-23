// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - synthetic packaging and HTTP fixture.
import * as Assert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import type { BundleOutput } from "alchemy/Bundle/Bundle";
import type * as Cloudflare from "@cloudflare/workers-types";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Admission from "../src/Admission.ts";
import * as Cache from "../src/Cache.ts";
import * as Savings from "../src/Savings.ts";
import { inspectNativeSavings, savingsBuild } from "../src/SavingsBuild.ts";

const directory = process.argv[2];
const proofDirectory = process.argv[3];
Assert.ok(directory && NodePath.isAbsolute(directory));
Assert.ok(proofDirectory && NodePath.isAbsolute(proofDirectory));
NodeFS.mkdirSync(proofDirectory);
const artifacts = await inspectNativeSavings(directory);
const selectedConfig = {
  TASK_CACHE_NATIVE_SAVINGS_DIRECTORY: directory,
  TASK_CACHE_NATIVE_SAVINGS_SHA256: artifacts.fingerprint,
};
const selectedBuild = (config: Record<string, string>) => savingsBuild.pipe(
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
);
const bundles = await Effect.runPromise(Effect.gen(function* () {
  Assert.equal(yield* selectedBuild({}), undefined);
  const mismatch = yield* Effect.result(selectedBuild({ ...selectedConfig,
    TASK_CACHE_NATIVE_SAVINGS_SHA256: "0".repeat(64) }));
  Assert.equal(mismatch._tag, "Failure");
  const build = yield* selectedBuild(selectedConfig);
  Assert.ok(build);
  const bundler = yield* WorkerBundle;
  const common = { id: "Cache", compatibility: { date: "2026-09-11", flags: ["nodejs_compat"] },
    stack: { name: "T3TaskCache", stage: "fixture" }, entry: { kind: "effect" as const, exports: {} } };
  const main = NodeURL.fileURLToPath(new URL("../src/worker.ts", import.meta.url));
  const retained = yield* bundler.build({ ...common, main, extraOptions: undefined });
  const native = yield* bundler.build({ ...common, main, extraOptions: build });
  const runtime = yield* bundler.build({ ...common,
    main: NodeURL.fileURLToPath(new URL("../src/SavingsRuntime.native.ts", import.meta.url)),
    entry: { kind: "external" }, extraOptions: { ...build, preserveEntrySignatures: "strict" },
  });
  return { retained, native, runtime };
}).pipe(Effect.provide(NodeServices.layer)));

const wasmFiles = (bundle: BundleOutput) => bundle.files.filter((file) => file.path.endsWith(".wasm"));
Assert.equal(wasmFiles(bundles.retained).length, 0);
Assert.equal(wasmFiles(bundles.native).length, 1);
Assert.equal(wasmFiles(bundles.runtime).length, 1);
const wasmBytes = NodeFS.readFileSync(artifacts.wasm);
for (const bundle of [bundles.native, bundles.runtime]) {
  const file = wasmFiles(bundle)[0];
  Assert.ok(file && typeof file.content !== "string");
  Assert.deepEqual(Buffer.from(file.content), wasmBytes);
}
Assert.equal((await inspectNativeSavings(directory)).fingerprint, artifacts.fingerprint);

const runtimeDirectory = NodePath.join(proofDirectory, "runtime");
NodeFS.mkdirSync(runtimeDirectory);
NodeFS.writeFileSync(NodePath.join(runtimeDirectory, "package.json"), '{"type":"module"}');
for (const file of bundles.runtime.files) {
  Assert.ok(!NodePath.isAbsolute(file.path) && !file.path.split("/").includes(".."));
  const destination = NodePath.join(runtimeDirectory, file.path);
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  NodeFS.writeFileSync(destination, file.content);
}
const loadedWasm = new Set<string>();
const hooks = NodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".wasm")) return nextLoad(url, context);
    const path = NodeURL.fileURLToPath(url);
    Assert.ok(path.startsWith(`${runtimeDirectory}${NodePath.sep}`));
    const bytes = NodeFS.readFileSync(path);
    Assert.deepEqual(bytes, wasmBytes);
    loadedWasm.add(url);
    return { format: "module", shortCircuit: true,
      source: `export default new WebAssembly.Module(Uint8Array.from(${JSON.stringify(Array.from(bytes))}));` };
  },
});
let nativeRuntime: { readonly layer: Layer.Layer<Savings.Savings, never, Savings.Database> };
try {
  nativeRuntime = await import(NodeURL.pathToFileURL(NodePath.join(runtimeDirectory,
    bundles.runtime.files[0].path)).href);
} finally {
  hooks.deregister();
}
Assert.equal(loadedWasm.size, 1);

async function verifyRoute(savingsLayer: Layer.Layer<Savings.Savings, never, Savings.Database>) {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  let failAfterReceipt = false;
  try {
    for (const migration of [
      "../vendor/vite-plus-remote-cache-cloudflare/migrations/0001_cache.sql",
      "../migrations/savings/0001_savings.sql", "../migrations/savings/0002_unspecified_tier.sql",
    ]) sqlite.exec(NodeFS.readFileSync(new URL(migration, import.meta.url), "utf8"));
    sqlite.exec(`INSERT INTO scopes(scope_id, endpoint, repository, repository_id, repository_owner_id, branch)
      VALUES ('t3code','https://cache.example','fixture/cache','1','2','refs/heads/main')`);
    const prepare = (sql: string, args: (string | number)[] = []) => ({
      sql, args,
      bind: (...values: (string | number)[]) => prepare(sql, values),
      all: async () => ({ results: sqlite.prepare(sql).all(...args),
        success: true, meta: { rows_read: 0, rows_written: 0, size_after: 0 } }),
    });
    const database = {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) => {
        sqlite.exec("BEGIN");
        try {
          for (const [index, statement] of statements.entries()) {
            sqlite.prepare(statement.sql).run(...statement.args);
            if (index === 0 && failAfterReceipt) throw new Error("Synthetic D1 failure");
          }
          sqlite.exec("COMMIT");
        } catch (cause) {
          sqlite.exec("ROLLBACK");
          throw cause;
        }
        return [];
      },
    } as unknown as Cloudflare.D1Database;
    const token = "synthetic-savings-token-012345678901234567890";
    const bindings = { INDEX: database,
      developerKeys: JSON.stringify({ fixture: NodeCrypto.createHash("sha256").update(token).digest("hex") }),
      readLimit: { limit: async () => ({ success: true }) },
    } as unknown as Cache.Bindings["Service"];
    const totals = () => sqlite.prepare(`SELECT local_ms, remote_ms, local_hits, remote_hits,
      executed, restore_failures, unspecified_ms, unspecified_hits FROM savings`).all().map((row) => ({ ...row }));
    await Effect.runPromise(Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      const recordedAt = yield* Clock.currentTimeMillis;
      const summary = { recordedAt, host: "fixture", platform: "linux", arch: "x64",
        ci: false, runId: "fixture", tasks: ["local", "remote", "unspecified", "executed", "failed"]
          .map((source, index) => ({ package: "fixture", task: "check", source, savedMs: index + 1 })) };
      const send = (id: string) => cache.handle(new Request("https://cache.example/projects/t3code/telemetry", {
        method: "POST", headers: { authorization: `Basic ${btoa(`fixture:${token}`)}` },
        body: JSON.stringify({ ...summary, id: id.repeat(64) }),
      }), { waitUntil: () => {} });
      Assert.equal((yield* send("a")).status, 204);
      Assert.equal((yield* send("a")).status, 204);
      const initial = totals();
      Assert.deepEqual(initial, [{ local_ms: 1, remote_ms: 2, local_hits: 1, remote_hits: 1,
        executed: 1, restore_failures: 1, unspecified_ms: 3, unspecified_hits: 1 }]);
      failAfterReceipt = true;
      Assert.equal((yield* send("b")).status, 503);
      Assert.deepEqual(totals(), initial);
      failAfterReceipt = false;
      Assert.equal((yield* send("b")).status, 204);
      Assert.equal((yield* send("b")).status, 204);
      Assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM receipts").get()?.count, 2);
      Assert.deepEqual(totals(), [{ local_ms: 2, remote_ms: 4, local_hits: 2, remote_hits: 2,
        executed: 2, restore_failures: 2, unspecified_ms: 6, unspecified_hits: 2 }]);
    }).pipe(Effect.provide(Cache.layer.pipe(Layer.provide([
      Admission.layer, Layer.succeed(Cache.Bindings, bindings),
      savingsLayer.pipe(Layer.provide(Layer.succeed(Savings.Database, database))),
    ])))));
    return totals();
  } finally {
    sqlite.close();
  }
}
const retainedTotals = await verifyRoute(Savings.layer);
Assert.deepEqual(await verifyRoute(nativeRuntime.layer), retainedTotals);
NodeFS.writeFileSync(NodePath.join(proofDirectory, "proof.json"), `${JSON.stringify({
  fingerprint: artifacts.fingerprint, retainedBundle: bundles.retained.hash,
  nativeBundle: bundles.native.hash, runtimeBundle: bundles.runtime.hash,
  wasmModules: loadedWasm.size, routesEquivalent: true, receiptRows: 2,
  duplicateAccounting: false, failedBatchRolledBack: true,
}, null, 2)}\n`);
NodeFS.writeSync(1, "Native savings Worker packaging and telemetry route passed\n");
