import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import * as Yaml from "yaml";
import { resolvePnpmVirtualStore } from "./pnpm-runtime-store.mjs";

const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export function parseLockDocuments(bytes) {
  return Yaml.parseAllDocuments(bytes.toString("utf8")).map((document) => {
    if (document.errors.length > 0) throw new Error(document.errors[0].message);
    return document.toJS();
  });
}

export function withinDirectory(directory, path) {
  const relative = NodePath.relative(directory, path);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
}

/** Check the installed application's complete lock, including transitive snapshots. */
export async function inspectInstalledRuntime(root, applicationLock) {
  const provenance = {
    status: "diagnostic-unverified",
    issues: [],
    package_manager: null,
    installed_lock_sha256: null,
    modules_metadata_sha256: null,
    installed_lock_matches_application_lock: false,
    node_executable_sha256: digest(await NodeFSP.readFile(NodeProcess.execPath)),
    external_packages_within_virtual_store: false,
  };
  let virtualStore = null;
  try {
    const installation = await resolvePnpmVirtualStore(root);
    const { metadata } = installation;
    const [lock, manifest] = await Promise.all([
      NodeFSP.readFile(NodePath.join(installation.virtualStore, "lock.yaml")),
      NodeFSP.readFile(NodePath.join(root, "package.json")),
    ]);
    provenance.installed_lock_sha256 = digest(lock);
    provenance.modules_metadata_sha256 = digest(metadata);
    const installedDocuments = parseLockDocuments(lock);
    const installed = installedDocuments.find((document) => document.importers?.["apps/server"]);
    provenance.installed_lock_matches_application_lock = NodeUtil.isDeepStrictEqual(
      installed,
      applicationLock,
    );
    if (!provenance.installed_lock_matches_application_lock)
      provenance.issues.push(
        "Installed pnpm application lock differs from the frozen source lock, including transitive resolutions.",
      );
    const modules = Yaml.parse(metadata.toString("utf8"));
    const sourceManifest = JSON.parse(manifest);
    provenance.package_manager = modules.packageManager ?? null;
    if (provenance.package_manager !== sourceManifest.packageManager)
      provenance.issues.push(
        "Installed package manager differs from the source packageManager pin.",
      );
    if (modules.nodeLinker !== "isolated" || typeof modules.virtualStoreDir !== "string")
      provenance.issues.push(
        "Qualification requires the application's configured isolated pnpm virtual store.",
      );
    else if (
      (await NodeFSP.realpath(NodePath.resolve(installation.modules, modules.virtualStoreDir))) !==
      installation.virtualStore
    )
      provenance.issues.push(
        "Installed pnpm virtual store metadata has conflicting interpretations.",
      );
    if (sourceManifest.engines?.node !== NodeProcess.version.slice(1))
      provenance.issues.push("Node runtime differs from the application's exact engine pin.");
    virtualStore = installation.virtualStore;
    provenance.virtual_store_scope = withinDirectory(await NodeFSP.realpath(root), virtualStore)
      ? "workspace"
      : "configured-external";
  } catch (error) {
    provenance.issues.push(
      `Installed pnpm provenance is unavailable: ${error.code ?? error.message}`,
    );
  }
  return { provenance, virtualStore };
}
