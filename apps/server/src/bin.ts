// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import packageJson from "../package.json" with { type: "json" };
import { isEntrypoint } from "./entrypoint.ts";

// This observation must not evaluate the embedded CLI or resolve sidecars.
// It supplies no readiness, database, selection or lease-transfer authority.
async function runSeaIdentityProbe(observe = false): Promise<void> {
  if (process.argv.length !== 3 || !NodeSea.isSea()) {
    process.exitCode = 78;
    return;
  }
  try {
    const asset = new Uint8Array(NodeSea.getRawAsset("binMain.mjs"));
    // Refuse oversized input before hashing. This is a probe budget, not a
    // packaging limit or permission to load a different asset.
    if (
      asset.byteLength === 0 ||
      asset.byteLength > 128 * 1024 * 1024 ||
      packageJson.name.length > 128 ||
      packageJson.version.length > 128
    ) {
      process.exitCode = 78;
      return;
    }
    const { createHash } = await import("node:crypto");
    const frame =
      JSON.stringify({
        protocol: observe ? "t3-sea-identity-observe-v1" : "t3-sea-identity-v1",
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        sea: true,
        assetName: "binMain.mjs",
        assetBytes: asset.byteLength,
        assetSha256: createHash("sha256").update(asset).digest("hex"),
        serving: false,
      }) + "\n";
    if (observe) {
      await holdSeaIdentityObservation(frame);
    } else {
      process.stdout.write(frame, (error) => {
        if (error) process.exitCode = 78;
      });
    }
  } catch {
    process.exitCode = 78;
  }
}

// The parent must inspect its owned child's image before sending finish + EOF.
// This frame is untrusted identity, never proof of running image or readiness.
async function holdSeaIdentityObservation(frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const expected = Buffer.from("finish\n");
    let received = 0;
    let ended = false;
    let flushed = false;
    let settled = false;
    const input = process.stdin;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", fail);
      input.removeListener("close", close);
      process.stdout.removeListener("error", fail);
      input.destroy();
      if (ok) resolve();
      else reject(new Error("SEA observation refused"));
    };
    const fail = () => finish(false);
    const complete = () => {
      if (ended && flushed) finish(received === expected.length);
    };
    const data = (chunk: Buffer) => {
      if (
        chunk.length > expected.length - received ||
        !chunk.equals(expected.subarray(received, received + chunk.length))
      ) {
        fail();
        return;
      }
      received += chunk.length;
    };
    const end = () => {
      ended = true;
      complete();
    };
    const close = () => {
      if (!ended) fail();
    };
    // Separate from the future parent's deadline. Even a lost finish or blocked
    // output callback refuses without loading the application. Not a reap proof.
    // @effect-diagnostics-next-line globalTimers:off -- The bootstrap deadline must run before the application runtime loads.
    const timer = setTimeout(fail, 5000);
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    input.once("close", close);
    process.stdout.once("error", fail);
    try {
      process.stdout.write(frame, (error) => {
        if (error) fail();
        else {
          flushed = true;
          complete();
        }
      });
    } catch {
      fail();
    }
  });
}

// Loads the CLI outside the launcher's module graph. Packaged builds embed it as a raw asset.
async function loadCliMain(): Promise<typeof import("./binMain.ts")> {
  if (!NodeSea.isSea()) return import("./binMain.ts");

  // Keep the executable's module URL so the CLI finds the web client and native packages beside it.
  const require = NodeModule.createRequire(import.meta.url);
  // require() resolves links in the executable path, such as a Windows junction.
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset("binMain.mjs")),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as typeof import("./binMain.ts");
  } finally {
    hook.deregister();
  }
}

function ignoreOutputError(): void {}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Logs go to stdout and stderr, which may be a closed desktop launcher pipe or a log file on
  // a full disk. Node emits a failed write as an unhandled stream error that crashes the process
  // and skips shutdown, so drop the line instead.
  process.stdout.on("error", ignoreOutputError);
  process.stderr.on("error", ignoreOutputError);

  if (process.argv[2] === "__sea-identity") {
    await runSeaIdentityProbe();
  } else if (process.argv[2] === "__sea-identity-observe") {
    await runSeaIdentityProbe(true);
  } else {
    // The launcher owns shutdown until its child exits, so it bypasses the Effect CLI runtime.
    // A service unit passes nothing, or on Windows the launcher's own flags; help and anything
    // else go through the full CLI.
    const launcher =
      process.argv[2] === "__service-launcher" ? await import("./cli/serviceLauncher.ts") : undefined;
    const launcherOptions = launcher?.parseServiceLauncherArgs(process.argv.slice(3));
    if (launcher !== undefined && launcherOptions !== undefined) {
      await launcher.runServiceLauncherCli(launcherOptions);
    } else {
      const { runCliCommand } = await loadCliMain();
      await runCliCommand();
    }
  }
}
