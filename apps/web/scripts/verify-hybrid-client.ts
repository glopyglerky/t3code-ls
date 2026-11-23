// @effect-diagnostics nodeBuiltinImport:off - isolated, plain Node application acceptance runner.
// Run from a clean CI checkout after installing Playwright Chromium and building the native helpers:
// node apps/web/scripts/verify-hybrid-client.ts /absolute/path/to/proof [upstream|native|both]
// The fixture and application state stay outside the checkout. They are retained for investigation.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { nativeExecutable } from "@t3tools/shared/nativeExecutable";
import { inspectNativeMessageUpdates, inspectNativeReplay } from "./hybrid-client-database.ts";
import {
  assertReplayTurnLinks,
  replayTurnIdentity,
  type ReplayTurnIdentity,
} from "./hybrid-client-turn.ts";

type Implementation = "upstream" | "native";
type PairingRenderer = "retained" | "dioxus" | "dioxus-fallback";
type OwnedApplication = { pid: number; pairingUrl: string; stop: () => Promise<void> };
type InterruptedShowcase = ReplayTurnIdentity & {
  threadId: string;
  threadUrl: string;
  requestId: string;
  partialMessageId: string;
  partialText: string;
};

const repoRoot = NodeFS.realpathSync(NodeURL.fileURLToPath(new URL("../../../", import.meta.url)));
const timeoutMs = 90_000;
const startupTimeoutMs = 180_000;
const replayPrompt = "Replay: showcase";
const replayMarker = "This turn is a replay.";
const bundledClient = process.env.T3_CODE_LS_BUNDLED_CLIENT_PROOF === "1";
const parallelTurnsProof = process.env.T3_CODE_LS_PARALLEL_TURNS_PROOF === "true";
const spliceNegotiationProof = process.env.T3_CODE_LS_SPLICE_NEGOTIATION_PROOF === "true";
const splitPtyProof = process.env.T3_CODE_LS_SPLIT_PTY_PROOF === "true";
const pairingProof = process.env.T3_CODE_LS_PAIRING_PROOF;
const bundledPtyProof = process.env.T3_CODE_LS_BUNDLED_PTY_PROOF === "true";
const nativePtyHost = bundledPtyProof
  ? NodePath.join(repoRoot, "apps/server/dist/native-bin/t3-code-ls-pty-host")
  : process.env.T3_CODE_LS_PTY_PROOF_EXECUTABLE;
const multiTabDraftProof = process.env.T3_CODE_LS_MULTI_TAB_DRAFT_PROOF === "true";
const draftStorageProof = process.env.T3_CODE_LS_DRAFT_STORAGE_PROOF === "true";
const fileEditorProof = process.env.T3_CODE_LS_FILE_EDITOR_PROOF === "true";
const tasksFile = "fixture-tasks.md";
const initialTasks = "- [ ] First milestone\n- [ ] Second milestone\n- [ ] Keep the draft\n";
const durableTextProof = process.env.T3_CODE_LS_DURABLE_TEXT_PROOF === "true";
const pdfLinkProof = process.env.T3_CODE_LS_PDF_LINK_PROOF === "true";
const expectsRustComposer = process.env.VITE_T3_CODE_LS_COMPOSER_OFFSETS === "rust";
const capturedApproval = {
  path: "apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/registry_transcript.ndjson",
  sha256: "f9c09f88e3b8480c44adc62ba30c085a33044a6bfc1611839128c3f80ea5ad81",
  model: "approval",
  modelLabel: "Write approval",
  prompt: "Replay the recorded permission request",
  reply: "Created the requested probe file.",
};
const capturedQuestion = {
  path: "apps/server/src/orchestration-v2/testkit/fixtures/acp_elicitation/registry_transcript.ndjson",
  sha256: "544a05a240a700ecad527fa785e9b8adf203fc8e93c48e9185e790ba86f103ee",
  option: "Strict schemas (Recommended)",
};
const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);
const mode = process.argv[3] ?? "both";
const proofArgument = process.argv[2];

if (
  !proofArgument ||
  !NodePath.isAbsolute(proofArgument) ||
  !["upstream", "native", "both"].includes(mode)
) {
  throw new Error(
    "Usage: node apps/web/scripts/verify-hybrid-client.ts /absolute/proof-dir [upstream|native|both]",
  );
}
if (process.platform !== "linux") {
  throw new Error(
    "This acceptance runner qualifies Linux only; other platforms require their own gate.",
  );
}
if (pairingProof !== undefined && (!bundledClient || !isPairingRenderer(pairingProof))) {
  throw new Error("The pairing proof requires the bundled client and renderer retained or dioxus.");
}

function isPairingRenderer(value: string): value is PairingRenderer {
  return value === "retained" || value === "dioxus" || value === "dioxus-fallback";
}

function outsideCheckout(path: string): void {
  const relative = NodePath.relative(repoRoot, path);
  if (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
  ) {
    throw new Error(`Acceptance artifacts and state must be outside the checkout: ${path}`);
  }
}

outsideCheckout(NodePath.resolve(proofArgument));
NodeFS.mkdirSync(proofArgument, { recursive: true });
const proofRoot = NodeFS.realpathSync(proofArgument);
outsideCheckout(proofRoot);
const runRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hybrid-client-"));
outsideCheckout(NodeFS.realpathSync(runRoot));

function redact(text: string): string {
  return stripVTControlCharacters(text).replace(/([#?&]token=)[^\s&"'<>]+/giu, "$1[REDACTED]");
}

function writeJson(path: string, value: unknown): void {
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? redact(item) : item), 2)}\n`,
  );
}

function git(args: string[], cwd = repoRoot): string {
  return ChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readJsonIfPresent(path: string): unknown {
  return NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : null;
}

const source = {
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]).length > 0,
  upstream: readJsonIfPresent(NodePath.join(repoRoot, "upstream.lock.json")),
  toolchain: readJsonIfPresent(NodePath.join(repoRoot, "toolchain.lock.json")),
  nativeManifest: readJsonIfPresent(NodePath.join(repoRoot, "bin", "manifest.json")),
};

async function availablePorts(): Promise<number[]> {
  const servers = [NodeNet.createServer(), NodeNet.createServer()];
  try {
    // Reserve both at once so the kernel cannot return the same port twice.
    return await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string")
                return reject(new Error("No TCP port allocated"));
              resolve(address.port);
            });
          }),
      ),
    );
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}

let activeApplication: OwnedApplication | undefined;
let browser: Browser | undefined;

async function startApplication(
  implementation: Implementation,
  stateDirectory: string,
  serverPort: number,
  webPort: number,
  logPath: string,
): Promise<OwnedApplication> {
  const env: NodeJS.ProcessEnv = bundledClient ? { PATH: process.env.PATH } : { ...process.env };
  // Component overrides would invalidate an explicit upstream/native comparison.
  for (const name of Object.keys(env)) {
    if (/^T3_CODE_LS_.*_EXECUTABLE$/.test(name)) delete env[name];
  }
  Object.assign(env, {
    PATH: `${NodePath.join(repoRoot, "node_modules", ".bin")}${NodePath.delimiter}${env.PATH ?? ""}`,
    T3_CODE_LS_IMPLEMENTATION: implementation,
    T3CODE_HOME: stateDirectory,
    T3CODE_DEV_SEED: "0",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT_OFFSET: String(webPort - 5733),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  });
  if (implementation === "native") {
    if (bundledPtyProof) env.T3_CODE_LS_BUNDLED_PTY_HOST = "1";
    else if (nativePtyHost !== undefined) env.T3_CODE_LS_PTY_HOST_EXECUTABLE = nativePtyHost;
  }
  if (bundledClient) Object.assign(env, { HOME: stateDirectory });
  NodeFS.writeFileSync(logPath, "");
  const args = bundledClient
    ? [
        "apps/server/dist/bin.mjs",
        "serve",
        "--base-dir",
        stateDirectory,
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--no-browser",
      ]
    : [
        "scripts/dev-runner.ts",
        "dev",
        "--home-dir",
        stateDirectory,
        "--no-seed",
        "--no-auto-bootstrap-project-from-cwd",
        "--port",
        String(serverPort),
      ];
  const child = ChildProcess.spawn(
    process.execPath,
    args,
    { cwd: repoRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const pid = child.pid;
  if (pid === undefined) {
    await new Promise<never>((_, reject) => child.once("error", reject));
    throw new Error("The application did not receive a process ID");
  }

  let stopping = false;
  let pairingUrl: string | undefined;
  let webReady = bundledClient;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(
    () => readyReject(new Error(`Application startup timed out; see ${logPath}`)),
    startupTimeoutMs,
  );
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("error", (error) => readyReject(error));
  child.once("exit", (code, signal) => {
    if (!stopping)
      readyReject(new Error(`Application exited (${code ?? signal}); see ${logPath}`));
  });

  function consumeLine(raw: string): void {
    const line = stripVTControlCharacters(raw);
    NodeFS.appendFileSync(logPath, `${redact(line)}\n`);
    const candidate = line.match(/https?:\/\/[^\s"'<>]+\/pair#token=[^\s"'<>]+/u)?.[0];
    if (candidate) {
      const url = new URL(candidate);
      const expectedOrigin = bundledClient
        ? `http://127.0.0.1:${serverPort}`
        : `http://localhost:${webPort}`;
      if (url.origin !== expectedOrigin) {
        readyReject(new Error(`Pairing URL has an unexpected origin: ${url.origin}`));
      } else {
        pairingUrl = candidate;
      }
    }
    if (/\bready in\b/iu.test(line)) webReady = true;
    if (pairingUrl && webReady) readyResolve();
  }

  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    stream.once("end", () => {
      if (pending) consumeLine(pending);
    });
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const signal = (value: NodeJS.Signals) => {
      try {
        process.kill(-pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    const killTimer = setTimeout(() => signal("SIGKILL"), 10_000);
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`Owned process group ${pid} did not close within 15 seconds`)),
        15_000,
      );
    });
    try {
      await Promise.race([exited, deadline]);
    } finally {
      clearTimeout(killTimer);
      clearTimeout(deadlineTimer!);
    }
  };
  const application: OwnedApplication = { pid, pairingUrl: "", stop };
  activeApplication = application;
  try {
    await ready;
    Assert.ok(pairingUrl);
    application.pairingUrl = pairingUrl;
    return application;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyPairing(implementation: Implementation, renderer: PairingRenderer) {
  const directory = NodePath.join(proofRoot, `${implementation}-pairing-${renderer}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  const stateDirectory = NodeFS.mkdtempSync(NodePath.join(runRoot, "pairing-"));
  const [serverPort, webPort] = await availablePorts();
  Assert.ok(serverPort && webPort);
  const context = await browser!.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const wasmPath = "/pairing-wasm/local_pairing_bg.wasm";
  const exchangePath = "/api/auth/browser-session";
  let token = "";

  try {
    const application = await startApplication(
      implementation,
      stateDirectory,
      serverPort,
      webPort,
      NodePath.join(directory, "startup.log"),
    );
    const pairingUrl = new URL(application.pairingUrl);
    token = new URLSearchParams(pairingUrl.hash.slice(1)).get("token") ?? "";
    Assert.ok(token.length > 0, "The owned server must issue a pairing credential");
    pairingUrl.hash = "";

    let wasmRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === wasmPath) wasmRequests++;
    });
    if (renderer === "dioxus-fallback") {
      await page.route(`**${wasmPath}`, (route) => route.abort("blockedbyclient"));
    }
    const [wasm] = await Promise.all([
      renderer === "dioxus"
        ? page.waitForResponse((response) => new URL(response.url()).pathname === wasmPath)
        : undefined,
      page.goto(pairingUrl.href),
    ]);
    let wasmSha256: string | undefined;
    if (wasm) {
      Assert.ok(wasm.ok(), "The bundled server must serve the pairing Wasm");
      const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      wasmSha256 = sha256(await wasm.body());
      const builtWasm = NodeFS.readFileSync(NodePath.join(repoRoot, "apps/web/dist", wasmPath));
      Assert.equal(wasmSha256, sha256(builtWasm), "The page must load the built Wasm bytes");
    }
    if (renderer === "dioxus-fallback") {
      await page.getByRole("alert").filter({ hasText: "Could not open the pairing form" })
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Use standard pairing", exact: true }).click();
    }

    const input = page.getByLabel("Pairing token", { exact: true });
    const form = page.locator("form").filter({ has: input });
    await form.waitFor({ state: "visible" });
    Assert.equal(
      await form.getAttribute("data-pairing-renderer"),
      renderer === "dioxus" ? "dioxus-wasm" : null,
    );
    Assert.equal(await input.getAttribute("autocomplete"), "off");
    Assert.equal(await input.evaluate((element) => (element as HTMLInputElement).type), "text");
    await form.locator('label[for="pairing-token"]').click();
    Assert.ok(await input.evaluate((element) => element === document.activeElement));

    const waitForExchange = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === exchangePath && response.request().method() === "POST",
      );
    const gate = Promise.withResolvers<void>();
    await page.route(
      `**${exchangePath}`,
      async (route) => {
        await gate.promise;
        await route.continue();
      },
      { times: 1 },
    );
    await input.fill("invalid-pairing-proof-credential");
    const rejectInvalidCredential = async () => {
      try {
        await input.press("Enter");
        const pending = form.getByRole("button", { name: "Pairing...", exact: true });
        await pending.waitFor({ state: "visible" });
        Assert.ok(await pending.isDisabled());
        Assert.ok(await input.isDisabled());
      } finally {
        gate.resolve();
      }
    };
    const [invalidExchange] = await Promise.all([waitForExchange(), rejectInvalidCredential()]);
    Assert.equal(invalidExchange.status(), 401);
    await form
      .getByRole("alert")
      .filter({ hasText: "Invalid pairing token" })
      .waitFor({ state: "visible" });
    const sessionUrl = new URL("/api/auth/session", pairingUrl);
    const unauthenticated = await context.request.get(sessionUrl.href);
    Assert.equal((await unauthenticated.json()).authenticated, false);

    const pairingWasmRequests = wasmRequests;
    Assert.equal(pairingWasmRequests, renderer === "retained" ? 0 : 1);
    await input.fill(token);
    const [validExchange] = await Promise.all([waitForExchange(), input.press("Enter")]);
    Assert.equal(validExchange.status(), 200);
    await page.waitForURL(new URL("/", pairingUrl).href);
    await page
      .getByRole("heading", { name: "Welcome to T3 Code", exact: true })
      .waitFor({ state: "visible" });
    Assert.equal(await form.count(), 0, "The pairing form must leave the authenticated page");
    const authenticated = await context.request.get(sessionUrl.href);
    Assert.equal((await authenticated.json()).authenticated, true);
    const welcomeControls = renderer === "dioxus"
      ? await verifyWelcomeControlUpdates(page)
      : undefined;
    if (renderer === "dioxus-fallback") {
      await page.getByRole("alert").filter({ hasText: "Could not open setup controls" })
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Use standard setup", exact: true }).click();
    }
    const heading = page.getByRole("heading", { name: "Welcome to T3 Code", exact: true });
    const welcome = page.getByRole("main").filter({ has: heading });
    const controls = welcome.locator('[data-welcome-renderer="dioxus-wasm"]');
    if (renderer === "dioxus") await controls.waitFor({ state: "visible" });
    else Assert.equal(await controls.count(), 0);
    await welcome.getByText(/^Looking for projects in your .* history…$/u)
      .waitFor({ state: "hidden" });
    const importProjects = welcome.getByRole("checkbox", { name: /^Import (?:\d+ )?projects? and their threads\b/u });
    if (await importProjects.isVisible()) await importProjects.uncheck();
    const start = welcome.getByRole("button", { name: "Start", exact: true });
    await start.waitFor({ state: "visible" });
    const completion = await start.isEnabled()
      ? start
      : welcome.getByRole("button", { name: "Start without an agent", exact: true });
    await completion.focus();
    await completion.press("Enter");
    await heading.waitFor({ state: "hidden" });
    Assert.equal(await controls.count(), 0, "The welcome Rust mount must leave the completed page");
    const workspace = NodePath.join(stateDirectory, "welcome-fixture");
    NodeFS.mkdirSync(workspace);
    await page.getByRole("button", { name: "Add project", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Local folder", { exact: true }).click();
    await dialog.getByRole("combobox").fill(workspace);
    await dialog.getByRole("button", { name: /^Add \(/u }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "New thread in welcome-fixture", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/draft/"));
    await page.getByTestId("composer-editor").waitFor({ state: "visible" });
    // Authentication reloads the document and the welcome page has a new module instance.
    Assert.equal(wasmRequests - pairingWasmRequests, renderer === "retained" ? 0 : 1);

    writeJson(NodePath.join(directory, "proof.json"), {
      source,
      renderer,
      implementation,
      chromium: browser!.version(),
      wasmSha256,
      pairingWasmRequests,
      welcomeWasmRequests: wasmRequests - pairingWasmRequests,
      invalidExchange: invalidExchange.status(),
      validExchange: validExchange.status(),
      sessionEstablished: true,
      welcomeControls,
      welcomeCompletedByKeyboard: true,
      projectDraftOpened: true,
    });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new Error(token ? message.replaceAll(token, "[REDACTED]") : message);
  } finally {
    await activeApplication?.stop();
    activeApplication = undefined;
    await context.close();
    NodeFS.rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function verifyWelcomeControlUpdates(page: Page) {
  return page.evaluate(async () => {
    const bindings = await import(new URL("/pairing-wasm/local_pairing.js", location.origin).href);
    const root = document.createElement("div");
    document.body.appendChild(root);
    let activations = 0;
    const activationCount = () => activations;
    const mount = bindings.mount_welcome_controls(root, false, false, 2, 2, () => { activations++; });
    let released = false;
    const waitFor = async (check: () => boolean) => {
      for (let frame = 0; frame < 120; frame++) {
        if (check()) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error("The Rust welcome controls did not apply their current state");
    };
    const button = () => root.querySelector<HTMLButtonElement>("#welcome-start")!;
    try {
      await waitFor(() => button()?.textContent === "Import 2 projects and start");
      if (!button().disabled) throw new Error("Start must require a ready agent");
      button().click();
      if (activationCount() !== 0) throw new Error("A disabled Start invoked setup");
      root.querySelector<HTMLButtonElement>("#welcome-without-agent")!.focus();
      mount.update(true, false, 2, 0);
      await waitFor(() => button().textContent === "Import threads and start" && document.activeElement === button());
      const original = button();
      mount.update(true, true, 2, 0);
      await waitFor(() => button().textContent === "Importing…" && button().disabled);
      if (button() !== original) throw new Error("A state update replaced the focused control");
      mount.update(true, true, 0, 0);
      await waitFor(() => button().textContent === "Starting…");
      mount.update(true, false, 1, 1);
      await waitFor(() => button().textContent === "Import 1 project and start" && !button().disabled);
      button().click();
      button().click();
      if (activationCount() !== 1) throw new Error("Setup activation must be single while pending");
      mount.free();
      released = true;
      if (root.childElementCount !== 0) throw new Error("A released welcome mount retained its controls");
      root.appendChild(original);
      original.disabled = false;
      original.click();
      if (activationCount() !== 1) throw new Error("A released welcome mount retained an activation");
      return { countUpdates: true, agentReadiness: true, pending: true, focusRetained: true, released: true };
    } finally {
      if (!released) mount.free();
      root.remove();
    }
  });
}

async function capture(page: Page, directory: string, name: string): Promise<void> {
  NodeFS.writeFileSync(
    NodePath.join(directory, `${name}.aria.txt`),
    redact(await page.locator("body").ariaSnapshot({ timeout: 15_000 })),
  );
  await page.screenshot({
    path: NodePath.join(directory, `${name}.png`),
    fullPage: true,
    timeout: 15_000,
  });
}

async function completeInitialSetup(page: Page): Promise<void> {
  // The integrated nightly opens a welcome page after pairing. Complete its normal
  // persisted setup before creating the fixture project through the sidebar.
  const heading = page.getByRole("heading", { name: "Welcome to T3 Code", exact: true });
  await heading.waitFor({ state: "visible" });
  const welcome = page.getByRole("main").filter({ has: heading });
  // Source development mode supplies the free replay agent. Requiring its row and
  // the enabled Start button also checks provider discovery without a real sign-in.
  await welcome.getByText("Replay (dev)", { exact: true }).waitFor({ state: "visible" });
  await welcome
    .getByText(/^Looking for projects in your .* history…$/u)
    .waitFor({ state: "hidden" });
  const projectImport = welcome.getByRole("checkbox", {
    name: /^Import (?:\d+ )?projects? and their threads\b/u,
  });
  if (await projectImport.isVisible()) await projectImport.uncheck();
  await welcome.getByRole("button", { name: "Start", exact: true }).click();
  await heading.waitFor({ state: "hidden" });
  await page.waitForURL((url) => url.pathname === "/");
}

async function readThreadSnapshot(
  page: Page,
  threadId: string,
): Promise<OrchestrationV2ThreadDetailSnapshot> {
  // Read the existing authenticated application contract with this browser session's cookies.
  const response = await page.request.get(
    new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, page.url()).href,
    {
      headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
      timeout: timeoutMs,
    },
  );
  Assert.ok(response.ok(), `Thread snapshot failed with HTTP ${response.status()}`);
  const snapshot = decodeSnapshot(await response.json());
  snapshotMetadata.set(page, summarizeSnapshot(snapshot));
  Assert.equal(snapshot.projection.thread.id, threadId);
  return snapshot;
}

async function submitReplay(
  page: Page,
  modelLabel = "Showcase",
  prompt = replayPrompt,
  projectName = "hybrid-fixture",
): Promise<string> {
  await page.getByRole("button", { name: `New thread in ${projectName}`, exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/draft/"));
  const picker = page.locator('[data-chat-provider-model-picker="true"]:visible');
  const search = page.getByPlaceholder("Search models...");
  await picker.click();
  await search.fill(modelLabel);
  await page.getByRole("option", { name: modelLabel }).click();
  if (!(await search.isVisible())) await picker.click();
  await page.locator("[data-composer-permissions-trigger]:visible").click();
  await page.getByRole("menuitemradio", { name: "Supervised", exact: true }).click();
  if (await search.isVisible()) await search.press("Escape");
  await search.waitFor({ state: "hidden" });

  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await editor.fill(prompt);
  await page.getByRole("button", { name: "Submit message", exact: true }).click();
  await page.waitForURL((url) => /^\/(?!draft\/)[^/]+\/[^/]+$/u.test(url.pathname));
  const thread = new URL(page.url()).pathname.split("/").at(-1);
  Assert.ok(thread, "The composer must navigate to the submitted thread");
  return decodeURIComponent(thread);
}

async function pendingShowcase(
  page: Page,
  threadId: string,
): Promise<InterruptedShowcase> {
  await page.getByRole("button", { name: /^(Yes|Approve)$/u }).first().waitFor({ state: "visible" });
  const pending = await readThreadSnapshot(page, threadId);
  const identity = replayTurnIdentity(pending);
  const request = pending.projection.runtimeRequests.find(
    (item) => item.providerTurnId === identity.providerTurnId && item.status === "pending",
  );
  const partialMessage = pending.projection.messages.find(
    (item) => item.role === "assistant" && item.runId === identity.runId && item.text.length > 0,
  );
  Assert.ok(request, "The interrupted turn must have a pending approval");
  Assert.ok(partialMessage, "The fixture must stream assistant text before the approval");
  return {
    ...identity,
    threadId,
    threadUrl: page.url(),
    requestId: request.id,
    partialMessageId: partialMessage.id,
    partialText: partialMessage.text,
  };
}

async function interruptShowcase(page: Page): Promise<InterruptedShowcase> {
  const evidence = await pendingShowcase(page, await submitReplay(page));
  await page.getByRole("button", { name: "Stop generation", exact: true }).click();
  await verifyInterruptedShowcase(page, evidence);
  return evidence;
}

async function addFixtureProject(page: Page, workspace: string, name: string) {
  await page.getByRole("button", { name: "Add project", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Local folder", { exact: true }).click();
  await dialog.getByRole("combobox").fill(workspace);
  await dialog.getByRole("button", { name: /^Add \(/u }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText(name, { exact: true }).first().waitFor({ state: "visible" });
}

async function verifyParallelShowcases(page: Page, workspace: string) {
  const projectNames = ["parallel-completion", "parallel-interrupt"] as const;
  for (const name of projectNames) {
    const target = NodePath.join(NodePath.dirname(workspace), name);
    NodeFS.mkdirSync(NodePath.join(target, "src"), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(workspace, "src", "math.ts"), NodePath.join(target, "src", "math.ts"));
    await addFixtureProject(page, target, name);
  }

  const completing = await page.context().newPage();
  const interrupting = await page.context().newPage();
  try {
    const origin = new URL(page.url()).origin;
    const open = async (tab: Page, projectName: string) => {
      await tab.goto(origin, { waitUntil: "domcontentloaded" });
      const threadId = await submitReplay(tab, "Showcase", replayPrompt, projectName);
      return pendingShowcase(tab, threadId);
    };
    const [complete, interrupt] = await Promise.all([
      open(completing, projectNames[0]),
      open(interrupting, projectNames[1]),
    ]);
    Assert.notEqual(complete.threadId, interrupt.threadId);
    Assert.notEqual(complete.providerTurnId, interrupt.providerTurnId);
    Assert.notEqual(complete.requestId, interrupt.requestId);

    await completing.getByRole("button", { name: /^(Yes|Approve)$/u }).first().click();
    const accepted = await assertCompleted(completing, complete.threadId, complete);
    const other = await readThreadSnapshot(interrupting, interrupt.threadId);
    Assert.equal(other.projection.runs.length, 1);
    Assert.equal(
      other.projection.runtimeRequests.find((request) => request.id === interrupt.requestId)?.status,
      "pending",
      "Approval must leave the concurrent request in the other thread pending",
    );
    await interrupting.getByRole("button", { name: "Stop generation", exact: true }).click();
    await verifyInterruptedShowcase(interrupting, interrupt);

    await Promise.all([
      completing.reload({ waitUntil: "domcontentloaded" }),
      interrupting.reload({ waitUntil: "domcontentloaded" }),
    ]);
    const reopened = await assertCompleted(completing, complete.threadId, complete);
    Assert.equal(reopened.assistantMessageId, accepted.assistantMessageId);
    await verifyInterruptedShowcase(interrupting, interrupt);
    return {
      separateRequests: true,
      stillPendingAfterOtherApproval: true,
      completedReopened: true,
      interruptedReopened: true,
      completedThread: complete.threadId,
      interruptedThread: interrupt.threadId,
    };
  } finally {
    await Promise.all([completing.close(), interrupting.close()]);
  }
}

async function verifyDraftMerge(page: Page) {
  const originalPrompt = "Fixture prompt before editing";
  const newerPrompt = "Newer unsent text from the first tab";
  const storageKey = "t3code:composer-drafts:v1";
  const editor = (tab: Page) => tab.getByTestId("composer-editor");
  const chooseModel = async (tab: Page, label: string) => {
    const picker = tab.locator('[data-chat-provider-model-picker="true"]:visible');
    const search = tab.getByPlaceholder("Search models...");
    await picker.click();
    await search.fill(label);
    await tab.getByRole("option", { name: label }).click();
    if (await search.isVisible()) await search.press("Escape");
    await search.waitFor({ state: "hidden" });
  };
  await page.getByRole("button", { name: "New thread in hybrid-fixture", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/draft/"));
  const draftUrl = page.url();
  const draftId = decodeURIComponent(new URL(draftUrl).pathname.split("/").at(-1)!);
  const waitSaved = async (tab: Page, model: string, prompt?: string) => {
    const state = await tab.waitForFunction(
      ({ storageKey, draftId, model, prompt }) => {
        const saved = localStorage.getItem(storageKey);
        if (saved === null) return null;
        const { version, state } = JSON.parse(saved);
        const row = state.draftsByThreadKey?.[draftId];
        if (
          version !== 9 ||
          row?.modelSelectionByProvider?.devReplay?.model !== model ||
          (prompt !== undefined && row.prompt !== prompt)
        ) return null;
        return { prompt: row.prompt, model };
      },
      { storageKey, draftId, model, prompt },
      { timeout: 15_000 },
    );
    return await state.jsonValue();
  };
  await chooseModel(page, "Showcase");
  await editor(page).fill(originalPrompt);
  await waitSaved(page, "showcase", originalPrompt);

  const second = await page.context().newPage();
  second.setDefaultTimeout(timeoutMs);
  try {
    await second.goto(draftUrl, { waitUntil: "domcontentloaded" });
    await editor(second).waitFor({ state: "visible" });
    Assert.equal(await editor(second).innerText(), originalPrompt);
    await editor(page).fill(newerPrompt);
    await waitSaved(page, "showcase", newerPrompt);

    Assert.equal(await editor(second).innerText(), originalPrompt, "The second tab must be stale");
    await chooseModel(second, "Write approval");
    const stored = await waitSaved(second, "approval");
    Assert.equal(stored?.prompt, newerPrompt, "A stale model save erased another tab's draft text");

    await second.reload({ waitUntil: "domcontentloaded" });
    await editor(second).waitFor({ state: "visible" });
    Assert.equal(await editor(second).innerText(), newerPrompt);
    await second.getByRole("button", { name: "Write approval", exact: true })
      .waitFor({ state: "visible" });
    return { visiblePrompt: newerPrompt, model: "approval", sameDraft: true };
  } finally {
    await second.close();
  }
}

async function verifyDraftStorageRecovery(page: Page) {
  const storageKey = "t3code:composer-drafts:v1";
  const original = "Draft stored before the quota fault";
  const revised = "Draft edited while storage is full 🐟";
  const editor = page.getByRole("textbox", { name: "Message New thread", exact: true });
  await page.getByRole("button", { name: "New thread in hybrid-fixture", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/draft/"));
  // Route navigation can change the URL before React has replaced the old thread's editor.
  await editor.waitFor({ state: "visible" });
  const draftId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  const saved = (prompt: string) => page.waitForFunction(
    ({ storageKey, draftId, prompt }) => {
      const raw = localStorage.getItem(storageKey);
      return raw !== null && JSON.parse(raw).state.draftsByThreadKey[draftId]?.prompt === prompt;
    },
    { storageKey, draftId, prompt },
    { timeout: 10_000 },
  );
  await editor.fill(original);
  Assert.equal(await editor.innerText(), original);
  await saved(original);
  await page.evaluate((key) => {
    const setItem = Storage.prototype.setItem;
    window.addEventListener("fixture-restore-draft-storage", () => {
      Storage.prototype.setItem = setItem;
    }, { once: true });
    Storage.prototype.setItem = function (name, value) {
      if (this === window.localStorage && name === key) {
        document.documentElement.dataset.fixtureDraftQuotaFault = "true";
        throw new DOMException("Synthetic composer storage quota", "QuotaExceededError");
      }
      setItem.call(this, name, value);
    };
  }, storageKey);
  const recovered = () => page.evaluate(() => {
    window.dispatchEvent(new Event("fixture-restore-draft-storage"));
  });
  try {
    await editor.fill(revised);
    await page.locator('html[data-fixture-draft-quota-fault="true"]').waitFor({ state: "attached" });
    const notice = page.getByText("Draft changes could not be saved", { exact: true });
    await notice.waitFor({ state: "visible", timeout: 10_000 });
    Assert.equal(await editor.innerText(), revised);
    await saved(original);
    await recovered();
    await page.getByRole("button", { name: "Retry saving", exact: true }).click();
    await saved(revised);
    await notice.waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.waitFor({ state: "visible" });
    Assert.equal(await editor.innerText(), revised);
    return { failureVisible: true, promptRetained: true, savedAfterRetry: true };
  } finally {
    await recovered();
  }
}

async function verifyInterruptedShowcase(page: Page, expected: InterruptedShowcase): Promise<void> {
  await page.waitForURL((url) => url.href === expected.threadUrl);
  await page.getByText("The project has a single math module.", { exact: false }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /^(Stop generation|Stopping)$/u }).waitFor({ state: "hidden" });
  const { projection } = await readThreadSnapshot(page, expected.threadId);
  Assert.equal(projection.runs.length, 1, "An interrupted turn must not be replayed on reopen");
  const run = projection.runs.find((item) => item.id === expected.runId);
  const attempt = projection.attempts.find((item) => item.id === expected.attemptId);
  const providerTurn = projection.providerTurns.find((item) => item.id === expected.providerTurnId);
  Assert.ok(run && attempt && providerTurn, "The original interrupted execution must remain linked");
  Assert.equal(run.status, "interrupted");
  Assert.equal(attempt.status, "interrupted");
  Assert.equal(providerTurn.status, "interrupted");
  Assert.equal(attempt.runId, run.id);
  assertReplayTurnLinks(attempt, providerTurn);
  const request = projection.runtimeRequests.find((item) => item.id === expected.requestId);
  Assert.equal(request?.status, "cancelled");
  const message = projection.messages.find((item) => item.id === expected.partialMessageId);
  Assert.equal(message?.text, expected.partialText);
  Assert.equal(message?.streaming, false);
}

async function terminalInput(page: Page) {
  const input = page.getByRole("textbox", { name: "Terminal input" });
  const drawer = page.getByRole("button", { name: "Toggle terminal drawer" });
  await drawer.waitFor({ state: "visible" });
  if ((await drawer.getAttribute("aria-pressed")) !== "true") await drawer.click();
  await input.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Terminal input"]',
    );
    return element !== null && !element.readOnly;
  });
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await input.focus();
  return input;
}

async function waitForTerminalCopy(
  page: Page,
  input: Locator,
  pattern: RegExp,
  phase?: string,
  observe?: (clipboard: string) => void,
) {
  const deadline = Date.now() + 10_000;
  do {
    await input.press("Control+Shift+a");
    await input.press("Control+Shift+c");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    observe?.(clipboard);
    const match = clipboard.match(pattern);
    if (match !== null) return match;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Expected a rendered terminal response matching ${pattern}${phase ? ` ${phase}` : ""}`);
}

async function terminalMarker(page: Page, prefix: "fixture-pty" | "fixture-reattach") {
  const input = await terminalInput(page);
  await waitForTerminalCopy(page, input, /[$#]\s*$/u);
  const command = `printf '${prefix}:%s %s\\n' "$$" '世界'`;
  await page.evaluate((line) => navigator.clipboard.writeText(line), command);
  await input.press("Control+Shift+v");
  await waitForTerminalCopy(page, input, new RegExp(`${prefix}:%s %s`, "u"));
  await input.press("Enter");
  // The echoed format string contains no PID. Only rendered shell output matches.
  const [, pid] = await waitForTerminalCopy(page, input, new RegExp(`${prefix}:(\\d+) 世界`, "u"));
  Assert.ok(pid);
  return pid;
}

function assertNativePtyOwner(shell: string, executable: string, serverPid: number): void {
  const expected = NodeFS.realpathSync(executable);
  let pid = Number(shell);
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const processDirectory = `/proc/${pid}`;
    const status = NodeFS.readFileSync(`${processDirectory}/status`, "utf8");
    const parent = Number(status.match(/^PPid:\s+(\d+)$/mu)?.[1]);
    if (NodeFS.readlinkSync(`${processDirectory}/exe`) === expected) {
      Assert.equal(parent, serverPid, "The bundled server must own the selected PTY helper");
      return;
    }
    if (parent === serverPid) break;
    pid = parent;
  }
  Assert.fail("The interactive shell must descend from the selected Rust PTY host");
}

async function waitForTerminalReceipt(page: Page, path: string) {
  const deadline = Date.now() + 10_000;
  do {
    if (NodeFS.existsSync(path)) {
      const value = NodeFS.readFileSync(path, "utf8");
      if (value.endsWith("\n")) return value.trim();
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`The terminal script did not write its ${NodePath.extname(path)} receipt`);
}

async function waitForSelectedTerminalText(page: Page, input: Locator, pattern: RegExp) {
  const deadline = Date.now() + 10_000;
  do {
    await input.press("Control+Shift+a");
    // The DOM copy operation reads Ghostty's selection without injecting Ctrl+C
    // while the canvas may still be empty and a foreground job owns the PTY.
    const text = await input.evaluate((element) => {
      const clipboard = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, cancelable: true }));
      return clipboard.getData("text/plain");
    });
    if (pattern.test(text)) return text;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Expected selected terminal text matching ${pattern}`);
}

async function verifyAlternateTerminalReconnect(page: Page, workspace: string, shell: string) {
  const script = NodePath.join(workspace, "fixture-terminal-screen.sh");
  const release = `${script}.leave`;
  const exited = `${script}.exited`;
  NodeFS.writeFileSync(
    script,
    [
      `trap 'printf "%s\\n" "$?" > "$0.exited"' EXIT`,
      "trap 'exit 130' INT",
      `printf 'fixture-main-screen:%s\\n\\033[?1049h\\033[Hfixture-alternate-screen:%s 世界\\n' "$1" "$1"`,
      'printf "%s %s\\n" "$1" "$$" > "$0.entered"',
      "attempt=0",
      'while [ ! -f "$0.leave" ] && [ "$attempt" -lt 600 ]; do',
      "  command -p sleep 0.1",
      "  attempt=$((attempt+1))",
      "done",
      '[ -f "$0.leave" ] || exit 1',
      `printf '\\033[?1049lfixture-primary-restored:%s\\n' "$1"`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  const shellQuote = `'${script.replaceAll("'", "'\\''")}'`;
  const input = await terminalInput(page);
  await page.evaluate((line) => navigator.clipboard.writeText(line), `/bin/sh ${shellQuote} "$$"`);
  await input.press("Control+Shift+v");
  await waitForTerminalCopy(page, input, /fixture-terminal-screen\.sh/u, "before submission");
  await input.press("Enter");
  const [reportedShell, foregroundPid] =
    (await waitForTerminalReceipt(page, `${script}.entered`)).split(" ");
  Assert.equal(reportedShell, shell);
  Assert.match(foregroundPid ?? "", /^\d+$/u);
  await page.reload({ waitUntil: "domcontentloaded" });
  const reattached = await terminalInput(page);
  const alternate = new RegExp(`fixture-alternate-screen:${shell} 世界`, "u");
  const screen = await waitForSelectedTerminalText(page, reattached, alternate);
  Assert.ok(!screen.includes(`fixture-main-screen:${shell}`));
  Assert.ok(
    NodeFS.existsSync(`/proc/${foregroundPid}/stat`),
    "The alternate screen must still belong to the original live foreground command",
  );
  NodeFS.writeFileSync(release, "leave\n", { flag: "wx" });
  Assert.equal(await waitForTerminalReceipt(page, exited), "0");
  const restored = new RegExp(`fixture-primary-restored:${shell}`, "u");
  const primary = await waitForSelectedTerminalText(page, reattached, restored);
  Assert.ok(primary.includes(`fixture-main-screen:${shell}`));
  Assert.ok(!alternate.test(primary));
  return {
    sameShell: true,
    foregroundSurvivedReconnect: true,
    alternateScreenRetained: true,
    primaryScreenRestored: true,
  };
}

async function verifySplitTerminalReconnect(page: Page, workspace: string, shell: string) {
  const script = NodePath.join(workspace, "fixture-terminal-fragments.sh");
  const gate = `${script}.resume`;
  const startedFile = `${script}.started`;
  const releasedFile = `${script}.released`;
  const exitFile = `${script}.exited`;
  NodeFS.writeFileSync(
    script,
    [
      `trap 'printf "%s\\n" "$?" > "$0.exited"' EXIT`,
      `printf 'fixture-fragment-start:%s\\n\\033[3' "$1"`,
      'printf "%s %s\\n" "$1" "$$" > "$0.started"',
      "attempt=0",
      'while [ ! -f "$0.resume" ] && [ "$attempt" -lt 600 ]; do',
      "  /usr/bin/sleep 0.1",
      "  attempt=$((attempt+1))",
      "done",
      '[ -f "$0.resume" ] || exit 1',
      'printf "%s\\n" "$1" > "$0.released"',
      `printf '2mfixture-fragment-end:%s \\360\\237' "$1"`,
      "/usr/bin/sleep 0.2",
      "printf '\\246\\200\\033[0m\\n'",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `/bin/sh ${quote(script)} "$$"`;
  const ended = /(?:^|\n)fixture-fragment-end:(\d+) 🦀(?:\r?\n|\s*$)/u;
  const input = await terminalInput(page);
  await page.evaluate((line) => navigator.clipboard.writeText(line), command);
  await input.press("Control+Shift+v");
  await waitForTerminalCopy(page, input, /fixture-terminal-fragments\.sh/u, "before submission");
  await input.press("Enter");
  // Keep the live foreground process free of key events until it writes the end
  // marker. A copy gesture without a selection can be delivered as terminal input.
  const [before, scriptPid] = (await waitForTerminalReceipt(page, startedFile)).split(" ");
  Assert.equal(before, shell);
  Assert.match(scriptPid ?? "", /^\d+$/u);
  let sawSnapshot = false;
  let resumeSnapshot = false;
  let attachRequests = 0;
  const output = new Set<string>();
  const rendered = new Set<string>();
  const codePoints = (text: string) => Array.from(text, (character) => character.codePointAt(0));
  const observeSocket = (socket: import("playwright").WebSocket) => {
    socket.on("framesent", ({ payload }) => {
      if (/"terminal\.(?:attach|observe)"/u.test(payload.toString())) attachRequests += 1;
    });
    socket.on("framereceived", ({ payload }) => {
      const json = payload.toString();
      if (!json.includes("fixture-fragment-") && !json.includes('"type":"output"')) return;
      const envelope = JSON.parse(json) as {
        values?: Array<{ type?: string; snapshot?: { history?: string }; data?: string }>;
      };
      for (const item of envelope.values ?? []) {
        const history = item.snapshot?.history;
        if (history?.includes(`fixture-fragment-start:${shell}`)) {
          sawSnapshot = true;
          resumeSnapshot ||= history.endsWith("\x1b[3");
        }
        if (item.type !== "output" || item.data === undefined || output.size >= 8) continue;
        const fixture = item.data.match(/^(2m)?fixture-fragment-end:\d+( [^\r\n\u001b]{0,8})/u);
        if (fixture) {
          output.add(JSON.stringify(codePoints(`${fixture[1] ?? ""}${fixture[2]}`)));
        } else {
          const continuation = item.data.match(/^(?:[🦀�]+|[🦀�]*\x1b\[0m)(?=\r?\n|$)/u);
          if (continuation) output.add(JSON.stringify(codePoints(continuation[0])));
        }
      }
    });
  };
  page.on("websocket", observeSocket);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const reattached = await terminalInput(page);
    const attachDeadline = Date.now() + 10_000;
    while (!sawSnapshot && Date.now() < attachDeadline) await page.waitForTimeout(100);
    Assert.ok(sawSnapshot, "The reattach snapshot must contain the staged terminal marker");
    NodeFS.writeFileSync(gate, "resume\n", { flag: "wx" });
    Assert.equal(await waitForTerminalReceipt(page, releasedFile), shell);
    Assert.equal(await waitForTerminalReceipt(page, exitFile), "0");
    const [, after] = await waitForTerminalCopy(
      page,
      reattached,
      ended,
      "after releasing PTY output",
      (clipboard) => {
        const fixture = clipboard.match(/(?:^|\n)(.{0,3})fixture-fragment-end:\d+([^\r\n]{0,8})/u);
        if (fixture && rendered.size < 8) {
          rendered.add(JSON.stringify(codePoints(`${fixture[1]}${fixture[2]}`)));
        }
      },
    );
    Assert.equal(after, shell);
    Assert.ok(resumeSnapshot, "The wire snapshot must include the staged control fragment");
    return { sameShell: true, controlSequenceResumed: true, splitUnicode: "🦀" };
  } catch (error) {
    const receipt = JSON.stringify({
      attachRequests,
      sawSnapshot,
      resumeSnapshot,
      gateReleased: NodeFS.existsSync(releasedFile),
      exit: NodeFS.existsSync(exitFile) ? NodeFS.readFileSync(exitFile, "utf8").trim() : null,
      output: [...output],
      rendered: [...rendered],
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)}. PTY fixture ${receipt}`);
  } finally {
    page.off("websocket", observeSocket);
  }
}

function summarizeSnapshot(snapshot: OrchestrationV2ThreadDetailSnapshot) {
  const projection = snapshot.projection;
  return {
    snapshotSequence: snapshot.snapshotSequence,
    threadId: projection.thread.id,
    runs: projection.runs.map(({ id, status, activeAttemptId, rootNodeId, providerThreadId }) => ({
      id,
      status,
      activeAttemptId,
      rootNodeId,
      providerThreadId,
    })),
    attempts: projection.attempts.map(
      ({ id, status, runId, rootNodeId, providerThreadId, providerTurnId }) => ({
        id,
        status,
        runId,
        rootNodeId,
        providerThreadId,
        providerTurnId,
      }),
    ),
    providerTurns: projection.providerTurns.map(
      ({ id, status, runAttemptId, providerThreadId, nodeId, ordinal }) => ({
        id,
        status,
        runAttemptId,
        providerThreadId,
        nodeId,
        ordinal,
      }),
    ),
    runtimeRequests: projection.runtimeRequests.map(({ id, status, nodeId, providerTurnId }) => ({
      id,
      status,
      nodeId,
      providerTurnId,
    })),
  };
}
const snapshotMetadata = new WeakMap<Page, ReturnType<typeof summarizeSnapshot>>();

async function assertCompleted(
  page: Page,
  threadId: string,
  identity: ReplayTurnIdentity,
  reply = replayMarker,
) {
  await page.waitForURL((url) => url.pathname.endsWith(`/${threadId}`), { timeout: timeoutMs });
  await page
    .getByText(reply, { exact: false })
    .last()
    .waitFor({ state: "visible", timeout: timeoutMs });
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .waitFor({ state: "hidden", timeout: timeoutMs });
  const snapshot = await readThreadSnapshot(page, threadId);
  Assert.equal(snapshot.projection.runs.length, 1, "Recovery must not create a second fixture run");
  const run = snapshot.projection.runs.find((item) => item.id === identity.runId);
  const attempt = snapshot.projection.attempts.find((item) => item.id === identity.attemptId);
  const providerTurn = snapshot.projection.providerTurns.find(
    (item) => item.id === identity.providerTurnId,
  );
  Assert.ok(run, "The original replay run must still exist");
  Assert.ok(attempt, "The original replay attempt must still exist");
  Assert.ok(providerTurn, "The original replay provider turn must still exist");
  Assert.equal(run.status, "completed", `Replay run ${run.id} did not complete`);
  Assert.equal(attempt.status, "completed", `Replay attempt ${attempt.id} did not complete`);
  Assert.equal(
    providerTurn.status,
    "completed",
    `Replay provider turn ${providerTurn.id} did not complete`,
  );
  Assert.equal(attempt.runId, run.id);
  Assert.equal(attempt.providerThreadId, run.providerThreadId);
  Assert.equal(attempt.rootNodeId, run.rootNodeId);
  assertReplayTurnLinks(attempt, providerTurn);
  Assert.ok(run.completedAt);
  Assert.ok(attempt.completedAt);
  Assert.ok(providerTurn.completedAt);
  const message = snapshot.projection.messages.find(
    (item) =>
      item.role === "assistant" && item.runId === run.id && item.text.includes(reply),
  );
  Assert.ok(message, "The completed replay text must belong to the recorded run");
  Assert.equal(message.streaming, false);
  return {
    ...identity,
    projectId: snapshot.projection.thread.projectId,
    threadId,
    snapshotSequence: snapshot.snapshotSequence,
    runStatus: run.status,
    attemptStatus: attempt.status,
    providerTurnStatus: providerTurn.status,
    runCompletedAt: DateTime.formatIso(run.completedAt),
    attemptCompletedAt: DateTime.formatIso(attempt.completedAt),
    providerTurnCompletedAt: DateTime.formatIso(providerTurn.completedAt),
    assistantMessageId: message.id,
  };
}

async function acceptCapturedApproval(page: Page) {
  const contents = NodeFS.readFileSync(NodePath.join(repoRoot, capturedApproval.path));
  const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
  Assert.equal(sha256, capturedApproval.sha256, "The recorded ACP approval fixture changed");
  const threadId = await submitReplay(page, capturedApproval.modelLabel, capturedApproval.prompt);
  const button = page
    .getByRole("group", { name: "Command approval", exact: true })
    .getByRole("button", { name: "Approve", exact: true });
  await button.waitFor({ state: "visible" });
  const pending = await readThreadSnapshot(page, threadId);
  const identity = replayTurnIdentity(pending, capturedApproval.model);
  const request = pending.projection.runtimeRequests.find(
    (item) => item.providerTurnId === identity.providerTurnId && item.status === "pending",
  );
  Assert.ok(request, "The recorded approval must belong to the live provider turn");
  Assert.ok(
    pending.projection.messages.some(
      (message) => message.role === "user" && message.text === capturedApproval.prompt,
    ),
    "The recorded-approval turn must contain the submitted prompt",
  );
  await button.click();
  const completed = await assertCompleted(page, threadId, identity, capturedApproval.reply);
  Assert.equal(
    (await readThreadSnapshot(page, threadId)).projection.runtimeRequests.find(
      (item) => item.id === request.id,
    )?.status,
    "resolved",
  );
  return { ...completed, requestId: request.id, source: capturedApproval.path, sha256 };
}

async function cancelCapturedQuestion(page: Page) {
  const contents = NodeFS.readFileSync(NodePath.join(repoRoot, capturedQuestion.path));
  const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
  Assert.equal(sha256, capturedQuestion.sha256, "The recorded ACP question fixture changed");
  const threadId = await submitReplay(page, "Question", "Replay the recorded question");
  const option = page.getByText(capturedQuestion.option, { exact: true }).first();
  await option.waitFor({ state: "visible" });
  const pending = await readThreadSnapshot(page, threadId);
  const identity = replayTurnIdentity(pending, "question");
  const request = pending.projection.runtimeRequests.find(
    (item) => item.kind === "user_input" && item.providerTurnId === identity.providerTurnId,
  );
  Assert.equal(request?.status, "pending");
  Assert.ok(request);
  const requestId = request.id;
  await page.getByRole("button", { name: "Stop generation", exact: true }).click();
  await option.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^(Stop generation|Stopping)$/u }).waitFor({ state: "hidden" });

  function assertCancelled(snapshot: OrchestrationV2ThreadDetailSnapshot) {
    const { projection } = snapshot;
    Assert.equal(projection.runs.length, 1);
    Assert.equal(projection.runs[0]?.id, identity.runId);
    Assert.equal(projection.runs[0]?.status, "interrupted");
    const cancelled = projection.runtimeRequests.find((item) => item.id === requestId);
    Assert.equal(cancelled?.status, "cancelled");
  }
  assertCancelled(await readThreadSnapshot(page, threadId));
  await page.reload({ waitUntil: "domcontentloaded" });
  assertCancelled(await readThreadSnapshot(page, threadId));
  return { ...identity, threadId, requestId, source: capturedQuestion.path, sha256 };
}

type FileWriteReceipt = {
  readonly expectedRevision: unknown;
  readonly status: unknown;
  readonly revision: unknown;
};

async function verifyFileEditor(page: Page, workspace: string, writes: EventEmitter) {
  const onDisk = NodePath.join(workspace, tasksFile);
  const revision = (contents: string) =>
    NodeCrypto.createHash("sha256").update(contents).digest("hex");
  const checkboxes = page.locator(".task-list-item").getByRole("checkbox");
  const panel = page.getByRole("button", { name: "Toggle right panel", exact: true });
  if ((await panel.getAttribute("aria-pressed")) !== "true") await panel.click();
  const files = page.locator('[aria-label="Open a surface"]').getByRole("button", { name: /^Files/u });
  await files.click();
  await page.locator(`[role="treeitem"][data-item-path="${tasksFile}"]`).click();
  const rendered = page.getByRole("button", { name: "Show rendered markdown", exact: true });
  await checkboxes.first().or(rendered).first().waitFor({ state: "visible" });
  if (await rendered.isVisible()) await rendered.click();

  const save = async (
    index: number,
    beforeWrite?: () => void,
  ): Promise<FileWriteReceipt> => {
    const signal = AbortSignal.timeout(15_000);
    const receipt = once(writes, "result", { signal });
    try {
      await checkboxes.nth(index).check({ timeout: 10_000 });
      beforeWrite?.();
    } catch (error) {
      void receipt.catch(() => {});
      throw error;
    }
    const [result] = await receipt;
    return result as FileWriteReceipt;
  };
  const first = initialTasks.replace("- [ ] First", "- [x] First");
  const second = first.replace("- [ ] Second", "- [x] Second");
  for (const [index, base, saved] of [[0, initialTasks, first], [1, first, second]] as const) {
    Assert.deepEqual(await save(index), {
      status: "Success",
      expectedRevision: revision(base),
      revision: revision(saved),
    });
    Assert.equal(NodeFS.readFileSync(onDisk, "utf8"), saved);
    Assert.ok(await checkboxes.nth(index).isChecked(), "The saved checkbox must stay checked");
  }

  const external = second + "\nAn external writer changed this file.\n";
  const conflict = await save(2, () => NodeFS.writeFileSync(onDisk, external));
  Assert.equal(conflict.status, "Failure");
  Assert.equal(conflict.expectedRevision, revision(second));
  await page.getByText("File changed on disk", { exact: true }).waitFor({ state: "visible" });
  Assert.equal(NodeFS.readFileSync(onDisk, "utf8"), external);
  Assert.ok(await checkboxes.nth(2).isChecked(), "The visible unsaved edit must remain after refusal");
  return { path: tasksFile, confirmedEdits: 2, externalChangePreserved: true, draftPreserved: true };
}

function textRevisionIdentity(stateDirectory: string, initialize = false) {
  const executable = NodePath.join(repoRoot, "apps/server/dist/native-bin/t3-code-ls-db");
  const databasePath = NodePath.join(stateDirectory, "userdata", "statev2.omdb");
  if (initialize) {
    Assert.equal(NodeFS.existsSync(databasePath), false, "Text revisions require a fresh fixture");
  }
  const requests = [
    ...(initialize
      ? [{ operation: "application_bootstrap", event_layout: "assistant_text_revisions_v1" }]
      : []),
    { operation: "application_generation_identity" },
  ];
  const mode = initialize ? "initialize-local" : "read-only-local";
  const run = ChildProcess.spawnSync(executable, [mode, databasePath], {
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    env: {},
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 65_536,
  });
  Assert.ifError(run.error);
  Assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  Assert.equal(responses.length, requests.length);
  for (const response of responses) Assert.equal(response.ok, true, JSON.stringify(response.error));
  if (initialize) Assert.equal(responses[0].result.initialized, true);
  const identity = responses.at(-1).result;
  Assert.equal(identity.engine, "omdb");
  Assert.equal(identity.generation, "native");
  Assert.equal(identity.layout, "t3-application-keyspace-v1+assistant-text-revisions-v1");
  Assert.match(identity.catalog_sha256, /^[a-f0-9]{64}$/u);
  return { layout: identity.layout as string, catalogSha256: identity.catalog_sha256 as string };
}

const linkedPdfName = "fixture-links.pdf";

function linkedPdf(): string {
  const page = (contents: number, annotations = "") =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R ${annotations} >>`;
  const stream = (text: string) => {
    const command = `BT /F1 24 Tf 30 700 Td (${text}) Tj ET`;
    return `<< /Length ${command.length} >>\nstream\n${command}\nendstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    page(
      4,
      "/Annots [<< /Type /Annot /Subtype /Link /Rect [30 690 220 730] /Border [0 0 0] /Dest [5 0 R /XYZ 0 792 0] >>]",
    ),
    stream("See page 2"),
    page(6),
    stream("Fixture PDF destination"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  const xref = source.length;
  return `${source}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function verifyLinkedPdf(page: Page) {
  const panel = page.getByRole("button", { name: "Toggle right panel", exact: true });
  if ((await panel.getAttribute("aria-pressed")) !== "true") await panel.click();
  await page.locator('[aria-label="Open a surface"]').getByRole("button", { name: /^Files/u }).click();
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(page.url()).origin &&
        /^\/api\/assets\/[^/]+\/fixture-links\.pdf$/u.test(url.pathname)
      );
    }),
    page.locator(`[role="treeitem"][data-item-path="${linkedPdfName}"]`).click(),
  ]);
  Assert.ok(response.ok(), `Signed fixture PDF returned HTTP ${response.status()}`);
  const reader = page.getByRole("region", { name: linkedPdfName, exact: true });
  await page.getByText("1 / 2 pages", { exact: true }).waitFor({ state: "visible" });
  const destination = reader.getByRole("link", { name: "Page 2", exact: true });
  await destination.waitFor({ state: "visible" });
  await reader.getByText("See page 2", { exact: true }).click({ force: true });
  const targetPage = page.getByText("2 / 2 pages", { exact: true });
  await targetPage.waitFor({ state: "visible", timeout: 8_000 });
  await reader.getByText("Fixture PDF destination", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await destination.press("Enter");
  await targetPage.waitFor({ state: "visible", timeout: 8_000 });
  return { signedAssetStatus: response.status(), pointerDestination: 2, keyboardDestination: 2 };
}

async function exercise(implementation: Implementation): Promise<void> {
  const directory = NodePath.join(proofRoot, implementation);
  NodeFS.mkdirSync(directory, { recursive: true });
  const workspace = NodePath.join(runRoot, implementation, "hybrid-fixture");
  const stateDirectory = NodePath.join(runRoot, implementation, "state");
  Assert.ok(!durableTextProof || (bundledClient && implementation === "native"));
  if (bundledClient) {
    const settingsDirectory = NodePath.join(stateDirectory, "userdata");
    NodeFS.mkdirSync(settingsDirectory, { recursive: true });
    writeJson(NodePath.join(settingsDirectory, "settings.json"), {
      responseStreamingMode: "paragraph",
      providerInstances: {
        devReplay: {
          displayName: "Replay (dev)",
          driver: "acpRegistry",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [NodePath.join(repoRoot, "apps/server/scripts/dev-replay-agent.ts")],
          },
        },
      },
    });
  }
  NodeFS.mkdirSync(NodePath.join(workspace, "src"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(workspace, "package.json"),
    '{"name":"hybrid-fixture","private":true,"scripts":{"test":"node --test"}}\n',
  );
  NodeFS.writeFileSync(
    NodePath.join(workspace, "src", "math.ts"),
    "export const sum = (a: number, b: number) => a + b;\n",
  );
  if (fileEditorProof) NodeFS.writeFileSync(NodePath.join(workspace, tasksFile), initialTasks);
  git(["init", "--initial-branch=main"], workspace);
  git(["add", "package.json", "src/math.ts", ...(fileEditorProof ? [tasksFile] : [])], workspace);
  if (pdfLinkProof) {
    NodeFS.writeFileSync(NodePath.join(workspace, linkedPdfName), linkedPdf());
    git(["add", linkedPdfName], workspace);
  }
  git(
    [
      "-c",
      "user.name=Hybrid acceptance",
      "-c",
      "user.email=hybrid-acceptance@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Add controlled replay fixture",
    ],
    workspace,
  );
  const [serverPort, webPort] = await availablePorts();
  Assert.ok(serverPort && webPort);
  Assert.notEqual(serverPort, webPort, "Server and client need distinct ports");
  Assert.ok(webPort > 5733, "The allocated web port must support the dev-runner offset");
  const proof = {
    schemaVersion: 1,
    status: "running",
    implementation,
    client: bundledClient ? "built" : "development",
    composer: "unverified",
    textRevisionProfile: null as ReturnType<typeof textRevisionIdentity> | null,
    pdfLinks: null as Awaited<ReturnType<typeof verifyLinkedPdf>> | null,
    scope:
      "Linux original web client; local project; composer submission; free ACP showcase approval and interruption; reload; same-state server restart",
    startedAt: new Date().toISOString(),
    finishedAt: null as string | null,
    source,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    browser: browser!.version(),
    stateDirectory,
    fixtureDirectory: workspace,
    serverPort,
    webPort,
    processGroups: [] as number[],
    currentStep: "application startup",
    completedSteps: [] as string[],
    threadId: null as string | null,
    threadUrl: null as string | null,
    turnIdentity: null as ReplayTurnIdentity | null,
    interrupted: null as InterruptedShowcase | null,
    capturedApproval: null as Awaited<ReturnType<typeof acceptCapturedApproval>> | null,
    cancelledQuestion: null as Awaited<ReturnType<typeof cancelCapturedQuestion>> | null,
    historyFind: null as { query: string; count: string; draftPreserved: boolean } | null,
    draftMerge: null as Awaited<ReturnType<typeof verifyDraftMerge>> | null,
    parallelTurns: null as Awaited<ReturnType<typeof verifyParallelShowcases>> | null,
    draftStorage: null as Awaited<ReturnType<typeof verifyDraftStorageRecovery>> | null,
    messageAppends: null as {
      requests: number;
      spliceCapableRequests: number;
      frames: number;
      rustDecoder: boolean;
      messageUpdates: Array<{ sequence: number; length: number; streaming: boolean }>;
      storedUpdates: ReturnType<typeof inspectNativeMessageUpdates>;
    } | null,
    messageSplice: null as {
      baseSequence: number;
      sequence: number;
      rustDecoder: boolean;
      reopenedTextMatches: boolean;
    } | null,
    terminalReattach: null as { sameShell: boolean; unicodeOutput: boolean } | null,
    terminalSplit: null as Awaited<ReturnType<typeof verifySplitTerminalReconnect>> | null,
    terminalAlternate: null as Awaited<ReturnType<typeof verifyAlternateTerminalReconnect>> | null,
    terminalFailure: null as string | null,
    terminalInitialOutput: false,
    nativePtyOwner: false,
    bundledNativePtyOwner: false,
    fileEditor: null as Awaited<ReturnType<typeof verifyFileEditor>> | null,
    completedSnapshots: [] as Array<
      Awaited<ReturnType<typeof assertCompleted>> & { checkpoint: string }
    >,
    persistence: [] as Array<ReturnType<typeof inspectNativeReplay> & { checkpoint: string }>,
    browserErrors: [] as string[],
    error: null as string | null,
  };
  const saveProof = () => writeJson(NodePath.join(directory, "proof.json"), proof);
  const starting = (step: string) => {
    proof.currentStep = step;
    saveProof();
    console.log(`[${implementation}] Starting ${step}`);
  };
  const completed = (step: string) => {
    proof.completedSteps.push(step);
    saveProof();
    console.log(`[${implementation}] ${step}`);
  };
  const inspectPersistence = (checkpoint: string, closed = false) => {
    if (implementation !== "native") return;
    const expected = proof.completedSnapshots.at(-1);
    Assert.ok(expected, "A completed client snapshot must precede native row verification");
    proof.persistence.push({
      checkpoint,
      ...inspectNativeReplay({
        executable: nativeExecutable("db"),
        stateDirectory,
        expected,
        closed,
      }),
    });
    saveProof();
  };
  saveProof();
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce" as const,
  };
  let context = await browser!.newContext(contextOptions);
  let page = await context.newPage();
  let threadFindRequests = 0;
  let messageAppendFrames = 0;
  let messageAppendRequests = 0;
  let messageSpliceRequests = 0;
  const spliceFrames = new Map<string, {
    readonly baseSequence: number;
    readonly sequence: number;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly inserted: string;
  }>();
  const wireMessages = new Map<string, Array<{ sequence: number; length: number; streaming: boolean }>>();
  const fileWrites = new EventEmitter();
  function observePage(current: Page): void {
    current.setDefaultTimeout(timeoutMs);
    current.setDefaultNavigationTimeout(timeoutMs);
    current.on("pageerror", (error) =>
      proof.browserErrors.push(redact(error.stack ?? error.message)),
    );
    current.on("console", (message) => {
      if (message.type() === "error") proof.browserErrors.push(redact(message.text()));
    });
    current.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const json = payload.toString();
        if (json.includes('"orchestration.searchThreadStream"')) {
          threadFindRequests += 1;
        }
        if (/"messageTextAppends":[12](?!\d)/u.test(json)) messageAppendRequests += 1;
        if (/"messageTextAppends":2(?!\d)/u.test(json)) messageSpliceRequests += 1;
      });
      socket.on("framereceived", ({ payload }) => {
        const json = payload.toString();
        if (json.includes('"kind":"message-text-append"')) {
          messageAppendFrames += 1;
        }
        if (!json.includes('"message.updated"')) return;
        let envelope: {
          values?: Array<{
            kind?: string;
            baseSequence?: number;
            sequence?: number;
            startUtf16?: number;
            endUtf16?: number;
            event?: { type?: string; payload?: { threadId?: string; text?: string; streaming?: boolean } };
          }>;
        };
        try {
          envelope = JSON.parse(json) as typeof envelope;
        } catch {
          return;
        }
        for (const frame of envelope.values ?? []) {
          const message = frame.event?.payload;
          if (
            frame.event?.type !== "message.updated" ||
            message?.threadId === undefined ||
            message.text === undefined ||
            frame.sequence === undefined
          ) continue;
          if (
            frame.kind === "message-text-splice" &&
            frame.baseSequence !== undefined &&
            frame.startUtf16 !== undefined &&
            frame.endUtf16 !== undefined
          ) {
            spliceFrames.set(message.threadId, {
              baseSequence: frame.baseSequence,
              sequence: frame.sequence,
              startUtf16: frame.startUtf16,
              endUtf16: frame.endUtf16,
              inserted: message.text,
            });
          }
          const messages = wireMessages.get(message.threadId) ?? [];
          if (messages.length < 64) {
            messages.push({
              sequence: frame.sequence,
              length: message.text.length,
              streaming: message.streaming === true,
            });
            wireMessages.set(message.threadId, messages);
          }
        }
      });
      const pending = new Map<string, unknown>();
      socket.on("framesent", ({ payload }) => {
        const json = payload.toString();
        if (!fileEditorProof || !json.includes('"projects.writeFile"')) return;
        const request = JSON.parse(json);
        if (request.payload?.relativePath === tasksFile) {
          pending.set(String(request.id), request.payload.expectedRevision);
        }
      });
      if (!fileEditorProof) return;
      socket.on("framereceived", ({ payload }) => {
        const json = payload.toString();
        if (pending.size === 0 || !json.includes('"Exit"')) return;
        const response = JSON.parse(json);
        const requestId = String(response.requestId);
        if (response._tag !== "Exit" || !pending.has(requestId)) return;
        fileWrites.emit("result", {
          expectedRevision: pending.get(requestId),
          status: response.exit?._tag,
          revision: response.exit?.value?.revision,
        } satisfies FileWriteReceipt);
        pending.delete(requestId);
      });
    });
  }
  observePage(page);

  try {
    if (durableTextProof) {
      starting("initialize the opted-in assistant text layout");
      proof.textRevisionProfile = textRevisionIdentity(stateDirectory, true);
      completed("Initialized the assistant text revision layout for this fresh omdb profile");
    }
    let application = await startApplication(
      implementation,
      stateDirectory,
      serverPort,
      webPort,
      NodePath.join(directory, "startup.log"),
    );
    proof.processGroups.push(application.pid);
    starting("initial setup");
    await page.goto(application.pairingUrl, { waitUntil: "domcontentloaded" });
    await completeInitialSetup(page);
    completed(
      "Completed initial setup through the normal UI without agent sign-in or project import",
    );
    starting("local project creation");
    await addFixtureProject(page, workspace, "hybrid-fixture");
    completed("Created local project through the normal client");
    if (parallelTurnsProof) {
      Assert.ok(bundledClient && implementation === "native");
      starting("run independently controlled replay turns in two projects");
      proof.parallelTurns = await verifyParallelShowcases(page, workspace);
      completed("Reopened distinct completed and interrupted turns after concurrent approvals");
    }
    if (multiTabDraftProof) {
      starting("two-tab unsent draft and model merge");
      proof.draftMerge = await verifyDraftMerge(page);
      completed("Kept the newer draft from the first tab and the model selected in the second");
    }
    starting("normal composer submission and controlled approval");
    const threadId = await submitReplay(page);
    proof.threadId = threadId;
    const usedRustComposer = await page.evaluate(
      () => performance.getEntriesByName("t3-composer-rust-offsets").length === 1,
    );
    Assert.equal(usedRustComposer, expectsRustComposer, "The composer must use the selected mapper");
    proof.composer = usedRustComposer ? "rust-wasm" : "retained";
    const approval = page.getByRole("button", { name: /^(Yes|Approve)$/u }).first();
    await approval.waitFor({ state: "visible" });
    const pending = await readThreadSnapshot(page, threadId);
    Assert.equal(pending.projection.thread.modelSelection?.instanceId, "devReplay");
    Assert.equal(pending.projection.thread.modelSelection?.model, "showcase");
    Assert.ok(
      pending.projection.messages.some(
        (message) => message.role === "user" && message.text === replayPrompt,
      ),
      "The submitted prompt must be present in the authoritative thread snapshot",
    );
    const turnIdentity = replayTurnIdentity(pending);
    proof.turnIdentity = turnIdentity;
    await capture(page, directory, "approval");
    await approval.click();
    completed("Approved the controlled replay provider request in the normal client");
    starting("replay completion and durable snapshot");
    proof.completedSnapshots.push({
      checkpoint: "initial",
      ...(await assertCompleted(page, threadId, turnIdentity)),
    });
    proof.threadUrl = page.url();
    inspectPersistence("initial");
    completed("Received the completed replay turn on the original thread route");
    if (pdfLinkProof) {
      starting("follow a same-document link in the PDF reader opened from Files");
      proof.pdfLinks = await verifyLinkedPdf(page);
      completed("Followed a link in the signed PDF with pointer and keyboard input");
      await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    }
    starting("stop with a streamed reply and pending approval");
    proof.interrupted = await interruptShowcase(page);
    Assert.notEqual(proof.interrupted.threadId, threadId);
    completed("Stopped a separate turn through the composer and retained its partial reply");

    starting("client reload");
    await page.reload({ waitUntil: "domcontentloaded" });
    await verifyInterruptedShowcase(page, proof.interrupted);
    await page.goto(proof.threadUrl, { waitUntil: "domcontentloaded" });
    proof.completedSnapshots.push({
      checkpoint: "client-reload",
      ...(await assertCompleted(page, threadId, turnIdentity)),
    });
    Assert.equal(page.url(), proof.threadUrl);
    inspectPersistence("client-reload");
    completed("Reconnected after a client reload with the same completed thread");

    starting("owned server restart");
    await application.stop();
    inspectPersistence("closed-before-restart", true);
    application = await startApplication(
      implementation,
      stateDirectory,
      serverPort,
      webPort,
      NodePath.join(directory, "restart.log"),
    );
    proof.processGroups.push(application.pid);
    starting("durable recovery in a fresh client");
    if (proof.textRevisionProfile !== null) {
      Assert.deepEqual(textRevisionIdentity(stateDirectory), proof.textRevisionProfile);
    }
    // Keep only the authenticated session cookies. A fresh client cannot satisfy recovery
    // from localStorage or IndexedDB, and must retrieve the old thread from the restarted server.
    // Do not consume the restart's new pairing token or persist the session cookies in proof.
    const cookies = await context.cookies();
    await context.close();
    context = await browser!.newContext({
      ...contextOptions,
      storageState: { cookies, origins: [] },
    });
    page = await context.newPage();
    observePage(page);
    await page.goto(proof.threadUrl, { waitUntil: "domcontentloaded" });
    proof.completedSnapshots.push({
      checkpoint: "server-restart",
      ...(await assertCompleted(page, threadId, turnIdentity)),
    });
    Assert.equal(page.url(), proof.threadUrl);
    inspectPersistence("server-restart");
    completed(
      "Recovered the same durable thread after server restart in a fresh client with the existing session",
    );
    await capture(page, directory, "completed");
    if (bundledClient && implementation === "native") {
      starting("find in reopened conversation");
      const draft = "Draft retained while finding a previous reply";
      const editor = page.getByTestId("composer-editor");
      await editor.fill(draft);
      const requestsBeforeFind = threadFindRequests;
      await page.keyboard.press("Control+f");
      const bar = page.getByRole("search", { name: "Find in thread" });
      const search = bar.getByRole("searchbox", { name: "Find in thread" });
      const query = "single math module";
      await search.fill(query);
      await bar.getByText("1/1", { exact: true }).waitFor({ state: "visible" });
      Assert.ok(threadFindRequests > requestsBeforeFind, "Find must query the restarted server");
      await page.waitForFunction(
        (expected) => Array.from(CSS.highlights.get("t3-thread-find-active") ?? []).some(
          (range) => range.toString() === expected,
        ),
        query,
      );
      await page.keyboard.press("Escape");
      await bar.waitFor({ state: "hidden" });
      Assert.equal(await editor.innerText(), draft);
      proof.historyFind = { query, count: "1/1", draftPreserved: true };
      completed("Found and highlighted the previous reply after restart while retaining the draft");
    }
    if (bundledClient && implementation === "native") {
      starting("interactive terminal reconnect");
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(page.url()).origin,
        });
        const shell = await terminalMarker(page, "fixture-pty");
        if (nativePtyHost !== undefined) {
          if (bundledPtyProof) {
            const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(NodePath.dirname(nativePtyHost), "manifest.json"), "utf8"));
            Assert.equal(manifest.target, "linux-x64");
            Assert.equal(manifest.files["t3-code-ls-pty-host"],
              NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(nativePtyHost)).digest("hex"));
          }
          assertNativePtyOwner(shell, nativePtyHost, application.pid);
          proof.nativePtyOwner = true;
          proof.bundledNativePtyOwner = bundledPtyProof;
        }
        proof.terminalInitialOutput = true;
        saveProof();
        await page.reload({ waitUntil: "domcontentloaded" });
        await assertCompleted(page, threadId, turnIdentity);
        const reattached = await terminalMarker(page, "fixture-reattach");
        Assert.equal(reattached, shell, "A browser reload must reattach to the same PTY shell");
        proof.terminalReattach = { sameShell: true, unicodeOutput: true };
        completed("Reattached to the same PTY and copied its rendered Unicode output after reload");
        if (splitPtyProof) {
          starting("reattach across a split terminal control sequence");
          proof.terminalSplit = await verifySplitTerminalReconnect(page, workspace, shell);
          completed("Reattached across a split control sequence and copied split UTF-8 output");
          starting("reattach while an alternate terminal screen is active");
          proof.terminalAlternate = await verifyAlternateTerminalReconnect(page, workspace, shell);
          completed("Reattached to the alternate screen and restored the primary terminal");
        }
      } catch (error) {
        proof.terminalFailure = redact(error instanceof Error ? error.message : String(error));
        saveProof();
      }
    }
    await page.goto(proof.interrupted.threadUrl, { waitUntil: "domcontentloaded" });
    await verifyInterruptedShowcase(page, proof.interrupted);
    completed("Recovered the interrupted turn and partial reply in the new browser session");
    starting("recorded ACP permission request");
    proof.capturedApproval = await acceptCapturedApproval(page);
    completed("Approved the recorded ACP permission request and received its expected reply");
    if (bundledClient && implementation === "native") {
      starting("recorded ACP question cancellation");
      proof.cancelledQuestion = await cancelCapturedQuestion(page);
      completed("Cancelled the recorded question in the composer and recovered its cancelled request");
    }
    if (expectsRustComposer && implementation === "native" && bundledClient) {
      starting("negotiated Rust text appends");
      const framesBefore = messageAppendFrames;
      const requestsBefore = messageAppendRequests;
      const splicesBefore = messageSpliceRequests;
      const appendThread = await submitReplay(page, "Text appends", "Replay: text appends");
      const approve = page.getByRole("button", { name: /^(Yes|Approve)$/u }).first();
      await approve.waitFor({ state: "visible" });
      Assert.ok(messageAppendRequests > requestsBefore, "Subscribe before releasing the fixture");
      await approve.click();
      const reply = "日本語 and a 🐟 complete the sequence. The bounded text fixture is complete.";
      await page.getByText(reply, { exact: false }).last().waitFor({ state: "visible" });
      const appended = await readThreadSnapshot(page, appendThread);
      await assertCompleted(page, appendThread, replayTurnIdentity(appended, "text-appends"), reply);
      const rustDecoder = await page.evaluate(
        () => performance.getEntriesByName("t3-thread-rust-text-append").length > 0,
      );
      proof.messageAppends = {
        requests: messageAppendRequests - requestsBefore,
        spliceCapableRequests: messageSpliceRequests - splicesBefore,
        frames: messageAppendFrames - framesBefore,
        rustDecoder,
        messageUpdates: wireMessages.get(appendThread) ?? [],
        storedUpdates: inspectNativeMessageUpdates(
          nativeExecutable("db"),
          stateDirectory,
          appendThread,
        ),
      };
      saveProof();
      Assert.ok(proof.messageAppends.requests > 0, "The client must negotiate text appends");
      if (spliceNegotiationProof) {
        Assert.ok(
          proof.messageAppends.spliceCapableRequests > 0,
          "The Rust binding must negotiate version 2",
        );
      }
      Assert.ok(proof.messageAppends.frames > 0, "The thread subscription must receive an append");
      Assert.ok(
        proof.messageAppends.storedUpdates.filter((update) => update.streaming).length >= 2,
        "The fixture must persist both streaming revisions before completing",
      );
      Assert.ok(rustDecoder, "The Rust binding must apply a received append");
      completed("Applied negotiated WebSocket text appends in the Rust browser reducer");
    }

    if (spliceNegotiationProof && implementation === "native") {
      starting("negotiated Rust Unicode text splice");
      const prefix =
        "The replacement fixture keeps the opening sentence in the same assistant message. Its original status is ";
      const suffix =
        ". All of this trailing text stays visible when the provider revises the status, including the final sentence.";
      const original = `${prefix}🐟 queued${suffix}`;
      const revised = `${prefix}🦀 ready${suffix}`;
      const finalText = `${revised} End of revised fixture.`;
      const thread = await submitReplay(page, "Text splices", "Replay: text splices");
      await page.getByRole("button", { name: /^(Yes|Approve)$/u }).first().click();
      await page.getByText(original, { exact: true }).last().waitFor({ state: "visible" });
      await page.getByText(revised, { exact: true }).last().waitFor({ state: "visible" });
      const frame = spliceFrames.get(thread);
      Assert.ok(frame, "The revised streaming reply must arrive as a splice");
      Assert.ok(frame.baseSequence < frame.sequence);
      Assert.equal(frame.startUtf16, prefix.length);
      Assert.equal(frame.endUtf16, prefix.length + "🐟 queued".length);
      Assert.equal(frame.inserted, "🦀 ready");
      const rustDecoder = await page.evaluate(
        () => performance.getEntriesByName("t3-thread-rust-text-splice").length === 1,
      );
      Assert.ok(rustDecoder, "The displayed splice must pass through the Rust decoder");
      const snapshot = await readThreadSnapshot(page, thread);
      const identity = replayTurnIdentity(snapshot, "text-splices");
      const result = await assertCompleted(page, thread, identity, finalText);
      await page.reload({ waitUntil: "domcontentloaded" });
      await assertCompleted(page, thread, identity, finalText);
      const reopened = await readThreadSnapshot(page, thread);
      Assert.equal(
        reopened.projection.messages.find((message) => message.id === result.assistantMessageId)?.text,
        finalText,
      );
      proof.messageSplice = {
        baseSequence: frame.baseSequence,
        sequence: frame.sequence,
        rustDecoder,
        reopenedTextMatches: true,
      };
      completed("Rendered an exact Unicode splice in Rust and recovered the completed reply after reload");
    }

    if (fileEditorProof) {
      starting("versioned workspace file edits and conflict");
      proof.fileEditor = await verifyFileEditor(page, workspace, fileWrites);
      completed("Saved two workspace edits and retained the next draft after an external change");
    }
    if (draftStorageProof) {
      starting("draft write quota denial and recovery");
      proof.draftStorage = await verifyDraftStorageRecovery(page);
      completed("Kept the unsent draft through quota denial, retry and reload");
    }
    if (implementation === "native") {
      Assert.equal(proof.persistence.length, 4);
      completed(
        "Verified canonical omdb rows and event heads through read-only native inspection, with no application SQLite files",
      );
    }
    if (proof.terminalFailure !== null) throw new Error(proof.terminalFailure);
    proof.status = "passed";
  } catch (error) {
    proof.status = "failed";
    proof.error = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
    try {
      await capture(page, directory, "failure");
    } catch (captureError) {
      proof.browserErrors.push(redact(`Could not capture failure: ${captureError}`));
    }
    console.error(
      `[${implementation}] Failure progress: ${JSON.stringify({
        step: proof.currentStep,
        url: redact(page.url()),
        completedSteps: proof.completedSteps,
        threadId: proof.threadId,
        turnIdentity: proof.turnIdentity,
        browserErrors: proof.browserErrors.slice(-5),
      })}`,
    );
    const metadata = snapshotMetadata.get(page);
    if (metadata) {
      writeJson(NodePath.join(directory, "failure-snapshot-metadata.json"), metadata);
      console.error(`[${implementation}] Last snapshot links: ${JSON.stringify(metadata)}`);
    }
    const snapshotPath = NodePath.join(directory, "failure.aria.txt");
    if (NodeFS.existsSync(snapshotPath)) {
      const snapshot = NodeFS.readFileSync(snapshotPath, "utf8");
      console.error(
        `[${implementation}] Failure accessibility snapshot (first 8,000 characters):\n${snapshot.slice(0, 8_000)}`,
      );
    }
    throw error;
  } finally {
    proof.finishedAt = new Date().toISOString();
    saveProof();
    await activeApplication?.stop();
    activeApplication = undefined;
    await context.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await activeApplication?.stop();
      await browser?.close();
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  });
}

const requested: Implementation[] =
  mode === "both" ? ["upstream", "native"] : [mode as Implementation];
const run = {
  status: "running",
  requested,
  passed: [] as Implementation[],
  source,
  pairingRenderer: pairingProof,
  runRoot,
  error: null as string | null,
};
try {
  const executablePath = process.env.T3_CODE_LS_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  console.log(`Original client acceptance: ${requested.join(", ")}; Chromium ${browser.version()}`);
  for (const implementation of requested) {
    if (pairingProof && isPairingRenderer(pairingProof)) {
      await verifyPairing(implementation, pairingProof);
    } else {
      await exercise(implementation);
    }
    run.passed.push(implementation);
  }
  run.status = "passed";
  console.log(`Client acceptance passed. Evidence: ${proofRoot}`);
} catch (error) {
  run.status = "failed";
  run.error = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error(run.error);
  process.exitCode = 1;
} finally {
  writeJson(NodePath.join(proofRoot, "summary.json"), run);
  await activeApplication?.stop();
  await browser?.close();
}
