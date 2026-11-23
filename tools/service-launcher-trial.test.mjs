import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../apps/server/src/cloud/serviceProtocol.ts";
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

async function fixture(t, selection = initial) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "t3-launcher-trial-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = path.join(home, "runtime");
  const userdata = path.join(home, "userdata");
  const statePath = path.join(runtime, "service-state.json");
  const starts = path.join(runtime, "starts.log");
  await fs.mkdir(userdata);
  await writeServiceState(statePath, selection);
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
  function launcher(state, environment = {}, output) {
    return new Launcher(home, state, {
      environment: { T3CODE_HOME: home, ...environment },
      backupSpaceProbe: { readFreeBytes: async () => Number.MAX_SAFE_INTEGER },
      output,
    });
  }
  return { runtime, userdata, statePath, starts, install, launcher };
}

async function readReply(file, running, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
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

async function sealedFixture(t, mode = "success") {
  const f = await fixture(t);
  const id = "a43bc4d1-666d-4157-aefd-02153e9c5ad4";
  const dbPath = path.join(f.userdata, "statev2.omdb");
  const original = path.join(f.userdata, `.statev2-source-${id}.omdb`);
  const failed = path.join(f.userdata, `.statev2-failed-sealed-${id}.omdb`);
  const calls = path.join(f.runtime, "rollback-calls");
  const ready = path.join(f.runtime, "ready.json");
  const backup = path.join(f.runtime, "db-backup", `${id}.omdb`);
  const receipt = path.join(f.userdata, `.statev2-trial-${id}.receipt-v1.json`);
  const pending = { protocol: 5, activeVersion, update: {
    id, fromVersion: activeVersion, targetVersion, dbPath, status: "pending",
  } };
  await fs.writeFile(dbPath, "sealed candidate fixture");
  await fs.writeFile(original, "original native fixture");
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, "original checkpoint fixture");
  await fs.writeFile(receipt, "original physical trial receipt fixture");
  await fs.writeFile(path.join(f.userdata, "server-owner.sqlite"), "t3code-omdb-owner-v1\n");
  await fs.writeFile(f.statePath, JSON.stringify(pending));
  const active = await f.install(activeVersion, `
    if (fs.readFileSync(${JSON.stringify(dbPath)}, "utf8") !== "original native fixture") process.exit(9);
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(context));
    setInterval(() => {}, 1000);
  `);
  await f.install(targetVersion, "process.exit(7);");
  const directory = path.join(active, "native-bin");
  await fs.mkdir(directory);
  const helper = `#!${process.execPath}\n` + `
    const fs = require("node:fs");
    const capabilities = {
      version: 1, engine: "omdb", engineRevision: "a".repeat(40),
      targetSchemaSha256: "b".repeat(64),
      ...( ${JSON.stringify(mode)} === "missing capability" ? {} : { sealedTrialRollback: 1 }),
    };
    if (process.argv[2] === "trial-capabilities") {
      console.log(JSON.stringify({ ok: true, result: capabilities }));
      process.exit(0);
    }
    if (process.argv[2] !== "trial-rollback-sealed" ||
        process.argv[3] !== ${JSON.stringify(path.dirname(f.userdata))} ||
        process.argv[4] !== ${JSON.stringify(id)}) process.exit(8);
    const calls = ${JSON.stringify(calls)};
    const reused = fs.existsSync(calls);
    fs.appendFileSync(calls, "rollback\\n");
    const identity = (file) => {
      const stat = fs.statSync(file, { bigint: true });
      return { device: stat.dev.toString(16).padStart(16, "0"),
        inode: stat.ino.toString(16).padStart(16, "0"), created: stat.birthtimeNs.toString() };
    };
    if (!reused) {
      fs.renameSync(${JSON.stringify(dbPath)}, ${JSON.stringify(failed)});
      fs.renameSync(${JSON.stringify(original)}, ${JSON.stringify(dbPath)});
    }
    if (${JSON.stringify(mode)} === "lost receipt" && !reused) {
      console.log(JSON.stringify({ ok: false, error: { kind: "unknown_commit" } }));
      process.exit(0);
    }
    if (${JSON.stringify(mode)} === "changed selection") {
      const state = ${JSON.stringify(pending)};
      state.update.targetVersion = "1.2.0";
      fs.writeFileSync(${JSON.stringify(f.statePath)}, JSON.stringify(state));
    }
    console.log(JSON.stringify({ ok: true, result: {
      activation: {
        update_id: ${JSON.stringify(mode === "wrong receipt" ? "other" : id)},
        from_version: ${JSON.stringify(activeVersion)}, target_version: ${JSON.stringify(targetVersion)},
        target_entry_sha256: "c".repeat(64), target_helper_sha256: "d".repeat(64),
        target_schema_sha256: "e".repeat(64),
      },
      database: identity(${JSON.stringify(dbPath)}),
      preserved_database: identity(${JSON.stringify(failed)}), reused,
    } }));
  `;
  await fs.writeFile(path.join(directory, "t3-code-ls-db"), helper, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    target: "linux-x64", rustTarget: "x86_64-unknown-linux-gnu",
    files: { "t3-code-ls-db": mode === "wrong digest" ? "0".repeat(64)
      : createHash("sha256").update(helper).digest("hex") },
  }));
  return { ...f, pending, ready, dbPath, calls, backup, receipt };
}

for (const mode of ["success", "lost receipt"]) {
  test(`recovers a sealed native pending trial through its installed helper with ${mode}`, {
    skip: !isQualifiedNativeHost(),
  }, async (t) => {
    const f = await sealedFixture(t, mode);
    await assert.rejects(readServiceState(f.statePath), /invalid or unsupported/u);
    const environment = { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" };
    if (mode === "lost receipt") {
      const failedLauncher = f.launcher(f.pending, environment);
      await assert.rejects(failedLauncher.run(), /receipt does not match/u);
      assert.deepEqual(JSON.parse(await fs.readFile(f.statePath, "utf8")), f.pending);
      assert.equal(await fs.readFile(f.dbPath, "utf8"), "original native fixture");
      await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
    }
    const launcher = f.launcher(f.pending, environment);
    const running = launcher.run().then(() => "completed", (error) => error.message);
    try {
      const context = await readReply(f.ready, running);
      assert.equal(context.protocol, SERVICE_LAUNCHER_PROTOCOL);
      assert.equal(context.childVersion, activeVersion);
      assert.deepEqual(await readServiceState(f.statePath), {
        ...initial, update: { id: f.pending.update.id, fromVersion: activeVersion,
          targetVersion, status: "rolled-back", reason: "sealed-trial-recovery" },
      });
      assert.equal(await fs.readFile(f.starts, "utf8"), `${activeVersion}\n`);
      assert.equal(await fs.readFile(f.calls, "utf8"), "rollback\n".repeat(mode === "lost receipt" ? 2 : 1));
      assert.equal(await fs.readFile(f.backup, "utf8"), "original checkpoint fixture");
      assert.equal(await fs.readFile(f.receipt, "utf8"), "original physical trial receipt fixture");
    } finally {
      await launcher.stop("SIGTERM");
      await running;
    }
  });
}

for (const mode of ["missing capability", "wrong digest", "wrong receipt", "changed selection", "missing helper", "noncanonical path", "unknown field", "disabled"]) {
  test(`preserves a sealed native pending trial after ${mode}`, {
    skip: mode === "disabled" ? process.platform === "win32" : !isQualifiedNativeHost(),
  }, async (t) => {
    const f = await sealedFixture(t, mode);
    const expected = structuredClone(f.pending);
    if (mode === "missing helper") {
      await fs.rm(path.join(f.runtime, "versions", activeVersion, "native-bin", "t3-code-ls-db"));
    }
    if (mode === "noncanonical path") expected.update.dbPath += ".different";
    if (mode === "unknown field") expected.extra = "unsupported";
    if (mode === "noncanonical path" || mode === "unknown field") {
      await fs.writeFile(f.statePath, JSON.stringify(expected));
    }
    const launcher = f.launcher(f.pending,
      mode === "disabled" ? {} : { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" });
    await assert.rejects(launcher.run());
    if (mode === "changed selection") expected.update.targetVersion = "1.2.0";
    assert.deepEqual(JSON.parse(await fs.readFile(f.statePath, "utf8")), expected);
    await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
    assert.equal(await fs.readFile(f.backup, "utf8"), "original checkpoint fixture");
    assert.equal(await fs.readFile(f.receipt, "utf8"), "original physical trial receipt fixture");
    if (["missing capability", "wrong digest", "disabled", "missing helper", "noncanonical path", "unknown field"].includes(mode)) {
      await assert.rejects(fs.stat(f.calls), { code: "ENOENT" });
      assert.equal(await fs.readFile(f.dbPath, "utf8"), "sealed candidate fixture");
    }
  });
}

test("ordinary launcher refuses isolated candidate preparation before any child starts", async (t) => {
  const f = await fixture(t);
  const launcher = f.launcher(initial, { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" });
  const before = await fs.readFile(f.statePath);
  await assert.rejects(launcher.prepareIsolatedCandidate({}),
    /requires a stopped native trial launcher/u);
  assert.deepEqual(await fs.readFile(f.statePath), before);
  await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
});

const launcherPromotionProof = process.env.T3_TEST_LAUNCHER_PROMOTION_INTENT === "1";
const launcherPublicationProof = process.env.T3_TEST_LAUNCHER_SEALED_PUBLICATION === "1";
const launcherCancelProof = process.env.T3_TEST_LAUNCHER_CANCEL_BEFORE_PUBLICATION === "1";
const launcherSealedServingProof = process.env.T3_TEST_LAUNCHER_SEALED_SERVING === "1";
const launchesPackagedPrevious = launcherCancelProof || launcherSealedServingProof;

test(launcherPromotionProof
  ? "compiled Rust helper records an installed launcher's native promotion intent"
  : "compiled Rust helper restores a sealed native trial before launcher startup", {
  skip: process.env.T3_TEST_SEALED_TRIAL_HELPER === undefined,
  timeout: launcherPublicationProof || launcherCancelProof ? 180_000 : 120_000,
}, async (t) => {
  const executable = process.env.T3_TEST_SEALED_TRIAL_HELPER;
  assert.ok(!launcherCancelProof || (launcherPromotionProof && !launcherPublicationProof));
  assert.ok(!launcherSealedServingProof || (launcherPromotionProof && launcherPublicationProof));
  assert.ok(isQualifiedNativeHost(), "The compiled-helper proof requires qualified Linux x64");
  assert.ok(path.isAbsolute(executable), "Pass the exact compiled helper by absolute path");
  const helperBytes = (await fs.stat(executable)).size;
  t.diagnostic(JSON.stringify({ helperBytes, installedArtifactLimitBytes: 128 * 1024 * 1024 }));
  assert.ok(helperBytes <= 128 * 1024 * 1024,
    "The installed helper must fit the native trial's 128 MiB artifact hash limit");
  const previousVersion = launchesPackagedPrevious ? process.env.T3_TEST_PREVIOUS_RUNTIME_VERSION : activeVersion;
  assert.ok(previousVersion !== undefined && isExactServiceVersion(previousVersion),
    "Use the exact installed package version when launching the previous runtime");
  const candidateVersion = launchesPackagedPrevious
    ? `${BigInt(previousVersion.split(".", 1)[0]) + 1n}.0.0`
    : targetVersion;
  assert.ok(isExactServiceVersion(candidateVersion) && compareExactServiceVersions(previousVersion, candidateVersion) < 0);
  const selected = { ...initial, activeVersion: previousVersion };
  const f = await fixture(t, selected);
  const home = path.dirname(f.userdata);
  const id = "63b13571-13c5-411b-ad39-35db4071a854";
  const dbPath = path.join(f.userdata, "statev2.omdb");
  const ready = path.join(f.runtime, "compiled-helper-ready.json");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const runHelper = (args, requests, helper = executable) => {
    const stdout = execFileSync(helper, args, {
      env: {}, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576,
      input: requests === undefined ? "" : `${requests.map((row) => JSON.stringify(row)).join("\n")}\n`,
    });
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
    for (const reply of replies) assert.equal(reply.ok, true, `${args[0]}: ${JSON.stringify(reply)}`);
    return replies.map((reply) => reply.result);
  };
  const commandId = "sealed-launcher-source";
  const seeded = runHelper(["initialize-local", dbPath], [
    { operation: "application_bootstrap" },
    { operation: "commit", batch: {
      command_id: commandId, request_digest: digest(JSON.stringify({ command: commandId })),
      expected_revision: 0,
      events: [{ id: `event:${commandId}`, payload: { text: "preserve this native event" } }],
      projections: [{ operation: "put", key: "project:one", payload: { title: commandId } }],
      effects: [{ id: `effect:${commandId}`, payload: { type: "cleanup" } }],
      result: { accepted: true },
    } },
    { operation: "application_generation_identity" },
    { operation: "receipt", command_id: commandId },
    { operation: "shutdown" },
  ]);
  assert.equal(seeded.length, 5);
  assert.deepEqual(seeded[3], seeded[1].receipt);
  runHelper(["owner-lock", path.join(f.userdata, "server-owner.sqlite")], [
    { operation: "owner_acquire" }, { operation: "owner_activate" },
  ]);
  const sourceBytes = await fs.readFile(dbPath);
  const sourceIdentity = await fs.stat(dbPath, { bigint: true });
  const previous = await f.install(previousVersion, `
    const selection = JSON.parse(fs.readFileSync(${JSON.stringify(f.statePath)}, "utf8"));
    if (selection.activeVersion !== ${JSON.stringify(previousVersion)} ||
        selection.update.status !== "rolled-back" || context.update.status !== "rolled-back") process.exit(9);
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(context));
    setInterval(() => {}, 1000);
  `);
  const target = await f.install(candidateVersion, "process.exit(7);");
  const preparationEntry = process.env.T3_TEST_PREPARE_ENTRY;
  if (launcherPromotionProof) assert.ok(preparationEntry, "Pass the packaged runtime for both roles");
  if (preparationEntry !== undefined) {
    assert.ok(path.isAbsolute(preparationEntry));
    const runtimeEntryBytes = (await fs.stat(preparationEntry)).size;
    t.diagnostic(JSON.stringify({ runtimeEntryBytes, installedRuntimeLimitBytes: 256 * 1024 * 1024 }));
    assert.ok(runtimeEntryBytes <= 256 * 1024 * 1024,
      "The installed runtime must fit its independent 256 MiB artifact hash limit");
    if (launchesPackagedPrevious) {
      await fs.cp(path.dirname(preparationEntry), target, { recursive: true });
      await fs.cp(path.dirname(preparationEntry), previous, { recursive: true });
    } else {
      await fs.copyFile(preparationEntry, path.join(target, "t3"));
      await fs.chmod(path.join(target, "t3"), 0o700);
      if (launcherPromotionProof) {
        await fs.copyFile(preparationEntry, path.join(previous, "t3"));
        await fs.chmod(path.join(previous, "t3"), 0o700);
      }
    }
  }
  const helperSha256 = digest(await fs.readFile(executable));
  for (const directory of [previous, target]) {
    const nativeDirectory = path.join(directory, "native-bin");
    if (launchesPackagedPrevious) {
      assert.equal(digest(await fs.readFile(path.join(nativeDirectory, "t3-code-ls-db"))), helperSha256);
      continue;
    }
    await fs.mkdir(nativeDirectory);
    await fs.copyFile(executable, path.join(nativeDirectory, "t3-code-ls-db"));
    await fs.writeFile(path.join(nativeDirectory, "manifest.json"), JSON.stringify({
      target: "linux-x64", rustTarget: "x86_64-unknown-linux-gnu",
      files: { "t3-code-ls-db": helperSha256 },
    }));
  }
  const [capabilities] = runHelper(["trial-capabilities"]);
  assert.equal(capabilities.sealedTrialRollback, 1);
  const [backup] = runHelper(["trial-backup", home, id, seeded[2].catalog_sha256]);
  const checkpoint = path.join(f.runtime, "native-db-backup", `${id}.omdb`);
  const checkpointBytes = await fs.readFile(checkpoint);
  const backupReceipt = path.join(f.runtime, "native-db-backup", `${id}.backup-receipt-v1.json`);
  const backupReceiptBytes = await fs.readFile(backupReceipt);
  const pending = { protocol: 5, activeVersion: previousVersion, update: {
    id, fromVersion: previousVersion, targetVersion: candidateVersion, dbPath, status: "pending",
  } };
  await fs.writeFile(f.statePath, JSON.stringify(pending));
  const activation = {
    update_id: id, from_version: previousVersion, target_version: candidateVersion,
    target_entry_sha256: digest(await fs.readFile(path.join(target, "t3"))),
    target_helper_sha256: helperSha256, target_schema_sha256: capabilities.targetSchemaSha256,
  };
  const request = {
    update_id: id, database: backup.database,
    checkpoint: { catalog_sha256: seeded[2].catalog_sha256,
      rows: backup.backup.rows, checksum: backup.backup.checksum },
    target_schema_sha256: capabilities.targetSchemaSha256, activation,
  };
  const [prepared] = runHelper(["trial-prepare-isolated", home, id], [request]);
  if (preparationEntry !== undefined) {
    const trial = path.join(f.userdata, `.statev2-trial-${id}.omdb`);
    const stageBytes = await fs.readFile(trial);
    const stageIdentity = await fs.stat(trial, { bigint: true });
    const stateBytes = await fs.readFile(f.statePath);
    const stateIdentity = await fs.stat(f.statePath, { bigint: true });
    const candidate = path.join(target, "t3");
    const preparationLauncher = f.launcher(pending, { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" });
    let witness;
    let observationBytes;
    const observationPath = path.join(f.userdata, `.statev2-trial-${id}.receipt-v1.json`);
    const beforeObservation = await fs.readFile(observationPath);
    for (const attempt of ["mismatched-update", "corrupt-receipt", "first", "retry"]) {
      const input = { request: attempt === "mismatched-update" ? {
        ...request, activation: { ...activation, target_version: "1.2.0" },
      } : request, preparation: attempt === "corrupt-receipt" ? {
        ...prepared, file_sha256: "0".repeat(64),
      } : prepared };
      if (attempt === "mismatched-update" || attempt === "corrupt-receipt") {
        await assert.rejects(preparationLauncher.prepareIsolatedCandidate(input),
          attempt === "mismatched-update" ? /does not match the selected update/u : /Command failed/u);
      } else {
        const actual = await preparationLauncher.prepareIsolatedCandidate(input);
        assert.deepEqual(actual, {
          protocol: 1, status: "prepared-isolated", updateId: id, targetVersion: candidateVersion,
          entrySha256: activation.target_entry_sha256, helperSha256,
          verificationSha256: digest(JSON.stringify(input)),
        });
        if (witness !== undefined) assert.deepEqual(actual, witness);
        witness = actual;
        const bytes = await fs.readFile(observationPath);
        const saved = JSON.parse(bytes);
        assert.deepEqual(saved.candidate_observation, {
          verification_json: JSON.stringify(input), witness: actual,
        });
        if (observationBytes !== undefined) assert.deepEqual(bytes, observationBytes);
        observationBytes = bytes;
      }
      if (attempt === "mismatched-update" || attempt === "corrupt-receipt") {
        assert.deepEqual(await fs.readFile(observationPath), beforeObservation);
      }
      assert.equal((await fs.stat(dbPath, { bigint: true })).ino, sourceIdentity.ino);
      assert.equal((await fs.stat(trial, { bigint: true })).ino, stageIdentity.ino);
      assert.equal((await fs.stat(f.statePath, { bigint: true })).ino, stateIdentity.ino);
      assert.deepEqual(await fs.readFile(dbPath), sourceBytes);
      assert.deepEqual(await fs.readFile(trial), stageBytes);
      assert.deepEqual(await fs.readFile(f.statePath), stateBytes);
      await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(f.userdata, "server-runtime.json")), { code: "ENOENT" });
    }
    const corrupted = JSON.parse(observationBytes);
    corrupted.candidate_observation.witness.verificationSha256 = "0".repeat(64);
    await fs.writeFile(observationPath, JSON.stringify(corrupted));
    await assert.rejects(preparationLauncher.prepareIsolatedCandidate({ request, preparation: prepared }), /Command failed/u);
    assert.deepEqual(JSON.parse(await fs.readFile(observationPath)), corrupted);
    await fs.writeFile(observationPath, observationBytes);
    // A fresh launcher replays the actual candidate and revalidates the durable observation.
    assert.deepEqual(await f.launcher(pending, { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" })
      .prepareIsolatedCandidate({ request, preparation: prepared }), witness);
    assert.deepEqual(await fs.readFile(observationPath), observationBytes);
    if (launcherPromotionProof) {
      const input = { request, preparation: prepared };
      const expectedIntent = {
        version: 1,
        verification_sha256: witness.verificationSha256,
        source_entry_sha256: digest(await fs.readFile(path.join(previous, "t3"))),
        source_helper_sha256: helperSha256,
        source_helper_schema_sha256: capabilities.targetSchemaSha256,
      };
      let persisted;
      for (const reopen of [false, true]) {
        const launcher = reopen
          ? f.launcher(pending, { T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1" })
          : preparationLauncher;
        assert.deepEqual(await launcher.prepareIsolatedCandidate(input, { recordPromotionIntent: true }), witness);
        const bytes = await fs.readFile(observationPath);
        const saved = JSON.parse(bytes);
        assert.deepEqual(saved.promotion_intent, expectedIntent);
        assert.deepEqual(saved.candidate_observation, JSON.parse(observationBytes).candidate_observation);
        if (persisted !== undefined) assert.deepEqual(bytes, persisted);
        persisted = bytes;
      }
      const blockedPublication = spawnSync(executable, ["trial-publish-sealed", home, id], {
        env: {}, input: "", encoding: "utf8", timeout: 30_000, maxBuffer: 8192,
      });
      assert.equal(blockedPublication.error, undefined);
      assert.equal(blockedPublication.status, 0);
      assert.equal(JSON.parse(blockedPublication.stdout).ok, false);
      assert.equal((await fs.stat(dbPath, { bigint: true })).ino, sourceIdentity.ino);
      assert.equal((await fs.stat(trial, { bigint: true })).ino, stageIdentity.ino);
      assert.equal((await fs.stat(f.statePath, { bigint: true })).ino, stateIdentity.ino);
      assert.deepEqual(await fs.readFile(dbPath), sourceBytes);
      assert.deepEqual(await fs.readFile(trial), stageBytes);
      assert.deepEqual(await fs.readFile(f.statePath), stateBytes);
      assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
      assert.deepEqual(await fs.readFile(backupReceipt), backupReceiptBytes);
      assert.deepEqual(await fs.readFile(observationPath), persisted);
      await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(f.userdata, "server-runtime.json")), { code: "ENOENT" });
      async function reopenPreviousRuntime(retainedCandidate) {
        const output = await fs.open(path.join(f.runtime, "rollback-recovery.log"), "a+", 0o600);
        const port = 48123;
        const launcher = f.launcher(pending, {
          HOME: home,
          PATH: "/usr/bin:/bin",
          T3CODE_HOST: "127.0.0.1",
          T3CODE_PORT: String(port),
          T3CODE_NO_BROWSER: "true",
          T3CODE_TELEMETRY_ENABLED: "false",
          T3CODE_OTEL_SDK_DISABLED: "true",
          T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1",
        }, output.fd);
        const running = launcher.run().then(() => "completed", (error) => error.message);
        try {
          const origin = `http://127.0.0.1:${port}`;
          const deadline = Date.now() + 45_000;
          let descriptor;
          while (Date.now() < deadline) {
            const outcome = await Promise.race([delay(50), running]);
            if (outcome !== undefined) {
              const log = Buffer.alloc(64 * 1024);
              const { bytesRead } = await output.read(log, 0, log.length, 0);
              const text = log.toString("utf8", 0, bytesRead);
              t.diagnostic(JSON.stringify({
                childReportedVersionMismatch: text.includes("The service launcher started a different t3 version."),
                childReportedInvalidContext: text.includes("The service launcher supplied invalid startup context."),
                childReportedStorageError: /OmdbStartupError|ServerOwnershipError|NativeDatabaseError/u.test(text),
                childReportedBindError: /EADDRINUSE|EACCES/u.test(text),
              }));
            }
            assert.equal(outcome, undefined, "The selected launcher must remain active");
            const response = await fetch(origin + "/.well-known/t3/environment", {
              redirect: "error", signal: AbortSignal.timeout(400),
            }).catch(() => undefined);
            if (response?.ok) {
              descriptor = await response.json();
              break;
            }
          }
          assert.ok(descriptor, "The previous packaged runtime must become ready after rollback");
          assert.equal(descriptor.databaseMigration, Number(seeded[0].migrations.at(-1).id));
          assert.deepEqual(await readServiceState(f.statePath), {
            ...selected, update: { id, fromVersion: previousVersion, targetVersion: candidateVersion,
              status: "rolled-back", reason: "sealed-trial-recovery" },
          });
          const runtime = JSON.parse(await fs.readFile(path.join(f.userdata, "server-runtime.json"), "utf8"));
          assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 1);
          assert.equal(await fs.realpath(`/proc/${runtime.pid}/exe`), path.join(previous, "t3"));
          assert.equal((await fs.stat(dbPath, { bigint: true })).ino, sourceIdentity.ino);
          const [restored] = runHelper(["read-only-local", dbPath], [
            { operation: "receipt", command_id: commandId },
          ]);
          assert.deepEqual(restored, seeded[3]);
          assert.equal((await fs.stat(retainedCandidate, { bigint: true })).ino, stageIdentity.ino);
          assert.deepEqual(await fs.readFile(retainedCandidate), stageBytes);
          assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
          assert.deepEqual(await fs.readFile(backupReceipt), backupReceiptBytes);
          assert.equal(JSON.parse(await fs.readFile(observationPath, "utf8")).sealed_publication.phase, "rolled_back");
        } finally {
          try {
            await launcher.stop("SIGTERM");
            await running;
          } finally {
            await output.close();
          }
        }
      }
      if (launcherPublicationProof) {
        assert.equal(capabilities.sealedIntentPublication, 1);
        const installedHelper = path.join(previous, "native-bin", "t3-code-ls-db");
        const previousPath = path.join(f.userdata, `.statev2-source-${id}.omdb`);
        const failedPath = path.join(f.userdata, `.statev2-failed-sealed-${id}.omdb`);
        const publish = ["trial-publish-intended-sealed", home, id];
        const [publication] = runHelper(publish, undefined, installedHelper);
        assert.deepEqual(publication, {
          activation, database: prepared.database, preserved_database: request.database, reused: false,
        });
        assert.equal((await fs.stat(dbPath, { bigint: true })).ino, stageIdentity.ino);
        assert.equal((await fs.stat(previousPath, { bigint: true })).ino, sourceIdentity.ino);
        assert.deepEqual(await fs.readFile(dbPath), stageBytes);
        assert.deepEqual(await fs.readFile(previousPath), sourceBytes);
        const receipt = JSON.parse(await fs.readFile(observationPath, "utf8"));
        assert.equal(receipt.sealed_publication.phase, "published");
        assert.equal(receipt.sealed_publication.selection_sha256, digest(stateBytes));
        assert.deepEqual(receipt.promotion_intent, expectedIntent);

        const assertRefused = (args, input = "") => {
          const result = spawnSync(installedHelper, args, {
            env: {}, input, encoding: "utf8", timeout: 30_000, maxBuffer: 8192,
          });
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0);
          assert.equal(JSON.parse(result.stdout).error.kind, "incompatible_store");
        };
        assertRefused(["read-only-local", dbPath], '{"operation":"application_schema"}\n');
        if (launcherSealedServingProof) {
          const served = spawnSync(path.join(target, "t3"), ["serve", "--host", "127.0.0.1", "--port", "48124", "--no-browser"], {
            cwd: target,
            env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", T3CODE_HOME: home,
              T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_TELEMETRY_ENABLED: "false" },
            input: "", encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL",
          });
          assert.equal(served.error?.code, undefined, "Sealed serve must exit before the process deadline");
          assert.equal(served.status, 1, "The packaged serve path must refuse the published sealed database");
          assert.ok(`${served.stdout}${served.stderr}`.includes("Native database rejected the request with incompatible_store."),
            "The packaged process must reject the sealed store through native startup");
          await assert.rejects(fs.stat(path.join(f.userdata, "server-runtime.json")), { code: "ENOENT" });
          await assert.rejects(fs.stat(path.join(f.userdata, "statev2.sqlite")), { code: "ENOENT" });
          assert.equal((await fs.stat(dbPath, { bigint: true })).ino, stageIdentity.ino);
          assert.deepEqual(await fs.readFile(dbPath), stageBytes);
          assert.deepEqual(await fs.readFile(previousPath), sourceBytes);
          assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
          assert.deepEqual(await fs.readFile(f.statePath), stateBytes);
          assert.deepEqual(JSON.parse(await fs.readFile(observationPath, "utf8")), receipt);
          t.diagnostic("Packaged serve refused the sealed catalog without publishing runtime state or modifying the database.");
        }
        const [retry] = runHelper(publish, undefined, installedHelper);
        assert.deepEqual(retry, { ...publication, reused: true });

        if (launcherSealedServingProof) {
          await reopenPreviousRuntime(failedPath);
          assertRefused(publish);
          t.diagnostic("The packaged launcher rolled back the published sealed trial and reopened the previous runtime.");
          return;
        }

        runHelper(["trial-rollback-sealed", home, id], undefined, installedHelper);
        assert.equal((await fs.stat(dbPath, { bigint: true })).ino, sourceIdentity.ino);
        assert.equal((await fs.stat(failedPath, { bigint: true })).ino, stageIdentity.ino);
        assert.deepEqual(await fs.readFile(dbPath), sourceBytes);
        assert.deepEqual(await fs.readFile(failedPath), stageBytes);
        assert.deepEqual(await fs.readFile(f.statePath), stateBytes);
        assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
        assert.deepEqual(await fs.readFile(backupReceipt), backupReceiptBytes);
        assert.equal(JSON.parse(await fs.readFile(observationPath, "utf8")).sealed_publication.phase, "rolled_back");
        const [sourceReceipt] = runHelper(["read-only-local", dbPath], [
          { operation: "receipt", command_id: commandId },
        ], installedHelper);
        assert.deepEqual(sourceReceipt, seeded[3]);
        assertRefused(publish);
        await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
        await assert.rejects(fs.stat(path.join(f.userdata, "server-runtime.json")), { code: "ENOENT" });
        t.diagnostic("Packaged native helper published, verified the serving fence, and restored the original sealed-trial source.");
      }
      if (launcherCancelProof) {
        assert.equal(JSON.parse(await fs.readFile(observationPath, "utf8")).sealed_publication, undefined);
        await reopenPreviousRuntime(trial);
        t.diagnostic("Cancelled the unstarted promotion and reopened the exact previous packaged server.");
      }
      return;
    }
    for (const valid of [false, true]) {
      const input = { request, preparation: valid ? prepared : {
        ...prepared, file_sha256: "0".repeat(64),
      } };
      const outcome = spawnSync(candidate, ["__service-prepare-isolated", home, id], {
        env: {}, input: JSON.stringify(input) + "\n", encoding: "utf8",
        timeout: 65_000, maxBuffer: 8192, killSignal: "SIGKILL",
      });
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.status, valid ? 0 : 1, outcome.stderr);
      if (valid) {
        assert.equal(outcome.stderr, "");
        assert.deepEqual(JSON.parse(outcome.stdout), {
          protocol: 1, status: "prepared-isolated", updateId: id, preparation: prepared,
        });
      } else {
        assert.equal(outcome.stdout, "");
        assert.match(outcome.stderr, /failed verification/u);
      }
      const sourceAfter = await fs.stat(dbPath, { bigint: true });
      const stageAfter = await fs.stat(trial, { bigint: true });
      const stateAfter = await fs.stat(f.statePath, { bigint: true });
      assert.equal(sourceAfter.ino, sourceIdentity.ino);
      assert.equal(sourceAfter.mtimeNs, sourceIdentity.mtimeNs);
      assert.equal(stageAfter.ino, stageIdentity.ino);
      assert.equal(stageAfter.mtimeNs, stageIdentity.mtimeNs);
      assert.equal(stateAfter.ino, stateIdentity.ino);
      assert.equal(stateAfter.mtimeNs, stateIdentity.mtimeNs);
      assert.deepEqual(await fs.readFile(dbPath), sourceBytes);
      assert.deepEqual(await fs.readFile(trial), stageBytes);
      assert.deepEqual(await fs.readFile(f.statePath), stateBytes);
      assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
      assert.deepEqual(await fs.readFile(backupReceipt), backupReceiptBytes);
      await assert.rejects(fs.stat(f.starts), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(f.userdata, "server-runtime.json")), { code: "ENOENT" });
    }
  }
  const [published] = runHelper(["trial-publish-sealed", home, id]);
  assert.deepEqual(published.activation, activation);
  assert.deepEqual(published.database, prepared.database);
  const sealedIdentity = await fs.stat(dbPath, { bigint: true });
  const sealedBytes = await fs.readFile(dbPath);
  assert.notEqual(sealedIdentity.ino, sourceIdentity.ino);
  const physicalReceipt = path.join(f.userdata, `.statev2-trial-${id}.receipt-v1.json`);
  const receiptBytes = await fs.readFile(physicalReceipt);
  const expectedState = { ...initial, update: {
    id, fromVersion: activeVersion, targetVersion, status: "rolled-back", reason: "sealed-trial-recovery",
  } };
  let committedStateIdentity;
  for (const restart of [false, true]) {
    await fs.rm(ready, { force: true });
    const launcher = f.launcher(restart ? expectedState : pending, {
      T3_CODE_LS_SEALED_TRIAL_RECOVERY: "1",
    });
    const running = launcher.run().then(() => "completed", (error) => error.message);
    try {
      const context = await readReply(ready, running, 6000);
      assert.equal(context.protocol, SERVICE_LAUNCHER_PROTOCOL);
      assert.equal(context.childVersion, activeVersion);
      assert.deepEqual(await readServiceState(f.statePath), expectedState);
      const restored = await fs.stat(dbPath, { bigint: true });
      assert.equal(restored.dev, sourceIdentity.dev);
      assert.equal(restored.ino, sourceIdentity.ino);
      assert.deepEqual(await fs.readFile(dbPath), sourceBytes);
      const stateIdentity = await fs.stat(f.statePath, { bigint: true });
      if (restart) {
        assert.equal(stateIdentity.ino, committedStateIdentity.ino);
        assert.equal(stateIdentity.mtimeNs, committedStateIdentity.mtimeNs);
      } else committedStateIdentity = stateIdentity;
    } finally {
      await launcher.stop("SIGTERM");
      await running;
    }
  }
  const failed = path.join(f.userdata, `.statev2-failed-sealed-${id}.omdb`);
  assert.equal((await fs.stat(failed, { bigint: true })).ino, sealedIdentity.ino);
  assert.deepEqual(await fs.readFile(failed), sealedBytes);
  assert.deepEqual(await fs.readFile(checkpoint), checkpointBytes);
  assert.deepEqual(await fs.readFile(backupReceipt), backupReceiptBytes);
  assert.deepEqual(await fs.readFile(physicalReceipt), receiptBytes);
  assert.equal(await fs.readFile(f.starts, "utf8"), `${activeVersion}\n${activeVersion}\n`);
  const [restoredReceipt] = runHelper(["read-only-local", dbPath], [
    { operation: "receipt", command_id: commandId }, { operation: "shutdown" },
  ]);
  assert.deepEqual(restoredReceipt, seeded[3]);
  t.diagnostic(JSON.stringify({ helperBytes, helperSha256, sourceSha256: digest(sourceBytes),
    sealedSha256: digest(sealedBytes), checkpointSha256: digest(checkpointBytes),
    preparedCandidateProcess: preparationEntry !== undefined,
    restoredOriginalInode: true, selectedPreviousRuntime: true, restartPreservedSelection: true }));
});

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
