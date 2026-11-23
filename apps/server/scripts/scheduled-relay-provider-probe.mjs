import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Readline from "node:readline";
import { once } from "node:events";

const [replay, witness, progress] = process.argv.slice(2);
Assert.ok(replay && witness && process.argv.length <= 5);
const peer = ChildProcess.spawn(process.execPath, [replay], { stdio: ["pipe", "pipe", "inherit"] });
const closed = once(peer, "close");
const input = Readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const output = Readline.createInterface({ input: peer.stdout, crlfDelay: Infinity });
let promptRequestId;
let recordedProgress = false;
peer.once("exit", () => input.close());
const forwardResponses = (async () => {
  for await (const line of output) {
    if (progress !== undefined && promptRequestId !== undefined) {
      const message = JSON.parse(line);
      if (message.id === promptRequestId && message.method === undefined) continue;
      if (!recordedProgress && message.method === "session/update" &&
        message.params?.update?.sessionUpdate === "agent_message_chunk") {
        const staged = progress + ".tmp";
        FS.writeFileSync(staged, "prompt-observed\n", { flag: "wx", mode: 0o600 });
        FS.renameSync(staged, progress);
        recordedProgress = true;
      }
    }
    if (!process.stdout.write(line + "\n")) await once(process.stdout, "drain");
  }
})();
try {
  for await (const line of input) {
    const message = JSON.parse(line);
    if (message.method === "session/prompt") {
      promptRequestId = message.id;
      FS.appendFileSync(witness, "prompt\n");
    }
    if (!peer.stdin.write(line + "\n")) await once(peer.stdin, "drain");
  }
} finally {
  peer.stdin.end();
  input.close();
}
await forwardResponses;
const [code] = await closed;
process.exitCode = code ?? 1;
