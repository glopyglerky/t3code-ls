import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const proofDirectory = process.argv[2];
Assert.equal(process.platform, "linux", "Run the proof on its Linux hosted lane");
Assert.equal(process.arch, "x64");
Assert.ok(proofDirectory && Path.isAbsolute(proofDirectory), "Pass a fresh absolute proof directory");
await FS.mkdir(proofDirectory);
const work = await FS.mkdtemp(Path.join(process.env.RUNNER_TEMP ?? OS.tmpdir(), "t3-relay-workerd-"));
const sha256 = (bytes) => Crypto.createHash("sha256").update(bytes).digest("hex");
const state = { protocol: 1, status: "failed", checkpoints: [] };
let child;
let childExit;
let logs = "";
let failure;
let bundler;
const stop = async () => {
  if (child === undefined) return;
  const active = child;
  if (active.exitCode === null && active.signalCode === null) active.kill("SIGTERM");
  const forced = setTimeout(() => active.kill("SIGKILL"), 5_000);
  try { await childExit.catch((error) => capture(String(error))); }
  finally { clearTimeout(forced); child = undefined; }
};
const capture = (chunk) => { logs = (logs + chunk.toString()).slice(-65_536); };
const checkpoint = (name) => state.checkpoints.push(name);
const cancellation = new AbortController();
const cancel = () => {
  cancellation.abort(new Error("The owned Workerd proof was interrupted"));
  child?.kill("SIGTERM");
  bundler?.stop();
};
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
try {
  const packageDirectory = Path.join(root, "node_modules/.pnpm/@cloudflare+workerd-linux-64@1.20261026.1/node_modules/@cloudflare/workerd-linux-64");
  const binary = Path.join(packageDirectory, "bin/workerd");
  Assert.equal(JSON.parse(await FS.readFile(Path.join(packageDirectory, "package.json"))).version, "1.20261026.1");
  const esbuildDirectory = Path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild");
  const esbuild = createRequire(import.meta.url)(Path.join(esbuildDirectory, "lib/main.js"));
  bundler = esbuild;
  Assert.equal(esbuild.version, "0.28.2");
  const version = spawnSync(binary, ["--version"], { env: {}, encoding: "utf8", timeout: 5_000, maxBuffer: 8192 });
  Assert.equal(version.error, undefined);
  Assert.equal(version.status, 0, version.stderr);
  Assert.match(version.stdout, /2026-10-26|1\.20261026\.1/u);
  Object.assign(state, {
    workerdVersion: version.stdout.trim(), esbuildVersion: esbuild.version,
    workerdSha256: sha256(await FS.readFile(binary)),
    lockSha256: sha256(await FS.readFile(Path.join(root, "pnpm-lock.yaml"))),
    storeSha256: sha256(await FS.readFile(Path.join(root, "infra/relay/src/hooks/HookInboxStore.ts"))),
    transactionSha256: sha256(await FS.readFile(Path.join(root, "infra/relay/src/hooks/HookInboxTransaction.ts"))),
  });
  const bundle = Path.join(work, "worker.mjs");
  await esbuild.build({
    entryPoints: [Path.join(root, "infra/relay/scripts/fixtures/hook-inbox-workerd.mjs")],
    outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2023",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
    logLevel: "warning", metafile: true,
  }).then(async ({ metafile }) => {
    const inputs = Object.keys(metafile.inputs);
    Assert.ok(inputs.some((name) => name.endsWith("hooks/HookInboxStore.ts")));
    Assert.ok(inputs.some((name) => name.endsWith("hooks/HookInboxTransaction.ts")));
    Assert.ok(inputs.some((name) => name.includes("sql-sqlite-do")));
    state.bundleInputs = inputs.length;
  });
  esbuild.stop();
  state.bundleSha256 = sha256(await FS.readFile(bundle));
  const storage = Path.join(work, "storage");
  await FS.mkdir(storage);
  const server = Net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const config = Path.join(work, "config.capnp");
  await FS.writeFile(config, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "inbox", worker = (
      compatibilityDate = "2026-10-26",
      compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      durableObjectNamespaces = [(className = "InboxProbe", uniqueKey = "synthetic-relay-inbox-v1", enableSql = true)],
      durableObjectStorage = (localDisk = "storage"),
      bindings = [(name = "INBOX", durableObjectNamespace = "InboxProbe")]
    )),
    (name = "storage", disk = (path = ${JSON.stringify(storage)}, writable = true)),
    (name = "internet", network = (allow = []))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "inbox")]
);
`);
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, body, expected = 200, timeout = 5_000) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), cancellation.signal]),
    });
    Assert.equal(response.status, expected, (await response.clone().text()).slice(0, 8192));
    const value = await response.json();
    Assert.equal(value.protocol, "t3-relay-inbox-workerd-v1");
    if (value.alarmRuns !== undefined) Assert.equal(value.alarmRuns, 0);
    return value;
  };
  const start = async () => {
    cancellation.signal.throwIfAborted();
    child = spawn(binary, ["serve", "--experimental", config], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    childExit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    // Observe early child failure while the bounded readiness loop is running.
    childExit.catch(() => {});
    const deadline = Date.now() + 15_000;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Workerd exited before readiness");
      try { return await request("/inspect", undefined, 200, 500); } catch (error) {
        if (!(error instanceof TypeError) && error?.name !== "TimeoutError") throw error;
        if (attempt === 99 || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  const body = (id, offset, failAt = "none") => ({ id, offset, failAt, target: `https://${id}.invalid/` });
  const empty = await start();
  Assert.deepEqual(empty.state, { held: [], target: [], alarm: null });
  checkpoint("real-workerd-sqlite-empty");
  const first = await request("/hold", body("first", 0));
  Assert.equal(first.accepted, true);
  Assert.equal(first.state.held.length, 1);
  Assert.equal(first.state.held[0].body, "00FF0A");
  Assert.equal(first.state.held[0].raw_token, "synthetic%2Ftoken");
  Assert.equal(first.state.target[0].base_url, "https://first.invalid/");
  Assert.equal(first.state.alarm, Date.UTC(2035, 0, 1) + 10_000);
  checkpoint("production-hold-target-alarm-committed");
  for (const failAt of ["state", "alarm"]) {
    const refused = await request("/hold", body("second", -60_000, failAt), 409);
    Assert.equal(refused.fault, failAt);
    Assert.deepEqual(refused.staged.held.map(({ id }) => id), ["first", "second"]);
    Assert.equal(refused.staged.target[0].base_url, "https://second.invalid/");
    Assert.equal(refused.staged.alarm, first.state.alarm - (failAt === "alarm" ? 60_000 : 0));
    Assert.deepEqual(refused.state, first.state);
    Assert.deepEqual((await request("/inspect")).state, first.state);
    checkpoint(`native-rollback-after-${failAt}-staging`);
  }
  const retried = await request("/hold", body("second", -60_000));
  Assert.equal(retried.accepted, true);
  Assert.deepEqual(retried.state.held.map(({ id }) => id), ["first", "second"]);
  Assert.equal(retried.state.target[0].base_url, "https://second.invalid/");
  Assert.equal(retried.state.alarm, first.state.alarm - 60_000);
  const duplicate = await request("/hold", body("second", -60_000));
  Assert.equal(duplicate.accepted, false);
  Assert.deepEqual(duplicate.state, retried.state);
  checkpoint("same-delivery-retry-and-duplicate");
  await stop();
  const reopened = await start();
  Assert.notEqual(reopened.bootId, empty.bootId);
  Assert.deepEqual(reopened.state, retried.state);
  checkpoint("disk-state-survives-owned-workerd-restart");
  const failedAfterReopen = await request("/hold", body("third", -120_000, "alarm"), 409);
  Assert.deepEqual(failedAfterReopen.state, retried.state);
  Assert.equal((await request("/hold", body("third", -120_000))).accepted, true);
  checkpoint("rollback-and-retry-after-restart");
  cancellation.signal.throwIfAborted();
  state.status = "passed";
} catch (error) {
  state.failure = error instanceof Error ? error.message : String(error);
  failure = error;
} finally {
  bundler?.stop();
  await stop();
  await FS.writeFile(Path.join(proofDirectory, "workerd.log"), logs);
  await FS.writeFile(Path.join(proofDirectory, "proof.json"), JSON.stringify(state, null, 2) + "\n");
  await FS.rm(work, { recursive: true, force: true });
  process.off("SIGTERM", cancel);
  process.off("SIGINT", cancel);
}
if (failure !== undefined) throw failure;
console.log(JSON.stringify(state));
