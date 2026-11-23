import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

const entry = new URL("../apps/server/src/bin.ts", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../apps/server/package.json", import.meta.url)));
// The source fixture models the bootstrap boundary, not a built SEA. The
// embedded application would fail if evaluated; only its raw bytes may be read.
const stateUrl = "data:text/javascript," + encodeURIComponent("export const state = {};");
const { state } = await import(stateUrl);
const seaUrl = "data:text/javascript," + encodeURIComponent(`
  import { state } from ${JSON.stringify(stateUrl)};
  export function isSea() { state.seaChecks++; return state.sea; }
  export function getRawAsset(name) {
    state.assets.push(name);
    if (state.missing) throw new Error('missing embedded asset');
    return state.asset;
  }
`);
const entrypointUrl = "data:text/javascript," + encodeURIComponent(`
  import { state } from ${JSON.stringify(stateUrl)};
  export function isEntrypoint() { return state.entrypoint; }
`);

test("early SEA identity stays outside the application graph", async (t) => {
  const embedded = new TextEncoder().encode("throw new Error('application must not start');\n");
  let sequence = 0;
  async function run(options = {}) {
    Object.assign(state, {
      sea: true, entrypoint: true, missing: false, seaChecks: 0, assets: [],
      asset: embedded.buffer, ...options,
    });
    const argv = process.argv;
    const exitCode = process.exitCode;
    const write = process.stdout.write;
    const stdoutErrors = process.stdout.listeners("error");
    const stderrErrors = process.stderr.listeners("error");
    let output = "";
    const unexpected = [];
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL?.startsWith(entry.href)) {
          if (specifier === "node:sea") return { url: seaUrl, shortCircuit: true };
          if (specifier === "./entrypoint.ts") return { url: entrypointUrl, shortCircuit: true };
          if (!["node:module", "node:timers", "node:url", "node:crypto", "../package.json"].includes(specifier)) {
            unexpected.push(specifier);
            throw new Error(`Unexpected bootstrap dependency: ${specifier}`);
          }
        }
        return next(specifier, context);
      },
    });
    try {
      process.argv = [process.execPath, "/sealed-fixture/t3", "__sea-identity", ...(options.args ?? [])];
      process.exitCode = undefined;
      process.stdout.write = (chunk, callback) => {
        if (options.outputFailure) throw new Error("closed observation pipe");
        if (options.outputCallbackFailure) {
          callback(new Error("closed observation pipe"));
          return false;
        }
        output += chunk;
        callback?.();
        return true;
      };
      await import(`${entry.href}?sea-identity-fixture=${sequence++}`);
      return { output, code: process.exitCode, unexpected };
    } finally {
      hooks.deregister();
      process.stdout.write = write;
      process.argv = argv;
      process.exitCode = exitCode;
      for (const [stream, original] of [[process.stdout, stdoutErrors], [process.stderr, stderrErrors]]) {
        for (const listener of stream.listeners("error")) {
          if (!original.includes(listener)) stream.removeListener("error", listener);
        }
      }
    }
  }

  await t.test("reports actual package identity and raw asset without evaluating it", async () => {
    const result = await run();
    assert.equal(result.code, undefined);
    assert.deepEqual(result.unexpected, []);
    assert.deepEqual(state.assets, ["binMain.mjs"]);
    assert.equal(result.output.split("\n").length, 2);
    assert.ok(Buffer.byteLength(result.output) <= 4096);
    assert.deepEqual(JSON.parse(result.output), {
      protocol: "t3-sea-identity-v1", packageName: packageJson.name,
      packageVersion: packageJson.version, pid: process.pid,
      platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
      sea: true, assetName: "binMain.mjs", assetBytes: embedded.byteLength,
      assetSha256: createHash("sha256").update(embedded).digest("hex"), serving: false,
    });
  });
  for (const [name, options] of [
    ["non-SEA", { sea: false }],
    ["extra argument", { args: ["--help"] }],
    ["asset override", { args: ["other.mjs"] }],
    ["missing asset", { missing: true }],
    ["empty asset", { asset: new ArrayBuffer(0) }],
    ["oversized asset", { asset: new ArrayBuffer(128 * 1024 * 1024 + 1) }],
    ["output failure", { outputFailure: true }],
    ["asynchronous output failure", { outputCallbackFailure: true }],
  ]) {
    await t.test(`refuses ${name} without CLI fallback`, async () => {
      const result = await run(options);
      assert.equal(result.code, 78);
      assert.equal(result.output, "");
      assert.deepEqual(result.unexpected, []);
      if (!state.sea || options.args) assert.deepEqual(state.assets, []);
    });
  }
  await t.test("importing the bootstrap does not run the probe", async () => {
    const result = await run({ entrypoint: false });
    assert.equal(result.code, undefined);
    assert.equal(result.output, "");
    assert.equal(state.seaChecks, 0);
    assert.deepEqual(state.assets, []);
    assert.deepEqual(result.unexpected, []);
  });
});
