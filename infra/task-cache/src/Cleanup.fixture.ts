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

// Exercise production SQL and triggers; R2 is a synthetic object-ownership model.
export async function checkConcurrentPublication() {
  const { reserve, publish, abandon, selectEntry, selectBlob } = await import(
    "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts"
  );
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(NodeFS.readFileSync(new URL(
      "../vendor/vite-plus-remote-cache-cloudflare/migrations/0001_cache.sql",
      import.meta.url,
    ), "utf8"));
    sqlite.exec(`INSERT INTO scopes(scope_id, endpoint, repository, repository_id, repository_owner_id, branch)
      VALUES ('fixture', 'https://cache.example', 'owner/repo', '1', '2', 'refs/heads/main')`);
    const prepare = (sql: string) => {
      let args: NodeSqlite.SQLInputValue[] = [];
      const statement = {
        bind(...values: NodeSqlite.SQLInputValue[]) {
          args = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
          return statement;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args), success: true,
            meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get()!.n) } };
        },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { results: [], success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    };
    let pause: (() => Promise<void>) | undefined;
    const database = {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        if (pause) { const wait = pause; pause = undefined; await wait(); }
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    } as unknown as Parameters<typeof reserve>[0];
    const scope = sqlite.prepare("SELECT * FROM scopes").get() as unknown as Parameters<typeof reserve>[1];
    const objects = new Map<string, string>();
    const key = new Uint8Array([0, 255]);
    const secondary = new Uint8Array([128]);
    const tokenExpiresAt = sqlite.prepare("SELECT unixepoch() + 3600 AS expiry").get()?.expiry;
    Assert.ok(typeof tokenExpiresAt === "number");
    const create = async (value: string) => {
      const generation = await reserve(database, scope, tokenExpiresAt, 10);
      generation.value_size = 2;
      generation.blob_size = 3;
      generation.blob_id = generation.generation_id;
      objects.set(generation.value_object, value);
      objects.set(generation.blob_object, `${value}:blob`);
      return generation;
    };
    const a = await create("a");
    const b = await create("b");
    const charges = (expected: number) => {
      for (const table of ["scopes", "deployment"])
        Assert.equal(sqlite.prepare(`SELECT charged_bytes FROM ${table}`).get()!.charged_bytes, expected);
    };
    const visible = async (winner: typeof a) => {
      const selected = await selectEntry(database, "fixture", key, secondary);
      Assert.equal(selected?.generation_id, winner.generation_id);
      Assert.equal(selected?.kind, "exact");
      Assert.equal(objects.get(selected!.value_object), winner === a ? "a" : "b");
      Assert.equal((await selectBlob(database, "fixture", selected!.blob_id!))?.generation_id,
        winner.generation_id);
    };
    Assert.equal(await selectEntry(database, "fixture", key, secondary), null);
    charges(20);
    let release!: () => void;
    let entered!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    pause = async () => { entered(); await gate; };
    const pending = publish(database, a, key, secondary);
    await enteredGate;
    await publish(database, b, key, secondary);
    await visible(b);
    charges(15);
    release();
    await pending;
    await visible(a);
    charges(10);
    Assert.equal(sqlite.prepare("SELECT state FROM generations WHERE generation_id = ?")
      .get(b.generation_id)!.state, "retired");
    // A failure after retirement/entry replacement must roll back the entire trigger.
    const c = await create("c");
    sqlite.exec(`CREATE TRIGGER fixture_publication_failure BEFORE INSERT ON associations
      BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
    await Assert.rejects(publish(database, c, key, secondary), /unavailable/);
    await visible(a);
    Assert.equal(sqlite.prepare("SELECT state FROM generations WHERE generation_id = ?")
      .get(c.generation_id)!.state, "uploading");
    charges(20);
    sqlite.exec("DROP TRIGGER fixture_publication_failure");
    await abandon(database, c.generation_id);
    await Assert.rejects(publish(database, c, key, secondary), /publication_guard/);
    await visible(a);
    // Claim only c. A failed object deletion must retain its row and charge.
    sqlite.prepare("UPDATE generations SET gc_after = unixepoch()+3600 WHERE generation_id = ?")
      .run(b.generation_id);
    sqlite.prepare("UPDATE generations SET gc_after = 0 WHERE generation_id = ?").run(c.generation_id);
    let failDelete = true;
    const deleted: string[][] = [];
    const env = { INDEX: database, GC_BATCH_SIZE: "1", ARTIFACTS: {
      async delete(keys: string[]) {
        Assert.deepEqual(keys, [c.value_object, c.blob_object]);
        deleted.push(keys);
        if (failDelete) throw new Error("synthetic R2 failure");
        for (const object of keys) objects.delete(object);
      },
    } } as unknown as Parameters<typeof cleanup>[0];
    await cleanup(env);
    charges(20);
    Assert.equal(sqlite.prepare("SELECT state FROM generations WHERE generation_id = ?")
      .get(c.generation_id)!.state, "deleting");
    await Assert.rejects(publish(database, c, key, secondary), /publication_guard/);
    await cleanup(env);
    Assert.equal(deleted.length, 1); // Retry waits for the claim deadline.
    failDelete = false;
    sqlite.prepare("UPDATE generations SET gc_after = 0 WHERE generation_id = ?").run(c.generation_id);
    await cleanup(env);
    charges(10);
    Assert.equal(deleted.length, 2);
    Assert.equal(sqlite.prepare("SELECT generation_id FROM generations WHERE generation_id = ?")
      .get(c.generation_id), undefined);
    Assert.deepEqual(new Set(objects.keys()), new Set([
      a.value_object, a.blob_object, b.value_object, b.blob_object,
    ]));
    await visible(a);
    for (const table of ["scopes", "deployment"]) {
      const row = sqlite.prepare(`SELECT entry_count, association_count FROM ${table}`).get()!;
      Assert.deepEqual([row.entry_count, row.association_count], [1, 1]);
    }
  } finally { sqlite.close(); }
}
