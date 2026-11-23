import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SERVICE_LAUNCHER_PROTOCOL } from "../apps/server/src/cloud/serviceProtocol.ts";
import { isQualifiedNativeHost } from "../packages/shared/src/nativeExecutable.ts";

// Run the launcher source without building the product or installing workspace dependencies.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@t3tools/shared/applicationDatabase") {
      return next(
        new URL("../packages/shared/src/applicationDatabase.ts", import.meta.url).href,
        context,
      );
    }
    return next(specifier, context);
  },
});
const { Launcher, readServiceState, writeServiceState } =
  await import("../apps/server/src/serviceLauncher.ts");
hooks.deregister();

const activeVersion = "1.0.0";
const targetVersion = "1.1.0";
const initial = { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion };

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "t3-launcher-trial-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = path.join(home, "runtime");
  const userdata = path.join(home, "userdata");
  const statePath = path.join(runtime, "service-state.json");
  const starts = path.join(runtime, "starts.log");
  await fs.mkdir(userdata);
  await writeServiceState(statePath, initial);
  async function install(version, source) {
    const directory = path.join(runtime, "versions", version);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, ".install-complete"), version);
    await fs.writeFile(
      path.join(directory, "t3"),
      `#!${process.execPath}\nimport fs from "node:fs";\nimport { DatabaseSync } from "node:sqlite";\n` +
        `const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);\n` +
        `fs.appendFileSync(${JSON.stringify(starts)}, context.childVersion + "\\n");\n${source}`,
      { mode: 0o700 },
    );
    return directory;
  }
  function launcher(state, environment = {}) {
    return new Launcher(home, state, {
      environment: { T3CODE_HOME: home, ...environment },
      backupSpaceProbe: { readFreeBytes: async () => Number.MAX_SAFE_INTEGER },
    });
  }
  return { runtime, userdata, statePath, starts, install, launcher };
}

async function readReply(file, running) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const reply = await fs.readFile(file, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (reply !== undefined) return JSON.parse(reply);
    const outcome = await Promise.race([delay(10), running]);
    if (outcome !== undefined) throw new Error(`Launcher ended before replying: ${outcome}`);
  }
  throw new Error("Timed out waiting for the launcher reply");
}

// Pinned runtime fixtures are executable Node scripts on Unix.
const processTest = (name, run) => test(name, { skip: process.platform === "win32" }, run);

for (const source of ["native", "unknown"]) {
  processTest(`refuses a live ${source} update before stopping the active child`, async (t) => {
    const f = await fixture(t);
    const dbPath = path.join(f.userdata, source === "native" ? "statev2.omdb" : "state.sqlite");
    const reply = path.join(f.runtime, "reply.json");
    const original = Buffer.from("synthetic database bytes\0");
    await fs.writeFile(dbPath, original);
    const active = await f.install(
      activeVersion,
      `if (context.update) process.exit(5);\n` +
        `const reply = ${JSON.stringify(reply)};\n` +
        `process.on("message", (message) => {\n` +
        `  fs.writeFileSync(reply + ".tmp", JSON.stringify({ ...message, pid: process.pid }));\n` +
        `  fs.renameSync(reply + ".tmp", reply);\n` +
        `});\n` +
        `process.send(${JSON.stringify({ type: "request-update", targetVersion, dbPath })});`,
    );
    await f.install(targetVersion, "process.exit(7);");
    const environment = {};
    const helperStarted = path.join(f.runtime, "helper-started");
    if (source === "native") {
      await fs.writeFile(path.join(f.userdata, "server-owner.sqlite"), "t3code-omdb-owner-v1\n");
      const helper = path.join(active, "native-bin", "t3-code-ls-db");
      await fs.mkdir(path.dirname(helper));
      await fs.writeFile(
        helper,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(helperStarted)}, "started");`,
        { mode: 0o700 },
      );
      environment.T3_CODE_LS_DB_EXECUTABLE = helper;
    }
    const launcher = f.launcher(initial, environment);
    const running = launcher.run().then(() => "completed", (error) => error.message);
    try {
      const outcome = await readReply(reply, running);
      assert.equal(outcome.type, "update-rejected");
      assert.match(outcome.reason, source === "native" ? /native database/i : /database format/i);
      assert.doesNotThrow(() => process.kill(outcome.pid, 0));
      assert.deepEqual(await readServiceState(f.statePath), initial);
      assert.deepEqual(await fs.readFile(dbPath), original);
      assert.equal(await fs.readFile(f.starts, "utf8"), `${activeVersion}\n`);
      await assert.rejects(fs.stat(helperStarted), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(f.runtime, "db-backup")), { code: "ENOENT" });
    } finally {
      await launcher.stop("SIGTERM");
      await running;
    }
  });
}

for (const mode of ["compatible", "wrong digest", "different engine"]) {
  test(`native trial matches both bundled helper contracts with ${mode}`, { skip: !isQualifiedNativeHost() }, async (t) => {
    const f = await fixture(t);
    const dbPath = path.join(f.userdata, "statev2.omdb");
    const reply = path.join(f.runtime, "helper-contract-reply.json");
    await fs.writeFile(dbPath, "native profile placeholder");
    await fs.writeFile(path.join(f.userdata, "server-owner.sqlite"), "t3code-omdb-owner-v1\n");
    const active = await f.install(activeVersion, `
      process.on("message", (message) => {
        const reply = ${JSON.stringify(reply)};
        fs.writeFileSync(reply + ".tmp", JSON.stringify({ ...message, pid: process.pid }));
        fs.renameSync(reply + ".tmp", reply);
      });
      process.send(${JSON.stringify({ type: "request-update", targetVersion, dbPath })});
    `);
    const target = await f.install(targetVersion, "process.exit(7);");
    for (const [runtime, isTarget] of [[active, false], [target, true]]) {
      const directory = path.join(runtime, "native-bin");
      const ran = path.join(directory, "ran");
      const result = {
        version: 1,
        engine: "omdb",
        engineRevision: (isTarget && mode === "different engine" ? "b" : "a").repeat(40),
        targetSchemaSha256: (isTarget ? "c" : "d").repeat(64),
      };
      const helper = `#!${process.execPath}\n` +
        `if (process.argv[2] !== "trial-capabilities") process.exit(8);\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "read capabilities");\n` +
        `console.log(${JSON.stringify(JSON.stringify({ ok: true, result }))});\n`;
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "t3-code-ls-db"), helper, { mode: 0o700 });
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
        target: "linux-x64",
        rustTarget: "x86_64-unknown-linux-gnu",
        files: {
          "t3-code-ls-db": isTarget && mode === "wrong digest"
            ? "0".repeat(64)
            : createHash("sha256").update(helper).digest("hex"),
        },
      }));
    }
    const launcher = f.launcher(initial);
    const running = launcher.run().then(() => "completed", (error) => error.message);
    try {
      const outcome = await readReply(reply, running);
      assert.equal(outcome.type, "update-rejected");
      const expectedReason = {
        compatible: /requires a durable checkpoint/u,
        "wrong digest": /could not verify both installed helpers/u,
        "different engine": /requires a supported transition/u,
      };
      assert.match(outcome.reason, expectedReason[mode]);
      assert.doesNotThrow(() => process.kill(outcome.pid, 0));
      assert.deepEqual(await readServiceState(f.statePath), initial);
      assert.equal(await fs.readFile(dbPath, "utf8"), "native profile placeholder");
      assert.equal(await fs.readFile(f.starts, "utf8"), `${activeVersion}\n`);
      assert.equal(await fs.readFile(path.join(active, "native-bin", "ran"), "utf8"), "read capabilities");
      const targetRun = path.join(target, "native-bin", "ran");
      if (mode === "wrong digest") await assert.rejects(fs.stat(targetRun), { code: "ENOENT" });
      else assert.equal(await fs.readFile(targetRun, "utf8"), "read capabilities");
    } finally {
      await launcher.stop("SIGTERM");
      await running;
    }
  });
}

processTest("preserves an inherited native pending update and interrupted legacy restore", async (t) => {
  const f = await fixture(t);
  const dbPath = path.join(f.userdata, "statev2.omdb");
  const update = {
    id: "inherited",
    fromVersion: activeVersion,
    targetVersion,
    dbPath,
    status: "pending",
  };
  const pending = { ...initial, update };
  const backup = path.join(f.runtime, "db-backup", update.id);
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, "database"), "stale copy");
  await fs.writeFile(path.join(backup, ".restore-pending"), "");
  await fs.writeFile(dbPath, "original native database");
  await fs.writeFile(`${dbPath}-wal`, "original side file");
  await fs.writeFile(path.join(f.userdata, "server-owner.sqlite"), "t3code-omdb-owner-v1\n");
  await f.install(activeVersion, "process.exit(5);");
  await f.install(targetVersion, "process.exit(7);");
  await writeServiceState(f.statePath, pending);

  for (let restart = 0; restart < 2; restart++) {
    await assert.rejects(f.launcher(pending).run(), /native database.*recovery/i);
    assert.deepEqual(await readServiceState(f.statePath), pending);
    assert.equal(await fs.readFile(dbPath, "utf8"), "original native database");
    assert.equal(await fs.readFile(`${dbPath}-wal`, "utf8"), "original side file");
    assert.deepEqual((await fs.readdir(backup)).sort(), [".restore-pending", "database"]);
    assert.equal(await fs.readFile(path.join(backup, "database"), "utf8"), "stale copy");
    await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
  }
});

processTest("rolls back a failed SQLite trial through the normal launcher", async (t) => {
  const f = await fixture(t);
  const dbPath = path.join(f.userdata, "state.sqlite");
  using db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('original')");
  db.close();
  await f.install(activeVersion, "process.exit(5);");
  await f.install(
    targetVersion,
    `using db = new DatabaseSync(${JSON.stringify(dbPath)});\n` +
      `db.exec("UPDATE items SET name = 'trial'");\nprocess.exit(7);`,
  );
  const pending = {
    ...initial,
    update: { id: "sqlite", fromVersion: activeVersion, targetVersion, dbPath, status: "pending" },
  };
  await writeServiceState(f.statePath, pending);
  await assert.rejects(f.launcher(pending).run(), /Active child exited unexpectedly \(5\)/);
  const restored = await readServiceState(f.statePath);
  assert.equal(restored.activeVersion, activeVersion);
  assert.equal(restored.update.status, "rolled-back");
  assert.equal(restored.update.reason, "candidate-exited:7");
  assert.equal(await fs.readFile(f.starts, "utf8"), `${targetVersion}\n${activeVersion}\n`);
  using reopened = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(reopened.prepare("SELECT name FROM items").get().name, "original");
});

processTest("keeps a failed trial pending when database ownership changes", async (t) => {
  const f = await fixture(t);
  const dbPath = path.join(f.userdata, "state.sqlite");
  const owner = path.join(f.userdata, "server-owner.sqlite");
  using db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('original')");
  db.close();
  const original = await fs.readFile(dbPath);
  await f.install(activeVersion, "process.exit(5);");
  await f.install(
    targetVersion,
    `using db = new DatabaseSync(${JSON.stringify(dbPath)});\n` +
      `db.exec("UPDATE items SET name = 'trial'");\n` +
      `fs.writeFileSync(${JSON.stringify(owner)}, "t3code-omdb-owner-v1\\n");\n` +
      `process.exit(7);`,
  );
  const pending = {
    ...initial,
    update: { id: "ownership-changed", fromVersion: activeVersion, targetVersion, dbPath, status: "pending" },
  };
  await writeServiceState(f.statePath, pending);

  await assert.rejects(f.launcher(pending).run(), /native database.*recovery/i);
  assert.deepEqual(await readServiceState(f.statePath), pending);
  assert.equal(await fs.readFile(f.starts, "utf8"), `${targetVersion}\n`);
  const backup = path.join(f.runtime, "db-backup", pending.update.id);
  assert.deepEqual(await fs.readdir(backup), ["database"]);
  assert.deepEqual(await fs.readFile(path.join(backup, "database")), original);
  using reopened = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(reopened.prepare("SELECT name FROM items").get().name, "trial");
});

processTest("finishes an interrupted SQLite restore before starting the previous runtime", async (t) => {
  const f = await fixture(t);
  const dbPath = path.join(f.userdata, "state.sqlite");
  const update = {
    id: "sqlite",
    fromVersion: activeVersion,
    targetVersion,
    dbPath,
    status: "pending",
  };
  const backup = path.join(f.runtime, "db-backup", update.id);
  await fs.mkdir(backup, { recursive: true });
  using db = new DatabaseSync(path.join(backup, "database"));
  db.exec("CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('original')");
  db.close();
  await fs.writeFile(path.join(backup, ".restore-pending"), "");
  await fs.writeFile(dbPath, "SQLite form");
  await f.install(activeVersion, "process.exit(5);");
  await f.install(targetVersion, "process.exit(7);");
  const pending = { ...initial, update };
  await writeServiceState(f.statePath, pending);

  await assert.rejects(f.launcher(pending).run(), /Active child exited unexpectedly \(5\)/);
  const restored = await readServiceState(f.statePath);
  assert.equal(restored.activeVersion, activeVersion);
  assert.equal(restored.update.status, "failed");
  assert.equal(restored.update.reason, "rollback-interrupted");
  assert.equal(await fs.readFile(f.starts, "utf8"), `${activeVersion}\n`);
  using reopened = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(reopened.prepare("SELECT name FROM items").get().name, "original");
});
