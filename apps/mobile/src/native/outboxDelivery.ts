import { requireOptionalNativeModule } from "expo";

import {
  resolveThreadOutboxDeliveryAction,
  type ThreadOutboxDeliveryAction,
} from "../state/thread-outbox-model";

const nativeControls = requireOptionalNativeModule<{
  resolveOutboxDeliveryV1?: (facts: number) => number;
}>("T3NativeControls");

export function selectOutboxDeliveryResolver(
  options?: { readonly requireNative?: boolean },
): typeof resolveThreadOutboxDeliveryAction {
  const resolve = nativeControls?.resolveOutboxDeliveryV1;
  if (resolve === undefined || resolve(0) !== 0) {
    if (options?.requireNative) throw new Error("Native outbox policy is unavailable");
    return resolveThreadOutboxDeliveryAction;
  }

  const familyCodes = { pending: 16, failed: 32, settled: 48 } as const;
  const actions: ReadonlyArray<ThreadOutboxDeliveryAction> = ["wait", "remove", "send"];
  return (facts) => {
    const code =
      Number(facts.isCreation) +
      2 * Number(facts.threadExists) +
      4 * Number(facts.shellStatus === "live") +
      8 * Number(facts.environmentConnected) +
      (facts.familyRead === undefined ? 0 : familyCodes[facts.familyRead]);
    const action = actions[resolve(code)];
    if (action !== undefined) return action;
    if (options?.requireNative) throw new Error("Native outbox policy returned an invalid action");
    return resolveThreadOutboxDeliveryAction(facts);
  };
}
