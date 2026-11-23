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
const work = await FS.mkdtemp(Path.join(process.env.RUNNER_TEMP ?? OS.tmpdir(), "t3-cache-http-workerd-"));
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
    cacheSha256: sha256(await FS.readFile(Path.join(root, "infra/task-cache/src/Cache.ts"))),
  });
  const bundle = Path.join(work, "worker.mjs");
  await esbuild.build({
    entryPoints: [Path.join(root, "infra/task-cache/scripts/fixtures/cache-http-workerd.mjs")],
    outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2023",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
    logLevel: "warning", metafile: true,
  }).then(async ({ metafile }) => {
    const inputs = Object.keys(metafile.inputs);
    for (const suffix of ["src/Cache.ts", "src/store.ts", "src/fetch.ts", "src/database.ts"])
      Assert.ok(inputs.some(name => name.endsWith(suffix)), suffix);
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
      try { return; } catch (error) {
        if (!(error instanceof TypeError) && error?.name !== "TimeoutError") throw error;
        if (attempt === 99 || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  await start();
  const call = async (path, options = {}) => fetch(base + path, {
    ...options, signal: AbortSignal.any([AbortSignal.timeout(5_000), cancellation.signal]),
  });
  const migration = await FS.readFile(Path.join(root,
    "infra/task-cache/vendor/vite-plus-remote-cache-cloudflare/migrations/0001_cache.sql"), "utf8");
  // start() only spawns the child; bound connection retries to local startup.
  let setup;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { setup = await call("/fixture/setup", { method: "POST", body: migration }); break; }
    catch (error) {
      if (!(error instanceof TypeError) || attempt === 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  Assert.equal(setup.status, 200, await setup.text());
  const authorization = `Basic ${Buffer.from("fixture:synthetic-savings-token-012345678901234567890").toString("base64")}`;
  // Independent, bounded CBOR encoder for these short synthetic request/response fields.
  const envelope = fields => Buffer.concat([Buffer.from([0xa0 + fields.length]),
    ...fields.flatMap(([name, value]) => {
      const text = Buffer.from(name);
      const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      const major = typeof value === "string" ? 0x60 : 0x40;
      const header = bytes.length < 24 ? [major + bytes.length] : [major + 24, bytes.length];
      Assert.ok(bytes.length < 256);
      return [Buffer.from([0x60 + text.length]), text, Buffer.from(header), bytes];
    })]);
  const key = Buffer.from([0, 255]), secondary = Buffer.from([128]);
  const route = operation => `/projects/t3code/${operation}`;
  const upload = async (value, blob, target = key) => {
    const metadata = envelope([["key", target], ["secondary_key", secondary], ["value", value]]);
    const body = Buffer.concat([
      Buffer.from('--fixture\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/cbor\r\n\r\n'),
      metadata,
      Buffer.from('\r\n--fixture\r\nContent-Disposition: form-data; name="blob"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      blob, Buffer.from('\r\n--fixture--\r\n'),
    ]);
    return call(route("store"), { method: "POST", headers: { authorization,
      "content-type": "multipart/form-data; boundary=fixture" }, body });
  };
  const inspect = async () => (await call("/fixture/inspect")).json();
  const fetchValue = target => call(route("fetch"), { method: "POST", headers: {
    authorization, "content-type": "application/cbor" },
    body: envelope([["key", target], ["secondary_key", Buffer.from([129])]]) });
  const values = [Buffer.from([1, 0, 255]), Buffer.from([254, 0, 10])];
  const blobs = [Buffer.from([5, 0, 255, 1]), Buffer.from([128, 10, 0, 255])];
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const stored = await upload(values[i], blobs[i]);
    Assert.equal(stored.status, 200, await stored.clone().text());
    const snapshot = await inspect();
    const current = snapshot.generations.find(row => row.state === "ready");
    Assert.ok(current);
    ids.push(current.blob_id);
    Assert.deepEqual(Buffer.from(await stored.arrayBuffer()), envelope([["blob_id", current.blob_id]]));
    const fetched = await fetchValue(key);
    Assert.equal(fetched.status, 200);
    Assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),
      envelope([["kind", "exact"], ["value", values[i]], ["blob_id", ids[i]]]));
    const blob = await call(route(`blob/${ids[i]}`), { headers: { authorization } });
    Assert.equal(blob.status, 200);
    Assert.deepEqual(Buffer.from(await blob.arrayBuffer()), blobs[i]);
  }
  Assert.notEqual(ids[0], ids[1]);
  const before = await inspect();
  Assert.deepEqual(before.generations.map(row => row.state), ["retired", "ready"]);
  Assert.equal(before.entries.length, 1);
  Assert.equal(before.entries[0].generation_id, before.generations[1].generation_id);
  Assert.equal(before.objects, 4);
  Assert.equal((await call("/fixture/refuse", { method: "POST" })).status, 204);
  Assert.equal((await upload(Buffer.from([9]), Buffer.from([9]))).status, 403);
  Assert.equal((await upload(Buffer.from([9]), Buffer.from([9]), Buffer.from([77]))).status, 403);
  Assert.deepEqual(await inspect(), before);
  const winner = await fetchValue(key);
  Assert.equal(winner.status, 200);
  Assert.deepEqual(Buffer.from(await winner.arrayBuffer()),
    envelope([["kind", "exact"], ["value", values[1]], ["blob_id", ids[1]]]));
  const winnerBlob = await call(route(`blob/${ids[1]}`), { headers: { authorization } });
  Assert.equal(winnerBlob.status, 200);
  Assert.deepEqual(Buffer.from(await winnerBlob.arrayBuffer()), blobs[1]);
  Assert.equal((await fetchValue(Buffer.from([77]))).status, 404);
  Assert.equal((await call(route("blob/00000000-0000-0000-0000-000000000000"),
    { headers: { authorization } })).status, 404);
  checkpoint("http-same-key-winner-exact-value-and-blob");
  checkpoint("policy-refused-replacement-preserves-winner-and-missing-key");
  state.bindingScope = "Workerd SQLite D1 interface fixture; synthetic in-memory R2 fixture";
  state.productionSemanticsQualified = false;
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
