// @effect-diagnostics nodeBuiltinImport:off -- validates the isolated, package-owned test profile
import * as NodePath from "node:path";
import { isQualifiedNativeHost, nativeExecutable, verifyBundledNativeExecutable } from "@t3tools/shared/nativeExecutable";
import type { ClaudeAgentSdkQueryOptions, ClaudeAgentSdkQueryRunnerShape } from "./ClaudeAdapterV2.ts";
import { makeControlledClaudeStdioRunner } from "./ClaudeStdioRunner.ts";

// A runner gains this profile only after package/helper verification. A caller's
// config property, environment marker or matching instance name alone is insufficient.
const noMcpOwners = new WeakMap<ClaudeAgentSdkQueryRunnerShape, {
  readonly instanceId: string;
  readonly directory: string;
}>();

export function controlledClaudeStdioDisablesMcp(
  runner: ClaudeAgentSdkQueryRunnerShape,
  ownerInstanceId: string,
  selectedInstanceId: string,
  cwd: string | null,
): boolean {
  const owner = noMcpOwners.get(runner);
  if (owner === undefined) return false;
  if (owner.instanceId !== ownerInstanceId || owner.instanceId !== selectedInstanceId ||
    owner.directory !== cwd) {
    throw new Error("Controlled Claude no-MCP owner or directory mismatch.");
  }
  return true;
}

/** Explicit synthetic selection only. This is not a vendor-provider replacement. */
export async function selectControlledClaudeStdioRunner(
  instanceId: string,
  environment: Readonly<Record<string, string | undefined>>,
  bundledDirectory?: string,
): Promise<ClaudeAgentSdkQueryRunnerShape | undefined> {
  const raw = environment.T3_CODE_LS_CLAUDE_STDIO_SYNTHETIC;
  if (raw === undefined) return undefined;
  if (raw.length > 65_536) throw new Error("Claude synthetic selection exceeds its bound.");
  const profile: unknown = JSON.parse(raw);
  if (typeof profile !== "object" || profile === null ||
    !("instanceId" in profile) || typeof profile.instanceId !== "string" ||
    !/^claude-stdio-synthetic-[a-z0-9-]+$/.test(profile.instanceId)) {
    throw new Error("Invalid Claude synthetic instance selection.");
  }
  // Other provider instances keep the ordinary SDK path, even in this package.
  if (profile.instanceId !== instanceId) return undefined;
  if (environment.T3_CODE_LS_IMPLEMENTATION === "upstream" || !isQualifiedNativeHost()) {
    throw new Error("The selected Claude synthetic profile requires the native Linux x64 package.");
  }
  if (!("version" in profile) || profile.version !== 1 ||
    !("program" in profile) || typeof profile.program !== "string" ||
    !NodePath.isAbsolute(profile.program) ||
    !/^claude_stdio_host-[a-f0-9]+$/.test(NodePath.basename(profile.program)) ||
    !("directory" in profile) || typeof profile.directory !== "string" ||
    !NodePath.isAbsolute(profile.directory) ||
    !("expectedOptions" in profile) || typeof profile.expectedOptions !== "object" ||
    profile.expectedOptions === null || Array.isArray(profile.expectedOptions)) {
    throw new Error("Invalid controlled Claude profile.");
  }
  if ("mcp" in profile && profile.mcp !== "disabled") {
    throw new Error("Invalid controlled Claude MCP profile.");
  }
  const expected = profile.expectedOptions as ClaudeAgentSdkQueryOptions;
  if (expected.permissionMode !== "default" || expected.sessionId !== "fixture" ||
    "resume" in expected || expected.cwd !== profile.directory ||
    "mcpServers" in expected || "hooks" in expected ||
    "allowDangerouslySkipPermissions" in expected) {
    throw new Error("Unsupported controlled Claude options.");
  }
  const executable = nativeExecutable("claude-stdio", undefined, bundledDirectory);
  // Runs before adapter creation or a prompt. No SDK retry on any selected failure.
  await verifyBundledNativeExecutable("claude-stdio", executable);
  const runner = makeControlledClaudeStdioRunner(
    executable, profile.program, profile.directory, expected,
  ).runner;
  if ("mcp" in profile && profile.mcp === "disabled") {
    noMcpOwners.set(runner, { instanceId, directory: profile.directory });
  }
  return runner;
}
