// @effect-diagnostics nodeBuiltinImport:off - deployment-time artifact verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Verify the web-target glue and Wasm together before handing paths to Alchemy. */
export async function inspectNativeSavings(directory: string) {
  if (!NodePath.isAbsolute(directory) || await NodeFS.realpath(directory) !== directory) {
    throw new Error("The native savings directory must be an absolute canonical path");
  }
  const digest = NodeCrypto.createHash("sha256");
  const files = ["savings.js", "savings_bg.wasm"] as const;
  for (const name of files) {
    const path = NodePath.join(directory, name);
    const file = await NodeFS.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 1_048_576) {
        throw new Error("Invalid native savings artifact");
      }
      const bytes = await file.readFile();
      const after = await NodeFS.lstat(path);
      if (
        bytes.byteLength !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("The native savings artifact changed during inspection");
      }
      digest.update(`${name}\0${bytes.byteLength}\0`);
      digest.update(bytes);
    } finally {
      await file.close();
    }
  }
  return {
    fingerprint: digest.digest("hex"),
    glue: NodePath.join(directory, files[0]),
    wasm: NodePath.join(directory, files[1]),
  };
}

export const savingsBuild = Effect.gen(function* () {
  const directory = yield* Config.String("TASK_CACHE_NATIVE_SAVINGS_DIRECTORY").pipe(Config.option);
  if (Option.isNone(directory)) return undefined;
  const expected = yield* Config.String("TASK_CACHE_NATIVE_SAVINGS_SHA256");
  const artifacts = yield* Effect.tryPromise({
    try: () => inspectNativeSavings(directory.value),
    catch: (cause) => new Config.ConfigError(new ConfigProvider.SourceError({
      message: "Could not verify the selected native savings artifacts",
      cause,
    })),
  });
  if (!/^[a-f0-9]{64}$/.test(expected) || artifacts.fingerprint !== expected) {
    return yield* Config.fail(new ConfigProvider.SourceError({
      message: "The native savings artifacts do not match their expected fingerprint",
    }));
  }
  return {
    input: {
      resolve: {
        alias: {
          "./SavingsRuntime.ts": NodeURL.fileURLToPath(new URL("./SavingsRuntime.native.ts", import.meta.url)),
          "@t3tools/task-cache/native-savings-glue": artifacts.glue,
          "@t3tools/task-cache/native-savings-wasm": artifacts.wasm,
        },
      },
    },
  };
});
