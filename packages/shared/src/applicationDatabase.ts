// @effect-diagnostics nodeBuiltinImport:off -- Installed runtime inspection is synchronous and read-only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { selectNativeExecutable } from "./nativeExecutable.ts";

/** Choose once at startup, never in response to a failed database operation. */
export const applicationDatabase = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  bundledDirectory?: string,
) => {
  const executable = selectNativeExecutable(
    "db",
    environment.T3_CODE_LS_DB_EXECUTABLE,
    undefined,
    undefined,
    environment.T3_CODE_LS_IMPLEMENTATION ?? null,
    bundledDirectory,
  );
  return executable === undefined
    ? { kind: "sqlite" as const }
    : { kind: "omdb" as const, executable };
};

/** The SEA loads its CLI and resolves helpers beside the real executable. */
export function installedApplicationDatabase(
  entryPath: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): ReturnType<typeof applicationDatabase> {
  const bundledDirectory = NodePath.join(
    NodePath.dirname(NodeFS.realpathSync(entryPath)),
    "native-bin",
  );
  // Windows spawn retains the first spelling of an environment key in lexical order.
  const windowsKeys = NodeOS.platform() === "win32" ? Object.keys(environment).sort() : undefined;
  const value = (key: string) =>
    environment[windowsKeys?.find((name) => name.toUpperCase() === key) ?? key];
  const selectionEnvironment = {
    T3_CODE_LS_DB_EXECUTABLE: value("T3_CODE_LS_DB_EXECUTABLE"),
    T3_CODE_LS_IMPLEMENTATION: value("T3_CODE_LS_IMPLEMENTATION"),
  };
  if (
    selectionEnvironment.T3_CODE_LS_DB_EXECUTABLE === undefined &&
    selectionEnvironment.T3_CODE_LS_IMPLEMENTATION === undefined &&
    NodeFS.lstatSync(bundledDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    // Stock releases have no native package. The caller still verifies the live database.
    return { kind: "sqlite" };
  }
  return applicationDatabase(selectionEnvironment, bundledDirectory);
}
