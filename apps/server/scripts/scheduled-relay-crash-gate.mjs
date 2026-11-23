// The verifier copies this beside its private configuration and adds a Node shebang.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";

const config = JSON.parse(FS.readFileSync(new URL("./relay-crash-gate.json", import.meta.url), "utf8"));
Assert.ok([
  "before-claim", "after-claim", "after-dispatch", "after-fresh-message", "after-fresh-start",
].includes(config.boundary));
const afterFreshMessage = config.boundary === "after-fresh-message";
const afterFreshStart = config.boundary === "after-fresh-start";
const freshLaunch = afterFreshMessage || afterFreshStart;
const [mode, target] = process.argv.slice(2);
Assert.equal(process.argv.length, 4);
if (mode === "owner-lock") {
  Assert.equal(target, Path.join(Path.dirname(config.database), "server-owner.sqlite"));
} else {
  Assert.ok(["initialize-local", "local", "read-only-local", "exclusive-local"].includes(mode));
  Assert.equal(target, config.database);
}

const child = ChildProcess.spawn(config.executable, [mode, target], {
  env: {},
  stdio: ["pipe", "pipe", "inherit"],
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const input = Readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const output = Readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const replies = output[Symbol.asyncIterator]();
const stop = () => {
  input.close();
  process.stdin.destroy();
  child.stdin.end();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.once("exit", stop);
const admit = { transaction: undefined, commandId: undefined, promptHash: undefined, committed: false };
let workerTransaction;
let workerClaimCommitted = false;
let dispatchTransaction;
let dispatchCommitted = false;
let launchThreadId;
let startTransaction;
let startSettled = false;
let completionSuppressed = false;
const publishWitness = () => {
  Assert.ok(admit.committed && admit.promptHash, "The exact ready delivery must be committed");
  const temporary = config.witness + ".tmp";
  FS.writeFileSync(temporary, JSON.stringify({
    deliveryId: config.deliveryId,
    promptSha256: admit.promptHash,
    admissionCommitted: true,
    workerClaimCommitted,
    dispatchCommitted,
    ...(freshLaunch ? { launchThreadId, startSettled, completionSuppressed } : {}),
  }) + "\n", { flag: "wx", mode: 0o600 });
  FS.renameSync(temporary, config.witness);
  if (!afterFreshStart && !input.closed) {
    return new Promise((resolve) => input.once("close", resolve));
  }
};

try {
  for await (const line of input) {
    const request = JSON.parse(line);
    const mutation = request.operation === "application_scheduled_write" ? request.mutation : undefined;
    const claimsDelivery =
      mutation?.kind === "patch_pending" && mutation.delivery_id === config.deliveryId &&
      mutation.patch.state === "relay_running";
    if (claimsDelivery && config.boundary === "before-claim") {
      await publishWitness();
      break;
    }
    const completesDelivery =
      mutation?.kind === "patch_task" &&
      mutation.expected?.last_run_webhook_delivery_id === config.deliveryId &&
      mutation.patch.last_run_status === "succeeded";
    if (completesDelivery && config.boundary === "after-dispatch") {
      Assert.ok(workerClaimCommitted && dispatchCommitted, "Command acceptance must already be committed");
      await publishWitness();
      break;
    }
    if (completesDelivery && afterFreshStart) {
      Assert.ok(workerClaimCommitted && dispatchCommitted && launchThreadId);
      Assert.equal(completionSuppressed, false);
      // Simulate losing the scheduler's compare-and-set while letting the real start effect settle.
      completionSuppressed = true;
      process.stdout.write(JSON.stringify({ ok: true, result: [] }) + "\n");
      if (startSettled) publishWitness();
      continue;
    }

    child.stdin.write(line + "\n");
    const reply = await replies.next();
    Assert.ok(!reply.done, "Native helper exited before replying");
    if (mutation?.kind === "insert_ready_relay" && mutation.delivery_id === config.deliveryId) {
      Assert.equal(JSON.parse(reply.value).ok, true, "The helper rejected ready admission");
      admit.transaction = request.transaction_id;
      admit.commandId = `scheduled-task:${mutation.task_id}:webhook:${config.deliveryId}`;
      admit.promptHash = Crypto.createHash("sha256").update(JSON.parse(mutation.prompt_json)).digest("hex");
    }
    if (request.operation === "application_commit" && request.transaction_id === admit.transaction) {
      const envelope = JSON.parse(reply.value);
      admit.committed = envelope.ok === true && envelope.result.committed === true;
    }
    if (claimsDelivery) {
      Assert.equal(JSON.parse(reply.value).ok, true, "The helper rejected the worker claim");
      Assert.equal(typeof request.transaction_id, "string");
      workerTransaction = request.transaction_id;
    }
    if (request.operation === "application_commit" && request.transaction_id === workerTransaction) {
      const envelope = JSON.parse(reply.value);
      Assert.ok(envelope.ok === true && envelope.result.committed === true);
      workerClaimCommitted = true;
      if (config.boundary === "after-claim") {
        await publishWitness();
        break;
      }
    }
    if (["application_receipts_insert", "application_receipts_upsert"].includes(request.operation)) {
      const receipt = request.receipt;
      if (freshLaunch && receipt.command_id === admit.commandId && receipt.command_type === "thread.create" &&
          receipt.status === "accepted") {
        launchThreadId = receipt.thread_id;
      }
      const dispatchId = freshLaunch ? `${admit.commandId}:initial-message` : admit.commandId;
      if (receipt.command_id === dispatchId && receipt.command_type === "message.dispatch" &&
          receipt.status === "accepted") {
        Assert.equal(JSON.parse(reply.value).ok, true, "The helper rejected the dispatch receipt");
        Assert.equal(typeof request.transaction_id, "string");
        if (freshLaunch) Assert.equal(receipt.thread_id, launchThreadId);
        dispatchTransaction = request.transaction_id;
      }
    }
    if (request.operation === "application_commit" && request.transaction_id === dispatchTransaction) {
      const envelope = JSON.parse(reply.value);
      dispatchCommitted = envelope.ok === true && envelope.result.committed === true;
      if (afterFreshMessage) {
        Assert.ok(workerClaimCommitted && dispatchCommitted && launchThreadId);
        await publishWitness();
        break;
      }
    }
    if (
      afterFreshStart && admit.commandId !== undefined &&
      request.operation === "application_outbox_succeed" &&
      request.effect_id.startsWith(`effect:${admit.commandId}:release:provider-turn.start:`)
    ) {
      Assert.deepEqual(JSON.parse(reply.value), { ok: true, result: true });
      Assert.equal(typeof request.transaction_id, "string");
      startTransaction = request.transaction_id;
    }
    if (request.operation === "application_commit" && request.transaction_id === startTransaction &&
        startTransaction !== undefined) {
      const envelope = JSON.parse(reply.value);
      Assert.ok(envelope.ok === true && envelope.result.committed === true);
      startSettled = true;
      if (completionSuppressed) publishWitness();
    }
    const query = request.query;
    if (
      afterFreshStart && request.operation === "application_scheduled_read" &&
      query.kind === "pending" && query.states?.includes("relay_ready") &&
      query.states.includes("relay_running")
    ) {
      // Leave the running row on disk for the restarted process to reconcile.
      const envelope = JSON.parse(reply.value);
      if (envelope.ok === true) {
        envelope.result = envelope.result.filter((row) =>
          row.delivery_id !== config.deliveryId || row.state !== "relay_running");
        process.stdout.write(JSON.stringify(envelope) + "\n");
        continue;
      }
    }
    process.stdout.write(reply.value + "\n");
  }
} finally {
  stop();
  output.close();
  process.exitCode = Number((await exited) !== 0);
}
