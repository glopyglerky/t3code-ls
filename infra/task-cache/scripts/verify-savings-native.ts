// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - owned synthetic Wasm/D1 qualification.
import * as Assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Cloudflare from "@cloudflare/workers-types";
import * as Savings from "../src/Savings.ts";
import * as SavingsFold from "../src/SavingsFold.ts";

const modulePath = process.argv[2];
Assert.ok(modulePath && NodePath.isAbsolute(modulePath), "Provide the built Wasm binding's absolute path");
const require = NodeModule.createRequire(import.meta.url);
const wasm = require(modulePath) as SavingsFold.WasmSavings;
const native = SavingsFold.fromWasm(wasm);
const sources = ["local", "remote", "unspecified", "executed", "failed"] as const;
const task = (source: typeof sources[number], savedMs: number) => ({
  package: "fixture", task: "check", source, savedMs,
});
const inputs: SavingsFold.SavingsTasks[] = [
  [], sources.map((source, index) => task(source, index + 1)),
  [task("local", Number.MAX_SAFE_INTEGER), task("remote", 0), task("local", 2), task("local", 1)],
  [task("unspecified", -0), task("failed", Number.MAX_SAFE_INTEGER)],
  Array.from({ length: 1000 }, (_, index) => task(sources[index % sources.length]!, index * 17)),
  Array.from({ length: 1000 }, () => task("remote", Number.MAX_SAFE_INTEGER)),
];
for (const tasks of inputs) Assert.deepEqual(native(tasks), SavingsFold.retained(tasks));
for (const words of [[0], [5, 0], [0, -1], [0, 0.5], [0, Infinity], [NaN, 1], [0, NaN]]) {
  Assert.throws(() => wasm.fold_savings(new Float64Array(words)));
}
Assert.throws(() => wasm.fold_savings(new Float64Array(2002)));

const sqlite = new NodeSqlite.DatabaseSync(":memory:");
try {
  for (const migration of ["0001_savings.sql", "0002_unspecified_tier.sql"]) {
    sqlite.exec(NodeFS.readFileSync(new URL(`../migrations/savings/${migration}`, import.meta.url), "utf8"));
  }
  let failAfterReceipt = false;
  let batches = 0;
  const database = {
    prepare: (sql: string) => ({ bind: (...args: (string | number)[]) => ({ sql, args }) }),
    batch: async (statements: { sql: string; args: (string | number)[] }[]) => {
      batches += 1;
      sqlite.exec("BEGIN");
      try {
        for (const [index, statement] of statements.entries()) {
          sqlite.prepare(statement.sql).run(...statement.args);
          if (failAfterReceipt && index === 0) throw new Error("Synthetic D1 failure");
        }
        sqlite.exec("COMMIT");
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
      return [];
    },
  } as unknown as Cloudflare.D1Database;
  await Effect.runPromise(Effect.gen(function* () {
    const savings = yield* Savings.Savings;
    const summary = {
      id: "a".repeat(64), recordedAt: 1, host: "fixture", platform: "linux",
      arch: "x64", ci: false, runId: "fixture", tasks: inputs[1]!,
    };
    yield* savings.record(summary, "fixture");
    yield* savings.record(summary, "fixture");
    const read = () => sqlite.prepare(`SELECT local_ms, remote_ms, local_hits, remote_hits,
      executed, restore_failures, unspecified_ms, unspecified_hits FROM savings`).all().map((row) => ({ ...row }));
    const expected = [{ local_ms: 1, remote_ms: 2, local_hits: 1, remote_hits: 1,
      executed: 1, restore_failures: 1, unspecified_ms: 3, unspecified_hits: 1 }];
    Assert.deepEqual(read(), expected);
    failAfterReceipt = true;
    const retry = { ...summary, id: "b".repeat(64) };
    const failure = yield* Effect.result(savings.record(retry, "fixture"));
    Assert.equal(failure._tag, "Failure");
    Assert.deepEqual(read(), expected);
    Assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM receipts").get()?.count, 1);
    failAfterReceipt = false;
    yield* savings.record(retry, "fixture");
    yield* savings.record(retry, "fixture");
    Assert.deepEqual(read(), [{ local_ms: 2, remote_ms: 4, local_hits: 2, remote_hits: 2,
      executed: 2, restore_failures: 2, unspecified_ms: 6, unspecified_hits: 2 }]);
    Assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM receipts").get()?.count, 2);
  }).pipe(Effect.provide(Savings.layerWithFold(native).pipe(
    Layer.provide(Layer.succeed(Savings.Database, database)),
  ))));
  const batchesBeforeFailure = batches;
  const broken = SavingsFold.fromWasm({ fold_savings: () => { throw new Error("Synthetic module failure"); } });
  const failure = await Effect.runPromise(Effect.result(
    Savings.Savings.pipe(Effect.flatMap((savings) => savings.record({
      id: "c".repeat(64), recordedAt: 1, host: "fixture", platform: "linux", arch: "x64",
      ci: false, runId: "fixture", tasks: [],
    }, "fixture")), Effect.provide(Savings.layerWithFold(broken).pipe(
      Layer.provide(Layer.succeed(Savings.Database, database)),
    ))),
  ));
  Assert.equal(failure._tag, "Failure");
  Assert.equal(batches, batchesBeforeFailure);
  NodeFS.writeSync(1, `${JSON.stringify({ differentialCases: inputs.length, receiptRows: 2,
    duplicateTotals: false, failedBatchRolledBack: true, failedModuleWrites: 0 })}\n`);
} finally {
  sqlite.close();
}
