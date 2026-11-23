// CI-only companion to the injected entry. Never imported by the normal application.
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { appAtomRegistry } from "./src/state/atom-registry";
import { environmentThreads } from "./src/state/threads";
import { createThreadOutboxDelivery } from "./src/state/threadOutboxDelivery";
import { enqueueThreadOutboxMessage, flushThreadOutbox, threadOutboxManager, encodeQueuedThreadMessage, type QueuedThreadMessage } from "./src/state/thread-outbox";
import { expoThreadOutboxStorage } from "./src/state/thread-outbox-storage";
import { selectOutboxDeliveryResolver } from "./src/native/outboxDelivery";

const threadId = ThreadId.make("t12-dispatch-thread");
const messageId = MessageId.make("t12-dispatch-message");
const commandId = CommandId.make("t12-dispatch-command");
const text = "T12 synthetic Android persisted task";
const assert = (condition: unknown): void => { if (!condition) throw new Error("Installed dispatch invariant failed"); };

export async function proveInstalledTaskDispatch(
  environmentId: EnvironmentId,
  reopen: boolean,
  control: (path: string) => Promise<unknown>,
) {
  const queues = () => Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)).flat();
  assert(await threadOutboxManager.load());
  assert(queues().length === 0);
  let cleanupFailures = 0;
  const originalRemove = expoThreadOutboxStorage.remove;
  let delivery: ReturnType<typeof createThreadOutboxDelivery> | undefined;
  let release = () => {};
  try {
    if (!reopen) {
      // The server is reachable only through the owned reverse mapping. Persist while disconnected.
      await control("/drop-dispatch");
      const message: QueuedThreadMessage = {
        environmentId, threadId, messageId, commandId, text, attachments: [], dispatchMode: "queue",
        modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
        runtimeMode: "approval-required", interactionMode: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        creation: { projectId: ProjectId.make("t12-dispatch-project"), projectTitle: "T12 synthetic project",
          workspaceMode: "local", branch: null, worktreePath: null },
      };
      await enqueueThreadOutboxMessage(message);
      await flushThreadOutbox();
      // Read the actual Expo files, independently of optimistic manager publication.
      const persisted = await expoThreadOutboxStorage.load();
      assert(persisted.errors.length === 0 && persisted.messages.length === 1);
      assert(JSON.stringify(encodeQueuedThreadMessage(persisted.messages[0]!)) === JSON.stringify(encodeQueuedThreadMessage(message)));
      await control("/assert-undispatched");
      // Fail exactly one local remove after server acceptance. No transport failure or replay injection.
      Object.defineProperty(expoThreadOutboxStorage, "remove", { configurable: true, value: async (entry: QueuedThreadMessage) => {
        if (entry.messageId === messageId && cleanupFailures === 0) {
          cleanupFailures++;
          throw new Error("Synthetic owned outbox cleanup failure");
        }
        return originalRemove(entry);
      } });
      delivery = createThreadOutboxDelivery(selectOutboxDeliveryResolver({ requireNative: true }));
      await control("/restore-dispatch");
    } else {
      // A new Android process reads existing pairing and an empty durable queue, never a new pairing.
      const persisted = await expoThreadOutboxStorage.load();
      assert(persisted.errors.length === 0 && persisted.messages.length === 0);
      delivery = createThreadOutboxDelivery(selectOutboxDeliveryResolver({ requireNative: true }));
    }
    const atom = environmentThreads.stateAtom(environmentId, threadId);
    release = appAtomRegistry.subscribe(atom, () => {});
    const deadline = Date.now() + 90_000;
    let snapshot: { runId: string; userMessageCount: number; runCount: number } | undefined;
    while (Date.now() < deadline) {
      const current = appAtomRegistry.get(atom);
      if (current.status === "live" && Option.isSome(current.data)) {
        const projection = current.data.value;
        const users = projection.messages.filter((row) => row.role === "user");
        if (users.length === 1 && users[0]?.id === messageId && users[0].text === text &&
            projection.runs.length === 1 && projection.runs[0]?.status === "completed" &&
            users[0].runId === projection.runs[0].id && queues().length === 0) {
          snapshot = { runId: projection.runs[0].id, userMessageCount: users.length, runCount: projection.runs.length };
          break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    assert(snapshot !== undefined);
    assert(reopen || cleanupFailures === 1);
    await flushThreadOutbox();
    const persisted = await expoThreadOutboxStorage.load();
    assert(persisted.errors.length === 0 && persisted.messages.length === 0);
    return { environmentId, threadId, messageId, commandId, text, ...snapshot,
      cleanupFailures, durableQueueCount: 0, reopened: reopen };
  } finally {
    delivery?.dispose();
    release();
    Object.defineProperty(expoThreadOutboxStorage, "remove", { configurable: true, value: originalRemove });
  }
}
