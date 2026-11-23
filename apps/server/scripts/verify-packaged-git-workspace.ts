// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off globalJsonInEffect:off - owned loopback archive fixture.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { ProjectId, WS_METHODS } from "@t3tools/contracts";
import { authenticatePackagedServer, reservePort, startPackagedServer } from "./packaged-server-fixture.ts";

const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const [argument, entryArgument] = process.argv.slice(2);
Assert.ok(argument && entryArgument && Path.isAbsolute(argument) && Path.isAbsolute(entryArgument));
Assert.equal(process.argv.length, 4);
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"], "Use the loopback-only hosted namespace");
const proof = Path.join(FS.realpathSync(Path.dirname(argument)), Path.basename(argument));
Assert.ok(Path.relative(root, proof).startsWith(`..${Path.sep}`));
FS.mkdirSync(proof, { mode: 0o700 });
const scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
const sourceEntry = FS.realpathSync(entryArgument);
const sourcePackage = Path.dirname(sourceEntry);
const copyPackage = Path.join(scratch, "package");
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Packaged Git workspace proof interrupted"));
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
const report: Record<string, unknown> = { status: "running", checkpoint: "preflight",
  stock: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f" };
const save = () => FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n");
const sha256 = (file: string) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
const checkpoint = (name: string) => { report.checkpoint = name; save(); };
let active: ReturnType<typeof startPackagedServer> | undefined;
let failure: unknown;

// strace may split one execve across unfinished/resumed lines. Require its success,
// not a generic child process, and retain argv only from this synthetic fixture.
function executions(file: string) {
  const pending = new Map<string, string>();
  const cwdByPid = new Map<string, string>();
  const successful: Array<{ line: string; cwd: string | undefined }> = [];
  for (const line of FS.readFileSync(file, "utf8").split("\n")) {
    const match = /^(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const [, pid, body] = match;
    let complete = body!;
    if (complete.includes("<unfinished ...>")) { pending.set(pid!, complete); continue; }
    if (complete.startsWith("<... ")) {
      const prefix = pending.get(pid!);
      pending.delete(pid!);
      if (prefix === undefined) continue;
      complete = prefix.replace("<unfinished ...>", "") + complete.replace(/^<\.\.\. \w+ resumed>/u, "");
    }
    if (!/= 0\s*$/u.test(complete)) continue;
    if (complete.startsWith("chdir(")) {
      const quoted = /^chdir\(("(?:[^"\\]|\\.)*")\)/u.exec(complete)?.[1];
      if (quoted !== undefined) cwdByPid.set(pid!, JSON.parse(quoted));
    } else if (complete.startsWith("execve(")) successful.push({ line: complete, cwd: cwdByPid.get(pid!) });
  }
  return successful;
}

try {
  checkpoint("preflight");
  FS.accessSync("/usr/bin/strace", FS.constants.X_OK);
  const originalManifest = Path.join(sourcePackage, "native-bin/manifest.json");
  const originalHelper = Path.join(sourcePackage, "native-bin/t3-code-ls-git-workspace");
  const manifest = JSON.parse(FS.readFileSync(originalManifest, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  Assert.equal(manifest.files["t3-code-ls-git-workspace"], sha256(originalHelper));
  const original = { entry: sha256(sourceEntry), helper: sha256(originalHelper), manifest: sha256(originalManifest) };
  report.source = ChildProcess.execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD", "HEAD^{tree}"], {
    env: {}, encoding: "utf8", timeout: 5_000,
  }).trim().split("\n");
  report.artifacts = { ...original,
    git: ChildProcess.execFileSync("/usr/bin/git", ["--version"], { env: {}, encoding: "utf8" }).trim(),
    toolchainLock: sha256(Path.join(root, "toolchain.lock.json")),
    gitWorkspaceLock: sha256(Path.join(root, "apps/server/rust/git-workspace/Cargo.lock")),
    strace: ChildProcess.execFileSync("/usr/bin/strace", ["--version"], { env: {}, encoding: "utf8" }).split("\n")[0],
  };
  FS.cpSync(sourcePackage, copyPackage, { recursive: true });
  const entry = Path.join(copyPackage, Path.basename(sourceEntry));
  const helper = Path.join(copyPackage, "native-bin/t3-code-ls-git-workspace");
  const manifestPath = Path.join(copyPackage, "native-bin/manifest.json");
  const helperBytes = FS.readFileSync(helper);
  const manifestBytes = FS.readFileSync(manifestPath);
  Assert.equal(sha256(entry), original.entry);
  Assert.equal(sha256(helper), original.helper);
  Assert.equal(sha256(manifestPath), original.manifest);
  const home = Path.join(scratch, "home");
  const homeBin = Path.join(home, "bin");
  const temporary = Path.join(scratch, "tmp");
  FS.mkdirSync(homeBin, { recursive: true });
  FS.mkdirSync(temporary);
  FS.symlinkSync("/usr/bin/git", Path.join(homeBin, "git"));
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home, PATH: homeBin, TMPDIR: temporary,
    XDG_CONFIG_HOME: Path.join(home, ".config"), XDG_DATA_HOME: Path.join(home, ".local/share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    T3_CODE_LS_IMPLEMENTATION: "native", T3_CODE_LS_BUNDLED_GIT_WORKSPACE: "1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false", T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1",
  };
  Assert.equal(baseEnv.T3_CODE_LS_GIT_WORKSPACE_EXECUTABLE, undefined);
  Assert.ok(!Object.keys(baseEnv).some((name) => /^T3_CODE_LS_.*_EXECUTABLE$/u.test(name)));
  const workspace = Path.join(scratch, "workspace");
  const linked = Path.join(scratch, "linked");
  const nested = Path.join(workspace, "nested");
  const bare = Path.join(scratch, "bare.git");
  const configuredWorktree = Path.join(scratch, "configured-worktree");
  const symlinkedWorktree = Path.join(scratch, "symlinked-worktree");
  FS.mkdirSync(nested, { recursive: true });
  const git = (cwd: string, ...args: string[]) => ChildProcess.execFileSync("/usr/bin/git", args, {
    cwd, env: baseEnv, encoding: "utf8", timeout: 10_000,
  }).trim();
  const fixtureIdentity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
  git(workspace, "init", "--quiet", "--initial-branch=main");
  FS.writeFileSync(Path.join(workspace, "README"), "Synthetic packaged Git workspace\n");
  const reviewPath = "review 雪\tname.txt";
  const originalReviewText = "\ufeffalpha\nunchanged\nold tail";
  const dirtyReviewText = "\ufeffalpha\nunchanged\nnew tail";
  FS.writeFileSync(Path.join(workspace, reviewPath), originalReviewText);
  FS.writeFileSync(Path.join(workspace, "binary.dat"), Buffer.from([65, 0, 66]));
  git(workspace, "add", ".");
  git(workspace, ...fixtureIdentity, "commit", "--quiet", "-m", "Fixture");
  git(workspace, "branch", "作業/修正");
  git(workspace, "worktree", "add", "--quiet", "-b", "linked-branch", linked);
  FS.writeFileSync(Path.join(linked, "README"), "Dirty linked checkout\n");
  FS.writeFileSync(Path.join(linked, reviewPath), dirtyReviewText);
  const reviewBase = git(linked, "rev-parse", "HEAD");
  FS.mkdirSync(bare);
  git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  for (const checkout of [configuredWorktree, symlinkedWorktree]) {
    FS.mkdirSync(checkout);
    git(checkout, "init", "--quiet", "--initial-branch=configured");
    git(checkout, ...fixtureIdentity, "commit", "--quiet", "--allow-empty", "-m", "Fixture");
  }
  git(configuredWorktree, "config", "core.worktree", "..");
  FS.mkdirSync(Path.join(symlinkedWorktree, "child"));
  FS.symlinkSync("../child", Path.join(symlinkedWorktree, ".git", "portal"));
  git(symlinkedWorktree, "config", "core.worktree", "portal/..");
  const phases: unknown[] = [];
  const observations: unknown[] = [];
  const linkedStatusByMode = new Map<string, unknown>();
  const reviewByMode = new Map<string, unknown>();
  report.phases = phases;
  report.observations = observations;
  for (const mode of ["native", "config", "included", "upstream", "hash-refusal", "manifest-refusal"] as const) {
    checkpoint(mode);
    FS.writeFileSync(helper, helperBytes);
    FS.writeFileSync(manifestPath, manifestBytes);
    if (mode === "hash-refusal") FS.appendFileSync(helper, "synthetic hash fault");
    if (mode === "manifest-refusal") {
      FS.writeFileSync(manifestPath, JSON.stringify({ ...manifest, target: "darwin-x64" }));
    }
    if (mode === "included") {
      const include = Path.join(scratch, "included.gitconfig");
      FS.writeFileSync(include, "[core]\n  abbrev = 12\n");
      git(workspace, "config", "include.path", include);
    } else if (mode === "upstream") git(workspace, "config", "--unset-all", "include.path");
    const baseDir = Path.join(scratch, `state-${mode}`);
    FS.mkdirSync(Path.join(baseDir, "userdata"), { recursive: true });
    FS.writeFileSync(Path.join(baseDir, "userdata/settings.json"), JSON.stringify({ providerInstances:
      Object.fromEntries(["codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
        .map((driver) => [driver, { driver, enabled: false }])) }));
    const env = { ...baseEnv,
      ...(mode === "config" ? { GIT_CONFIG_COUNT: "0" } : {}),
      ...(mode === "upstream" ? { T3_CODE_LS_IMPLEMENTATION: "upstream" } : {}),
    };
    const trace = Path.join(proof, `${mode}.execve`);
    active = startPackagedServer({ bundle: entry, executable: true, execTrace: trace,
      logPath: Path.join(proof, `${mode}.log`), signal: abort.signal, baseDir, env, port: await reservePort() });
    if (mode.endsWith("refusal")) {
      await Assert.rejects(active.ready);
      await active.stop(); active = undefined;
      Assert.ok(!executions(trace).some(({ line }) => line.startsWith(`execve(${JSON.stringify(helper)},`)));
      Assert.match(FS.readFileSync(Path.join(proof, `${mode}.log`), "utf8"), /bundled native Git workspace helper/u);
      phases.push({ mode, startupRefused: true, helperExecuted: false });
      continue;
    }
    await active.ready;
    const client = await authenticatePackagedServer(active, abort.signal);
    if (mode === "native" || mode === "upstream") {
      await client.createProject({ projectId: ProjectId.make("fixture-git-review"),
        title: "Synthetic Git review", workspaceRoot: linked });
    }
    const locations = mode === "native"
      ? [{ label: "root", cwd: workspace }, { label: "nested", cwd: nested },
        { label: "linked", cwd: linked }, { label: "bare", cwd: bare },
        { label: "configured-worktree", cwd: configuredWorktree },
        { label: "symlinked-worktree", cwd: symlinkedWorktree }]
      : [{ label: "root", cwd: workspace }, ...(mode === "upstream" ? [{ label: "linked", cwd: linked }] : [])];
    for (const { label, cwd } of locations) {
      checkpoint(`${mode}:${label}:rpc`);
      const result = await client.rpc((rpc) => rpc[WS_METHODS.vcsListRefs]({ cwd, refresh: true, refKind: "local" }));
      if (label === "linked") {
        // The ordinary refresh waits for both status halves without timing the poller.
        const status = await client.rpc((rpc) => rpc[WS_METHODS.vcsRefreshStatus]({ cwd }));
        Assert.equal(status.refName, "linked-branch");
        Assert.equal(status.hasWorkingTreeChanges, true);
        Assert.match(git(cwd, "status", "--porcelain"), /M README/u, "The linked fixture stays dirty");
        linkedStatusByMode.set(mode, status);
        if (mode === "upstream") Assert.deepEqual(status, linkedStatusByMode.get("native"));
        report.linkedStatus = Object.fromEntries(linkedStatusByMode);
        const previewInput = { cwd, baseRef: reviewBase, sourceKind: "working-tree" as const };
        const preview = await client.rpc((rpc) => rpc[WS_METHODS.reviewGetDiffPreview](previewInput));
        const metadata = await client.rpc((rpc) => rpc[WS_METHODS.reviewGetDiffPreview]({ ...previewInput, metadataOnly: true }));
        const contentsInput = { cwd, sourceKind: "working-tree" as const, changeType: "change" as const,
          baseRef: reviewBase, headRef: null, oldPath: reviewPath, newPath: reviewPath };
        const contents = await client.rpc((rpc) => rpc[WS_METHODS.reviewGetDiffFileContents](contentsInput));
        Assert.deepEqual(contents, { oldContents: originalReviewText, newContents: dirtyReviewText });
        // The independent Git oracle supplies the complete hunk bytes. Metadata
        // and hashes must also agree with the retained authenticated route below.
        const oraclePatch = ChildProcess.execFileSync("/usr/bin/git", ["-c", "diff.relative=false",
          "-c", "diff.suppressBlankEmpty=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
          "--submodule=short", "--find-renames", "--minimal", "--patch", "--src-prefix=a/", "--dst-prefix=b/", reviewBase, "--"],
          { cwd, env: baseEnv, encoding: "utf8", timeout: 10_000 });
        const working = preview.sources.find((source) => source.kind === "working-tree");
        Assert.ok(working);
        Assert.equal(working.diff, oraclePatch);
        await Assert.rejects(client.rpc((rpc) => rpc[WS_METHODS.reviewGetDiffFileContents]({ ...contentsInput,
          oldPath: "binary.dat", newPath: "binary.dat" })));
        const observedReview = { sources: preview.sources, metadata: metadata.sources, contents };
        reviewByMode.set(mode, observedReview);
        if (mode === "upstream") Assert.deepEqual(observedReview, reviewByMode.get("native"));
        report.review = Object.fromEntries(reviewByMode);
      }
      // Match stock's normal application admission, before GitVcsDriverCore.
      // A valid bare Git database is not a supported application work tree.
      const detection = ChildProcess.spawnSync("/usr/bin/git", ["-C", cwd, "rev-parse",
        "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      { env: baseEnv, encoding: "utf8", timeout: 10_000 });
      Assert.equal(detection.error, undefined, `${mode}:${label}: Git detection oracle failed to run`);
      Assert.equal(detection.signal, null, `${mode}:${label}: Git detection oracle was interrupted`);
      const [insideWorktree, worktreeRoot] = detection.stdout.split("\n");
      const isRepo = detection.status === 0 && insideWorktree === "true";
      const isAtRepositoryRoot = isRepo ? worktreeRoot === FS.realpathSync(cwd) : undefined;
      const refs = isRepo
        ? git(cwd, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads").split("\n").filter(Boolean).sort()
        : [];
      const current = isRepo ? git(cwd, "symbolic-ref", "--short", "HEAD") : undefined;
      observations.push({ mode, location: label, oracle: { isRepo, detectionExit: detection.status,
        detectionStdout: detection.stdout, detectionStderr: detection.stderr, refs, current,
        isAtRepositoryRoot },
      actual: { isRepo: result.isRepo, refs: result.refs.map((ref) => ref.name).sort(),
        totalCount: result.totalCount, current: result.refs.find((ref) => ref.current)?.name,
        isAtRepositoryRoot: result.isAtRepositoryRoot } });
      save();
      Assert.equal(isRepo, cwd !== bare, `${mode}:${label}: fixture work-tree admission changed`);
      Assert.equal(result.isRepo, isRepo, `${mode}:${label}: normal application work-tree admission`);
      Assert.deepEqual(result.refs.map((ref) => ref.name).sort(), refs, `${mode}:${label}: branch names`);
      Assert.equal(result.totalCount, refs.length, `${mode}:${label}: branch count`);
      if (isRepo) {
        Assert.equal(result.refs.find((ref) => ref.current)?.name, current, `${mode}:${label}: HEAD`);
        Assert.equal(isAtRepositoryRoot, cwd !== nested, `${mode}:${label}: fixture root identity changed`);
        Assert.equal(result.isAtRepositoryRoot, isAtRepositoryRoot, `${mode}:${label}: root identity`);
      }
    }
    checkpoint(`${mode}:execution-witness`);
    await active.stop(); active = undefined;
    const calls = executions(trace);
    const nativeCalls = calls.filter(({ line }) => line.startsWith(`execve(${JSON.stringify(helper)},`));
    const gitDiscovery = calls.filter(({ line }) => line.includes('"--git-common-dir"') || line.includes('"--show-toplevel"'));
    const registryProbes = gitDiscovery.filter(({ line }) => line.includes('"--is-inside-work-tree"'));
    const coreDiscovery = gitDiscovery.filter(({ line }) => !line.includes('"--is-inside-work-tree"'));
    for (const { label, cwd } of locations) {
      Assert.ok(registryProbes.some(({ line }) => line.includes(`"-C", ${JSON.stringify(cwd)}`)),
        `${mode}:${label}: normal application repository detection must run`);
    }
    if (mode === "native") {
      for (const { label, cwd } of locations.filter(({ cwd }) => cwd !== bare)) {
        Assert.ok(nativeCalls.some((call) => call.cwd === cwd && call.line.includes(JSON.stringify(cwd))),
          `${mode}:${label}: the packaged helper must execute in the requested work tree`);
        const discovery = coreDiscovery.filter((call) => call.cwd === cwd);
        const usesRetainedDiscovery = cwd === symlinkedWorktree;
        for (const argument of ["--git-common-dir", "--show-toplevel"]) {
          Assert.equal(discovery.some(({ line }) => line.includes(JSON.stringify(argument))),
            usesRetainedDiscovery, `${mode}:${label}: retained ${argument}`);
        }
      }
      Assert.ok(nativeCalls.some((call) => call.cwd === linked && call.line.includes('"review-blob"')),
        "Authenticated expansion must execute the packaged native blob read");
      Assert.ok(!calls.some((call) => call.cwd === linked && call.line.includes('"show", "--end-of-options"') &&
        call.line.includes("review ")),
        "Admitted text expansion must avoid retained Git show");
      Assert.ok(calls.some((call) => call.cwd === linked && call.line.includes('"show", "--end-of-options"') &&
        call.line.includes("binary.dat")), "Binary expansion must retain Git diagnostics");
      Assert.ok(nativeCalls.some((call) => call.cwd === linked && call.line.includes('"branch-head"')),
        "Authenticated status refresh must execute the native branch read");
      Assert.ok(!calls.some((call) => call.cwd === linked && call.line.includes('"--symbolic-full-name", "HEAD"')),
        "Ordinary linked branch status must avoid retained HEAD lookup");
      Assert.ok(!nativeCalls.some((call) => call.cwd === bare || call.line.includes(JSON.stringify(bare))),
        "The bare repository must be rejected by normal admission before helper execution");
    } else if (mode === "included") {
      Assert.ok(nativeCalls.some((call) => call.cwd === workspace) && coreDiscovery.some((call) => call.cwd === workspace),
        "Included configuration must retain Core Git discovery after native refusal");
    } else {
      Assert.equal(nativeCalls.length, 0, "Configuration overrides and retained mode must bypass native reads");
      Assert.ok(coreDiscovery.some((call) => call.cwd === workspace), `${mode}: retained Core Git discovery must execute`);
      if (mode === "upstream") {
        Assert.ok(calls.some((call) => call.cwd === linked && call.line.includes('"--symbolic-full-name", "HEAD"')),
          "Retained linked branch status must execute Git HEAD lookup");
      }
    }
    phases.push({ mode, locations: locations.length, nativeCalls: nativeCalls.length,
      registryProbes: registryProbes.length, retainedCoreDiscoveryCalls: coreDiscovery.length });
    save();
  }
  Assert.deepEqual({ entry: sha256(sourceEntry), helper: sha256(originalHelper), manifest: sha256(originalManifest) }, original);
  report.status = "passed";
  checkpoint("complete");
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  failure = error;
} finally {
  try {
    await active?.stop();
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = error instanceof Error ? error.message : String(error);
    failure ??= error;
  } finally {
    FS.rmSync(scratch, { recursive: true, force: true });
    save();
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  }
}
if (failure !== undefined) throw failure;
console.log(JSON.stringify(report));
