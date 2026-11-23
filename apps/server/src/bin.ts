// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import packageJson from "../package.json" with { type: "json" };
import { isEntrypoint } from "./entrypoint.ts";

// This observation must not evaluate the embedded CLI or resolve sidecars.
// It supplies no readiness, database, selection or lease-transfer authority.
async function runSeaIdentityProbe(): Promise<void> {
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
    process.stdout.write(
      JSON.stringify({
        protocol: "t3-sea-identity-v1",
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
      }) + "\n",
      (error) => {
        if (error) process.exitCode = 78;
      },
    );
  } catch {
    process.exitCode = 78;
  }
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
