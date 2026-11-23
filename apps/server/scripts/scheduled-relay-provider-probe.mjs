import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Readline from "node:readline";
import { once } from "node:events";

const [replay, witness] = process.argv.slice(2);
Assert.ok(replay && witness && process.argv.length === 4);
const peer = ChildProcess.spawn(process.execPath, [replay], { stdio: ["pipe", "inherit", "inherit"] });
const closed = once(peer, "close");
const input = Readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
peer.once("exit", () => input.close());
try {
  for await (const line of input) {
    if (JSON.parse(line).method === "session/prompt") {
      FS.appendFileSync(witness, "prompt\n");
    }
    if (!peer.stdin.write(line + "\n")) await once(peer.stdin, "drain");
  }
} finally {
  peer.stdin.end();
  input.close();
}
const [code] = await closed;
process.exitCode = code ?? 1;
