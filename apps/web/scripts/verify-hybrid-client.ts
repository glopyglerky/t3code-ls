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
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_TERMINAL_ID,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadDetailSnapshot,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type Locator,
  type Page,
  type Response as BrowserResponse,
} from "playwright";
import { nativeExecutable } from "@t3tools/shared/nativeExecutable";
import { SOCKET_FRAME_PARTS_QUERY_PARAM } from "@t3tools/shared/socketFrameParts";
import { denyThreadLinkWasm, verifyThreadNavigation } from "./hybrid-client-thread-navigation.ts";
import { verifyApprovalAction } from "./hybrid-client-approval-action.ts";
import { verifyGuestNameForm } from "./hybrid-client-guest-name.ts";
import { verifyBundledVoiceDraft } from "./hybrid-client-voice.ts";
import {
  inspectNativeApprovalReceipt,
  inspectNativeMessageUpdates,
  inspectNativeTextUpdates,
  inspectNativeReplay,
} from "./hybrid-client-database.ts";
import { stagePreviewFixtureBrowser, verifyPreviewLifetime } from "./hybrid-client-preview.ts";
import {
  installTerminalWireObserver,
  type TerminalWireWindow,
} from "./hybrid-client-terminal-wire.ts";
import {
  assertReplayTurnLinks,
  replayTurnIdentity,
  type ReplayTurnIdentity,
} from "./hybrid-client-turn.ts";

type Implementation = "upstream" | "native";
type PairingRenderer = "retained" | "dioxus" | "dioxus-fallback";
type ComposerSubmitRequest = {
  method: string;
  commandId: string;
  threadId: string;
  messageId: string;
};
type ComposerSubmitProof = {
  renderer: "dioxus" | "dioxus-fallback";
  requests: ComposerSubmitRequest[];
};
type ComposerStopRequest = {
  type: "thread.stop" | "run.interrupt";
  commandId: string;
  threadId: string;
  runId?: string;
};
type OwnedApplication = {
  pid: number;
  pairingUrl: string;
  stop: (target?: "group" | "server") => Promise<void>;
};
type InterruptedShowcase = ReplayTurnIdentity & {
  threadId: string;
  threadUrl: string;
  projectId: string;
  requestId: string;
  partialMessageId: string;
  partialText: string;
};

const repoRoot = NodeFS.realpathSync(NodeURL.fileURLToPath(new URL("../../../", import.meta.url)));
const timeoutMs = 90_000;
const startupTimeoutMs = 180_000;
const replayPrompt = "Replay: showcase";
const parallelTurnsProof = process.env.T3_CODE_LS_PARALLEL_TURNS_PROOF === "true";
const replayMarker = "This turn is a replay.";
const bundledClient = process.env.T3_CODE_LS_BUNDLED_CLIENT_PROOF === "1";
const previewLifetimeProof = process.env.T3_CODE_LS_PREVIEW_LIFETIME_PROOF === "true";
Assert.ok(!previewLifetimeProof || bundledClient, "Preview lifetime requires the packaged application");
const spliceNegotiationProof = process.env.T3_CODE_LS_SPLICE_NEGOTIATION_PROOF === "true";
const splitPtyProof = process.env.T3_CODE_LS_SPLIT_PTY_PROOF === "true";
const pairingProof = process.env.T3_CODE_LS_PAIRING_PROOF;
const guestNameProof = process.env.T3_CODE_LS_GUEST_NAME_PROOF;
Assert.ok(guestNameProof === undefined || (bundledClient && ["retained", "dioxus", "dioxus-fallback"].includes(guestNameProof)), "Guest name proof requires an explicit packaged renderer");
const dioxusFindProof = process.env.T3_CODE_LS_DIOXUS_FIND_PROOF;
const composerSubmitRenderer = process.env.T3_CODE_LS_COMPOSER_SUBMIT_PROOF;
const threadLinkProof = process.env.T3_CODE_LS_THREAD_LINK_PROOF;
Assert.ok(threadLinkProof === undefined || (bundledClient && ["dioxus", "dioxus-fallback"].includes(threadLinkProof)), "Thread navigation requires an explicit packaged renderer");
const composerStopProof = process.env.T3_CODE_LS_COMPOSER_STOP_PROOF === "true";
const formattedAssistantProof = process.env.T3_CODE_LS_ASSISTANT_INLINE_PROOF === "true";
const formattedAssistantText = "**Bold** *calm* 雪.";
const formattedAssistantDisplay = "Bold calm 雪.";
const capturedStop = formattedAssistantProof ? {
  path: "apps/server/scripts/dev-replay/formatted_text_transcript.ndjson",
  sha256: "cd181febbb577f922c7e732605d1930c34a8073ca23d982e93cb865c53149333",
  model: "formatted-text",
  modelLabel: "Formatted text",
  prompt: "Replay the formatted assistant message",
  partialText: formattedAssistantText,
} : {
  path: "apps/server/src/orchestration-v2/testkit/fixtures/todo_list/registry_transcript.ndjson",
  sha256: "560623d69777188138a1d9a7fbc0cc994f4067eb2a7d30ae113b0667456ec45e",
  model: "todo-list",
  modelLabel: "Plan and reads",
  prompt: "Replay the recorded plan and reads",
  partialText: "I'll track the three steps and inspect both files.",
};
const composerSubmitWasmPath = "/pairing-wasm/local_pairing_bg.wasm";
const expectsDioxusFind = process.env.VITE_T3_CODE_LS_THREAD_FIND_RENDERER === "dioxus";
const bundledPtyProof = process.env.T3_CODE_LS_BUNDLED_PTY_PROOF === "true";
const ptyRestartProof = process.env.T3_CODE_LS_PTY_RESTART_PROOF === "true";
const ptyContentionProof = process.env.T3_CODE_LS_PTY_CONTENTION_PROOF === "true";
const nativePtyHost = bundledPtyProof
  ? NodePath.join(repoRoot, "apps/server/dist/native-bin/t3-code-ls-pty-host")
  : process.env.T3_CODE_LS_PTY_PROOF_EXECUTABLE;
const multiTabDraftProof = process.env.T3_CODE_LS_MULTI_TAB_DRAFT_PROOF === "true";
const draftStorageProof = process.env.T3_CODE_LS_DRAFT_STORAGE_PROOF === "true";
const fileEditorProof = process.env.T3_CODE_LS_FILE_EDITOR_PROOF === "true";
const tasksFile = "fixture-tasks.md";
const initialTasks = "- [ ] First milestone\n- [ ] Second milestone\n- [ ] Keep the draft\n";
const durableByteProof = process.env.T3_CODE_LS_DURABLE_BYTE_PROOF === "true";
const durableTextProof = process.env.T3_CODE_LS_DURABLE_TEXT_PROOF === "true";
const voiceDraftProof = process.env.T3_CODE_LS_VOICE_DRAFT_PROOF === "true";
const pdfLinkProof = process.env.T3_CODE_LS_PDF_LINK_PROOF === "true";
const pdfExternalLinkProof = process.env.T3_CODE_LS_PDF_EXTERNAL_LINK_PROOF === "true";
Assert.ok(!pdfExternalLinkProof || (pdfLinkProof && bundledClient), "External PDF links require the packaged PDF proof");
const htmlInteractionProof = process.env.T3_CODE_LS_HTML_INTERACTION_PROOF === "true";
const pdfExternalOnlyProof = process.env.T3_CODE_LS_PDF_EXTERNAL_ONLY_PROOF === "true";
Assert.ok(!pdfExternalOnlyProof || (pdfExternalLinkProof && bundledClient), "PDF-only qualification requires the packaged external-link case");
Assert.ok(!pdfExternalOnlyProof || [
  parallelTurnsProof, spliceNegotiationProof, splitPtyProof, bundledPtyProof, ptyRestartProof,
  multiTabDraftProof, draftStorageProof, fileEditorProof, durableTextProof, voiceDraftProof,
  htmlInteractionProof, pairingProof !== undefined, dioxusFindProof !== undefined,
  composerSubmitRenderer !== undefined,
].every((enabled) => !enabled), "PDF-only qualification cannot replace another selected proof scope");
Assert.ok(!htmlInteractionProof || bundledClient, "Interactive HTML must exercise the packaged browser route");
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
Assert.ok(
  !ptyContentionProof ||
    (process.arch === "x64" &&
      mode === "native" &&
      bundledClient &&
      bundledPtyProof &&
      !ptyRestartProof),
  "Terminal contention requires a dedicated run with the bundled Linux x64 PTY host",
);
if (pairingProof !== undefined && (!bundledClient || !isPairingRenderer(pairingProof))) {
  throw new Error("The pairing proof requires the bundled client and renderer retained or dioxus.");
}
Assert.ok(
  composerSubmitRenderer === undefined ||
    (bundledClient && mode === "native" &&
      (composerSubmitRenderer === "dioxus" || composerSubmitRenderer === "dioxus-fallback")),
  "The Send button proof requires the bundled native application and an explicit renderer",
);

Assert.ok(
  !composerStopProof || composerSubmitRenderer !== undefined,
  "The Stop button proof requires the packaged Send renderer",
);

Assert.ok(!durableByteProof || (bundledClient && mode === "native" && expectsRustComposer && [
  durableTextProof, parallelTurnsProof, spliceNegotiationProof, splitPtyProof, bundledPtyProof,
  ptyRestartProof, ptyContentionProof, multiTabDraftProof, draftStorageProof, fileEditorProof,
  voiceDraftProof, pdfLinkProof, htmlInteractionProof, previewLifetimeProof, threadLinkProof,
  pairingProof !== undefined, guestNameProof !== undefined, dioxusFindProof !== undefined,
  composerSubmitRenderer !== undefined, composerStopProof,
].every((enabled) => !enabled)), "Byte receipt requires its own packaged native Rust-composer run");

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
  if (previewLifetimeProof && process.env.T3CODE_SERVER_BROWSER_SANDBOX === "0") {
    // Only the loopback-isolated synthetic preview case selects this host workaround.
    env.T3CODE_SERVER_BROWSER_SANDBOX = "0";
  }
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

  const stop = async (target: "group" | "server" = "group") => {
    if (stopping) return;
    stopping = true;
    const signal = (value: NodeJS.Signals, recipient: number) => {
      try {
        process.kill(recipient, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM", target === "server" ? pid : -pid);
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      signal("SIGKILL", -pid);
    }, 10_000);
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`Owned process group ${pid} did not close within 15 seconds`)),
        15_000,
      );
    });
    try {
      await Promise.race([exited, deadline]);
      if (target === "server") {
        Assert.equal(killed, false, "The server must close without the process-group backstop");
      }
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

async function verifyGuestName(implementation: Implementation, renderer: PairingRenderer) {
  const directory = NodePath.join(proofRoot, `${implementation}-guest-name-${renderer}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  const stateDirectory = NodeFS.mkdtempSync(NodePath.join(runRoot, "guest-name-"));
  const [serverPort, webPort] = await availablePorts();
  Assert.ok(serverPort && webPort);
  const context = await browser!.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    const application = await startApplication(implementation, stateDirectory, serverPort, webPort, NodePath.join(directory, "startup.log"));
    const hash = renderer === "dioxus" ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(NodePath.join(repoRoot, "apps/web/dist/pairing-wasm/local_pairing_bg.wasm"))).digest("hex") : undefined;
    const result = await verifyGuestNameForm(page, new URL(application.pairingUrl).origin, renderer, hash);
    writeJson(NodePath.join(directory, "proof.json"), { source, implementation, chromium: browser!.version(), ...result });
  } finally {
    await activeApplication?.stop(); activeApplication = undefined;
    await context.close(); NodeFS.rmSync(stateDirectory, { recursive: true, force: true });
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
    const welcomeControls = renderer === "dioxus"
      ? await verifyWelcomeControlUpdates(page)
      : undefined;
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
  projectName?: string,
  composerSubmit?: ComposerSubmitProof,
): Promise<string> {
  await page.getByRole("button", {
    name: projectName === undefined ? "New thread in hybrid-fixture" : "New thread",
    exact: true,
  }).click();
  if (projectName !== undefined) {
    const picker = page.getByRole("dialog");
    await picker.getByPlaceholder("Search...", { exact: true }).fill(projectName);
    await picker.getByRole("option").filter({
      has: page.getByText(projectName, { exact: true }),
    }).click();
    await picker.waitFor({ state: "hidden" });
    await page.locator("[data-draft-project-trigger]")
      .getByText(projectName, { exact: true }).waitFor({ state: "visible" });
  }
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
  const submit = composerSubmit
    ? await verifyComposerSubmitRefusal(page, editor, composerSubmit)
    : page.getByRole("button", { name: "Submit message", exact: true });
  await editor.click();
  await editor.fill(prompt);
  await submit.click();
  await page.waitForURL((url) => /^\/(?!draft\/)[^/]+\/[^/]+$/u.test(url.pathname));
  const thread = new URL(page.url()).pathname.split("/").at(-1);
  Assert.ok(thread, "The composer must navigate to the submitted thread");
  return decodeURIComponent(thread);
}

async function verifyComposerSubmitRefusal(
  page: Page,
  editor: Locator,
  proof: ComposerSubmitProof,
): Promise<Locator> {
  const footer = page.locator('[data-chat-composer-footer="true"]:visible');
  const native = footer.locator('button[data-composer-submit-renderer="dioxus-wasm"]');
  const buttons = footer.locator('button[type="submit"]');
  if (proof.renderer === "dioxus-fallback") {
    await footer.getByRole("button", { name: "Use standard Send button", exact: true }).click();
    Assert.equal(proof.requests.length, 0, "Selecting the standard control must never submit");
    Assert.equal(await native.count(), 0);
  } else {
    await native.waitFor({ state: "visible" });
  }
  const submit = footer.getByRole("button", { name: "Submit message", exact: true });
  await submit.waitFor({ state: "visible" });
  Assert.equal(await buttons.count(), 1);
  Assert.ok(await submit.isDisabled(), "An empty draft must disable Send");
  Assert.ok(await submit.evaluate((button) => (button as HTMLButtonElement).form?.contains(button)));
  await submit.evaluate((button) => (button as HTMLButtonElement).click());
  Assert.equal(proof.requests.length, 0, "The disabled action must never submit");

  const draftUrl = page.url();
  const draft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
  await editor.fill(draft);
  await submit.and(footer.locator("button:enabled")).waitFor({ state: "visible" });
  const validation = page.locator('[data-chat-composer-validation="prompt-length"]');
  await validation.waitFor({ state: "hidden" });
  await submit.press("Enter");
  await validation.filter({ hasText: /Prompt is 1 character over the /u })
    .waitFor({ state: "visible" });
  Assert.equal(await editor.textContent(), draft, "Local refusal must preserve the whole draft");
  Assert.equal(page.url(), draftUrl, "Local refusal must preserve the draft route");
  Assert.ok(await submit.evaluate((button) => document.activeElement === button));
  Assert.equal(proof.requests.length, 0, "Local refusal must never dispatch a turn");
  return submit;
}

async function assertNativeAssistantText(page: Page, threadId: string, messageId: string) {
  const snapshot = await readThreadSnapshot(page, threadId);
  const item = snapshot.projection.turnItems.find((item) =>
    item.type === "assistant_message" && item.messageId === messageId);
  Assert.ok(item && item.type === "assistant_message");
  const row = page.locator(`[data-assistant-citation-source=${JSON.stringify(messageId)}]`)
    .locator('[data-assistant-text-renderer="dioxus-wasm"]');
  await row.waitFor({ state: "visible" });
  if (formattedAssistantProof) {
    Assert.equal(item.text, formattedAssistantText);
    Assert.equal(await row.getAttribute("data-source-text"), item.text);
    await assertFormattedAssistantText(row);
  } else {
    Assert.equal(await row.textContent(), item.text);
  }
  Assert.equal(await row.getAttribute("data-message-updated-at"), DateTime.formatIso(item.updatedAt));
  Assert.equal(await row.getAttribute("data-streaming"), String(item.streaming));
  const sequence = Number(await row.getAttribute("data-snapshot-sequence"));
  Assert.ok(sequence >= snapshot.snapshotSequence, "Rendered text must reflect the observed committed snapshot");
  return { messageId, text: item.text, updatedAt: DateTime.formatIso(item.updatedAt), sequence,
    streaming: item.streaming };
}

async function assertFormattedAssistantText(row: ReturnType<Page["locator"]>) {
  Assert.equal(await row.textContent(), formattedAssistantDisplay);
  Assert.equal(await row.locator("strong").textContent(), "Bold");
  Assert.equal(await row.locator("em").textContent(), "calm");
}

async function verifyComposerStop(
  page: Page,
  threadId: string,
  renderer: ComposerSubmitProof["renderer"],
  requests: ComposerStopRequest[],
) {
  const threadUrl = page.url();
  const draftKey = new URL(threadUrl).pathname.split("/").slice(-2).map(decodeURIComponent).join(":");
  const editor = page.getByTestId("composer-editor");
  const footer = page.locator('[data-chat-composer-footer="true"]:visible');
  const native = footer.locator('button[data-composer-stop-renderer="dioxus-wasm"]');
  const stop = footer.getByRole("button", { name: "Stop generation", exact: true });
  const draft = "This unsent draft must survive Stop and reopen.";
  const visiblePartialText = formattedAssistantProof ? formattedAssistantDisplay : capturedStop.partialText;
  const partialText = page.getByText(visiblePartialText, { exact: true });
  await partialText.waitFor({ state: "visible" });
  const pending = await readThreadSnapshot(page, threadId);
  const identity = replayTurnIdentity(pending, capturedStop.model);
  Assert.equal(pending.projection.runs[0]?.status, "running");
  Assert.equal(pending.projection.runtimeRequests.length, 0);
  const partial = pending.projection.messages.find(
    (message) => message.role === "assistant" && message.runId === identity.runId &&
      message.text === capturedStop.partialText,
  );
  Assert.ok(partial, "The run must stream the captured text before Stop");

  const timelineProof = process.env.T3_CODE_LS_ASSISTANT_TEXT_PROOF === "true";
  let streamingRow: Awaited<ReturnType<typeof assertNativeAssistantText>> | undefined;
  if (timelineProof && renderer === "dioxus") {
    streamingRow = await assertNativeAssistantText(page, threadId, partial.id);
    Assert.equal(streamingRow.streaming, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForURL(threadUrl);
    const resumed = await assertNativeAssistantText(page, threadId, partial.id);
    Assert.equal(resumed.text, streamingRow.text);
    Assert.equal(resumed.updatedAt, streamingRow.updatedAt);
    Assert.equal(resumed.streaming, true);
  }

  if (renderer === "dioxus-fallback") {
    const fallback = footer.getByRole("button", { name: "Use standard Stop button", exact: true });
    await fallback.waitFor({ state: "visible" });
    Assert.equal(await stop.count(), 0);
    await fallback.press("Enter");
    await stop.waitFor({ state: "visible" });
    Assert.ok(await stop.evaluate((button) => document.activeElement === button));
    Assert.equal(await native.count(), 0);
  } else {
    await native.waitFor({ state: "visible" });
    Assert.ok(await stop.evaluate((button) => button.matches('[data-composer-stop-renderer="dioxus-wasm"]')));
  }
  Assert.equal(requests.length, 0, "Rendering or selecting a fallback must never stop a run");
  const originalStop = await stop.elementHandle();
  await editor.fill(draft);
  const send = footer.locator('button[type="submit"]:enabled');
  if (renderer === "dioxus-fallback") {
    const fallback = footer.getByRole("button", { name: "Use standard Send button", exact: true });
    // The initial Send already chose the standard renderer. Select it again only if the footer remounted.
    await send.or(fallback).first().waitFor({ state: "visible" });
    if (await fallback.isVisible()) await fallback.click();
    Assert.equal(await send.getAttribute("data-composer-submit-renderer"), null);
  }
  await send.waitFor({ state: "visible" });
  const originalSend = await send.elementHandle();
  await editor.press("End");
  await editor.press("a");
  await editor.press("Backspace");
  Assert.ok(await editor.evaluate((element) => document.activeElement === element), "Typing beside the live row must retain composer focus");
  Assert.equal(await stop.count(), 1);
  Assert.equal(await send.count(), 1);
  Assert.ok(await stop.evaluate((button, original) => button === original, originalStop));
  Assert.ok(await send.evaluate((button, original) => button === original, originalSend));
  Assert.equal(await stop.getAttribute("type"), "button");
  if (renderer === "dioxus") {
    Assert.equal(await send.getAttribute("data-composer-submit-renderer"), "dioxus-wasm");
  }

  await stop.focus();
  Assert.ok(await stop.evaluate((button) => document.activeElement === button));
  await page.keyboard.press("Enter");
  await footer.getByRole("button", { name: /^(Stop generation|Stopping)$/u })
    .waitFor({ state: "hidden" });
  Assert.ok(await send.evaluate((button, original) => button === original, originalSend));
  const assertInterrupted = async () => {
    const { projection } = await readThreadSnapshot(page, threadId);
    Assert.equal(projection.runs.length, 1);
    const run = projection.runs.find((item) => item.id === identity.runId);
    const attempt = projection.attempts.find((item) => item.id === identity.attemptId);
    const providerTurn = projection.providerTurns.find((item) => item.id === identity.providerTurnId);
    Assert.equal(run?.status, "interrupted");
    Assert.ok(attempt && providerTurn);
    Assert.equal(attempt.runId, run?.id);
    Assert.equal(attempt.status, "interrupted");
    Assert.equal(providerTurn.status, "interrupted");
    assertReplayTurnLinks(attempt, providerTurn);
    const message = projection.messages.find((item) => item.id === partial.id);
    Assert.equal(message?.text, capturedStop.partialText);
    Assert.equal(message?.streaming, false);
    const users = projection.messages.filter((item) => item.role === "user");
    Assert.deepEqual(users.map((item) => item.text), [capturedStop.prompt]);
    return users[0]?.id;
  };
  Assert.equal(await editor.innerText(), draft);
  const sentMessageId = await assertInterrupted();
  await page.waitForFunction(
    ({ draftKey, draft }) => {
      const raw = localStorage.getItem("t3code:composer-drafts:v1");
      return raw !== null && JSON.parse(raw).state?.draftsByThreadKey?.[draftKey]?.prompt === draft;
    },
    { draftKey, draft },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(threadUrl);
  await partialText.waitFor({ state: "visible" });
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLElement>('[data-testid="composer-editor"]')
      ?.innerText === expected,
    draft,
  );
  Assert.equal(await assertInterrupted(), sentMessageId);
  const reopenedRow = timelineProof && renderer === "dioxus" ? await assertNativeAssistantText(page, threadId, partial.id) : undefined;
  if (timelineProof && renderer === "dioxus-fallback") {
    Assert.equal(await page.locator('[data-assistant-text-renderer="dioxus-wasm"]:visible').count(), 0);
    await partialText.waitFor({ state: "visible" });
    if (formattedAssistantProof) {
      const retainedRow = page.locator(`[data-assistant-citation-source=${JSON.stringify(partial.id)}] p`);
      await assertFormattedAssistantText(retainedRow);
    }
  }
  if (reopenedRow) Assert.equal(reopenedRow.streaming, false);
  Assert.equal(requests.length, 1, "Keyboard Stop must send exactly one interruption command");
  const [request] = requests;
  Assert.ok(request?.commandId);
  Assert.equal(request.threadId, threadId);
  if (request.type === "run.interrupt") Assert.equal(request.runId, identity.runId);
  return {
    renderer,
    threadId,
    ...identity,
    request,
    sentMessageId,
    capturedFixtureSha256: capturedStop.sha256,
    formattedAssistantText: formattedAssistantProof ? formattedAssistantDisplay : undefined,
    timeline: timelineProof ? { streamingRow, reopenedRow, runningRouteResumed: renderer === "dioxus", retainedFallback: renderer === "dioxus-fallback" } : undefined,
    draftPreserved: true,
    interruptedReopened: true,
  };
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
    projectId: pending.projection.thread.projectId,
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
    for (const tab of [completing, interrupting]) {
      Assert.equal(await tab.evaluate(() => performance.getEntriesByName("t3-composer-rust-offsets").length), 1);
    }
    Assert.notEqual(complete.threadId, interrupt.threadId);
    Assert.notEqual(complete.projectId, interrupt.projectId);
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
  const retry = page.getByRole("button", { name: "Retry saving", exact: true });
  const fault = page.locator('html[data-fixture-draft-quota-fault="true"]');
  const deny = () => page.evaluate((key) => {
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
  const notice = page.getByText("Draft changes could not be saved", { exact: true });
  await editor.fill(original);
  Assert.equal(await editor.innerText(), original);
  await saved(original);
  await deny();
  try {
    await editor.fill(revised);
    await fault.waitFor({ state: "attached" });
    await notice.waitFor({ state: "visible", timeout: 10_000 });
    Assert.equal(await editor.innerText(), revised);
    await saved(original);
    await recovered();
    await retry.click();
    await saved(revised);
    await notice.waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.waitFor({ state: "visible" });
    Assert.equal(await editor.innerText(), revised);

    const other = await page.context().newPage();
    other.setDefaultTimeout(timeoutMs);
    try {
      await other.goto(page.url(), { waitUntil: "domcontentloaded" });
      const otherEditor = other.getByRole("textbox", { name: "Message New thread", exact: true });
      await otherEditor.waitFor({ state: "visible" });
      Assert.equal(await otherEditor.innerText(), revised);
      const unsaved = "First tab's unsaved edit";
      const newer = "Second tab's newer saved edit";
      await deny();
      await editor.fill(unsaved);
      await fault.waitFor({ state: "attached" });
      await notice.waitFor({ state: "visible", timeout: 10_000 });
      await saved(revised);
      await otherEditor.fill(newer);
      await saved(newer);
      const readEnvelope = () => other.evaluate((key) => localStorage.getItem(key), storageKey);
      const beforeRetry = await readEnvelope();
      Assert.equal(JSON.parse(beforeRetry!).version, 9);

      await recovered();
      await retry.click();
      Assert.equal(await readEnvelope(), beforeRetry, "Retry overwrote the other tab's saved draft");
      await page.getByRole("alert").filter({ hasText: "Draft changed in another tab" })
        .waitFor({ state: "visible" });
      Assert.equal(await editor.innerText(), unsaved);

      await other.reload({ waitUntil: "domcontentloaded" });
      await otherEditor.waitFor({ state: "visible" });
      Assert.equal(await otherEditor.innerText(), newer);
    } finally {
      await other.close();
    }
    return {
      failureVisible: true,
      promptRetained: true,
      savedAfterRetry: true,
      newerDraftPreserved: true,
      conflictAnnounced: true,
    };
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
  await waitForSelectedTerminalText(page, input, /[$#]\s*$/u);
  const command = `printf '${prefix}:%s %s\\n' "$$" '世界'`;
  await page.evaluate((line) => navigator.clipboard.writeText(line), command);
  await input.press("Control+Shift+v");
  await waitForSelectedTerminalText(page, input, new RegExp(`${prefix}:%s %s`, "u"));
  await input.press("Enter");
  // The echoed format string contains no PID. Only rendered shell output matches.
  const pattern = new RegExp(`${prefix}:(\\d+) 世界`, "u");
  const pid = (await waitForSelectedTerminalText(page, input, pattern)).match(pattern)?.[1];
  Assert.ok(pid);
  return pid;
}

function assertNativePtyOwner(shell: string, executable: string, serverPid: number): number {
  const expected = NodeFS.realpathSync(executable);
  let pid = Number(shell);
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const processDirectory = `/proc/${pid}`;
    const status = NodeFS.readFileSync(`${processDirectory}/status`, "utf8");
    const parent = Number(status.match(/^PPid:\s+(\d+)$/mu)?.[1]);
    if (NodeFS.readlinkSync(`${processDirectory}/exe`) === expected) {
      Assert.equal(parent, serverPid, "The bundled server must own the selected PTY helper");
      return pid;
    }
    if (parent === serverPid) break;
    pid = parent;
  }
  Assert.fail("The interactive shell must descend from the selected Rust PTY host");
}

function assertBundledPtyIdentity(executable: string): string {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(executable), "manifest.json"), "utf8"),
  );
  const sha256 = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(executable)).digest("hex");
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.files["t3-code-ls-pty-host"], sha256);
  return sha256;
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

function liveLinuxProcess(pid: number) {
  Assert.ok(Number.isSafeInteger(pid) && pid > 1, "Expected a bounded fixture process identity");
  let status: string;
  try {
    status = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fields = status.slice(status.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const [state, parent, group, , , foregroundGroup] = fields;
  const started = fields[19];
  Assert.ok(started && parent && group && foregroundGroup, "Expected a Linux process identity");
  if (state === "Z" || state === "X") return null;
  return { pid, parent: Number(parent), started, group: Number(group), foregroundGroup: Number(foregroundGroup) };
}

async function verifyOwnedPtyShutdown(page: Page, workspace: string, shell: string, helper: number,
  stopServer: () => Promise<void>) {
  const script = NodePath.join(workspace, "fixture-pty-restart.sh");
  const marker = `${script}.pid`;
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  NodeFS.writeFileSync(script, `printf '%s\\n' "$$" > ${quote(marker)}\nexec sleep 600\n`);
  const input = await terminalInput(page);
  await page.evaluate((line) => navigator.clipboard.writeText(line), `sh ${quote(script)}`);
  await input.press("Control+Shift+v");
  await waitForSelectedTerminalText(page, input, /fixture-pty-restart\.sh/u);
  await input.press("Enter");
  const foreground = liveLinuxProcess(Number(await waitForTerminalReceipt(page, marker)));
  const session = liveLinuxProcess(Number(shell));
  const owner = liveLinuxProcess(helper);
  Assert.ok(session && owner && foreground, "The server must own a live terminal and foreground job");
  Assert.equal(foreground.parent, session.pid, "The scripted job must belong to this terminal");
  const processes = [session, owner, foreground];
  const remains = ({ pid, started }: (typeof processes)[number]) => liveLinuxProcess(pid)?.started === started;
  try {
    await stopServer();
    const deadline = Date.now() + 5000;
    while (processes.some(remains) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    Assert.deepEqual(processes.filter(remains), [], "The stopped server must leave no live PTY processes");
    return session;
  } finally {
    for (const owned of processes.filter(remains)) {
      try { process.kill(owned.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
}

async function verifyAlternateTerminalReconnect(
  page: Page,
  workspace: string,
  shell: string,
  scope: "normal" | "contention" = "normal",
) {
  const script = NodePath.join(workspace, `fixture-terminal-screen-${scope}.sh`);
  const release = `${script}.leave`;
  const exited = `${script}.exited`;
  NodeFS.writeFileSync(
    script,
    [
      "trap 'exit 130' INT",
      'saved=$(command -p stty -g) || exit 1',
      `trap 'status=$?; command -p stty "$saved"; printf "%s\\n" "$status" > "$0.exited"' EXIT`,
      'command -p stty -echo -icanon min 1 time 0 || exit 1',
      'query() {',
      `  printf '\\033[%s;%sH\\033[6n' "$2" "$3"`,
      `  IFS= read -r -t 10 -d R response || exit 1`,
      `  printf -v expected '\\033[%s;%s' "$2" "$3"`,
      '  [[ $response == "$expected" ]] || exit 1',
      `  printf '%sR\\n' "$response" > "$0.$1" || exit 1`,
      '}',
      `printf 'fixture-main-screen:%s\\n\\033[?1049h\\033[Hfixture-alternate-screen:%s 世界\\n' "$1" "$1"`,
      "query queried 7 11",
      'printf "%s %s\\n" "$1" "$$" > "$0.entered"',
      "attempt=0",
      'while [ ! -f "$0.leave" ] && [ "$attempt" -lt 600 ]; do',
      "  command -p sleep 0.1",
      "  attempt=$((attempt+1))",
      "done",
      '[ -f "$0.leave" ] || exit 1',
      'query reconnected 8 12',
      `printf '\\033[?1049lfixture-primary-restored:%s\\n' "$1"`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  const shellQuote = `'${script.replaceAll("'", "'\\''")}'`;
  const input = await terminalInput(page);
  await page.evaluate((line) => navigator.clipboard.writeText(line), `/bin/bash ${shellQuote} "$$"`);
  await input.press("Control+Shift+v");
  await waitForTerminalCopy(page, input, /fixture-terminal-screen-(normal|contention)\.sh/u, "before submission");
  await input.press("Enter");
  const [reportedShell, foregroundPid] =
    (await waitForTerminalReceipt(page, `${script}.entered`)).split(" ");
  Assert.equal(reportedShell, shell);
  Assert.match(foregroundPid ?? "", /^\d+$/u);
  Assert.equal(Buffer.from(await waitForTerminalReceipt(page, `${script}.queried`)).toString("hex"), "1b5b373b313152");
  const originalShell = liveLinuxProcess(Number(shell));
  const foreground = liveLinuxProcess(Number(foregroundPid));
  Assert.ok(originalShell && foreground);
  Assert.equal(foreground.parent, originalShell.pid);
  Assert.equal(foreground.group, foreground.foregroundGroup);
  await page.reload({ waitUntil: "domcontentloaded" });
  const reattached = await terminalInput(page);
  const alternate = new RegExp(`fixture-alternate-screen:${shell} 世界`, "u");
  const screen = await waitForSelectedTerminalText(page, reattached, alternate);
  Assert.ok(!screen.includes(`fixture-main-screen:${shell}`));
  Assert.ok(
    NodeFS.existsSync(`/proc/${foregroundPid}/stat`),
    "The alternate screen must still belong to the original live foreground command",
  );
  Assert.deepEqual(liveLinuxProcess(Number(foregroundPid)), foreground);
  Assert.equal(liveLinuxProcess(Number(shell))?.started, originalShell.started);
  NodeFS.writeFileSync(release, "leave\n", { flag: "wx" });
  Assert.equal(Buffer.from(await waitForTerminalReceipt(page, `${script}.reconnected`)).toString("hex"), "1b5b383b313252");
  Assert.equal(await waitForTerminalReceipt(page, exited), "0");
  const restored = new RegExp(`fixture-primary-restored:${shell}`, "u");
  const primary = await waitForSelectedTerminalText(page, reattached, restored);
  Assert.ok(primary.includes(`fixture-main-screen:${shell}`));
  Assert.ok(!alternate.test(primary));
  Assert.equal(await terminalMarker(page, "fixture-reattach"), shell);
  Assert.equal(liveLinuxProcess(Number(shell))?.started, originalShell.started);
  return {
    cursorPositionReplies: ["1b5b373b313152", "1b5b383b313252"],
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

async function startCapturedApproval(page: Page) {
  const contents = NodeFS.readFileSync(NodePath.join(repoRoot, capturedApproval.path));
  const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
  Assert.equal(sha256, capturedApproval.sha256, "The recorded ACP approval fixture changed");
  const threadId = await submitReplay(page, capturedApproval.modelLabel, capturedApproval.prompt);
  const button = page
    .getByRole("group", { name: "Command approval", exact: true })
    .getByRole("button", { name: "Approve", exact: true });
  if (process.env.T3_CODE_LS_APPROVAL_PROOF === "dioxus-fallback") {
    const fallback = page.getByRole("group", { name: "Command approval", exact: true })
      .getByRole("button", { name: "Use standard approval button", exact: true });
    await fallback.click();
    Assert.ok(await button.evaluate((node) => document.activeElement === node));
  }
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
  return { threadId, identity, requestId: request.id, button, sha256 };
}

async function acceptCapturedApproval(page: Page) {
  if (process.env.T3_CODE_LS_APPROVAL_PROOF) {
    Assert.ok(bundledClient, "Approval proof requires the packaged browser");
    Assert.equal(process.env.VITE_T3_CODE_LS_APPROVAL_RENDERER, "dioxus");
    return verifyApprovalAction(page, {
      start: () => startCapturedApproval(page),
      complete: (threadId, identity) => assertCompleted(page, threadId, identity, capturedApproval.reply),
      snapshot: (threadId) => readThreadSnapshot(page, threadId),
      source: capturedApproval.path,
    });
  }
  const { threadId, identity, requestId, button, sha256 } = await startCapturedApproval(page);
  await button.click();
  const completed = await assertCompleted(page, threadId, identity, capturedApproval.reply);
  Assert.equal(
    (await readThreadSnapshot(page, threadId)).projection.runtimeRequests.find(
      (item) => item.id === requestId,
    )?.status,
    "resolved",
  );
  return { ...completed, requestId, source: capturedApproval.path, sha256 };
}

async function verifyTerminalContention(
  page: Page,
  threadId: string,
  workspace: string,
  application: OwnedApplication,
  executable: string,
) {
  const rowsPerBurst = 128;
  const rowPayload = "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const expectedRows = Array.from({ length: rowsPerBurst * 2 }, (_, index) =>
    `j45-row:${String(index + 1).padStart(3, "0")}:${rowPayload}`,
  );
  const rows = (text: string) => text.split(/\r?\n/u).filter((line) => line.startsWith("j45-row:"));
  const firstRows = expectedRows.slice(0, rowsPerBurst);
  const token = "j45-echo:世界";
  const echoLine = /^j45-echo:世界\r?$/mu;
  const script = NodePath.join(workspace, "fixture-pty-contention.sh");
  const command = `/bin/bash '${script.replaceAll("'", "'\\''")}' "$$"`;
  NodeFS.writeFileSync(script, [
    `trap 'printf "%s\\n" "$?" > "$0.exited"' EXIT`,
    "burst() {",
    "  for ((row=$1; row<=$2; row++)); do",
    `    printf 'j45-row:%03d:${rowPayload}\\n' "$row"`,
    "  done",
    "}",
    'printf "%s %s\\n" "$1" "$$" > "$0.started"',
    // Bash may emit invisible bracketed-paste controls as the foreground job starts.
    "printf '\\n'",
    `burst 1 ${rowsPerBurst}`,
    `printf 'j45-ready:%s\\n' "$1"`,
    `IFS= read -r -t 60 input && [[ $input == '${token}' ]] || exit 1`,
    `printf 'j45-accepted:%s\\n' "$input"`,
    `burst ${rowsPerBurst + 1} ${expectedRows.length}`,
    `printf 'j45-drained:%s\\n' "$1"`,
    'IFS= read -r -t 60 release && [[ $release == j45-release ]] || exit 1',
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });

  const origin = new URL(page.url()).origin;
  await page.addInitScript(installTerminalWireObserver, {
    origin,
    threadId,
    terminalId: DEFAULT_TERMINAL_ID,
    attachTag: WS_METHODS.terminalAttach,
    observeTag: WS_METHODS.terminalObserve,
    framePartsParam: SOCKET_FRAME_PARTS_QUERY_PARAM,
  });

  const driverCounters = () => ({ sockets: 0, sent: 0, received: 0, errors: 0 });
  const beforeDriver = driverCounters();
  const afterDriver = driverCounters();
  let reattaching = false;
  const observeSocket = (socket: import("playwright").WebSocket) => {
    const url = new URL(socket.url());
    if (url.origin !== origin.replace(/^http/u, "ws") || url.pathname !== "/ws") return;
    const counters = reattaching ? afterDriver : beforeDriver;
    counters.sockets++;
    socket.on("framesent", () => counters.sent++);
    socket.on("framereceived", () => counters.received++);
    socket.on("socketerror", () => counters.errors++);
  };
  const waitForWire = async (checkpoint: "echo" | "snapshot" | "drain", shell: string) => {
    const readWire = () => (window as TerminalWireWindow).__t3FixtureTerminalWire;
    const handle = await page.waitForFunction(
      ({ checkpoint, echoPattern, shell }) => {
        const wire = (window as TerminalWireWindow).__t3FixtureTerminalWire;
        if (wire === undefined) return false;
        const { counters, output, snapshot } = wire;
        if (counters.attachRequests > 1 || counters.mismatchedEvents > 0 || counters.overflow > 0) {
          return wire;
        }
        const echo = new RegExp(echoPattern, "mu");
        if (checkpoint === "echo" && echo.test(output)) return wire;
        if (checkpoint === "snapshot" && echo.test(snapshot?.history ?? "")) return wire;
        if (checkpoint === "drain" && output.includes(`j45-drained:${shell}`)) return wire;
        return false;
      },
      { checkpoint, echoPattern: echoLine.source, shell },
      { timeout: 10_000 },
    ).catch((error: unknown) => {
      if (error instanceof playwrightErrors.TimeoutError) return undefined;
      throw error;
    });
    const wire = handle ? await handle.jsonValue() : await page.evaluate(readWire);
    await handle?.dispose();
    const diagnostics = {
      driver: { ...(reattaching ? afterDriver : beforeDriver) },
      browser: wire && {
        ...wire.counters,
        rows: rows(wire.output).length,
        snapshotRows: rows(wire.snapshot?.history ?? "").length,
      },
    };
    Assert.ok(
      wire && handle && wire.counters.attachRequests === 1 &&
        wire.counters.mismatchedEvents === 0 && wire.counters.overflow === 0,
      `Terminal wire checkpoint ${checkpoint} failed (${JSON.stringify(diagnostics)})`,
    );
    return { ...wire, diagnostics };
  };
  const paste = async (input: Locator, text: string) => {
    await page.evaluate((line) => navigator.clipboard.writeText(line), text);
    await input.press("Control+Shift+v");
  };

  const chat = await page.context().newPage();
  chat.setDefaultTimeout(timeoutMs);
  page.on("websocket", observeSocket);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.bringToFront();
    const shell = await terminalMarker(page, "fixture-pty");
    const sha256 = assertBundledPtyIdentity(executable);
    const helper = assertNativePtyOwner(shell, executable, application.pid);
    const shellProcess = liveLinuxProcess(Number(shell));
    Assert.ok(shellProcess);
    await chat.goto(origin, { waitUntil: "domcontentloaded" });
    const approval = await startCapturedApproval(chat);
    Assert.notEqual(approval.threadId, threadId);
    await page.bringToFront();
    const input = await terminalInput(page);
    await paste(input, command);
    await waitForSelectedTerminalText(page, input, /fixture-pty-contention\.sh/u);
    await input.press("Enter");
    const [reportedShell, jobPid] = (await waitForTerminalReceipt(page, `${script}.started`)).split(" ");
    Assert.equal(reportedShell, shell);
    const job = liveLinuxProcess(Number(jobPid));
    Assert.ok(
      job && job.parent === shellProcess.pid && job.group === job.foregroundGroup,
      "The burst process must own the shell's foreground PTY",
    );
    await waitForSelectedTerminalText(page, input, new RegExp(`^j45-ready:${shell}\\r?$`, "mu"));
    await paste(input, token);
    const firstScreen = await waitForSelectedTerminalText(page, input, echoLine);
    Assert.deepEqual(rows(firstScreen), firstRows, "The initial burst must render in order");
    const before = await waitForWire("echo", shell);
    Assert.deepEqual(rows(before.output), firstRows, "The initial wire burst must be complete and ordered");
    const inputEcho = before.output.match(echoLine)?.[0]?.trimEnd();
    Assert.equal(inputEcho, token);
    Assert.ok(!before.output.includes("j45-accepted:"), "Echo must precede Enter and the script reply");

    reattaching = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    const reattached = await terminalInput(page);
    Assert.deepEqual(rows(await waitForSelectedTerminalText(page, reattached, echoLine)), firstRows);
    const reattachWire = await waitForWire("snapshot", shell);
    const snapshot = reattachWire.snapshot;
    Assert.ok(snapshot, "A fresh browser socket must receive a terminal snapshot");
    Assert.equal(snapshot.status, "running");
    Assert.equal(snapshot.pid, shellProcess.pid);
    Assert.equal(NodeFS.realpathSync(snapshot.cwd), NodeFS.realpathSync(workspace));
    Assert.deepEqual(rows(snapshot.history), firstRows);
    Assert.match(snapshot.history, echoLine);
    Assert.equal(liveLinuxProcess(shellProcess.pid)?.started, shellProcess.started);
    Assert.equal(assertNativePtyOwner(shell, executable, application.pid), helper);
    Assert.deepEqual(liveLinuxProcess(job.pid), job);
    const pending = await readThreadSnapshot(chat, approval.threadId);
    Assert.deepEqual(replayTurnIdentity(pending, capturedApproval.model), approval.identity);
    Assert.equal(
      pending.projection.runtimeRequests.find((item) => item.id === approval.requestId)?.status,
      "pending",
    );
    Assert.ok(await approval.button.isVisible());

    await reattached.press("Enter");
    await approval.button.click();
    const completed = await assertCompleted(
      chat, approval.threadId, approval.identity, capturedApproval.reply,
    );
    const assertExactChat = async () => {
      const { projection } = await readThreadSnapshot(chat, approval.threadId);
      Assert.deepEqual(projection.attempts.map((item) => item.id), [approval.identity.attemptId]);
      Assert.deepEqual(projection.providerTurns.map((item) => item.id), [approval.identity.providerTurnId]);
      Assert.deepEqual(projection.runtimeRequests.map(({ id, status }) => ({ id, status })), [
        { id: approval.requestId, status: "resolved" },
      ]);
      Assert.deepEqual(
        projection.messages.filter((message) => message.role === "user").map(({ text }) => text),
        [capturedApproval.prompt],
      );
      const assistant = projection.messages.filter((message) => message.role === "assistant");
      Assert.deepEqual(assistant.map(({ id, text }) => ({ id, text })), [
        { id: completed.assistantMessageId, text: capturedApproval.reply },
      ]);
    };
    await assertExactChat();
    await page.bringToFront();
    const finalScreen = await waitForSelectedTerminalText(
      page, reattached, new RegExp(`^j45-drained:${shell}\\r?$`, "mu"),
    );
    const renderedRows = rows(finalScreen);
    Assert.deepEqual(renderedRows, expectedRows);
    const accepted = `j45-accepted:${token}`;
    Assert.ok(finalScreen.includes(accepted));
    const after = await waitForWire("drain", shell);
    Assert.ok(after.output.includes(accepted));
    const wireRows = [...rows(before.output), ...rows(after.output)];
    Assert.deepEqual(wireRows, expectedRows);
    Assert.deepEqual(liveLinuxProcess(job.pid), job, "Chat must finish before releasing the foreground job");

    await paste(reattached, "j45-release");
    await reattached.press("Enter");
    Assert.equal(await waitForTerminalReceipt(page, `${script}.exited`), "0");
    Assert.equal(await terminalMarker(page, "fixture-reattach"), shell);
    Assert.equal(liveLinuxProcess(shellProcess.pid)?.started, shellProcess.started);
    await chat.reload({ waitUntil: "domcontentloaded" });
    const reopened = await assertCompleted(
      chat, approval.threadId, approval.identity, capturedApproval.reply,
    );
    Assert.equal(reopened.assistantMessageId, completed.assistantMessageId);
    await assertExactChat();
    const alternate = await verifyAlternateTerminalReconnect(page, workspace, shell, "contention");
    Assert.ok(!NodeFS.existsSync(NodePath.join(workspace, ".codex-probe-write-action.txt")));
    return {
      helper: { pid: helper, sha256 },
      terminalThreadId: threadId,
      terminalId: snapshot.terminalId,
      shell: shellProcess,
      foreground: job,
      snapshotSequence: snapshot.sequence,
      sameShell: true,
      alternate,
      orderedWireRows: wireRows.length,
      wire: { before: before.diagnostics, after: after.diagnostics },
      orderedRenderedRows: renderedRows.length,
      orderedRowsSha256: NodeCrypto.createHash("sha256").update(wireRows.join("\n")).digest("hex"),
      rowsPerBurst,
      inputEcho,
      chatPendingAfterReattach: true,
      chatCompletedBeforeForegroundExit: true,
      chat: {
        ...reopened,
        requestId: approval.requestId,
        fixtureSha256: approval.sha256,
        exactReply: capturedApproval.reply,
        reopened: true,
      },
    };
  } finally {
    page.off("websocket", observeSocket);
    await chat.close();
  }
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

function textRevisionIdentity(stateDirectory: string, initialize = false, layout: "full" | "compact" = "compact") {
  const executable = NodePath.join(repoRoot, "apps/server/dist/native-bin/t3-code-ls-db");
  const databasePath = NodePath.join(stateDirectory, "userdata", "statev2.omdb");
  if (initialize) {
    Assert.equal(NodeFS.existsSync(databasePath), false, "Text revisions require a fresh fixture");
  }
  const requests = [
    ...(initialize
      ? [{ operation: "application_bootstrap", ...(layout === "compact" ? { event_layout: "assistant_text_revisions_v1" } : {}) }]
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
  Assert.equal(identity.layout, layout === "compact"
    ? "t3-application-keyspace-v1+assistant-text-revisions-v1" : "t3-application-keyspace-v1");
  Assert.match(identity.catalog_sha256, /^[a-f0-9]{64}$/u);
  return { layout: identity.layout as string, catalogSha256: identity.catalog_sha256 as string };
}

const linkedPdfName = "fixture-links.pdf";

function linkedPdf(externalUrl?: string): string {
  const page = (contents: number, annotations = "") =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R ${annotations} >>`;
  const stream = (text: string) => {
    const command = `BT /F1 24 Tf 30 700 Td (${text}) Tj${externalUrl && text === "See page 2" ? " 0 -60 Td (Open controlled destination) Tj" : ""} ET`;
    return `<< /Length ${command.length} >>\nstream\n${command}\nendstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    page(
      4,
      `/Annots [<< /Type /Annot /Subtype /Link /Rect [30 690 220 730] /Border [0 0 0] /Dest [5 0 R /XYZ 0 792 0] >>${externalUrl ? ` << /Type /Annot /Subtype /Link /Rect [30 630 360 670] /Border [0 0 0] /A << /S /URI /URI (${externalUrl}) >> >>` : ""}]`,
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

async function startPdfLinkDestination() {
  const path = `/pdf-destination-${NodeCrypto.randomUUID()}`;
  let requests = 0;
  let unexpected = 0;
  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "GET" && request.url === path) {
      requests++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'" });
      response.end("<!doctype html><title>Controlled PDF destination</title><h1>Controlled PDF destination</h1>");
    } else {
      if (request.url !== "/favicon.ico") unexpected++;
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  Assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}${path}`, requests: () => requests, unexpected: () => unexpected,
    stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function verifyLinkedPdf(page: Page, workspace: string) {
  const target = pdfExternalLinkProof ? await startPdfLinkDestination() : null;
  const originalUrl = page.url();
  const originalPages = page.context().pages().length;
  let outsideRequests = 0;
  const observe = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) outsideRequests++;
  };
  if (target) page.context().on("request", observe);
  const popups: Page[] = [];
  try {
    if (target) NodeFS.writeFileSync(NodePath.join(workspace, linkedPdfName), linkedPdf(target.url));
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
    let external = null as { pointerOpened: boolean; keyboardOpened: boolean; requests: number; noUnsolicitedRequests: boolean; openerIsolated: boolean } | null;
    if (target) {
      Assert.equal(target.requests(), 0, "PDF load and internal jumps must not fetch an external annotation");
      Assert.equal(page.context().pages().length, originalPages);
      await page.getByRole("button", { name: "Previous page", exact: true }).click();
      const web = reader.getByRole("link", { name: target.url, exact: true });
      await web.waitFor({ state: "visible" });
      Assert.equal(await web.getAttribute("href"), target.url);
      Assert.equal(await web.getAttribute("target"), "_blank");
      Assert.ok((await web.getAttribute("rel"))?.includes("noopener"));
      await page.waitForTimeout(200);
      Assert.equal(target.requests(), 0, "Visible link annotations must remain passive before activation");
      for (const [index, keyboard] of [false, true].entries()) {
        const [popup] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 15_000 }),
          keyboard ? web.press("Enter") : web.click(),
        ]);
        popups.push(popup);
        await popup.waitForURL(target.url, { timeout: 15_000 });
        await popup.getByRole("heading", { name: "Controlled PDF destination", exact: true }).waitFor({ state: "visible" });
        Assert.equal(await popup.evaluate(() => window.opener === null), true);
        Assert.equal(target.requests(), index + 1);
        Assert.equal(page.url(), originalUrl);
        await page.getByText("1 / 2 pages", { exact: true }).waitFor({ state: "visible" });
        await popup.close();
      }
      Assert.equal(target.unexpected(), 0);
      Assert.equal(outsideRequests, 0);
      Assert.equal(page.context().pages().length, originalPages);
      external = { pointerOpened: true, keyboardOpened: true, requests: target.requests(), noUnsolicitedRequests: true, openerIsolated: true };
    }
    return { signedAssetStatus: response.status(), pointerDestination: 2, keyboardDestination: 2, external };
  } finally {
    page.context().off("request", observe);
    for (const popup of popups) if (!popup.isClosed()) await popup.close();
    await target?.stop();
  }
}

const interactiveHtmlTitle = "Controlled interactive document";

async function verifyInteractiveHtml(page: Page, resumeThreadId: string) {
  const resumeUrl = page.url();
  const statuses: number[] = [];
  const contentTypes: string[] = [];
  const observeAsset = (response: BrowserResponse) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(page.url()).origin || !url.pathname.startsWith("/api/assets/") ||
        decodeURIComponent(url.pathname.split("/").at(-1) ?? "") !== `${interactiveHtmlTitle}.html`) return;
    if (statuses.length < 8) {
      statuses.push(response.status());
      contentTypes.push(response.headers()["content-type"] ?? "");
    }
  };
  page.on("response", observeAsset);
  try {
    const threadId = await submitReplay(page, "Interactive HTML", "Render the controlled interactive document");
    await page.getByText(/Interactive HTML fixture published\. MCP initialized=1 tool=1 teardown=(terminated|stateless)\./u).waitFor({ state: "visible", timeout: timeoutMs });
    await page.getByRole("button", { name: "Stop generation", exact: true }).waitFor({ state: "hidden" });
    const snapshot = await readThreadSnapshot(page, threadId);
    Assert.equal(snapshot.projection.runs.length, 1);
    Assert.equal(snapshot.projection.runs[0]?.status, "completed");
    const rendered = snapshot.projection.turnItems.filter((item) => item.type === "dynamic_tool" && item.toolName === "t3-code.html_render");
    Assert.equal(rendered.length, 1, "The controlled provider must project one real html_render result");
    const inlineElement = page.locator(`iframe[title="${interactiveHtmlTitle}"]`).first();
    await inlineElement.waitFor({ state: "visible" });
    const inline = await (await inlineElement.elementHandle())?.contentFrame();
    Assert.ok(inline);
    await inline.getByRole("button", { name: "Add one", exact: true }).waitFor({ state: "visible" });
    const sandbox = (await inlineElement.getAttribute("sandbox"))?.split(/\s+/u) ?? [];
    Assert.ok(sandbox.includes("allow-scripts") && sandbox.includes("allow-forms"));
    Assert.ok(!sandbox.includes("allow-same-origin"));
    Assert.equal(await inline.evaluate(() => self.origin), "null");
    Assert.equal(await inline.locator("#t3-theme").count(), 1, "The real publisher must inject its bootstrap");
    await inline.getByText(/^Host theme: (light|dark)$/u).waitFor({ state: "visible" });
    Assert.equal(await inline.getByLabel("Count", { exact: true }).inputValue(), "0");
    await inline.getByRole("button", { name: "Add one", exact: true }).click();
    Assert.equal(await inline.getByLabel("Count", { exact: true }).inputValue(), "1");
    await inline.getByLabel("Value", { exact: true }).fill("7");
    await inline.getByRole("button", { name: "Double value", exact: true }).click();
    await inline.getByText("Result: 14", { exact: true }).waitFor({ state: "visible" });
    const initialHeight = (await inlineElement.boundingBox())?.height;
    Assert.ok(initialHeight !== undefined);
    await inline.getByRole("button", { name: "Expand content", exact: true }).click();
    await page.waitForFunction(({ title, before }) => {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
      return frame !== null && frame.getBoundingClientRect().height > before + 200;
    }, { title: interactiveHtmlTitle, before: initialHeight });
    const inlineHeight = (await inlineElement.boundingBox())!.height;
    const container = inlineElement.locator("..");
    await container.hover();
    await container.getByRole("button", { name: "Open full screen", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Expanded ${interactiveHtmlTitle} preview`, exact: true });
    await dialog.waitFor({ state: "visible" });
    const modalElement = dialog.locator(`iframe[title="${interactiveHtmlTitle}"]`);
    await modalElement.waitFor({ state: "visible" });
    const modal = await (await modalElement.elementHandle())?.contentFrame();
    Assert.ok(modal && modal !== inline);
    await modal.getByRole("button", { name: "Add one", exact: true }).waitFor({ state: "visible" });
    Assert.equal(await modal.evaluate(() => self.origin), "null");
    Assert.equal(await modal.getByLabel("Count", { exact: true }).inputValue(), "0");
    await modal.getByRole("button", { name: "Add one", exact: true }).click();
    await modal.getByRole("button", { name: "Add one", exact: true }).click();
    Assert.equal(await modal.getByLabel("Count", { exact: true }).inputValue(), "2");
    Assert.equal(await inline.getByLabel("Count", { exact: true }).inputValue(), "1");
    const modalHeight = (await modalElement.boundingBox())!.height;
    await modal.getByRole("button", { name: "Expand content", exact: true }).click();
    await page.waitForFunction(({ title, before }) => {
      const frames = document.querySelectorAll<HTMLIFrameElement>(`iframe[title="${title}"]`);
      return frames.length === 2 && frames[1]!.getBoundingClientRect().height > before + 200;
    }, { title: interactiveHtmlTitle, before: modalHeight });
    Assert.ok(Math.abs((await inlineElement.boundingBox())!.height - inlineHeight) < 40,
      "A dialog page's size message must not resize the inline page");
    await Promise.all([
      page.waitForEvent("framedetached", { predicate: (frame) => frame === modal }),
      dialog.getByRole("button", { name: "Close", exact: true }).click(),
    ]);
    await dialog.waitFor({ state: "hidden" });
    Assert.equal(modal.isDetached(), true);
    Assert.equal(await inline.getByLabel("Count", { exact: true }).inputValue(), "1");
    await container.hover();
    await container.getByRole("button", { name: "Open full screen", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    const reopenedElement = dialog.locator(`iframe[title="${interactiveHtmlTitle}"]`);
    await reopenedElement.waitFor({ state: "visible" });
    const reopened = await (await reopenedElement.elementHandle())?.contentFrame();
    Assert.ok(reopened && reopened !== modal);
    await reopened.getByRole("button", { name: "Add one", exact: true }).waitFor({ state: "visible" });
    Assert.equal(await reopened.getByLabel("Count", { exact: true }).inputValue(), "0");
    await Promise.all([
      page.waitForEvent("framedetached", { predicate: (frame) => frame === reopened }),
      dialog.getByRole("button", { name: "Close", exact: true }).click(),
    ]);
    await dialog.waitFor({ state: "hidden" });
    Assert.equal(reopened.isDetached(), true);
    await inline.getByRole("button", { name: "Add one", exact: true }).click();
    Assert.equal(await inline.getByLabel("Count", { exact: true }).inputValue(), "2");
    Assert.equal(statuses[0], 200);
    Assert.ok(contentTypes[0]?.startsWith("text/html"));
    const audit = snapshot.projection.messages.find((message) => message.role === "assistant" && message.text.includes("MCP initialized=1 tool=1"))?.text;
    Assert.ok(audit);
    await page.goto(resumeUrl, { waitUntil: "domcontentloaded" });
    await readThreadSnapshot(page, resumeThreadId);
    return { signedAssetStatus: statuses[0], toolCalls: 1, opaqueOrigin: true, ownFrameResize: true,
      unrelatedFrameUnchanged: true, modalDetached: true, reopenedFresh: true, mcpAudit: audit };
  } finally {
    page.off("response", observeAsset);
  }
}

const byteSamples: Array<{
  profile: "full" | "compact";
  artifacts: Record<string, string>;
  updates: ReturnType<typeof inspectNativeTextUpdates>;
  dialogue: Array<{ role: string; text: string; streaming: boolean }>;
  wire: { sentFrames: number; receivedFrames: number; sentPayloadBytes: number; receivedPayloadBytes: number };
}> = [];

async function exercise(implementation: Implementation, byteProfile?: "full" | "compact"): Promise<void> {
  const fixtureName = byteProfile ? `${implementation}-${byteProfile}` : implementation;
  const directory = NodePath.join(proofRoot, fixtureName);
  NodeFS.mkdirSync(directory, { recursive: true });
  const workspace = NodePath.join(runRoot, fixtureName, "hybrid-fixture");
  const stateDirectory = NodePath.join(runRoot, fixtureName, "state");
  Assert.ok(!durableTextProof || (bundledClient && implementation === "native"));
  Assert.ok(!previewLifetimeProof || implementation === "native");
  const previewBrowser = previewLifetimeProof ? stagePreviewFixtureBrowser(stateDirectory) : null;
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
            commandArgs: [
              NodePath.join(repoRoot, "apps/server/scripts/dev-replay-agent.ts"),
              ...(composerStopProof ? ["--hold-for-interrupt"] : []),
            ],
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
    composerSubmit: null as (ComposerSubmitProof & {
      wasmSha256: string | null;
      refusedWasmRequests: number;
      localRefusalPreservedDraft: true;
    }) | null,
    threadNavigation: null as Awaited<ReturnType<typeof verifyThreadNavigation>> | null,
    threadNavigationWasmRefusals: 0,
    composerStop: null as Awaited<ReturnType<typeof verifyComposerStop>> | null,
    byteAccounting: null as (typeof byteSamples)[number] | null,
    textRevisionProfile: null as ReturnType<typeof textRevisionIdentity> | null,
    pdfLinks: null as Awaited<ReturnType<typeof verifyLinkedPdf>> | null,
    htmlInteraction: null as Awaited<ReturnType<typeof verifyInteractiveHtml>> | null,
    previewBrowser,
    previewLifetime: null as Awaited<ReturnType<typeof verifyPreviewLifetime>> | null,
    pdfExternalOnly: pdfExternalOnlyProof,
    scope: composerStopProof
      ? "Linux packaged native application; authenticated Send and keyboard Stop, captured replay, and draft-preserving reopen"
      : composerSubmitRenderer
      ? "Linux packaged native application; authenticated ordinary Send, local refusal, and one controlled replay turn"
      : pdfExternalOnlyProof
      ? "Linux packaged native application; authenticated local project and replay thread; signed PDF internal jumps and explicit loopback external links; no terminal qualification"
      : ptyContentionProof
        ? "Linux x64 bundled PTY; foreground burst, browser reattach, and a separate recorded ACP approval"
        : "Linux original web client; local project; composer submission; free ACP showcase approval and interruption; reload; same-state server restart",
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
    approvalReceipt: null as ReturnType<typeof inspectNativeApprovalReceipt> | null,
    cancelledQuestion: null as Awaited<ReturnType<typeof cancelCapturedQuestion>> | null,
    historyFind: null as {
      query: string;
      count: string;
      draftPreserved: boolean;
      renderer: "dioxus-wasm" | "retained";
      refusedWasmRequests: number;
    } | null,
    voiceDraft: null as Awaited<ReturnType<typeof verifyBundledVoiceDraft>> | null,
    parallelTurns: null as Awaited<ReturnType<typeof verifyParallelShowcases>> | null,
    draftMerge: null as Awaited<ReturnType<typeof verifyDraftMerge>> | null,
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
    messageSpliceRecovery: null as {
      rejectedSequence: number;
      staleBaseSequence: number;
      resumedAfterSequence: number;
      replayBaseSequence: number;
      completedTextMatches: boolean;
    } | null,
    terminalReattach: null as { sameShell: boolean; unicodeOutput: boolean } | null,
    terminalSplit: null as Awaited<ReturnType<typeof verifySplitTerminalReconnect>> | null,
    terminalAlternate: null as Awaited<ReturnType<typeof verifyAlternateTerminalReconnect>> | null,
    terminalContention: null as Awaited<ReturnType<typeof verifyTerminalContention>> | null,
    terminalRestart: null as {
      oldOwnerExited: boolean;
      foregroundExited: boolean;
      newShell: boolean;
      previousThreadReopened: boolean;
    } | null,
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
  const composerSubmit: ComposerSubmitProof | undefined =
    composerSubmitRenderer === "dioxus" || composerSubmitRenderer === "dioxus-fallback"
      ? { renderer: composerSubmitRenderer, requests: [] }
      : undefined;
  const voiceSubmissions: string[] = [];
  const voiceAlternateSocketHosts: string[] = [];
  const stopRequests: ComposerStopRequest[] = [];
  let composerWasm: BrowserResponse | undefined;
  let refusedComposerWasmRequests = 0;
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
  let observeBytes = false;
  const wire = { sentFrames: 0, receivedFrames: 0, sentPayloadBytes: 0, receivedPayloadBytes: 0 };
  const countPayload = (direction: "sent" | "received", payload: string | Buffer) => {
    if (!observeBytes) return;
    const bytes = typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length;
    if (direction === "sent") { wire.sentFrames += 1; wire.sentPayloadBytes += bytes; }
    else { wire.receivedFrames += 1; wire.receivedPayloadBytes += bytes; }
  };
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
      if (voiceDraftProof && new URL(socket.url()).host !== new URL(current.url()).host) {
        voiceAlternateSocketHosts.push(new URL(socket.url()).host);
      }
      socket.on("framesent", ({ payload }) => {
        countPayload("sent", payload);
        const json = payload.toString();
        if (voiceDraftProof && (
          json.includes(ORCHESTRATION_V2_WS_METHODS.launchThread) ||
          json.includes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)
        )) {
          const request = JSON.parse(json);
          if (
            (request.tag === ORCHESTRATION_V2_WS_METHODS.launchThread && request.payload?.initialMessage) ||
            (request.tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && request.payload?.type === "message.dispatch")
          ) voiceSubmissions.push(request.tag);
        }
        if (composerSubmit && (
          json.includes(ORCHESTRATION_V2_WS_METHODS.launchThread) ||
          json.includes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)
        )) {
          const request = JSON.parse(json);
          const input = request.payload;
          if (
            composerStopProof && request.tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand &&
            (input?.type === "thread.stop" || input?.type === "run.interrupt")
          ) {
            stopRequests.push({
              type: input.type, commandId: input.commandId, threadId: input.threadId,
              ...(input.runId === undefined ? {} : { runId: input.runId }),
            });
          }
          if (
            (request.tag === ORCHESTRATION_V2_WS_METHODS.launchThread && input?.initialMessage) ||
            (request.tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && input?.type === "message.dispatch")
          ) {
            composerSubmit.requests.push({
              method: request.tag,
              commandId: input.commandId,
              threadId: input.threadId,
              messageId: input.initialMessage?.messageId ?? input.messageId,
            });
          }
        }
        if (json.includes('"orchestration.searchThreadStream"')) {
          threadFindRequests += 1;
        }
        if (/"messageTextAppends":[12](?!\d)/u.test(json)) messageAppendRequests += 1;
        if (/"messageTextAppends":2(?!\d)/u.test(json)) messageSpliceRequests += 1;
      });
      socket.on("framereceived", ({ payload }) => {
        countPayload("received", payload);
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
    if (composerSubmit?.renderer === "dioxus") {
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === composerSubmitWasmPath) composerWasm = response;
      });
    } else if (composerSubmit?.renderer === "dioxus-fallback") {
      await page.route(`**${composerSubmitWasmPath}`, (route) => {
        refusedComposerWasmRequests += 1;
        return route.abort("blockedbyclient");
      });
    }
    if (durableTextProof || byteProfile !== undefined) {
      starting("initialize the opted-in assistant text layout");
      proof.textRevisionProfile = textRevisionIdentity(stateDirectory, true, byteProfile ?? "compact");
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
    if (byteProfile !== undefined) {
      starting(`packaged ${byteProfile} text byte receipt predecessor`);
      const prompt = "Replay: text appends";
      const first = "This controlled reply sends several messages through the normal provider stream. The composer receives the first sentence while the same message is still open. A different frame brings another sentence and the same message keeps both sentences in their original order. The next frame will continue the reply with Unicode text and then finish the same turn. ";
      const second = "日本語 and a 🐟 complete the sequence. The bounded text fixture is complete.";
      const finalText = first + second + " The fixture now ends the turn.";
      const artifacts = Object.fromEntries([
        "apps/server/dist/bin.mjs", "apps/server/dist/native-bin/t3-code-ls-db",
        "apps/server/scripts/dev-replay-agent.ts",
        "apps/server/scripts/dev-replay/text_appends_transcript.ndjson",
      ].map((path) => [path, NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(repoRoot, path))).digest("hex")]));
      observeBytes = true;
      const threadId = await submitReplay(page, "Text appends", prompt);
      const approval = page.getByRole("button", { name: /^(Yes|Approve)$/u }).first();
      await approval.waitFor({ state: "visible" });
      const pending = await readThreadSnapshot(page, threadId);
      const identity = replayTurnIdentity(pending, "text-appends");
      await approval.click();
      await assertCompleted(page, threadId, identity, finalText);
      const snapshot = await readThreadSnapshot(page, threadId);
      observeBytes = false;
      Assert.ok(wire.sentFrames > 0 && wire.receivedFrames > 0);
      Assert.ok(messageAppendRequests > 0 && messageAppendFrames > 0);
      Assert.ok(await page.evaluate(
        () => performance.getEntriesByName("t3-thread-rust-text-append").length > 0,
      ), "The packaged Rust reducer must apply a negotiated append");
      const dialogue = snapshot.projection.messages.map(({ role, text, streaming }) => ({ role, text, streaming }));
      Assert.deepEqual(dialogue, [
        { role: "user", text: prompt, streaming: false },
        { role: "assistant", text: finalText, streaming: false },
      ]);
      const updates = inspectNativeTextUpdates(NodePath.join(repoRoot, "apps/server/dist/native-bin/t3-code-ls-db"), stateDirectory, threadId);
      Assert.equal(updates.at(-1)?.text, finalText);
      Assert.ok(updates.some((update) => update.streaming && update.text === first));
      Assert.ok(updates.some((update) => update.streaming && update.text === first + second));
      await page.reload({ waitUntil: "domcontentloaded" });
      await assertCompleted(page, threadId, identity, finalText);
      Assert.deepEqual((await readThreadSnapshot(page, threadId)).projection.messages
        .map(({ role, text, streaming }) => ({ role, text, streaming })), dialogue);
      Assert.deepEqual(textRevisionIdentity(stateDirectory, false, byteProfile), proof.textRevisionProfile);
      proof.byteAccounting = { profile: byteProfile, artifacts, updates, dialogue, wire };
      byteSamples.push(proof.byteAccounting);
      completed("Compared the completed Unicode dialogue and ordered durable updates after reload");
      proof.status = "passed";
      return;
    }
    if (threadLinkProof) {
      Assert.equal(implementation, "native");
      // Both threads are created by the normal composer and controlled free ACP
      // replay. No DOM injection, real provider or installed profile is used.
      const targetId = await submitReplay(page, "Formatted text", "Synthetic navigation target");
      await page.getByText(formattedAssistantDisplay, { exact: true }).waitFor({ state: "visible" });
      const targetUrl = page.url();
      const sourceId = await submitReplay(page, "Thread navigation", `Navigation target: ${targetId}`);
      await page.getByText("Synthetic navigation ready.", { exact: true }).waitFor({ state: "visible" });
      const sourceUrl = page.url();
      const source = await readThreadSnapshot(page, sourceId);
      Assert.ok(source.projection.thread.id === sourceId);
      let readRefusals: (() => number) | undefined;
      if (threadLinkProof === "dioxus-fallback") {
        readRefusals = await denyThreadLinkWasm(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForURL(sourceUrl);
      }
      const targetPath = new URL(targetUrl).pathname;
      const link = page.locator(`a[href=${JSON.stringify(targetPath)}]:visible`);
      proof.threadNavigation = await verifyThreadNavigation(
        page, link, targetUrl, formattedAssistantDisplay,
        threadLinkProof as "dioxus" | "dioxus-fallback",
      );
      if (readRefusals) proof.threadNavigationWasmRefusals = readRefusals();
      proof.status = "passed";
      return;
    }
    if (voiceDraftProof) {
      Assert.ok(bundledClient && implementation === "native" && expectsRustComposer);
      starting("capture synthetic microphone audio into an unsent draft");
      proof.voiceDraft = await verifyBundledVoiceDraft(
        page, () => voiceSubmissions, () => voiceAlternateSocketHosts, observePage,
      );
      completed("Preserved unsent Unicode drafts through insertion, cancellation, destination failure and concurrent-edit reopen");
      proof.status = "passed";
      return;
    }
    if (parallelTurnsProof) {
      Assert.ok(bundledClient && implementation === "native" && expectsRustComposer);
      starting("run independently controlled replay turns in two projects");
      proof.parallelTurns = await verifyParallelShowcases(page, workspace);
      completed("Reopened distinct completed and interrupted turns after concurrent approvals");
      proof.composer = "rust-wasm";
      proof.status = "passed";
      return;
    }
    if (multiTabDraftProof) {
      starting("two-tab unsent draft and model merge");
      proof.draftMerge = await verifyDraftMerge(page);
      completed("Kept the newer draft from the first tab and the model selected in the second");
    }
    starting(
      composerStopProof ? "normal composer Send and Stop" : "normal composer submission and controlled approval",
    );
    if (composerStopProof) {
      const capturedBytes = NodeFS.readFileSync(NodePath.join(repoRoot, capturedStop.path));
      Assert.equal(NodeCrypto.createHash("sha256").update(capturedBytes).digest("hex"), capturedStop.sha256);
    }
    const threadId = await submitReplay(
      page,
      composerStopProof ? capturedStop.modelLabel : undefined,
      composerStopProof ? capturedStop.prompt : undefined,
      undefined,
      composerSubmit,
    );
    proof.threadId = threadId;
    const usedRustComposer = await page.evaluate(
      () => performance.getEntriesByName("t3-composer-rust-offsets").length === 1,
    );
    Assert.equal(usedRustComposer, expectsRustComposer, "The composer must use the selected mapper");
    proof.composer = usedRustComposer ? "rust-wasm" : "retained";
    const wasmAtSend = composerWasm;
    const refusedWasmAtSend = refusedComposerWasmRequests;
    let wasmSha256AtSend: string | null = null;
    if (composerSubmit?.renderer === "dioxus") {
      Assert.ok(wasmAtSend !== undefined && wasmAtSend.ok(), "Send must load the bundled Wasm");
      // Chromium may discard this response body on the Stop proof's reload.
      wasmSha256AtSend = NodeCrypto.createHash("sha256").update(await wasmAtSend.body()).digest("hex");
      const bundledWasm = NodePath.join(repoRoot, "apps/web/dist", composerSubmitWasmPath.slice(1));
      Assert.equal(wasmSha256AtSend, NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(bundledWasm)).digest("hex"));
    }
    function recordComposerSubmit(
      composerSubmit: ComposerSubmitProof,
      sentMessageId: string | undefined,
    ) {
      Assert.equal(composerSubmit.requests.length, 1, "Send must emit exactly one turn request");
      const [request] = composerSubmit.requests;
      Assert.ok(request?.commandId);
      Assert.equal(request.method, ORCHESTRATION_V2_WS_METHODS.launchThread);
      Assert.equal(request.threadId, threadId);
      Assert.ok(sentMessageId);
      Assert.equal(sentMessageId, request.messageId);
      if (composerSubmit.renderer === "dioxus") {
        Assert.ok(wasmSha256AtSend);
      } else {
        Assert.equal(refusedWasmAtSend, 1, "The explicit fallback must follow a blocked Wasm load");
      }
      proof.composerSubmit = {
        ...composerSubmit,
        wasmSha256: wasmSha256AtSend,
        refusedWasmRequests: refusedWasmAtSend,
        localRefusalPreservedDraft: true,
      };
    }
    if (composerStopProof && composerSubmit) {
      proof.composerStop = await verifyComposerStop(page, threadId, composerSubmit.renderer, stopRequests);
      proof.threadUrl = page.url();
      recordComposerSubmit(composerSubmit, proof.composerStop.sentMessageId);
      completed("Verified one keyboard Stop, the interrupted run, and the unsent draft after reopen");
      proof.status = "passed";
      return;
    }
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
    if (composerSubmit) {
      const messages = pending.projection.messages.filter((message) => message.role === "user");
      Assert.equal(messages.length, 1);
      recordComposerSubmit(composerSubmit, messages[0]?.id);
      completed("Verified the Send button, local refusal, and exactly one authenticated turn");
      proof.status = "passed";
      return;
    }
    if (ptyContentionProof) {
      Assert.ok(nativePtyHost !== undefined);
      starting("run a foreground terminal burst during an independent replay turn");
      proof.terminalContention = await verifyTerminalContention(
        page, threadId, workspace, application, nativePtyHost,
      );
      proof.nativePtyOwner = true;
      proof.bundledNativePtyOwner = true;
      completed("Verified ordered terminal output, echoed input, same-shell reattach, and exact replay completion");
      proof.status = "passed";
      return;
    }
    if (pdfLinkProof) {
      starting("follow a same-document link in the PDF reader opened from Files");
      proof.pdfLinks = await verifyLinkedPdf(page, workspace);
      completed("Followed a link in the signed PDF with pointer and keyboard input");
      if (pdfExternalOnlyProof) {
        Assert.equal(implementation, "native");
        Assert.equal(proof.client, "built");
        Assert.equal(proof.composer, "rust-wasm");
        Assert.equal(proof.pdfLinks.signedAssetStatus, 200);
        Assert.equal(proof.pdfLinks.pointerDestination, 2);
        Assert.equal(proof.pdfLinks.keyboardDestination, 2);
        Assert.deepEqual(proof.pdfLinks.external, {
          pointerOpened: true, keyboardOpened: true, requests: 2,
          noUnsolicitedRequests: true, openerIsolated: true,
        });
        Assert.equal(proof.completedSnapshots.length, 1);
        Assert.equal(proof.persistence.length, 1);
        completed("Qualified signed PDF internal jumps and two explicit isolated external launches");
        proof.status = "passed";
        return;
      }
      await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    }
    if (htmlInteractionProof) {
      starting("interact with a real signed HTML reply and its scoped bridge");
      proof.htmlInteraction = await verifyInteractiveHtml(page, threadId);
      completed("Interacted with the real HTML publisher's page and scoped frame lifecycle");
    }
    if (previewLifetimeProof) {
      starting("navigate and reconnect the real server-browser preview");
      proof.previewLifetime = await verifyPreviewLifetime(page, threadId, NodePath.join(directory, "preview.png"));
      completed("Interacted with the streamed preview and verified hidden and closed viewer lifetimes");
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
      let refusedWasmRequests = 0;
      if (dioxusFindProof === "fallback") {
        await page.route("**/pairing-wasm/*_bg.wasm", (route) => {
          refusedWasmRequests++;
          return route.abort();
        });
      }
      await editor.fill(draft);
      const requestsBeforeFind = threadFindRequests;
      await page.keyboard.press("Control+f");
      const bar = page.getByRole("search", { name: "Find in thread" });
      const search = bar.getByRole("searchbox", { name: "Find in thread" });
      const renderer = await bar.getAttribute("data-thread-find-renderer") === "dioxus-wasm"
        ? "dioxus-wasm" : "retained";
      if (dioxusFindProof === "dioxus" || (dioxusFindProof === undefined && expectsDioxusFind)) {
        Assert.equal(renderer, "dioxus-wasm");
      }
      if (dioxusFindProof === "fallback") {
        Assert.equal(renderer, "retained");
        Assert.ok(refusedWasmRequests > 0);
      }
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
      if (dioxusFindProof !== undefined) {
        await search.press("Control+f");
        await page.waitForFunction(() => {
          const active = document.activeElement;
          return active instanceof HTMLInputElement && active.type === "search"
            && active.selectionStart === 0 && active.selectionEnd === active.value.length;
        });
        Assert.equal(await search.evaluate((input) => input.dispatchEvent(new window.KeyboardEvent("keydown", {
          key: "Enter", isComposing: true, bubbles: true, cancelable: true,
        }))), true, "A composition Enter must not navigate search matches");
        await search.press("Shift+Enter");
        await bar.getByRole("button", { name: "Next match", exact: true }).click();
        await search.fill("No matching words in this deterministic transcript");
        await bar.getByText("0/0", { exact: true }).waitFor({ state: "visible" });
        Assert.equal(await bar.getByRole("button", { name: "Next match", exact: true }).isDisabled(), true);
        await bar.getByRole("button", { name: "Close find", exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "composer-editor");
      } else {
        await page.keyboard.press("Escape");
      }
      await bar.waitFor({ state: "hidden" });
      Assert.equal(await editor.innerText(), draft);
      proof.historyFind = { query, count: "1/1", draftPreserved: true, renderer, refusedWasmRequests };
      completed("Found and highlighted the previous reply after restart while retaining the draft");
      if (dioxusFindProof !== undefined) {
        proof.status = "passed";
        return;
      }
    }
    if (bundledClient && implementation === "native") {
      starting("interactive terminal reconnect");
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(page.url()).origin,
        });
        const shell = await terminalMarker(page, "fixture-pty");
        let terminalOwner: number | undefined;
        if (nativePtyHost !== undefined) {
          if (bundledPtyProof) assertBundledPtyIdentity(nativePtyHost);
          terminalOwner = assertNativePtyOwner(shell, nativePtyHost, application.pid);
          proof.nativePtyOwner = true;
          proof.bundledNativePtyOwner = bundledPtyProof;
        }
        proof.terminalInitialOutput = true;
        saveProof();
        if (ptyRestartProof) {
          Assert.ok(bundledPtyProof && nativePtyHost && terminalOwner !== undefined);
          starting("stop the native server with a foreground terminal job");
          const previous = await verifyOwnedPtyShutdown(page, workspace, shell, terminalOwner,
            () => application.stop("server"));
          application = await startApplication(implementation, stateDirectory, serverPort,
            webPort, NodePath.join(directory, "terminal-restart.log"));
          proof.processGroups.push(application.pid);
          await page.reload({ waitUntil: "domcontentloaded" });
          await assertCompleted(page, threadId, turnIdentity);
          const replacement = await terminalMarker(page, "fixture-reattach");
          const restarted = liveLinuxProcess(Number(replacement));
          Assert.ok(restarted);
          Assert.ok(restarted.pid !== previous.pid || restarted.started !== previous.started,
            "A fresh terminal must have a distinct process identity after server restart");
          assertNativePtyOwner(replacement, nativePtyHost, application.pid);
          proof.terminalRestart = {
            oldOwnerExited: true,
            foregroundExited: true,
            newShell: true,
            previousThreadReopened: true,
          };
          completed("Reopened the durable thread and started a new owned terminal after graceful server shutdown");
          proof.status = "passed";
          return;
        }
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
        if (ptyRestartProof) throw error;
      }
    }
    await page.goto(proof.interrupted.threadUrl, { waitUntil: "domcontentloaded" });
    await verifyInterruptedShowcase(page, proof.interrupted);
    completed("Recovered the interrupted turn and partial reply in the new browser session");
    starting("recorded ACP permission request");
    proof.capturedApproval = await acceptCapturedApproval(page);
    completed("Approved the recorded ACP permission request and received its expected reply");
    if (process.env.T3_CODE_LS_APPROVAL_PROOF) {
      Assert.equal(implementation, "native");
      const approval = proof.capturedApproval;
      Assert.ok("approvalAction" in approval && approval.approvalAction);
      const [decision] = approval.approvalAction.decisions;
      Assert.ok(decision);
      proof.approvalReceipt = inspectNativeApprovalReceipt(
        nativeExecutable("db"),
        stateDirectory,
        decision.commandId,
        decision.threadId,
        approval.snapshotSequence,
      );
      completed("Verified the exact accepted approval receipt in native storage after reopen");
      proof.status = "passed";
      return;
    }
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

      starting("stale splice base recovery through the selected thread owner");
      const recoveryPage = await context.newPage();
      observePage(recoveryPage);
      let recoveryThread: string | undefined;
      let rejectedSequence: number | undefined;
      let staleBaseSequence: number | undefined;
      let resumedAfterSequence: number | undefined;
      let resumedRequestId: string | undefined;
      let replayBaseSequence: number | undefined;
      try {
        // Intercept only this page's sockets, before its first connection. The
        // server and durable fixture remain untouched; one wire base is stale.
        await recoveryPage.routeWebSocket("**/*", (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((payload) => {
            const request = JSON.parse(payload.toString());
            if (
              rejectedSequence !== undefined &&
              request.tag === ORCHESTRATION_V2_WS_METHODS.subscribeThread &&
              request.payload?.threadId === recoveryThread
            ) {
              Assert.equal(request.payload.messageTextAppends, 2);
              Assert.ok(Number.isSafeInteger(request.payload.afterSequence));
              Assert.ok(request.payload.afterSequence < rejectedSequence,
                "A rejected splice must not advance the owner's replay watermark");
              resumedAfterSequence = request.payload.afterSequence;
              resumedRequestId = String(request.id);
            }
            server.send(payload);
          });
          server.onMessage((payload) => {
            // The proof uses the ordinary JSON wire envelope. Forward other
            // frames intact, and fail below if no eligible splice was exercised.
            let envelope;
            try { envelope = JSON.parse(payload.toString()); } catch {
              socket.send(payload);
              return;
            }
            let changed = false;
            for (const item of Array.isArray(envelope?.values) ? envelope.values : []) {
              if (item?.event?.type !== "message.updated" ||
                item.event.payload?.threadId !== recoveryThread) continue;
              if (rejectedSequence === undefined && item.kind === "message-text-splice") {
                Assert.ok(item.baseSequence > 0);
                rejectedSequence = item.sequence;
                staleBaseSequence = item.baseSequence - 1;
                item.baseSequence = staleBaseSequence;
                changed = true;
              } else if (resumedAfterSequence !== undefined && replayBaseSequence === undefined &&
                String(envelope.requestId) === resumedRequestId) {
                Assert.equal(item.kind, "event",
                  "A new subscription must establish a full JSON message before any edit");
                Assert.ok(item.sequence > resumedAfterSequence);
                replayBaseSequence = item.sequence;
              }
            }
            socket.send(changed ? JSON.stringify(envelope) : payload);
          });
        });
        await recoveryPage.goto(page.url(), { waitUntil: "domcontentloaded" });
        recoveryThread = await submitReplay(recoveryPage, "Text splices", "Replay: text splices");
        await recoveryPage.getByRole("button", { name: /^(Yes|Approve)$/u }).first().click();
        await recoveryPage.getByText(original, { exact: true }).last().waitFor({ state: "visible" });
        const pending = await readThreadSnapshot(recoveryPage, recoveryThread);
        const recovered = await assertCompleted(
          recoveryPage, recoveryThread, replayTurnIdentity(pending, "text-splices"), finalText,
        );
        await recoveryPage.getByText(finalText, { exact: true }).last().waitFor({ state: "visible" });
        Assert.ok(rejectedSequence !== undefined, "Inject exactly one stale splice base");
        Assert.ok(staleBaseSequence !== undefined);
        Assert.ok(resumedAfterSequence !== undefined, "The shared owner must resubscribe");
        Assert.ok(replayBaseSequence !== undefined, "Recovery must receive an authoritative message base");
        const completedSnapshot = await readThreadSnapshot(recoveryPage, recoveryThread);
        Assert.deepEqual(
          completedSnapshot.projection.messages.filter((message) => message.role === "assistant")
            .map(({ id, text, streaming }) => ({ id, text, streaming })),
          [{ id: recovered.assistantMessageId, text: finalText, streaming: false }],
          "Completion replaces the original message exactly once after rejected edits",
        );
        proof.messageSpliceRecovery = {
          rejectedSequence, staleBaseSequence, resumedAfterSequence, replayBaseSequence,
          completedTextMatches: true,
        };
        completed("Rejected a stale Rust splice and recovered exact completion without advancing its watermark");
      } finally {
        await recoveryPage.close();
      }

    }

    if (fileEditorProof) {
      starting("versioned workspace file edits and conflict");
      proof.fileEditor = await verifyFileEditor(page, workspace, fileWrites);
      completed("Saved two workspace edits and retained the next draft after an external change");
    }
    if (draftStorageProof) {
      starting("draft quota denial, retry and cross-tab conflict");
      proof.draftStorage = await verifyDraftStorageRecovery(page);
      completed("Recovered the unsent draft and preserved the newer save from another tab");
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
    if (previewLifetimeProof) {
      NodeFS.rmSync(NodePath.join(stateDirectory, "tools", "chrome-headless-shell"), { recursive: true, force: true });
    }
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
  guestNameRenderer: guestNameProof,
  runRoot,
  error: null as string | null,
};
try {
  const executablePath = process.env.T3_CODE_LS_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    ...(voiceDraftProof
      ? { channel: "chromium", args: ["--use-fake-device-for-media-stream"] }
      : {}),
  });
  console.log(`Original client acceptance: ${requested.join(", ")}; Chromium ${browser.version()}`);
  for (const implementation of requested) {
    if (guestNameProof && isPairingRenderer(guestNameProof)) {
      await verifyGuestName(implementation, guestNameProof);
    } else if (pairingProof && isPairingRenderer(pairingProof)) {
      await verifyPairing(implementation, pairingProof);
    } else {
      if (durableByteProof) {
        await exercise(implementation, "full");
        await exercise(implementation, "compact");
        const [full, compact] = byteSamples;
        Assert.ok(full && compact && byteSamples.length === 2);
        Assert.deepEqual(full.artifacts, compact.artifacts);
        Assert.deepEqual(full.dialogue, compact.dialogue);
        Assert.deepEqual(full.updates, compact.updates);
        writeJson(NodePath.join(proofRoot, "durable-wire-predecessor.json"), {
          schemaVersion: 1, status: "receipt-predecessor", source,
          stockProductDenominator: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f",
          pairedProfiles: byteSamples,
          equality: "exact role/text/streaming dialogue and ordered reconstructed assistant updates; per-profile identities and timestamps excluded",
          wireBoundary: "Playwright WebSocket sent/received payloads on the owned page, from before submitReplay through the completed authoritative snapshot; includes control and snapshot traffic on all page sockets",
          wireExcludes: "WebSocket headers, masks, compression, TCP/TLS, HTTP and provider traffic; no per-turn transport or allocation claim",
          physicalEventKeyValueBytes: null,
          physicalGap: "Bundled read-only-local application events API expands stored revisions; raw event K/V plus indexes and witnesses are not exposed",
          gainClaim: null, walEquivalence: false, stockEquivalence: false,
          isolatedResultPooled: false,
          remaining: "Root must qualify packaged execution, add bounded raw persisted K/V inspection and repeat matched trials before comparing bytes",
        });
      } else {
        await exercise(implementation);
      }
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
