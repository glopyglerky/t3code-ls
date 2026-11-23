// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - synthetic loopback/process transport fixture.
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
import * as Option from "effect/Option";
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

async function peer(mode: "complete" | "truncated" | "cancel" | "wrong-run") {
  let arrived!: () => void;
  const sending = new Promise<void>((resolve) => { arrived = resolve; });
  let finish!: () => void;
  const cancelled = new Promise<void>((resolve) => { finish = resolve; });
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
        arrived();
        const interrupt = mode === "cancel" || mode === "wrong-run";
        if (interrupt) await cancelled;
        const terminalId = mode === "wrong-run" ? "unrelated-run" : run.id;
        if (mode !== "truncated") {
          response.write(envelope({ result: { agentId, runId: terminalId, status: interrupt ? 5 : 3, result: { result: run.result } } }));
          response.write(envelope({ done: { agentId, runId: terminalId } }));
          response.write(envelope({}, 2));
        }
        response.end();
      } else if (operation === "CancelRun") {
        NodeAssert.deepEqual(message, { agentId, runId: run.id });
        response.setHeader("content-type", "application/json");
        response.end("{}");
        finish();
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
    sending,
    requests,
    errors,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runner(endpoint: string, receivedText: string[], outcomes: string[], children: NodeChildProcess.ChildProcessWithoutNullStreams[]): CursorAgentSdk.CursorAgentSdkRunner["Service"] {
  return {
    assertComplete: Effect.void,
    open: (input) => Effect.tryPromise({
      try: async () => {
        NodeAssert.equal(input.operation, "create");
        const child = NodeChildProcess.spawn(executable!, [endpoint], {
          env: {},
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
          killSignal: "SIGKILL",
        });
        children.push(child);
        child.stderr.resume();
        child.stdin.on("error", () => { child.kill("SIGTERM"); });
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        // Attach rejection immediately, including startup failure before the first frame.
        void exited.catch(() => undefined);
        const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        child.stdin.write(`${JSON.stringify({ operation: "create", options: input.options })}\n`);
        const opened = await lines.next();
        NodeAssert.equal(opened.done, false);
        NodeAssert.deepEqual(JSON.parse(opened.value!), { version: 1, agentId });
        return cursorAgentSdkSession(child, lines, exited, receivedText, endpoint, outcomes, children);
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
  endpoint: string,
  outcomes: string[],
  children: NodeChildProcess.ChildProcessWithoutNullStreams[],
): CursorAgentSdk.CursorAgentSdkSession {
  return {
    agentId,
    listMessages: Effect.succeed([]),
    close: Effect.promise(async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }),
    send: (input) => Effect.sync(() => {
      NodeAssert.equal(input.summarize, false);
      NodeAssert.equal(input.message, wirePrompt);
      child.stdin.end(`${JSON.stringify({ operation: "send", text: input.message })}\n`);
      return {
        agentId,
        // The controlled recording fixes the native run identity before dispatch.
        runId: run.id,
        cancel: Effect.tryPromise({
          try: async () => {
            const cancellation = NodeChildProcess.spawn(executable!, [endpoint, "cancel", agentId, run.id], {
              env: {}, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
            });
            children.push(cancellation);
            cancellation.stdin.end();
            cancellation.stdout.resume();
            cancellation.stderr.resume();
            await new Promise<void>((resolve, reject) => {
              cancellation.once("error", reject);
              cancellation.once("close", (code) => code === 0 ? resolve() : reject(new Error("CancelRun failed")));
            });
          },
          catch: (cause) => new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "rust.cancel", cause }),
        }),
        wait: Effect.tryPromise({
          try: async () => {
            let result: { id: string; status: "finished" | "cancelled"; result: string } | undefined;
            for (let line = await lines.next(); !line.done; line = await lines.next()) {
              const frame = JSON.parse(line.value);
              NodeAssert.equal(frame.version, 1);
              if (typeof frame.text === "string") {
                NodeAssert.equal(result, undefined);
                receivedText.push(frame.text);
                if (input.onDelta) await Effect.runPromise(input.onDelta({ type: "text-delta", text: frame.text }));
              } else {
                NodeAssert.equal(result, undefined);
                // A matching result/done pair from a different run is still invalid.
                NodeAssert.equal(frame.result.id, run.id);
                NodeAssert.ok(frame.result.status === "finished" || frame.result.status === "cancelled");
                NodeAssert.equal(frame.result.result, run.result);
                result = frame.result;
              }
            }
            NodeAssert.equal(await exited, 0);
            NodeAssert.ok(result);
            outcomes.push(result.status);
            return { ...result, requestId: "fixture-request", model: { id: "composer-2.5" }, durationMs: 1 };
          },
          catch: (cause) => new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "rust.send", cause }),
        }),
      };
    }),
  };
}

describe.skipIf(!executable)("Cursor adapter through the Rust Connect host", () => {
  it.effect.each(["complete", "truncated", "cancel", "wrong-run"] as const)("preserves the controlled turn, mode=%s", (mode) =>
    Effect.gen(function* () {
      const bridge = yield* Effect.acquireRelease(Effect.promise(() => peer(mode)), (peer) => Effect.promise(peer.close));
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
      const outcomes: string[] = [];
      const children: NodeChildProcess.ChildProcessWithoutNullStreams[] = [];
      const adapter = yield* makeCursorAdapterV2({ instanceId, environment: { HOME: workspace } }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, runner(bridge.endpoint, receivedText, outcomes, children)),
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
      const interrupted = mode === "cancel" || mode === "wrong-run";
      if (interrupted) {
        // This resolves only after the real Rust Send request reaches the loopback peer.
        yield* Effect.promise(() => bridge.sending);
        const started = Option.getOrThrow(yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"), Stream.runHead,
        ));
        assert(started.type === "provider_turn.updated");
        yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      }
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      yield* Effect.promise(() => Promise.all(children.map((child) =>
        child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
          new Promise<void>((resolve) => { child.once("close", () => resolve()); }),
      )));
      const lateTerminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"), Stream.runHead,
        Effect.timeoutOption("50 millis"),
      );
      assert.ok(Option.isNone(lateTerminal));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.status, interrupted ? "interrupted" : mode === "truncated" ? "failed" : "completed");
      const messages = events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant" ? [event.message.text] : [],
      );
      assert.equal(messages.at(-1), run.result);
      assert.deepEqual(receivedText, deltas);
      assert.equal(new Set(events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant" ? [event.message.id] : [],
      )).size, 1);
      assert.deepEqual(outcomes, mode === "cancel" ? ["cancelled"] : mode === "complete" ? ["finished"] : []);
      assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
      assert.deepEqual(bridge.requests, interrupted ? ["CreateAgent", "Send", "CancelRun", "CloseAgent"] : ["CreateAgent", "Send", "CloseAgent"]);
      assert.deepEqual(bridge.errors, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer)),
    ),
  );
});
