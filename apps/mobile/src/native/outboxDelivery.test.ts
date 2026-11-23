import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveThreadOutboxDeliveryAction } from "../state/thread-outbox-model";
import { selectOutboxDeliveryResolver } from "./outboxDelivery";

const { nativeResolve } = vi.hoisted(() => ({ nativeResolve: vi.fn<(facts: number) => number>() }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ resolveOutboxDeliveryV1: nativeResolve }),
}));

describe("native outbox delivery", () => {
  beforeEach(() => nativeResolve.mockReset());

  it("retains the existing policy when the native library is absent", () => {
    nativeResolve.mockReturnValue(-1);
    expect(selectOutboxDeliveryResolver()).toBe(resolveThreadOutboxDeliveryAction);
  });

  it("rejects absent native policy when an installed-package proof requires it", () => {
    nativeResolve.mockReturnValue(-1);
    expect(() => selectOutboxDeliveryResolver({ requireNative: true })).toThrow("Native outbox policy is unavailable");
  });

  it("does not hide an invalid native action in strict proof selection", () => {
    nativeResolve.mockReturnValueOnce(0).mockReturnValue(-1);
    const resolve = selectOutboxDeliveryResolver({ requireNative: true });
    expect(() => resolve({ isCreation: false, threadExists: true, shellStatus: "live",
      environmentConnected: true })).toThrow("Native outbox policy returned an invalid action");
  });

  it("sends current evidence to the native policy and reads the returned action", () => {
    nativeResolve.mockReturnValueOnce(0).mockReturnValueOnce(2);
    const resolve = selectOutboxDeliveryResolver();
    expect(resolve({
      isCreation: false,
      threadExists: true,
      shellStatus: "live",
      environmentConnected: true,
      familyRead: "settled",
    })).toBe("send");
    expect(nativeResolve.mock.calls).toEqual([[0], [62]]);
  });

  const artifactMatrix = process.env.T3_OUTBOX_PROOF_MATRIX;
  it.skipIf(artifactMatrix === undefined)("matches every retained policy outcome through the hosted Rust artifact", () => {
    const outcomes: number[] = JSON.parse(artifactMatrix!);
    expect(outcomes).toHaveLength(64);
    nativeResolve.mockImplementation((facts) => outcomes[facts] ?? -1);
    const resolve = selectOutboxDeliveryResolver();
    expect(resolve).not.toBe(resolveThreadOutboxDeliveryAction);
    for (const shellStatus of ["empty", "cached", "synchronizing", "live"] as const) {
      for (const familyRead of [undefined, "pending", "failed", "settled"] as const) {
        for (let flags = 0; flags < 8; flags++) {
          const facts = {
            isCreation: (flags & 1) !== 0,
            threadExists: (flags & 2) !== 0,
            shellStatus,
            environmentConnected: (flags & 4) !== 0,
            ...(familyRead === undefined ? {} : { familyRead }),
          };
          expect(resolve(facts), JSON.stringify(facts)).toBe(resolveThreadOutboxDeliveryAction(facts));
        }
      }
    }
  });
});
