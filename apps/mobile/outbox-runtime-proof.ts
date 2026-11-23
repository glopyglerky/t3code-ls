// Explicit CI-only entry selected by withAndroidOutboxProof; normal App is not loaded.
import { registerRootComponent, requireNativeModule } from "expo";
import { createElement, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { selectOutboxDeliveryResolver } from "./src/native/outboxDelivery";
import { resolveThreadOutboxDeliveryAction } from "./src/state/thread-outbox-model";

function InstalledOutboxProof() {
  const [status, setStatus] = useState("running");
  useEffect(() => {
    const native = requireNativeModule<{
      resolveOutboxDeliveryV1: (facts: number) => number;
      recordOutboxRuntimeProof: (result: string) => void;
    }>("T3NativeControls");
    const report: Record<string, unknown> = { schema: 1, status: "running", checkpoint: "select-native" };
    try {
      const resolve = selectOutboxDeliveryResolver({ requireNative: true });
      if (resolve === resolveThreadOutboxDeliveryAction) throw new Error("Retained policy selected");
      report.checkpoint = "native-matrix";
      const matrix: number[] = [];
      for (let code = 0; code < 64; code++) {
        const familyRead = ([undefined, "pending", "failed", "settled"] as const)[code >> 4];
        const facts = { isCreation: (code & 1) !== 0, threadExists: (code & 2) !== 0,
          shellStatus: (code & 4) !== 0 ? "live" as const : "cached" as const,
          environmentConnected: (code & 8) !== 0, ...(familyRead === undefined ? {} : { familyRead }) };
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
      report.matrix = matrix;
      report.status = "passed";
      report.checkpoint = "complete";
    } catch (error) {
      report.status = "failed";
      report.failure = error instanceof Error ? error.message : String(error);
    }
    native.recordOutboxRuntimeProof(JSON.stringify(report));
    setStatus(String(report.status));
  }, []);
  return createElement(View, { style: { padding: 32 } },
    createElement(Text, { accessibilityLabel: `Native outbox proof ${status}` }, `Native outbox proof ${status}`));
}

registerRootComponent(InstalledOutboxProof);
