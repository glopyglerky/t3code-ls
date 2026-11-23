import { requireOptionalNativeModule } from "expo";

import {
  resolveThreadOutboxDeliveryAction,
  type ThreadOutboxDeliveryAction,
} from "../state/thread-outbox-model";

const nativeControls = requireOptionalNativeModule<{
  resolveOutboxDeliveryV1?: (facts: number) => number;
}>("T3NativeControls");

export function selectOutboxDeliveryResolver(): typeof resolveThreadOutboxDeliveryAction {
  const resolve = nativeControls?.resolveOutboxDeliveryV1;
  if (resolve === undefined || resolve(0) !== 0) return resolveThreadOutboxDeliveryAction;

  const familyCodes = { pending: 16, failed: 32, settled: 48 } as const;
  const actions: ReadonlyArray<ThreadOutboxDeliveryAction> = ["wait", "remove", "send"];
  return (facts) => {
    const code =
      Number(facts.isCreation) +
      2 * Number(facts.threadExists) +
      4 * Number(facts.shellStatus === "live") +
      8 * Number(facts.environmentConnected) +
      (facts.familyRead === undefined ? 0 : familyCodes[facts.familyRead]);
    return actions[resolve(code)] ?? resolveThreadOutboxDeliveryAction(facts);
  };
}
