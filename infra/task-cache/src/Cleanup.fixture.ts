// @effect-diagnostics nodeBuiltinImport:off - real SQLite exercises the cleanup transaction.
import * as Assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { cleanup } from "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts";

export async function checkAssociationCleanup() {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  try {
    sqlite.exec(
      NodeFS.readFileSync(
        new URL(
          "../vendor/vite-plus-remote-cache-cloudflare/migrations/0001_cache.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    sqlite.exec(`
      INSERT INTO scopes (scope_id, endpoint, repository, repository_id, repository_owner_id, branch)
      VALUES ('fixture', 'https://cache.example', 'owner/repo', '1', '2', 'refs/heads/main');
      INSERT INTO generations (generation_id, scope_id, state, policy_version, token_exp,
        lease_until, gc_after, value_object, blob_object, charged_bytes)
      VALUES ('live', 'fixture', 'ready', 1, unixepoch()+3600, 0, unixepoch()+3600,
        'live/value', 'live/blob', 4),
        ('retired', 'fixture', 'retired', 1, unixepoch()+3600, 0, 0,
        'retired/value', 'retired/blob', 6);
      INSERT INTO entries VALUES ('fixture', X'01', 'live');
      INSERT INTO associations VALUES
        ('fixture', X'10', X'01'), ('fixture', X'20', X'02'),
        ('fixture', X'80', X'01'), ('fixture', X'FE', X'02'), ('fixture', X'FF', X'02');
    `);

    const deletedObjects: string[] = [];
    let afterCursorRead: (() => Promise<void>) | undefined;
    const prepare = (sql: string) => {
      let args: NodeSqlite.SQLInputValue[] = [];
      const statement = {
        bind(...values: NodeSqlite.SQLInputValue[]) {
          args = values.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          return statement;
        },
        async all() {
          const results = sqlite.prepare(sql).all(...args);
          if (sql.startsWith("SELECT scope_id, secondary_key") && afterCursorRead) {
            const pause = afterCursorRead;
            afterCursorRead = undefined;
            await pause();
          }
          return { results };
        },
        run() {
          return sqlite.prepare(sql).run(...args);
        },
      };
      return statement;
    };
    const database = {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const env = {
      INDEX: database,
      GC_BATCH_SIZE: "2",
      ARTIFACTS: {
        async delete(keys: string[]) {
          deletedObjects.push(...keys);
        },
      },
    } as unknown as Parameters<typeof cleanup>[0];
    const state = () => ({
      cursor: sqlite
        .prepare("SELECT hex(secondary_key) AS key FROM maintenance WHERE id = 1")
        .get()?.key,
      keys: sqlite
        .prepare("SELECT hex(secondary_key) AS key FROM associations ORDER BY secondary_key")
        .all()
        .map((row) => row.key),
    });

    afterCursorRead = async () => {
      Assert.deepEqual(deletedObjects, ["retired/value", "retired/blob"]);
      await cleanup(env);
      Assert.deepEqual(state(), { cursor: "20", keys: ["10", "80", "FE", "FF"] });
      await cleanup(env);
      Assert.deepEqual(state(), { cursor: "FE", keys: ["10", "80", "FF"] });
      // An orphan introduced behind the newer cursor belongs to the next scan.
      sqlite.exec("INSERT INTO associations VALUES ('fixture', X'30', X'02')");
    };
    await cleanup(env);
    Assert.deepEqual(state(), { cursor: "FE", keys: ["10", "30", "80", "FF"] });

    sqlite.exec(`
      CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON associations
      WHEN OLD.secondary_key = X'FF'
      BEGIN SELECT RAISE(ABORT, 'fixture association delete failed'); END;
    `);
    await Assert.rejects(cleanup(env), /fixture association delete failed/);
    Assert.deepEqual(state(), { cursor: "FE", keys: ["10", "30", "80", "FF"] });
    sqlite.exec("DROP TRIGGER fixture_delete_failure");
    await cleanup(env);
    Assert.deepEqual(state(), { cursor: "FF", keys: ["10", "30", "80"] });
    await cleanup(env);
    Assert.deepEqual(state(), { cursor: "", keys: ["10", "30", "80"] });
    await cleanup(env);
    Assert.deepEqual(state(), { cursor: "30", keys: ["10", "80"] });
    Assert.deepEqual(deletedObjects, ["retired/value", "retired/blob"]);
    for (const table of ["scopes", "deployment"]) {
      const { charged_bytes, entry_count, association_count } = sqlite
        .prepare(`SELECT charged_bytes, entry_count, association_count FROM ${table}`)
        .get()!;
      Assert.deepEqual([charged_bytes, entry_count, association_count], [4, 1, 2]);
    }
  } finally {
    sqlite.close();
  }
}
