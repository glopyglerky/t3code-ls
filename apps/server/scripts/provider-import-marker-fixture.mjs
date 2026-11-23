// Copied into a synthetic profile with an absolute Node shebang by the proof.
// The production helper starts with an empty environment, so use a sidecar.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";

const config = JSON.parse(FS.readFileSync(new URL("./native-relay.json", import.meta.url), "utf8"));
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

const projectionTransactions = new Set();
let projectionCommitted = false;
const record = (entry) => FS.appendFileSync(config.trace, JSON.stringify(entry) + "\n");

try {
  for await (const line of input) {
    const request = JSON.parse(line);
    const transactionId = request.transaction_id;
    const isTargetMarker =
      request.operation === "application_runtime_state_write" &&
      request.request.kind === "runtime_import" &&
      request.request.thread_id === config.threadId &&
      JSON.parse(request.request.source).filePath === config.rollout;

    if (isTargetMarker && !FS.existsSync(config.fault)) {
      Assert.ok(projectionCommitted, "The exact import projection must commit before the fault");
      // This one request never reaches omdb. The caller receives a definite
      // rejection and can roll back its marker transaction as usual.
      const rejection = {
        ok: false,
        error: { kind: "invalid_request", message: "synthetic import marker refusal" },
      };
      FS.writeFileSync(
        config.fault,
        JSON.stringify({
          transactionId,
          source: JSON.parse(request.request.source),
          nativeRequestForwarded: false,
          rejection,
        }) + "\n",
        { flag: "wx" },
      );
      record({ operation: "refused-runtime-import", transactionId });
      process.stdout.write(JSON.stringify(rejection) + "\n");
      continue;
    }

    child.stdin.write(line + "\n");
    const reply = await replies.next();
    Assert.ok(!reply.done, "Native helper exited before replying");
    const envelope = JSON.parse(reply.value);
    if (
      request.operation === "application_events_append" &&
      request.row.stream_id === config.threadId &&
      envelope.ok
    ) {
      projectionTransactions.add(transactionId);
      record({
        operation: request.operation,
        transactionId,
        eventId: request.row.event_id,
        sequence: envelope.result.sequence,
      });
    }
    if (projectionTransactions.has(transactionId) && request.operation === "application_commit") {
      projectionCommitted = envelope.ok === true && envelope.result.committed === true;
      record({ operation: request.operation, transactionId, committed: projectionCommitted });
      projectionTransactions.delete(transactionId);
    }
    if (
      request.operation === "application_runtime_state_write" &&
      request.request.kind === "runtime_recover_import" &&
      request.request.runtime.threadId === config.threadId
    ) {
      record({
        operation: "runtime_recover_import",
        source: JSON.parse(request.request.source),
        messages: request.request.messages,
        receipt: envelope,
      });
    }
    process.stdout.write(reply.value + "\n");
  }
} finally {
  stop();
  output.close();
  process.exitCode = Number((await exited) !== 0);
}
