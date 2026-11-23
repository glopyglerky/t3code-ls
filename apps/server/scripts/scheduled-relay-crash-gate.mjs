// The verifier copies this beside its private configuration and adds a Node shebang.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";

const config = JSON.parse(FS.readFileSync(new URL("./relay-crash-gate.json", import.meta.url), "utf8"));
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
const admit = { transaction: undefined, promptHash: undefined, committed: false };

try {
  for await (const line of input) {
    const request = JSON.parse(line);
    const mutation = request.operation === "application_scheduled_write" ? request.mutation : undefined;
    if (
      mutation?.kind === "patch_pending" && mutation.delivery_id === config.deliveryId &&
      mutation.patch.state === "relay_running"
    ) {
      Assert.ok(admit.committed && admit.promptHash, "The exact ready delivery must be committed");
      FS.writeFileSync(config.witness, JSON.stringify({
        deliveryId: config.deliveryId,
        promptSha256: admit.promptHash,
        admissionCommitted: true,
        workerTransitionForwarded: false,
      }) + "\n", { flag: "wx", mode: 0o600 });
      // Hold the worker before its first native state change until the verifier kills the group.
      if (!input.closed) await new Promise((resolve) => input.once("close", resolve));
      break;
    }

    child.stdin.write(line + "\n");
    const reply = await replies.next();
    Assert.ok(!reply.done, "Native helper exited before replying");
    if (mutation?.kind === "insert_ready_relay" && mutation.delivery_id === config.deliveryId) {
      Assert.equal(JSON.parse(reply.value).ok, true, "The helper rejected ready admission");
      admit.transaction = request.transaction_id;
      admit.promptHash = Crypto.createHash("sha256").update(JSON.parse(mutation.prompt_json)).digest("hex");
    }
    if (request.operation === "application_commit" && request.transaction_id === admit.transaction) {
      const envelope = JSON.parse(reply.value);
      admit.committed = envelope.ok === true && envelope.result.committed === true;
    }
    process.stdout.write(reply.value + "\n");
  }
} finally {
  stop();
  output.close();
  process.exitCode = Number((await exited) !== 0);
}
