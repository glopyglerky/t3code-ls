#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  nativeArtifactFiles,
  nativeComponents,
  nativeFile,
  nativeHash,
} from "./native-artifacts.mjs";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const target = "linux-x64";
const compatibility = "bluefe-rustc-via-lustr";
const git = (...args) =>
  NodeChildProcess.execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
const json = (path) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
const sha = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function stageLustNative(base, receiptPath, artifacts, destination) {
  NodeAssert.ok(
    [base, receiptPath, artifacts, destination].every(NodePath.isAbsolute),
    "Use absolute paths for the base bundle, Lust receipt, artifacts and output.",
  );
  const commit = git("rev-parse", "HEAD").toString().trim();
  const tree = git("rev-parse", "HEAD^{tree}").toString().trim();
  NodeAssert.equal(
    git("status", "--porcelain", "--untracked-files=normal").length,
    0,
    "Stage a bundle from a clean source checkout.",
  );
  const baseManifest = NodeFS.readFileSync(NodePath.join(base, "manifest.json"));
  const manifest = JSON.parse(baseManifest);
  nativeArtifactFiles(base, target);
  NodeAssert.equal(manifest.source_commit, commit, "Base bundle source commit differs.");
  NodeAssert.equal(manifest.source_tree, tree, "Base bundle source tree differs.");
  NodeAssert.equal(manifest.source_tree_dirty, false);
  NodeAssert.equal(manifest.compiler_route, compatibility);
  NodeAssert.equal(manifest.build_profile, "release");
  NodeAssert.equal(
    manifest.toolchain_lock_sha256,
    nativeHash(NodePath.join(root, "toolchain.lock.json")),
  );

  const receiptBytes = NodeFS.readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  const pin = json(NodePath.join(root, "lust-toolchain.json"));
  const upstream = json(NodePath.join(root, "upstream.lock.json")).upstream.commit;
  NodeAssert.equal(receipt.schema, 1);
  NodeAssert.equal(receipt.status, "passed", "Lust proof must pass.");
  NodeAssert.equal(receipt.workspace_git_revision, commit, "Lust proof source commit differs.");
  NodeAssert.deepEqual(receipt.compiler, pin, "Lust compiler pins differ.");
  for (const key of ["compiler_binary_sha256", "compiler_core_sha256"]) {
    NodeAssert.match(receipt[key], /^[a-f0-9]{64}$/);
  }
  NodeAssert.ok(
    Object.hasOwn(receipt.inputs, "lust-toolchain.json"),
    "Lust proof omits its pin input.",
  );
  for (const [name, wanted] of Object.entries(receipt.inputs)) {
    const pinned = name.match(/^git:([a-f0-9]{40}):(.+)$/);
    const path = pinned?.[2] ?? name;
    NodeAssert.ok(
      !NodePath.isAbsolute(path) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      "Lust proof has an invalid source path.",
    );
    if (pinned) NodeAssert.equal(pinned[1], upstream, "Lust proof oracle differs.");
    const bytes = git("cat-file", "blob", `${pinned ? upstream : commit}:${path}`);
    NodeAssert.equal(sha(bytes), wanted, `Lust proof input differs: ${path}`);
  }

  const selected = nativeComponents.map((component) => {
    const file = nativeFile(component, target);
    const fromLust = component !== "db";
    const source = NodePath.join(fromLust ? artifacts : base, file);
    NodeAssert.ok(NodeFS.lstatSync(source).isFile(), `Expected a regular component file: ${file}`);
    NodeFS.accessSync(source, NodeFS.constants.X_OK);
    const digest = nativeHash(source);
    if (fromLust) {
      NodeAssert.equal(
        receipt[`${component}_binary_sha256`],
        digest,
        `Lust component hash differs: ${file}`,
      );
      NodeAssert.deepEqual(
        receipt.artifacts.filter((item) => item.file === file),
        [{ file, sha256: digest }],
      );
    } else {
      NodeAssert.equal(digest, manifest.files[file], `Base database hash differs: ${file}`);
    }
    return { file, source, digest, compiler: fromLust ? "native-lust" : compatibility };
  });

  NodeAssert.ok(!NodeFS.existsSync(destination), "Choose a new bundle output directory.");
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  const stage = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(destination), ".t3-lust-bundle-"),
  );
  try {
    for (const { file, source, digest } of selected) {
      const output = NodePath.join(stage, file);
      NodeFS.copyFileSync(source, output, NodeFS.constants.COPYFILE_EXCL);
      NodeAssert.equal(nativeHash(output), digest, `Component changed while staging: ${file}`);
    }
    const mixed = {
      ...manifest,
      files: Object.fromEntries(selected.map(({ file, digest }) => [file, digest])),
      compiler_route: "mixed-native-lust-bluefe",
      compiler_routes: Object.fromEntries(selected.map(({ file, compiler }) => [file, compiler])),
      build_profile: "mixed",
      build_profiles: Object.fromEntries(
        selected.map(({ file, compiler }) => [
          file,
          compiler === compatibility ? "release" : "default",
        ]),
      ),
      ci_run_id: null,
      ci_run_attempt: null,
      compatibility_manifest_sha256: sha(baseManifest),
      lust_receipt_sha256: sha(receiptBytes),
    };
    NodeFS.writeFileSync(
      NodePath.join(stage, "manifest.json"),
      JSON.stringify(mixed, null, 2) + "\n",
    );
    nativeArtifactFiles(stage, target);
    NodeFS.renameSync(stage, destination);
  } finally {
    if (NodeFS.existsSync(stage)) NodeFS.rmSync(stage, { recursive: true });
  }
}

const args = process.argv.slice(2);
if (args.length !== 4)
  throw new Error(
    "Usage: node tools/stage-lust-native.mjs BASE LUST_RECEIPT LUST_ARTIFACTS OUTPUT",
  );
stageLustNative(...args);
