// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication } from "playwright-core";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
    "expect-native": { type: "boolean", default: false },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>] [--expect-native]",
  );
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
const userdata = NodePath.join(t3Home, "userdata");
const source = NodePath.join(userdata, "statev2.sqlite");
const heldSource = NodePath.join(home, "legacy-source.sqlite");
const nativeDatabase = NodePath.join(userdata, "statev2.omdb");
const nativeMarker = NodePath.join(userdata, "server-owner.sqlite");
const hashFile = (path: string) => NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
NodeFS.mkdirSync(userdata, { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, source);

async function closeApp(instance: ElectronApplication) {
  const child = instance.process();
  const closed = instance.close().then(() => true, () => false);
  const graceful = await Promise.race([
    closed,
    NodeTimersPromises.setTimeout(10_000, false, { ref: false }),
  ]);
  if (!graceful) child.kill("SIGKILL");
  return graceful;
}

let step = "launching the app";
let app: ElectronApplication | undefined;
try {
  if (values["expect-native"]) {
    NodeAssert.equal(process.platform, "linux");
    NodeAssert.equal(process.arch, "x64");
    NodeAssert.deepEqual(Object.keys(NodeOS.networkInterfaces()), ["lo"]);
    NodeAssert.equal(values.app, undefined, "Use the packaged entrypoint");
  }
  const fixtureHash = hashFile(source);
  const nativeLaunches: Array<{ database: string; owner: number }> = [];
  for (let launch = 1; launch <= (values["expect-native"] ? 2 : 1); launch++) {
    step = `launching the app (attempt ${launch})`;
    app = await _electron.launch({
      executablePath: executable,
      // Linux CI runners do not allow the Chromium sandbox's user namespaces.
      args: [...(values.app ? [NodePath.resolve(values.app)] : []), "--no-sandbox"],
      // macOS needs the runner's login keychain for safeStorage.
      env: {
        ...process.env,
        XDG_CONFIG_HOME: NodePath.join(home, ".config"),
        XDG_DATA_HOME: NodePath.join(home, ".local/share"),
        T3CODE_HOME: t3Home,
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_DISABLE_AUTO_UPDATE: "true",
      },
      timeout: STEP_TIMEOUT_MS,
    });
    step = "waiting for the first window";
    const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
    try {
      step = `finding "${THREAD_TITLE}" in the sidebar`;
      const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
      await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
      step = "opening the thread";
      await thread.click();
      await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
      if (values["expect-native"]) {
        step = "reading the selected database and desktop backend owner";
        NodeAssert.equal(NodeFS.readFileSync(nativeMarker, "utf8"), "t3code-omdb-owner-v1\n");
        const database = NodeFS.lstatSync(nativeDatabase, { bigint: true });
        NodeAssert.ok(database.isFile() && database.size > 0n);
        const { pid, origin } = JSON.parse(NodeFS.readFileSync(NodePath.join(userdata, "server-runtime.json"), "utf8"));
        NodeAssert.ok(Number.isSafeInteger(pid) && pid > 0);
        NodeAssert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
        process.kill(pid, 0);
        nativeLaunches.push({ database: `${database.dev}:${database.ino}`, owner: pid });
      }
    } catch (error) {
      NodeFS.mkdirSync(artifactsDir, { recursive: true });
      await page
        .screenshot({ path: NodePath.join(artifactsDir, `window-${launch}.png`), timeout: 10_000 })
        .catch(() => {});
      throw error;
    }
    if (values["expect-native"]) {
      step = "closing the packaged app and its backend";
      NodeAssert.equal(await closeApp(app), true);
      app = undefined;
      if (launch === 1) {
        NodeAssert.equal(hashFile(source), fixtureHash);
        NodeFS.renameSync(source, heldSource);
      }
    }
  }
  if (values["expect-native"]) {
    step = "verifying native reopen and the legacy source";
    NodeAssert.equal(nativeLaunches[0]!.database, nativeLaunches[1]!.database);
    NodeAssert.notEqual(nativeLaunches[0]!.owner, nativeLaunches[1]!.owner);
    NodeAssert.equal(NodeFS.existsSync(source), false);
    NodeAssert.equal(hashFile(heldSource), fixtureHash);
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(artifactsDir, "native-reopen.json"), JSON.stringify({
      fixtureSha256: fixtureHash,
      migrated: true,
      reopened: true,
      legacySourcePreserved: true,
      launches: nativeLaunches,
    }, null, 2) + "\n");
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  if (app) await closeApp(app);
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
