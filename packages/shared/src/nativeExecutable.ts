/* oxlint-disable t3code/no-global-process-runtime -- Synchronous executable paths and standalone build scripts have no Effect runtime. */
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off -- Executable selection uses host paths in source and bundled distributions.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const hostGlibcVersion = (() => {
  try {
    const report = process.report.getReport();
    if (!("header" in report) || typeof report.header !== "object" || report.header === null)
      return undefined;
    if (!("glibcVersionRuntime" in report.header)) return undefined;
    const version = report.header.glibcVersionRuntime;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
})();

export function isQualifiedNativeHost(
  platform: NodeJS.Platform = NodeOS.platform(),
  architecture: string = NodeOS.arch(),
  glibcVersion: string | undefined = hostGlibcVersion,
): boolean {
  if (platform !== "linux" || architecture !== "x64" || glibcVersion === undefined) return false;
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(glibcVersion);
  return (
    match !== null && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 39))
  );
}

function packageUsesUpstream(
  executable: string,
  platform: NodeJS.Platform,
  architecture: string,
): boolean {
  const manifestPath = NodePath.join(NodePath.dirname(executable), "manifest.json");
  if (!NodeFS.existsSync(manifestPath)) return false;
  const manifest: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("Invalid native implementation manifest");
  if (!("implementation" in manifest) || manifest.implementation === "native") {
    return false;
  }
  if (
    manifest.implementation !== "upstream" ||
    !("target" in manifest) ||
    manifest.target !== `${platform}-${architecture}` ||
    !("selection" in manifest) ||
    !["explicit-upstream", "unqualified-platform", "incompatible-host-libc"].includes(
      String(manifest.selection),
    ) ||
    !("upstreamCommit" in manifest) ||
    typeof manifest.upstreamCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) ||
    !("files" in manifest) ||
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    Array.isArray(manifest.files) ||
    Object.keys(manifest.files).length !== 0
  )
    throw new Error("Invalid upstream implementation manifest");
  return true;
}

export function selectNativeExecutable(
  component: string,
  override?: string,
  platform: NodeJS.Platform = NodeOS.platform(),
  architecture: string = NodeOS.arch(),
  implementation: string | null | undefined = process.env.T3_CODE_LS_IMPLEMENTATION,
  bundledDirectory?: string,
): string | undefined {
  if (implementation != null && implementation !== "upstream" && implementation !== "native")
    throw new Error("T3_CODE_LS_IMPLEMENTATION must be upstream or native");
  // The adapter validates an explicit selection through its own error contract.
  if (override !== undefined) return override;
  if (implementation === "upstream") return undefined;
  if (!isQualifiedNativeHost(platform, architecture)) {
    if (implementation === "native")
      throw new Error("The native implementation is not qualified for this host");
    return undefined;
  }
  const executable = nativeExecutable(component, undefined, bundledDirectory);
  if (implementation !== "native" && packageUsesUpstream(executable, platform, architecture))
    return undefined;
  return executable;
}

export function nativeExecutable(
  component: string,
  override?: string,
  bundledDirectory?: string,
): string {
  if (override !== undefined) {
    if (!NodePath.isAbsolute(override) || override.trim() !== override)
      throw new Error("Native executable override must be an absolute path");
    return override;
  }
  const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)).replace(
    /\.asar([\\/])/,
    ".asar.unpacked$1",
  );
  const source = directory.endsWith(NodePath.join("packages", "shared", "src"));
  return NodePath.resolve(
    bundledDirectory ?? NodePath.resolve(directory, source ? "../../../bin" : "native-bin"),
    `t3-code-ls-${component}${NodeOS.platform() === "win32" ? ".exe" : ""}`,
  );
}

/** Verify an optional Linux sidecar before selecting its package-owned path. */
export async function verifyBundledNativeExecutable(component: string, executable: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/.test(component) || !NodePath.isAbsolute(executable) ||
    NodePath.basename(executable) !== `t3-code-ls-${component}`) {
    throw new Error("Invalid bundled native helper identity");
  }
  const flags = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
  const manifestPath = NodePath.join(NodePath.dirname(executable), "manifest.json");
  const manifestFile = await NodeFS.promises.open(manifestPath, flags);
  let manifest;
  try {
    const before = await manifestFile.stat();
    if (!before.isFile() || before.size > 1_048_576) throw new Error("Invalid native helper manifest");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of manifestFile.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 1_048_576) throw new Error("Native helper manifest exceeds its bound");
      chunks.push(chunk);
    }
    const after = await NodeFS.promises.lstat(manifestPath);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Native helper manifest changed during verification");
    }
    manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await manifestFile.close(); }
  const declared = manifest?.files?.[`t3-code-ls-${component}`];
  if (manifest?.target !== "linux-x64" || manifest.rustTarget !== "x86_64-unknown-linux-gnu" ||
    (manifest.implementation !== undefined && manifest.implementation !== "native") ||
    typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared)) {
    throw new Error("The bundled native manifest does not select this helper");
  }
  const helper = await NodeFS.promises.open(executable, flags);
  try {
    const before = await helper.stat();
    if (!before.isFile() || before.size > 134_217_728) throw new Error("Invalid bundled native helper");
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of helper.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 134_217_728) throw new Error("Bundled native helper exceeds its bound");
      hash.update(chunk);
    }
    const after = await NodeFS.promises.lstat(executable);
    if (hash.digest("hex") !== declared || !after.isFile() || before.dev !== after.dev ||
      before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs) {
      throw new Error("The bundled native helper does not match its manifest");
    }
    await NodeFS.promises.access(executable, NodeFS.constants.X_OK);
  } finally { await helper.close(); }
}
