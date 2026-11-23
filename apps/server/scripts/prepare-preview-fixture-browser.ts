// @effect-diagnostics nodeBuiltinImport:off - hosted synthetic application fixture preparation.
import * as FS from "node:fs";
import * as Path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { makePreviewBrowser } from "../src/preview/PreviewBrowser.ts";

// Run before the network-isolated application case. Use the production installer,
// including its source-pinned archive hash and safe extraction, without a server.
const destination = process.argv[2];
if (!destination || !Path.isAbsolute(destination)) throw new Error("An absolute fresh fixture directory is required.");
FS.mkdirSync(destination);
const executable = await Effect.runPromise(Effect.gen(function* () {
  const browser = yield* makePreviewBrowser({ baseDir: destination });
  return yield* browser.executable;
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));
const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
if (!version.includes(Path.basename(Path.dirname(executable)))) throw new Error("Installed browser version mismatch.");
const receipt = {
  source: "PreviewBrowser", platform: process.platform, architecture: process.arch,
  executable: Path.relative(destination, executable),
  executableSha256: createHash("sha256").update(FS.readFileSync(executable)).digest("hex"), version,
};
FS.writeFileSync(Path.join(destination, "preview-browser.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
