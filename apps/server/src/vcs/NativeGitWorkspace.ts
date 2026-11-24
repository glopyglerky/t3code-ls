import * as HostProcess from "@t3tools/shared/HostProcess";
import { nativeExecutable, verifyBundledNativeExecutable } from "@t3tools/shared/nativeExecutable";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class BundledGitWorkspaceError extends Schema.TaggedError<BundledGitWorkspaceError>()(
  "BundledGitWorkspaceError", { cause: Schema.Defect() },
) {
  override get message(): string { return "Could not verify the bundled native Git workspace helper."; }
}

/** Selection belongs to the existing Git service, before any read is attempted. */
export const select = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const override = environment.T3_CODE_LS_GIT_WORKSPACE_EXECUTABLE;
  const bundled = environment.T3_CODE_LS_BUNDLED_GIT_WORKSPACE;
  if (bundled !== undefined && bundled !== "1") {
    return yield* Effect.die(new Error("T3_CODE_LS_BUNDLED_GIT_WORKSPACE must be 1 when selected."));
  }
  if (environment.T3_CODE_LS_IMPLEMENTATION === "upstream") return undefined;
  if (bundled === undefined) return override;
  if (override !== undefined) return yield* Effect.die(new Error("Select one native Git workspace helper source."));
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const path = yield* Path.Path;
  const executable = nativeExecutable("git-workspace");
  if (platform !== "linux" || architecture !== "x64" || !path.isAbsolute(executable)) {
    return yield* Effect.die(new Error("The bundled Git workspace helper requires Linux x64."));
  }
  yield* Effect.tryPromise({
    try: () => verifyBundledNativeExecutable("git-workspace", executable),
    catch: (cause) => new BundledGitWorkspaceError({ cause }),
  }).pipe(Effect.orDie);
  return executable;
});
