// @effect-diagnostics nodeBuiltinImport:off -- spawns only the Cargo fixture executable
import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkQueryRunnerShape,
} from "./ClaudeAdapterV2.ts";

type FixtureEvent =
  | readonly ["message" | "background", SDKMessage]
  | readonly [
      "permission",
      readonly [
        number,
        {
          readonly tool_name: string;
          readonly input: Record<string, unknown>;
          readonly tool_use_id: string;
        },
      ],
    ]
  | readonly ["withdrawn", number]
  | readonly ["interrupted", string];

const failure = (method: string, cause: unknown) =>
  new ClaudeAgentSdkQueryRunnerError({ method, cause });

export function makeClaudeStdioFixture(executable: string, directory: string) {
  if (!isAbsolute(executable) || !/^claude_stdio_host-[a-f0-9]+$/.test(basename(executable))) {
    throw new Error("Use the absolute Cargo claude_stdio_host test executable path.");
  }

  const child = spawn(executable, ["--adapter-bridge"], {
    cwd: directory,
    env: { TMPDIR: directory },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const exit = new Promise<Error | number | null>((resolve) => {
    child.once("error", resolve);
    child.once("close", resolve);
  });
  // Keep broken pipes on the same failure path as an absent reply.
  child.stdin.on("error", () => {});

  const readReply = async () => {
    const line = await output.next();
    if (line.done) throw new Error("Rust fixture closed before replying.");
    return JSON.parse(line.value) as unknown;
  };
  const ready = readReply();
  let tail = ready.then(
    () => {},
    () => {},
  );
  let closing: Promise<void> | undefined;

  const command = <Frame extends { readonly type: string }>(frame: Frame) => {
    const reply = tail.then(async () => {
      child.stdin.write(JSON.stringify(frame) + "\n");
      return readReply();
    });
    tail = reply.then(
      () => {},
      () => {},
    );
    return reply;
  };

  const close = () =>
    (closing ??= tail.then(async () => {
      child.stdin.end();
      const status = await exit;
      if (status !== 0) throw new Error(`Rust fixture exit: ${status}`);
    }));

  const backgroundHandled = Promise.withResolvers<void>();
  const approvals = new Map<number, AbortController>();
  const decisions: Promise<unknown>[] = [];
  let approvalFailure: Error | undefined;
  let pendingInterrupt:
    | {
        readonly id: Promise<unknown>;
        readonly complete: (id: string) => void;
      }
    | undefined;
  let opened = false;
  const unsupported = (method: string) =>
    Effect.fail(failure(method, new Error("Outside the Claude stdio fixture profile.")));

  const runner: ClaudeAgentSdkQueryRunnerShape = {
    allocateSessionId: Effect.succeed("fixture"),
    open: ({ options }) =>
      Effect.tryPromise({
        try: async () => {
          const permit = options.canUseTool;
          if (
            opened ||
            options.sessionId !== "fixture" ||
            options.permissionMode !== "default" ||
            permit === undefined ||
            (await ready) !== "ready"
          ) {
            throw new Error("Expected a fresh approval-required Claude fixture session.");
          }
          opened = true;
          const messages = async function* () {
            while (closing === undefined) {
              if (approvalFailure !== undefined) throw approvalFailure;
              // The Rust test executable owns these bounded replies and their schema.
              const event = (await command({ type: "pull" })) as FixtureEvent | null;
              if (event === null) continue;
              switch (event[0]) {
                case "background":
                  yield event[1];
                  backgroundHandled.resolve();
                  break;
                case "message":
                  yield event[1];
                  break;
                case "permission": {
                  const [ticket, request] = event[1];
                  const controller = new AbortController();
                  approvals.set(ticket, controller);
                  const decide = { type: "permission", ticket };
                  decisions.push(
                    permit(request.tool_name, request.input, {
                      signal: controller.signal,
                      toolUseID: request.tool_use_id,
                      requestId: String(ticket),
                    })
                      .then((decision) => command({ ...decide, decision }))
                      .catch((cause: unknown) => {
                        approvalFailure = new Error("Rust fixture approval failed.", { cause });
                      })
                      .finally(() => approvals.delete(ticket)),
                  );
                  break;
                }
                case "withdrawn": {
                  const controller = approvals.get(event[1]);
                  if (controller === undefined) throw new Error("Unknown approval withdrawal.");
                  controller.abort();
                  break;
                }
                case "interrupted": {
                  const request = pendingInterrupt;
                  if (request === undefined || (await request.id) !== event[1]) {
                    throw new Error("Unexpected Rust interrupt response.");
                  }
                  pendingInterrupt = undefined;
                  request.complete(event[1]);
                  break;
                }
              }
            }
          };
          return {
            messages: Stream.fromAsyncIterable(messages(), (cause) => failure("messages", cause)),
            offer: (message, onQueued) =>
              Effect.tryPromise({
                try: () => command(message),
                catch: (cause) => failure("offer", cause),
              }).pipe(
                Effect.tap(() => Effect.sync(() => onQueued?.())),
                Effect.asVoid,
              ),
            interrupt: Effect.tryPromise({
              try: async () => {
                if (pendingInterrupt !== undefined) throw new Error("Interrupt already pending.");
                const done = Promise.withResolvers<string>();
                const id = command({ type: "interrupt" });
                pendingInterrupt = { id, complete: done.resolve };
                await id;
                await done.promise;
              },
              catch: (cause) => failure("interrupt", cause),
            }),
            close: Effect.tryPromise({ try: close, catch: (cause) => failure("close", cause) }),
            setModel: () => unsupported("setModel"),
            applyFlagSettings: () => unsupported("applyFlagSettings"),
            setPermissionMode: () => unsupported("setPermissionMode"),
            stopTask: () => unsupported("stopTask"),
            backgroundTasks: () => unsupported("backgroundTasks"),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => unsupported("readMcpResource"),
            callMcpTool: () => unsupported("callMcpTool"),
            listPermissionRules: Effect.succeed([]),
          };
        },
        catch: (cause) => failure("open", cause),
      }),
    forkSession: () => unsupported("forkSession"),
    subagentLaunchToolUseId: () => unsupported("subagentLaunchToolUseId"),
    subagentModel: () => unsupported("subagentModel"),
    assertComplete: Effect.void,
  };
  return { runner, close, backgroundHandled: backgroundHandled.promise, decisions };
}
