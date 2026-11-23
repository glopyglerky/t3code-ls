// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off globalTimers:off - synthetic loopback/process transport fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => { throw new Error("The Rust bridge fixture must not load the SDK"); },
  isCursorSdkError: () => false,
}));

const executable = process.env.T3_CODE_LS_CURSOR_BRIDGE_EXECUTABLE;
const recording = NodeFS.readFileSync(new URL(
  "../../../../apps/server/src/orchestration-v2/testkit/fixtures/simple/cursor_transcript.ndjson",
  import.meta.url,
), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const agentId: string = recording.find((row) => row.label === "agent.opened").frame.agentId;
const run: { id: string; result: string } = recording.find((row) => row.label === "run.completed:1").frame.result;
const prompt: string = recording.find((row) => row.label === "run.start:1").frame.message;
const wirePrompt = `${prompt}\n\n${buildRuntimeInstructions({ harness: "Cursor", model: "composer-2.5" })}`;
const deltas: string[] = recording.filter((row) => row.label === "text-delta").map((row) => row.frame.update.text);

function envelope(value: unknown, flags = 0): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

async function peer(truncated: boolean) {
  const requests: string[] = [];
  const errors: unknown[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        NodeAssert.ok(length <= 1024 * 1024);
        chunks.push(chunk);
      }
      const operation = request.url?.split("/").at(-1);
      const body = Buffer.concat(chunks);
      const message = JSON.parse(operation === "Send" ? body.subarray(5).toString("utf8") : body.toString("utf8"));
      NodeAssert.equal(request.headers["connect-protocol-version"], "1");
      requests.push(operation!);
      if (operation === "CreateAgent") {
        NodeAssert.equal(message.options.model.id, "composer-2.5");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ agentId }));
      } else if (operation === "Send") {
        NodeAssert.equal(body[0], 0);
        NodeAssert.equal(body.readUInt32BE(1), body.length - 5);
        NodeAssert.deepEqual(message, { agentId, message: { text: wirePrompt }, options: { enableDeltas: true } });
        response.setHeader("content-type", "application/connect+json");
        for (const text of deltas) {
          const frame = envelope({ interactionUpdate: { type: "text-delta", update: { type: "text-delta", text } } });
          // Split headers and payloads across writes before the terminal result.
          for (let start = 0; start < frame.length; start += 7) response.write(frame.subarray(start, start + 7));
        }
        if (!truncated) {
          response.write(envelope({ result: { agentId, runId: run.id, status: 3, result: { result: run.result } } }));
          response.write(envelope({ done: { agentId, runId: run.id } }));
          response.write(envelope({}, 2));
        }
        response.end();
      } else {
        NodeAssert.equal(operation, "CloseAgent");
        NodeAssert.deepEqual(message, { agentId });
        response.setHeader("content-type", "application/json");
        response.end("{}");
      }
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  NodeAssert.ok(address !== null && typeof address !== "string");
  return {
    endpoint: `127.0.0.1:${address.port}`,
    requests,
    errors,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runner(endpoint: string, receivedText: string[]): CursorAgentSdk.CursorAgentSdkRunner["Service"] {
  return {
    assertComplete: Effect.void,
    open: (input) => Effect.tryPromise({
      try: async () => {
        NodeAssert.equal(input.operation, "create");
        const child = NodeChildProcess.spawn(executable!, [endpoint], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
        child.stderr.resume();
        child.stdin.on("error", () => { child.kill("SIGTERM"); });
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        // Attach rejection immediately, including startup failure before the first frame.
        void exited.catch(() => undefined);
        const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        void exited.finally(() => clearTimeout(timer)).catch(() => undefined);
        child.stdin.write(`${JSON.stringify({ operation: "create", options: input.options })}\n`);
        const opened = await lines.next();
        NodeAssert.equal(opened.done, false);
        NodeAssert.deepEqual(JSON.parse(opened.value!), { version: 1, agentId });
        return cursorAgentSdkSession(child, lines, exited, receivedText);
      },
      catch: (cause) => new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "rust.open", cause }),
    }),
  };
}

function cursorAgentSdkSession(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  lines: AsyncIterator<string>,
  exited: Promise<number | null>,
  receivedText: string[],
): CursorAgentSdk.CursorAgentSdkSession {
  return {
    agentId,
    listMessages: Effect.succeed([]),
    close: Effect.sync(() => { child.stdin.end(); }),
    send: (input) => Effect.sync(() => {
      NodeAssert.equal(input.summarize, false);
      NodeAssert.equal(input.message, wirePrompt);
      child.stdin.end(`${JSON.stringify({ operation: "send", text: input.message })}\n`);
      return {
        agentId,
        // The controlled recording fixes the native run identity before dispatch.
        runId: run.id,
        cancel: Effect.sync(() => { child.kill("SIGTERM"); }),
        wait: Effect.tryPromise({
          try: async () => {
            let result: { id: string; status: "finished"; result: string } | undefined;
            for (let line = await lines.next(); !line.done; line = await lines.next()) {
              const frame = JSON.parse(line.value);
              NodeAssert.equal(frame.version, 1);
              if (typeof frame.text === "string") {
                NodeAssert.equal(result, undefined);
                receivedText.push(frame.text);
                if (input.onDelta) await Effect.runPromise(input.onDelta({ type: "text-delta", text: frame.text }));
              } else {
                NodeAssert.equal(result, undefined);
                NodeAssert.deepEqual(frame.result, { id: run.id, status: "finished", result: run.result });
                result = frame.result;
              }
            }
            NodeAssert.equal(await exited, 0);
            NodeAssert.ok(result);
            return { ...result, requestId: "fixture-request", model: { id: "composer-2.5" }, durationMs: 1 };
          },
          catch: (cause) => new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "rust.send", cause }),
        }),
      };
    }),
  };
}

describe.skipIf(!executable)("Cursor adapter through the Rust Connect host", () => {
  it.effect.each([false, true])("preserves the recorded simple turn, truncated=%s", (truncated) =>
    Effect.gen(function* () {
      const bridge = yield* Effect.acquireRelease(Effect.promise(() => peer(truncated)), (peer) => Effect.promise(peer.close));
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-rust-adapter-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-rust-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const receivedText: string[] = [];
      const adapter = yield* makeCursorAdapterV2({ instanceId, environment: { HOME: workspace } }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, runner(bridge.endpoint, receivedText)),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-rust-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-rust-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-rust-attempt"),
        rootNodeId: NodeId.make("cursor-rust-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-rust-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Rust bridge fixture",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-rust-message"),
          createdBy: "user",
          creationSource: "web",
          text: prompt,
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.status, truncated ? "failed" : "completed");
      const messages = events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant" ? [event.message.text] : [],
      );
      assert.equal(messages.at(-1), run.result);
      assert.deepEqual(receivedText, deltas);
      assert.equal(new Set(events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant" ? [event.message.id] : [],
      )).size, 1);
      assert.deepEqual(bridge.requests, ["CreateAgent", "Send", "CloseAgent"]);
      assert.deepEqual(bridge.errors, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer)),
    ),
  );
});
