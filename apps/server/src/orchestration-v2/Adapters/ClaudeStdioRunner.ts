// @effect-diagnostics nodeBuiltinImport:off -- starts the scoped helper with a deterministic child
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkQueryOptions,
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

async function within<A>(pending: Promise<A>, milliseconds: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude stdio helper timed out.")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startHelper(executable: string, peer: string, directory: string) {
  const child = NodeChildProcess.spawn(executable, [], {
    cwd: directory,
    env: { TMPDIR: directory, T3_CLAUDE_TEST_PARENT_ONLY: "fixture" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const output = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const exit = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {});

  const exchange = async (frame: object, expected: "ready" | "ok" | "closed") => {
    child.stdin.write(JSON.stringify(frame) + "\n");
    const line = await within(output.next(), expected === "ready" ? 20_000 : 6_000);
    if (line.done) throw new Error("Claude stdio helper closed before replying.");
    let reply: { readonly type?: unknown; readonly value?: unknown } | null;
    try {
      reply = JSON.parse(line.value);
    } catch {
      throw new Error("Invalid Claude stdio helper reply.");
    }
    if (reply?.type !== expected) {
      throw new Error("Claude stdio helper refused " + expected + ".");
    }
    return reply.value;
  };

  const ready = exchange(
    {
      type: "open",
      version: 1,
      profile: "session",
      program: peer,
      cwd: directory,
      home: directory,
    },
    "ready",
  ).then((value) => {
    const receipt = value as { version?: unknown; pid?: unknown } | null;
    if (receipt?.version !== 1 || typeof receipt.pid !== "number" || receipt.pid <= 0) {
      throw new Error("Invalid Claude stdio readiness receipt.");
    }
  });
  let tail: Promise<unknown> = ready;
  const command = (frame: { readonly type: string }) => {
    const reply = tail.then(() => exchange(frame, "ok"));
    tail = reply;
    return reply;
  };

  const close = async () => {
    try {
      if (
        await tail.then(
          () => true,
          () => false,
        )
      ) {
        const status = (await exchange({ type: "close" }, "closed")) as {
          code: number | null;
          signal: number | null;
        };
        if (status.code !== 0 && status.signal !== 9) {
          throw new Error("Unexpected Claude fixture child exit.");
        }
      }
    } finally {
      child.stdin.end();
      let status: number | null;
      try {
        status = await within(exit, 6_000);
      } catch {
        child.kill("SIGTERM");
        status = await within(exit, 20_000);
      }
      if (status !== 0) throw new Error("Claude stdio helper exited unsuccessfully.");
    }
  };
  return { ready, command, close };
}

export function makeControlledClaudeStdioRunner(
  executable: string,
  peer: string,
  directory: string,
  expected: ClaudeAgentSdkQueryOptions,
) {
  if (
    !NodePath.isAbsolute(executable) ||
    NodePath.basename(executable) !== "t3-code-ls-claude-stdio"
  ) {
    throw new Error("Use the absolute t3-code-ls-claude-stdio path.");
  }
  if (
    !NodePath.isAbsolute(peer) ||
    !/^claude_stdio_host-[a-f0-9]+$/.test(NodePath.basename(peer))
  ) {
    throw new Error("Use the absolute deterministic Claude child path.");
  }

  let helper: ReturnType<typeof startHelper> | undefined;
  let closing: Promise<void> | undefined;

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
  const close = () =>
    (closing ??= (async () => {
      for (const controller of approvals.values()) controller.abort();
      await helper?.close();
    })());
  const unsupported = (method: string) =>
    Effect.fail(failure(method, new Error("Outside the Claude stdio fixture profile.")));

  const runner: ClaudeAgentSdkQueryRunnerShape = {
    allocateSessionId: Effect.succeed("fixture"),
    open: ({ options }) =>
      Effect.tryPromise({
        try: async () => {
          const { canUseTool: permit, onUserDialog, onElicitation, ...settings } = options;
          if (
            helper !== undefined ||
            closing !== undefined ||
            typeof permit !== "function" ||
            (onUserDialog !== undefined && typeof onUserDialog !== "function") ||
            (onElicitation !== undefined && typeof onElicitation !== "function")
          ) {
            throw new Error("Expected a fresh approval-required Claude fixture session.");
          }
          if (!NodeUtil.isDeepStrictEqual(settings, expected)) {
            const keys = new Set([...Object.keys(settings), ...Object.keys(expected)]);
            const differing = [...keys].filter((key) =>
              Object.hasOwn(settings, key) !== Object.hasOwn(expected, key) ||
              !NodeUtil.isDeepStrictEqual(Reflect.get(settings, key), Reflect.get(expected, key)),
            );
            // Bounded synthetic witness, names only. Never retain callback settings,
            // authenticated MCP headers or the inherited query environment.
            await NodeFS.writeFile(NodePath.join(directory, "claude-stdio-options-refused.json"),
              JSON.stringify({ version: 1, type: "options-refused", differing }) + "\n",
              { flag: "wx", mode: 0o600 });
            throw new Error(`Unsupported Claude fixture options: ${differing.join(", ")}`);
          }
          const started = startHelper(executable, peer, directory);
          helper = started;
          try {
            await started.ready;
          } catch (cause) {
            await close().catch(() => {});
            throw cause;
          }
          const command = started.command;
          const messages = async function* () {
            while (closing === undefined) {
              if (approvalFailure !== undefined) throw approvalFailure;
              // The helper owns these bounded replies and their schema.
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
                      .then((decision) => closing === undefined && command({ ...decide, decision }))
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
                try {
                  await id;
                  await within(done.promise, 6_000);
                } finally {
                  pendingInterrupt = undefined;
                }
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
