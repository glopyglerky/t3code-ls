import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";

const [replay, log] = process.argv.slice(2);
if (!replay || !log) throw new Error("Expected the frozen replay and fixture trace path");
const mark = (phase) => appendFileSync(log, JSON.stringify({ phase, millis: Date.now(), pid: process.pid }) + "\n");
mark("spawn");
const child = spawn(process.execPath, [replay], { stdio: ["pipe", "pipe", "inherit"] });
const stopped = once(child, "close");
const inputs = createInterface({ input: process.stdin, crlfDelay: Infinity });
const outputs = createInterface({ input: child.stdout, crlfDelay: Infinity });
let prompt;
let first = false;
let assistantText = "";
let prefix = false;

await Promise.all([
  (async () => {
    try {
      for await (const line of inputs) {
        const request = JSON.parse(line);
        if (request.method === "initialize") mark("initialize");
        if (request.method === "session/new") mark("session_new");
        if (request.method === "session/prompt") {
          prompt = request.id;
          mark("prompt");
        }
        if (!child.stdin.write(line + "\n")) await once(child.stdin, "drain");
      }
    } finally {
      child.stdin.end();
    }
  })(),
  (async () => {
    for await (const line of outputs) {
      const frame = JSON.parse(line);
      if (prompt !== undefined) {
        if (!first && frame.method === "session/update" &&
          frame.params?.update?.sessionUpdate === "agent_message_chunk") {
          mark("first_chunk");
          first = true;
        }
        if (frame.method === "session/update" && frame.params?.update?.sessionUpdate === "agent_message_chunk") {
          const content = frame.params.update.content;
          if (content?.type === "text" && typeof content.text === "string") {
            assistantText = (assistantText + content.text).slice(-128);
            if (!prefix && assistantText.includes("I'll track the")) {
              mark("visible_prefix");
              prefix = true;
            }
          }
        }
        if (frame.method === undefined && frame.id === prompt) mark("prompt_result");
      }
      if (!process.stdout.write(line + "\n")) await once(process.stdout, "drain");
    }
  })(),
]);
const [code] = await stopped;
process.exitCode = code ?? 1;
