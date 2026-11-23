// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off - isolated packaged refusal proof.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Schema from "effect/Schema";
import { ClaudeSettings, CommandId, MessageId, ProjectId, ProviderInstanceId, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import type { RowPage } from "../src/persistence/RedbClient.ts";
import { makeClaudeQueryOptions } from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { cellValue } from "../../../tools/omdb-guest-state.ts";
import { authenticatePackagedServer, reservePort, startPackagedServer } from "./packaged-server-fixture.ts";

// This gate expects the current coupled MCP profile to REFUSE. It must not turn
// into a conversation pass when selection or option equality stops working.
// The optional no-mcp-refusal arm must instead refuse an unrelated model mismatch.
const [proofArgument, entryArgument, fixtureArgument, mode = "mcp-refusal", ...extra] = process.argv.slice(2);
Assert.ok(mode === "mcp-refusal" || mode === "no-mcp-refusal" || mode === "no-mcp-conversation");
const conversation = mode === "no-mcp-conversation";
const noMcp = mode !== "mcp-refusal";
const terminalStatus = conversation ? "completed" : "failed";
Assert.equal(extra.length, 0);
for (const argument of [proofArgument, entryArgument, fixtureArgument]) Assert.ok(argument && Path.isAbsolute(argument));
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"], "Use the loopback-only hosted network namespace");
const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const proof = Path.join(FS.realpathSync(Path.dirname(proofArgument!)), Path.basename(proofArgument!));
Assert.ok(Path.relative(root, proof).startsWith(`..${Path.sep}`));
const entry = FS.realpathSync(entryArgument!);
const fixture = FS.realpathSync(fixtureArgument!);
Assert.match(Path.basename(fixture), /^claude_stdio_host-[a-f0-9]+$/u);
FS.mkdirSync(proof, { mode: 0o700 });
const scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Packaged Claude refusal interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const hash = (file: string) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
const report: Record<string, unknown> = { status: "running", scope: mode,
  stock: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f", conversationQualified: false };
const save = () => FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let active: ReturnType<typeof startPackagedServer> | undefined;
let failure: unknown;
const text = "Claude 🌱 café é\n  終了 🛠️";
const instanceId = ProviderInstanceId.make("claude-stdio-synthetic-packaged");
const projectId = ProjectId.make("claude-stdio-synthetic-project");
const messageId = MessageId.make(Crypto.randomUUID());
const commandId = CommandId.make(Crypto.randomUUID());
const title = "Synthetic Claude fixture";
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };

try {
  const nativeBin = Path.join(Path.dirname(entry), "native-bin");
  const helper = Path.join(nativeBin, "t3-code-ls-claude-stdio");
  const databaseHelper = Path.join(nativeBin, "t3-code-ls-db");
  const manifestFile = Path.join(nativeBin, "manifest.json");
  const manifest = JSON.parse(FS.readFileSync(manifestFile, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  for (const file of [helper, databaseHelper]) {
    Assert.ok(FS.lstatSync(file).isFile() && !FS.lstatSync(file).isSymbolicLink());
    FS.accessSync(file, FS.constants.X_OK);
    Assert.equal(manifest.files[Path.basename(file)], hash(file));
  }
  FS.accessSync("/usr/bin/strace", FS.constants.X_OK);
  report.source = ChildProcess.execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD", "HEAD^{tree}"],
    { env: {}, encoding: "utf8", timeout: 5_000 }).trim().split("\n");
  report.artifacts = { entry: hash(entry), manifest: hash(manifestFile), helper: hash(helper),
    fixture: hash(fixture), databaseHelper: hash(databaseHelper), toolchainLock: hash(Path.join(root, "toolchain.lock.json")) };
  const state = Path.join(scratch, "state");
  const home = Path.join(scratch, "home");
  const workspace = Path.join(scratch, "workspace");
  const temporary = Path.join(scratch, "tmp");
  const bin = Path.join(scratch, "bin");
  const userdata = Path.join(state, "userdata");
  for (const directory of [userdata, home, workspace, temporary, bin]) FS.mkdirSync(directory, { recursive: true });
  FS.symlinkSync("/usr/bin/git", Path.join(bin, "git"));
  ChildProcess.execFileSync("/usr/bin/git", ["init", "--quiet", workspace], { env: { HOME: home, PATH: bin }, timeout: 5_000 });
  FS.writeFileSync(Path.join(workspace, "packaged-conversation"), "");
  FS.writeFileSync(Path.join(userdata, "settings.json"), JSON.stringify({ providerInstances: {
    ...Object.fromEntries(["codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
      .map((driver) => [driver, { driver, enabled: false }])),
    [instanceId]: { driver: "claudeAgent", enabled: true, config: {} },
  } }));
  // Both the server process and expected query use explicit, synthetic inputs.
  // The oracle never observes the server's live options, environment or credentials.
  const childEnvironment = { HOME: home, PATH: bin, TMPDIR: temporary,
    XDG_CONFIG_HOME: Path.join(home, ".config"), XDG_DATA_HOME: Path.join(home, ".local/share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1",
  };
  const expectedOptions = conversation
    ? makeClaudeQueryOptions({
        modelSelection, nativeThreadId: "fixture", title, resume: false, cwd: workspace,
        attachmentsDir: Path.join(userdata, "attachments"),
        settings: Schema.decodeUnknownSync(ClaudeSettings)({}),
        environment: { ...childEnvironment, CLAUDE_CODE_ENTRYPOINT: "t3-code" },
        tools: { type: "preset", preset: "claude_code" }, permissionMode: "default",
        supportedDialogKinds: ["resume_return"],
      })
    : { permissionMode: "default", sessionId: "fixture", cwd: workspace,
        ...(noMcp ? { model: "deliberate-unrelated-mismatch" } : {}) };
  const env = { ...childEnvironment,
    T3_CODE_LS_CLAUDE_STDIO_SYNTHETIC: JSON.stringify({
      version: 1, instanceId, program: fixture, directory: workspace, expectedOptions,
      ...(noMcp ? { mcp: "disabled" } : {}),
    }),
  };
  const traces: string[] = [];
  const start = async (phase: string) => {
    const trace = Path.join(proof, phase + ".exec");
    traces.push(trace);
    const server = startPackagedServer({ bundle: entry, executable: true, baseDir: state, env,
      logPath: Path.join(proof, phase + ".log"), execTrace: trace, signal: abort.signal, port: await reservePort() });
    active = server;
    await server.ready;
    return server;
  };
  report.phase = "boot";
  const first = await start("initial");
  const client = await authenticatePackagedServer(first, abort.signal);
  await client.createProject({ projectId, title, workspaceRoot: workspace });
  report.phase = "launch";
  const { threadId } = await client.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(Crypto.randomUUID()), projectId, title, generateTitle: false,
    modelSelection, runtimeMode: "approval-required",
    interactionMode: "default", workspaceStrategy: { type: "root" },
  }));
  const read = (connection: typeof client) => connection.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }));
  const witnessFile = Path.join(workspace, "claude-stdio-options-refused.json");
  const empty = await read(client);
  Assert.equal(empty.messages.length, 0);
  Assert.equal(empty.runs.length, 0);
  report.phase = "dispatch";
  // Exactly one dispatch. A timeout/error never retries this operation.
  await client.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({ type: "message.dispatch", commandId,
    threadId, messageId, text, attachments: [], createdBy: "user", creationSource: "web",
    dispatchMode: { type: "start_immediately" } }));
  let settled = await read(client);
  const deadline = AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]);
  while (!settled.runs.some((run) => run.status === terminalStatus)) {
    if (settled.runs.some((run) => run.status === (conversation ? "failed" : "completed"))) {
      if (FS.existsSync(witnessFile)) FS.copyFileSync(witnessFile, Path.join(proof, "options-refused.json"));
      throw new Error("Unexpected terminal state for the selected fixture arm");
    }
    await delay(100, undefined, { signal: deadline });
    settled = await read(client);
  }
  Assert.equal(settled.runs.length, 1);
  Assert.equal(settled.messages.filter((message) => message.role === "user").length, 1);
  const user = settled.messages.find((message) => message.id === messageId);
  Assert.equal(user?.text, text);
  Assert.equal(user?.runId, settled.runs[0]?.id);
  const assistant = settled.messages.filter((message) => message.role === "assistant" && message.text.length > 0);
  Assert.equal(assistant.length, conversation ? 1 : 0);
  const reply = assistant[0];
  if (conversation) {
    Assert.equal(reply?.text, text);
    Assert.equal(reply?.runId, user?.runId);
    Assert.notEqual(reply?.id, messageId);
    Assert.ok(reply?.id);
  }

  // The witness distinguishes an intentional refusal from an earlier startup failure.
  report.phase = "runner-outcome";
  let witness: unknown;
  if (!conversation) {
    const refusal = JSON.parse(FS.readFileSync(witnessFile, "utf8"));
    Assert.equal(refusal.version, 1);
    Assert.equal(refusal.type, "options-refused");
    Assert.ok(Array.isArray(refusal.differing));
    if (noMcp) {
      Assert.ok(!refusal.differing.includes("mcpServers"));
      Assert.ok(!refusal.differing.includes("hooks"));
      Assert.ok(refusal.differing.includes("model"));
    } else {
      Assert.ok(refusal.differing.includes("mcpServers"));
    }
    Assert.ok(refusal.differing.every((key: unknown) => typeof key === "string"));
    witness = refusal;
  }
  if (FS.existsSync(witnessFile)) {
    FS.copyFileSync(witnessFile, Path.join(proof, "options-refused.json"));
  }
  Assert.equal(FS.existsSync(witnessFile), !conversation);
  Assert.ok(await first.stop());
  active = undefined;
  const database = Path.join(userdata, "statev2.omdb");
  Assert.ok(FS.lstatSync(database).isFile());
  Assert.ok(!FS.existsSync(Path.join(userdata, "statev2.sqlite")));
  const snapshot = (table = "orchestration_events") => {
    const transaction_id = "claude-packaged-refusal";
    const requests = [{ operation: "application_begin", transaction_id, mode: "read" },
      { operation: "application_scan", transaction_id, table, limit: 256 },
      { operation: "application_rollback", transaction_id }];
    const replies = ChildProcess.execFileSync(databaseHelper, ["read-only-local", database], { env: {}, encoding: "utf8",
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024, input: requests.map((value) => JSON.stringify(value)).join("\n") + "\n" })
      .trim().split("\n").map((line) => JSON.parse(line));
    Assert.equal(replies.length, requests.length);
    Assert.ok(replies.every((reply) => reply.ok === true));
    Assert.equal(replies[1].result.next, null);
    return replies[1].result.rows as RowPage["rows"];
  };
  report.phase = "native-events";
  const before = snapshot();
  const events = before.filter(({ row }) => cellValue(row.stream_id) === threadId)
    .map(({ row }) => ({ type: cellValue(row.event_type), payload: JSON.parse(String(cellValue(row.payload_json))) }));
  const terminals = events.filter((event) => event.type === "run.updated" && event.payload.id === settled.runs[0]?.id && event.payload.status === terminalStatus);
  Assert.equal(terminals.length, 1);
  Assert.ok(events.some((event) => event.type === "message.updated" && event.payload.id === messageId && event.payload.text === text));
  if (reply) {
    Assert.ok(events.some((event) => event.type === "message.updated" &&
      event.payload.id === reply.id && event.payload.text === text));
  }
  const receipts = snapshot("orchestration_command_receipts");
  const receipt = receipts.filter(({ row }) => cellValue(row.command_id) === commandId);
  Assert.equal(receipt.length, 1);
  Assert.equal(cellValue(receipt[0]!.row.command_type), "message.dispatch");
  Assert.equal(cellValue(receipt[0]!.row.status), "accepted");
  report.phase = "reopen";
  const reopened = await start("reopened");
  Assert.notEqual(first.pid, reopened.pid);
  const reopenedClient = await authenticatePackagedServer(reopened, abort.signal);
  const restored = await read(reopenedClient);
  Assert.deepEqual(restored.messages, settled.messages);
  Assert.deepEqual(restored.runs, settled.runs);
  Assert.ok(await reopened.stop());
  active = undefined;
  Assert.deepEqual(snapshot(), before);
  Assert.deepEqual(snapshot("orchestration_command_receipts"), receipts);
  if (!conversation) Assert.deepEqual(JSON.parse(FS.readFileSync(witnessFile, "utf8")), witness);
  for (const marker of ["adapter-child-started", "conversation-child-started", "conversation-prompt.json"]) {
    Assert.equal(FS.existsSync(Path.join(workspace, marker)), conversation);
  }
  if (conversation) {
    const prompt = JSON.parse(FS.readFileSync(Path.join(workspace, "conversation-prompt.json"), "utf8"));
    Assert.equal(prompt.type, "user");
    Assert.ok(typeof prompt.uuid === "string" && prompt.uuid.length === 36);
    Assert.ok(JSON.stringify(prompt.message).includes(JSON.stringify(text)));
  }
  // Count exec attempts by configured exact paths in each isolated process.
  const [initialTrace, reopenedTrace] = traces.map((file) => FS.readFileSync(file, "utf8"));
  Assert.ok(initialTrace !== undefined && reopenedTrace !== undefined);
  for (const executable of [fixture, helper]) {
    const prefix = `execve(${JSON.stringify(executable)}`;
    Assert.equal(initialTrace.split("\n").filter((line) => line.includes(prefix)).length, conversation ? 1 : 0);
    Assert.ok(!reopenedTrace.includes(prefix));
  }
  // The normal installation status may probe --version. The synthetic PATH
  // has no Claude CLI; require that exact probe to fail before any process runs.
  const absentCli = `execve(${JSON.stringify(Path.join(bin, "claude"))}, ["claude", "--version"]`;
  const unavailableInstallationProbes = (initialTrace + reopenedTrace).split("\n").filter((line) =>
    /execve\("[^"\n]*\/(?:claude|claude-code)"/u.test(line));
  Assert.ok(unavailableInstallationProbes.every((line) =>
    line.includes(absentCli) && line.includes(" = -1 ENOENT ")));
  report.observed = { instanceId, commandId, messageId, runId: settled.runs[0]?.id, text,
    dispatchCount: 1, terminalStatus, terminalEvents: 1, assistantMessages: assistant.length,
    assistantMessageId: reply?.id, nativeStore: "omdb", reopened: true, receiptRetained: true,
    helperManifestVerified: true, controlledOpenRefusedMcpOptions: !noMcp,
    controlledNoMcpRefusedUnrelatedModel: noMcp && !conversation,
    helperOrProviderExecuted: conversation, unavailableInstallationProbes: unavailableInstallationProbes.length };
  report.conversationQualified = conversation;
  report.phase = "complete";
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.failure = error instanceof Error ? error.name : "Unknown failure";
} finally {
  try {
    await active?.stop();
    FS.rmSync(scratch, { recursive: true, force: true });
    report.scratchRemoved = !FS.existsSync(scratch);
  } catch (error) { failure ??= error; report.status = "failed"; report.cleanupFailure = "Owned cleanup failed"; }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  save();
}
if (failure !== undefined) throw new Error("Packaged Claude refusal proof failed; inspect its private logs and checkpoint.", { cause: failure });
