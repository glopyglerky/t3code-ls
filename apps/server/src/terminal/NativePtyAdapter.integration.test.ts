// @effect-diagnostics nodeBuiltinImport:off globalTimers:off processEnvInEffect:off -- disposable Linux PTY process fixture.
import * as Effect from "effect/Effect";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { describe, expect, it } from "vite-plus/test";
import * as NativePtyAdapter from "./NativePtyAdapter.ts";

const executable = process.env.T3_CODE_LS_PTY_PROOF_EXECUTABLE;

async function within<A>(promise: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native PTY fixture did not settle")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!executable || process.platform !== "linux")("NativePtyAdapter signal lifecycle", () => {
  it("observes a graceful trapped exit after data listeners detach", async () => {
    const process = await Effect.runPromise(
      Effect.flatMap(PtyAdapter.PtyAdapter, (adapter) => adapter.spawn({
        shell: "/bin/sh",
        args: ["-c", "trap 'printf terminated; exit 42' TERM; printf ready; while :; do :; done"],
        cwd: "/tmp",
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
        cols: 80,
        rows: 24,
      })).pipe(Effect.provide(NativePtyAdapter.layer(executable!))),
    );
    const exited = Promise.withResolvers<PtyAdapter.PtyExitEvent>();
    const unsubscribeExit = process.onExit(exited.resolve);
    const ready = Promise.withResolvers<void>();
    let output = "";
    const unsubscribeData = process.onData((data) => {
      output += data;
      if (output.includes("ready")) ready.resolve();
    });
    try {
      await within(ready.promise);
      unsubscribeData();
      const deliveredBeforeTermination = output;
      process.kill("SIGTERM");
      const exit = await within(exited.promise);
      expect(exit.exitCode).toBe(42);
      expect(output).toBe(deliveredBeforeTermination);
    } finally {
      unsubscribeData();
      process.kill("SIGKILL");
      await within(exited.promise);
      unsubscribeExit();
    }
  });
});
