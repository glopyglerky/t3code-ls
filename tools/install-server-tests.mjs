#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const manifests = NodeURL.fileURLToPath(new URL("./server-test-runtime/", import.meta.url));
const runtime = process.env.T3_CODE_LS_TEST_RUNTIME ?? manifests;
if (runtime !== manifests) {
  await NodeFSP.mkdir(runtime, { recursive: true });
  for (const name of ["package.json", "package-lock.json"])
    await NodeFSP.copyFile(NodePath.join(manifests, name), NodePath.join(runtime, name));
}
NodeChildProcess.execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: runtime,
  stdio: "inherit",
});

// Production adapters and recovery imports reach Markdown and provider SDKs.
// Apply the same pinned patches as the workspace installation before importing.
const lock = JSON.parse(
  await NodeFSP.readFile(NodePath.join(runtime, "package-lock.json"), "utf8"),
);
const patches = [
  ["@cursor/sdk"],
  ["@effect/platform-node-shared"],
  ["@ff-labs/fff-node"],
  ["node-pty"],
  ["mdast-util-math"],
  ["micromark-extension-llm-math", "micromark-extension-math"],
  ["micromark-extension-gfm-table"],
  ["micromark"],
  ["mdast-util-to-hast"],
  ["@muse-code/sdk"],
];
for (const [name, installedName = name] of patches) {
  const directory = NodePath.join(runtime, "node_modules", installedName);
  const manifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
  );
  const version = lock.packages["node_modules/" + installedName]?.version;
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
  ) {
    throw new Error(`Unexpected ${name} locked test dependency`);
  }
  NodeChildProcess.execFileSync(
    "patch",
    [
      "--batch",
      "--forward",
      "-p1",
      "-i",
      NodePath.join(root, "patches", `${name.replace("/", "__")}@${version}.patch`),
    ],
    {
      cwd: directory,
      stdio: "inherit",
    },
  );
}

async function linkIfMissing(name, target) {
  const link = NodePath.join(root, "node_modules", name);
  try {
    await NodeFSP.lstat(link);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await NodeFSP.mkdir(NodePath.join(link, ".."), { recursive: true });
  await NodeFSP.symlink(target, link, "dir");
}

const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(runtime, "package.json"), "utf8"));
for (const name of Object.keys(manifest.dependencies)) {
  await linkIfMissing(name, NodePath.join(runtime, "node_modules", name));
}

// The targeted checker follows real workspace types, including settings schemas
// for the other providers. No replacement declarations or mock packages are used.
for (const entry of await NodeFSP.readdir(NodePath.join(root, "packages"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const directory = NodePath.join(root, "packages", entry.name);
  let workspace;
  try {
    workspace = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await linkIfMissing(workspace.name, directory);
}
console.log(
  "Installed locked server integration test dependencies and linked actual workspace sources.",
);
