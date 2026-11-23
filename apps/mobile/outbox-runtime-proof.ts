// Explicit CI-only entry selected by withAndroidOutboxProof; normal App is not loaded.
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { registerRootComponent, requireNativeModule } from "expo";
import { createElement, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { selectOutboxDeliveryResolver } from "./src/native/outboxDelivery";
import {
  resolveThreadOutboxDeliveryAction,
  type QueuedThreadMessage,
} from "./src/state/thread-outbox-model";

type Phase = "seed" | "seed-creation" | "reopen-remove" | "reopen-empty";

interface NativeProof {
  getOutboxRuntimeProofPhase: () => string | null;
  resolveOutboxDeliveryV1: (facts: number) => number;
  recordOutboxRuntimeProof: (result: string) => void;
}

function verifyMatrix(
  native: NativeProof,
  resolve: typeof resolveThreadOutboxDeliveryAction,
): number[] {
  const matrix: number[] = [];
  for (let code = 0; code < 64; code++) {
    const familyRead = ([undefined, "pending", "failed", "settled"] as const)[code >> 4];
    const facts = {
      isCreation: (code & 1) !== 0,
      threadExists: (code & 2) !== 0,
      shellStatus: (code & 4) !== 0 ? ("live" as const) : ("cached" as const),
      environmentConnected: (code & 8) !== 0,
      ...(familyRead === undefined ? {} : { familyRead }),
    };
    const expected = resolveThreadOutboxDeliveryAction(facts);
    const actual = resolve(facts);
    const nativeCode = native.resolveOutboxDeliveryV1(code);
    if (actual !== expected || ["wait", "remove", "send"][nativeCode] !== expected) {
      throw new Error(`Native matrix mismatch at ${code}`);
    }
    matrix.push(nativeCode);
  }
  if (native.resolveOutboxDeliveryV1(-1) !== -1 || native.resolveOutboxDeliveryV1(64) !== -1) {
    throw new Error("Native input bound mismatch");
  }
  return matrix;
}

async function runProof(native: NativeProof, phase: Phase): Promise<string> {
  const report: Record<string, unknown> = {
    schema: 2,
    phase,
    status: "running",
    checkpoint: "select-native",
  };
  try {
    const resolve = selectOutboxDeliveryResolver({ requireNative: true });
    if (resolve === resolveThreadOutboxDeliveryAction) throw new Error("Retained policy selected");

    if (phase === "seed") {
      report.checkpoint = "native-matrix";
      report.matrix = verifyMatrix(native, resolve);
    }

    report.checkpoint = "load-outbox";
    const { Directory, File, Paths } = await import("expo-file-system");
    const { COMPOSER_ATTACHMENT_DIRECTORY } = await import("./src/lib/composerAttachmentFiles");
    const { appAtomRegistry } = await import("./src/state/atom-registry");
    const { enqueueThreadOutboxMessage, flushThreadOutbox, threadOutboxManager } =
      await import("./src/state/thread-outbox");
    const { scopedThreadKey } = await import("./src/lib/scopedEntities");
    const readQueues = () => appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
    if (!(await threadOutboxManager.load())) throw new Error("Could not load the installed outbox");

    const environmentId = EnvironmentId.make("t12-offline-environment");
    const threadId = ThreadId.make("t12-offline-thread");
    const messageId = MessageId.make("t12-offline-message");
    const threadKey = scopedThreadKey(environmentId, threadId);

    if (phase === "seed" || phase === "seed-creation") {
      report.checkpoint = "enqueue-draft";
      if (Object.keys(readQueues()).length !== 0) throw new Error("Expected a fresh fixture outbox");
      const { createPastedTextComposerAttachment } = await import("./src/lib/composerImages");
      const attachment = await createPastedTextComposerAttachment({
        text: "T12 offline attachment\nπ 🙂\n",
        name: "t12-offline.txt",
        maxBytes: 128,
      });
      const message: QueuedThreadMessage = {
        environmentId,
        threadId,
        messageId,
        commandId: CommandId.make("t12-offline-command"),
        text: phase === "seed-creation" ? "T12 offline pending task" : "T12 offline draft",
        attachments: [attachment],
        dispatchMode: "queue",
        createdAt: "2026-01-01T00:00:00.000Z",
        ...(phase === "seed-creation" ? {
          creation: {
            projectId: ProjectId.make("t12-offline-project"),
            projectTitle: "Fixture project",
            workspaceMode: "local" as const,
            branch: null,
            worktreePath: null,
          },
        } : {}),
      };
      await enqueueThreadOutboxMessage(message);
      await flushThreadOutbox();
    }

    if (phase === "reopen-empty") {
      report.checkpoint = "verify-empty";
      const attachmentDirectory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
      report.queueCount = Object.keys(readQueues()).length;
      report.attachmentFileCount = attachmentDirectory.exists
        ? attachmentDirectory.list().length
        : 0;
      if (report.queueCount !== 0 || report.attachmentFileCount !== 0) {
        throw new Error("Removed outbox data survived reopen");
      }
    } else {
      report.checkpoint = "verify-queued-draft";
      const queues = readQueues();
      const queue = queues[threadKey];
      const message = queue?.[0];
      if (
        Object.keys(queues).length !== 1 ||
        queue?.length !== 1 ||
        message?.environmentId !== environmentId ||
        message.threadId !== threadId ||
        message.messageId !== messageId
      ) {
        throw new Error("Expected one queued draft in the exact fixture scope");
      }
      const attachment = message.attachments[0];
      if (message.attachments.length !== 1 || attachment?.type !== "file") {
        throw new Error("Expected one file-backed attachment");
      }
      const file = new File(attachment.fileUri);
      report.threadKey = threadKey;
      report.message = message;
      report.attachmentBase64 = await file.base64();
      report.offlineAction = resolve({
        isCreation: message.creation !== undefined,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
      });
      if (report.offlineAction !== "wait") throw new Error("Cached absence must keep the draft");

      if (phase === "reopen-remove") {
        report.checkpoint = "reconcile-loaded-draft";
        report.reconcileAction = resolve({
          isCreation: message.creation !== undefined,
          threadExists: message.creation !== undefined,
          shellStatus: "live",
          environmentConnected: false,
          familyRead: "settled",
        });
        if (report.reconcileAction !== "remove") {
          throw new Error("A settled outbox entry must be removed");
        }
        const removed = await threadOutboxManager.remove(message);
        if (removed !== message) throw new Error("The loaded draft was not removed");
        const { releaseUnusedComposerAttachmentFiles } =
          await import("./src/state/use-composer-drafts");
        await releaseUnusedComposerAttachmentFiles(removed.attachments);
        report.queueCount = Object.keys(readQueues()).length;
        report.attachmentFileExists = file.exists;
        if (report.queueCount !== 0 || report.attachmentFileExists) {
          throw new Error("Removal did not clear the queue and its unreferenced attachment");
        }
      }
    }

    report.status = "passed";
    report.checkpoint = "complete";
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
  }
  native.recordOutboxRuntimeProof(JSON.stringify(report));
  return String(report.status);
}

function InstalledOutboxProof() {
  const [status, setStatus] = useState("running");
  useEffect(() => {
    const native = requireNativeModule<NativeProof>("T3NativeControls");
    const phase = native.getOutboxRuntimeProofPhase();
    if (
      phase !== "seed" && phase !== "seed-creation" &&
      phase !== "reopen-remove" && phase !== "reopen-empty"
    ) {
      setStatus("invalid fixture phase");
      return;
    }
    void runProof(native, phase).then(setStatus);
  }, []);
  return createElement(
    View,
    { style: { padding: 32 } },
    createElement(
      Text,
      { accessibilityLabel: `Native outbox proof ${status}` },
      `Native outbox proof ${status}`,
    ),
  );
}

registerRootComponent(InstalledOutboxProof);
