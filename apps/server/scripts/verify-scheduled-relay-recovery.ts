// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalJsonInEffect:off - loopback-only packaged process proof.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskWebhookDeliveryId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { assertNoApplicationSqlite } from "../../web/scripts/hybrid-client-database.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../src/cloud/config.ts";
import {
  authenticatePackagedServer,
  reservePort,
  startPackagedServer,
} from "./packaged-server-fixture.ts";

const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const outputPath = process.argv[2];
const boundary = process.argv[3] ?? "before-claim";
Assert.ok(outputPath && Path.isAbsolute(outputPath) && process.argv.length <= 4);
Assert.ok(boundary === "before-claim" || boundary === "after-claim" ||
  boundary === "after-dispatch" || boundary === "after-provider-prompt");
const afterProviderPrompt = boundary === "after-provider-prompt";
const proof = Path.join(FS.realpathSync(Path.dirname(outputPath)), Path.basename(outputPath));
Assert.ok(Path.relative(root, proof).startsWith(`..${Path.sep}`));
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"], "Run in a loopback-only namespace");
FS.mkdirSync(proof, { mode: 0o700 });

const bundle = Path.join(root, "apps/server/dist/bin.mjs");
const helper = Path.join(root, "apps/server/dist/native-bin/t3-code-ls-db");
const hash = (data: string | Uint8Array) => Crypto.createHash("sha256").update(data).digest("hex");
const write = (path: string, data: unknown) =>
  FS.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const report: Record<string, unknown> = { status: "running", boundary };
const checkpoint = (phase: string) => {
  report.phase = phase;
  write(Path.join(proof, "proof.json"), report);
};

const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Scheduled relay proof interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

let owned: ReturnType<typeof startPackagedServer> | undefined;
let scratch: string | undefined;
let webhookPath: string | undefined;
try {
  checkpoint("verify source and packaged helper");
  const git = (...args: string[]) =>
    ChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  Assert.equal(git("status", "--porcelain"), "");
  const manifest = JSON.parse(FS.readFileSync(Path.join(Path.dirname(helper), "manifest.json"), "utf8"));
  const helperSha256 = hash(FS.readFileSync(helper));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.files["t3-code-ls-db"], helperSha256);
  report.source = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  report.artifacts = { bundleSha256: hash(FS.readFileSync(bundle)), helperSha256 };

  scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
  const baseDir = Path.join(scratch, "state");
  const home = Path.join(scratch, "home");
  const workspaceRoot = Path.join(scratch, "workspace");
  const userdata = Path.join(baseDir, "userdata");
  const secrets = Path.join(userdata, "secrets");
  const bin = Path.join(home, "bin");
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: Path.join(scratch, "tmp"),
    XDG_CONFIG_HOME: Path.join(home, ".config"),
    XDG_DATA_HOME: Path.join(home, ".local", "share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    T3_CODE_LS_IMPLEMENTATION: "native",
    T3_CODE_LS_DURABLE_RELAY_WEBHOOKS: "1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    NO_COLOR: "1",
  };
  for (const directory of [secrets, bin, workspaceRoot, env.TMPDIR]) {
    FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  FS.symlinkSync("/usr/bin/git", Path.join(bin, "git"));
  ChildProcess.execFileSync(Path.join(bin, "git"), ["init", "--quiet"], { cwd: workspaceRoot, env });
  const provider = ProviderInstanceId.make("devReplay");
  const providerWitness = Path.join(scratch, "provider-prompts.txt");
  const providerProgress = Path.join(scratch, "provider-progress.txt");
  FS.writeFileSync(providerWitness, "", { mode: 0o600 });
  const promptsObserved = () => FS.readFileSync(providerWitness, "utf8").split("prompt\n").length - 1;
  write(Path.join(userdata, "settings.json"), {
    providerInstances: {
      ...Object.fromEntries(
        ["codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
          .map((driver) => [driver, { driver, enabled: false }]),
      ),
      [provider]: {
        driver: "acpRegistry",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [
            Path.join(root, "apps/server/scripts/scheduled-relay-provider-probe.mjs"),
            Path.join(root, "apps/server/scripts/dev-replay-agent.ts"),
            providerWitness,
            ...(afterProviderPrompt ? [providerProgress] : []),
          ],
        },
      },
    },
  });
  const { privateKey, publicKey } = Crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const issuer = "https://relay.fixture.test";
  FS.writeFileSync(Path.join(secrets, `${CLOUD_MINT_PUBLIC_KEY}.bin`), publicKey, { mode: 0o600 });
  FS.writeFileSync(Path.join(secrets, `${RELAY_ISSUER_SECRET}.bin`), issuer, { mode: 0o600 });

  const relayId = `fixture-relay-${boundary}-restart`;
  const deliveryId = ScheduledTaskWebhookDeliveryId.make(`delivery:relay:${relayId}`);
  const gate = Path.join(scratch, "relay-crash-gate.mjs");
  const witnessPath = Path.join(proof, "ready.json");
  const database = Path.join(userdata, "statev2.omdb");
  Assert.ok(!/\s/u.test(process.execPath), "The native gate requires a Node path without whitespace");
  FS.writeFileSync(gate, `#!${process.execPath}\n` + FS.readFileSync(
    new URL("./scheduled-relay-crash-gate.mjs", import.meta.url), "utf8",
  ), { mode: 0o700 });
  write(Path.join(scratch, "relay-crash-gate.json"), {
    executable: helper, database, deliveryId, witness: witnessPath, boundary,
  });

  const start = async (name: string, executable?: string) => {
    owned = startPackagedServer({
      bundle,
      logPath: Path.join(proof, `${name}.log`),
      signal: abort.signal,
      baseDir,
      port: await reservePort(),
      env: executable === undefined ? env : { ...env, T3_CODE_LS_DB_EXECUTABLE: executable },
    });
    await owned.ready;
    return owned;
  };

  checkpoint("create idle replay thread and webhook through authenticated RPC");
  const initial = await start("initial", afterProviderPrompt ? undefined : gate);
  const client = await authenticatePackagedServer(initial, abort.signal);
  const projectId = ProjectId.make("fixture-relay-recovery");
  const title = "Scheduled relay recovery";
  await client.createProject({ projectId, title, workspaceRoot });
  const shared = {
    title,
    projectId,
    modelSelection: { instanceId: provider, model: "todo-list" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  } as const;
  const { threadId, projection } = await client.rpc((rpc) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      ...shared,
      commandId: CommandId.make("fixture-relay-thread"),
      generateTitle: false,
    }),
  );
  Assert.equal(projection.messages.length, 0);
  Assert.equal(projection.runs.length, 0);
  const { task } = await client.rpc((rpc) => rpc[WS_METHODS.scheduledTasksUpsert]({
    ...shared,
    commandId: CommandId.make("fixture-relay-task"),
    enabled: true,
    threadId,
    threadMode: "continue",
    prompt: "Synthetic relay body {{body.marker}}",
    schedule: { type: "webhook" },
  }));
  webhookPath = task.webhook?.path;
  Assert.ok(webhookPath?.startsWith(`/api/hooks/${encodeURIComponent(task.id)}/`));
  const environmentId = FS.readFileSync(Path.join(userdata, "environment-id"), "utf8").trim();
  Assert.ok(environmentId);
  const receivedAt = new Date().toISOString();
  const now = Math.floor(Date.parse(receivedAt) / 1_000);
  const signature = await Effect.runPromise(signRelayJwt({
    privateKey,
    typ: RELAY_HOOK_DELIVERY_TYP,
    payload: {
      iss: issuer, aud: `t3-env:${environmentId}`, sub: environmentId, jti: `proof:${relayId}`,
      iat: now, exp: now + 600, environmentId, deliveryId: relayId, receivedAt, hookId: task.id,
    },
  }).pipe(Effect.provide(NodeCrypto.layerSignature)));
  const marker = "preserved café 🦀";
  const post = async (origin: string, outcome: "accepted" | "duplicate" | "unresolved") => {
    const response = await fetch(new URL(webhookPath!, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_HOOK_DELIVERY_HEADER]: signature,
        "x-t3-relay-delivery-id": relayId,
        "x-t3-relay-received-at": receivedAt,
      },
      body: JSON.stringify({ marker }),
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    Assert.equal(response.status, outcome === "unresolved" ? 500 : 202);
    Assert.equal(response.headers.get("x-t3-hook-outcome"), outcome);
    Assert.deepEqual(await response.json(), outcome === "unresolved"
      ? { error: "delivery_unresolved", deliveryId }
      : { deliveryId });
    return response.status;
  };

  checkpoint("acknowledge durable admission and interrupt the selected boundary");
  report.initialStatus = await post(initial.origin, "accepted");
  const readyPath = afterProviderPrompt ? providerProgress : witnessPath;
  for (let i = 0; !FS.existsSync(readyPath) && i < 300; i++) await delay(50, undefined, { signal: abort.signal });
  let promptSha256: string;
  if (afterProviderPrompt) {
    Assert.equal(FS.readFileSync(readyPath, "utf8"), "prompt-observed\n");
    const { delivery } = await client.rpc((rpc) => rpc[WS_METHODS.scheduledTasksGetWebhookDelivery]({
      id: task.id, deliveryId, acceptAnyOutcome: true,
    }));
    Assert.ok(delivery.renderedPrompt?.includes(marker));
    promptSha256 = hash(delivery.renderedPrompt);
    const active = await client.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }));
    Assert.equal(active.runs.length, 1);
    Assert.ok(!["completed", "failed", "cancelled", "interrupted"].includes(active.runs[0]!.status));
    report.providerProgressReceived = true;
  } else {
    const witness = JSON.parse(FS.readFileSync(witnessPath, "utf8"));
    Assert.equal(witness.deliveryId, deliveryId);
    Assert.equal(witness.admissionCommitted, true);
    Assert.equal(witness.workerClaimCommitted, boundary !== "before-claim");
    Assert.equal(witness.dispatchCommitted, boundary === "after-dispatch");
    Assert.match(witness.promptSha256, /^[0-9a-f]{64}$/u);
    promptSha256 = witness.promptSha256;
  }
  const exit = await initial.stop("SIGKILL");
  owned = undefined;
  Assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
  report.processExit = exit;
  const promptsBeforeReopen = promptsObserved();
  if (afterProviderPrompt) Assert.equal(promptsBeforeReopen, 1);
  else Assert.ok(promptsBeforeReopen <= (boundary === "after-dispatch" ? 1 : 0));

  const expectedRunCount = boundary === "after-claim" ? 0 : 1;
  const expectedTaskStatus = boundary === "after-claim" ? "failed" : "succeeded";
  checkpoint("reopen without the gate and settle the durable delivery");
  const reopened = await start("reopened");
  const resumed = await authenticatePackagedServer(reopened, abort.signal);
  const settled = await resumed.rpc((rpc) => rpc[WS_METHODS.scheduledTasksSubscribe]({}).pipe(
    Stream.map(({ tasks }) => tasks.find(({ id }) => id === task.id)),
    Stream.filter((candidate) => candidate !== undefined &&
      candidate.runCount === expectedRunCount &&
      (boundary === "after-dispatch" || afterProviderPrompt || candidate.lastRunStatus === expectedTaskStatus)),
    Stream.runHead,
  ));
  Assert.ok(Option.isSome(settled) && settled.value);
  const retryOutcome = boundary === "after-claim" ? "unresolved" : "duplicate";
  report.retryStatuses = await Promise.all([post(reopened.origin, retryOutcome), post(reopened.origin, retryOutcome)]);
  const { delivery } = await resumed.rpc((rpc) => rpc[WS_METHODS.scheduledTasksGetWebhookDelivery]({
    id: task.id, deliveryId, acceptAnyOutcome: true,
  }));
  if (boundary !== "after-claim") {
    Assert.equal(delivery.outcome, "accepted");
    Assert.equal(delivery.error, null);
  } else {
    Assert.equal(delivery.outcome, "dispatch_failed");
    Assert.equal(delivery.error, "Dispatch could not be confirmed. This delivery will not run again automatically.");
    Assert.equal(settled.value.lastRunError, delivery.error);
  }
  Assert.ok(delivery.renderedPrompt?.includes(marker));
  Assert.equal(hash(delivery.renderedPrompt), promptSha256);

  checkpoint("verify the thread matches the durable delivery disposition");
  const readProjection = () => resumed.rpc((rpc) => rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }));
  let final = await readProjection();
  if (boundary === "before-claim") {
    for (let i = 0; final.runs[0]?.status !== "completed" && i < 40; i++) {
      await delay(250, undefined, { signal: abort.signal });
      final = await readProjection();
    }
    Assert.equal(final.runs[0]?.status, "completed");
    Assert.ok(final.messages.some((message) => message.role === "assistant" && message.text.includes("todo list fixture complete")));
  }
  if (boundary === "after-claim") {
    Assert.deepEqual(final.messages, []);
  } else {
    const user = final.messages.filter((message) => message.role === "user");
    Assert.equal(user.length, 1);
    Assert.equal(user[0]!.id, `scheduled-task-message:${task.id}:webhook:${deliveryId}`);
    Assert.equal(user[0]!.scheduledTaskId, task.id);
    Assert.equal(user[0]!.text, delivery.renderedPrompt);
    Assert.equal(final.runs[0]?.userMessageId, user[0]!.id);
  }
  Assert.equal(final.runs.length, expectedRunCount);
  if (afterProviderPrompt) {
    Assert.ok(["failed", "cancelled", "interrupted"].includes(final.runs[0]!.status));
    report.reopenedRunStatus = final.runs[0]!.status;
  }
  const promptsAfterReopen = promptsObserved();
  Assert.equal(promptsAfterReopen, boundary === "before-claim" ? 1 : promptsBeforeReopen);
  report.providerPrompts = { beforeReopen: promptsBeforeReopen, afterReopen: promptsAfterReopen };
  Assert.ok(FS.lstatSync(database).isFile());
  assertNoApplicationSqlite(baseDir);
  report.durableDelivery = {
    deliveryId, outcome: delivery.outcome, runCount: expectedRunCount, promptSha256,
  };
  report.status = "passed";
} catch (error) {
  const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.failure = webhookPath ? details.replaceAll(webhookPath, "[REDACTED]") : details;
  report.status = "failed";
  process.exitCode = 1;
} finally {
  try {
    await owned?.stop();
    if (scratch) FS.rmSync(scratch, { recursive: true, force: true });
    report.fixtureRemoved = scratch !== undefined && !FS.existsSync(scratch);
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  write(Path.join(proof, "proof.json"), report);
  if (report.status !== "passed") console.error(report.failure ?? report.cleanupFailure);
}
