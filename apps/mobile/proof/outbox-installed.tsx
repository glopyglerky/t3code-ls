// MIT. Candidate-only entry; never imported by the normal application.
import { registerRootComponent, requireOptionalNativeModule } from "expo";
import { File, Paths } from "expo-file-system";
import { Text } from "react-native";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { selectOutboxDeliveryResolver } from "../src/native/outboxDelivery";
import { resolveThreadOutboxDeliveryAction, encodeQueuedThreadMessage, type QueuedThreadMessage } from "../src/state/thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "../src/state/thread-outbox-storage";

type Binding = { resolveOutboxDeliveryV1?: (facts: number) => number } | null;
function admit(binding: Binding) {
  const resolve = binding?.resolveOutboxDeliveryV1;
  if (typeof resolve !== "function") throw new Error("absent-binding");
  if (resolve(0) !== 0 || resolve(-1) !== -1 || resolve(64) !== -1) {
    throw new Error("blocked-binding");
  }
  return resolve;
}
const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("outbox-proof-environment"),
  threadId: ThreadId.make("outbox-proof-thread"),
  messageId: MessageId.make("outbox-proof-message"),
  commandId: CommandId.make("outbox-proof-command"),
  text: "Synthetic installed outbox persistence", attachments: [],
  createdAt: "2026-11-23T00:00:00.000Z",
};
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
async function run() {
  const control = JSON.parse(await new File(Paths.document, "outbox-proof-control.json").text());
  const result = new File(Paths.document, "outbox-proof-result.json");
  try {
    check(typeof control.nonce === "string", "missing nonce");
    const installed = requireOptionalNativeModule<NonNullable<Binding>>("T3NativeControls");
    // These are explicit gate fault injections, never evidence of an absent installed binary.
    if (control.mode === "absent" || control.mode === "blocked") {
      const injected = control.mode === "absent" ? null : { resolveOutboxDeliveryV1: () => -1 };
      let refusal = "";
      try { admit(injected); } catch (error) { refusal = String(error); }
      check(refusal.includes(`${control.mode}-binding`), "gate accepted injected binding");
      result.write(JSON.stringify({ nonce: control.nonce, mode: control.mode, status: "refused", faultInjection: true }));
      return;
    }
    const native = admit(installed);
    const selected = selectOutboxDeliveryResolver();
    check(selected !== resolveThreadOutboxDeliveryAction, "production resolver fell back");
    const actions = ["wait", "remove", "send"];
    const outcomes = [];
    for (let bits = 0; bits < 64; bits++) {
      const family = [undefined, "pending", "failed", "settled"] as const;
      const facts = { isCreation: !!(bits & 1), threadExists: !!(bits & 2),
        shellStatus: bits & 4 ? "live" as const : "cached" as const,
        environmentConnected: !!(bits & 8),
        ...(family[bits >> 4] === undefined ? {} : { familyRead: family[bits >> 4] }) };
      const actual = native(bits);
      check(actions[actual] === resolveThreadOutboxDeliveryAction(facts), `native cell ${bits}`);
      check(selected(facts) === actions[actual], `production cell ${bits}`);
      outcomes.push(actual);
    }
    const loaded = await expoThreadOutboxStorage.load();
    check(loaded.errors.length === 0, "storage errors");
    if (control.mode === "seed") {
      check(loaded.messages.length === 0, "seed storage not empty");
      await expoThreadOutboxStorage.write(message);
      await flushThreadOutboxWrites();
      const saved = await expoThreadOutboxStorage.load();
      check(saved.errors.length === 0 && saved.messages.length === 1 &&
        JSON.stringify(encodeQueuedThreadMessage(saved.messages[0]!)) === JSON.stringify(encodeQueuedThreadMessage(message)), "seed readback mismatch");
    } else if (control.mode === "reopen") {
      check(loaded.messages.length === 1 && JSON.stringify(encodeQueuedThreadMessage(loaded.messages[0]!)) === JSON.stringify(encodeQueuedThreadMessage(message)), "reopen mismatch");
      await expoThreadOutboxStorage.remove(loaded.messages[0]!);
      const removed = await expoThreadOutboxStorage.load();
      check(removed.errors.length === 0 && removed.messages.length === 0, "remove failed");
    } else if (control.mode === "empty") {
      check(loaded.messages.length === 0, "removed message returned");
    } else { throw new Error("unknown proof mode"); }
    result.write(JSON.stringify({ nonce: control.nonce, mode: control.mode, status: "passed", outcomes,
      storage: control.mode === "seed" ? "durable" : control.mode === "reopen" ? "reopened-and-removed" : "empty-after-reopen" }));
  } catch (error) {
    result.write(JSON.stringify({ nonce: control.nonce, mode: control.mode, status: "failed", error: String(error) }));
  }
}
registerRootComponent(() => <Text>Candidate outbox installed proof</Text>);
void run();
