// @effect-diagnostics nodeBuiltinImport:off -- isolated package manifest refusal checks
import * as FS from "node:fs/promises";
import { createHash } from "node:crypto";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it } from "vitest";
import { isQualifiedNativeHost } from "@t3tools/shared/nativeExecutable";
import {
  controlledClaudeStdioDisablesMcp as disablesMcp,
  controlledClaudeStdioQueryEnvironment as controlledEnvironment,
  selectControlledClaudeStdioRunner as select,
} from "./ClaudeStdioSelection.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await FS.rm(path, { recursive: true, force: true }); });
const instanceId = "claude-stdio-synthetic-captured";
const profile = (directory: string) => ({
  instanceId, version: 1, program: Path.join(directory, "claude_stdio_host-1234abcd"), directory,
  expectedOptions: { permissionMode: "default", sessionId: "fixture", cwd: directory },
});
const env = (value: unknown) => ({ T3_CODE_LS_CLAUDE_STDIO_SYNTHETIC: JSON.stringify(value) });
it("keeps ordinary instances on SDK selection", async () => {
  expect(await select("claudeAgent", {})).toBeUndefined();
  expect(await select("claudeAgent", env(profile("/unused")))).toBeUndefined();
});
it("rejects malformed selection without a provider launch", async () => {
  await expect(select(instanceId, env({ instanceId: "claudeAgent" }))).rejects.toThrow();
});
it.skipIf(!isQualifiedNativeHost())("rejects a missing helper or incompatible manifest before opening", async () => {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "claude-selection-"));
  directories.push(directory);
  const selection = env(profile(directory));
  await expect(select(instanceId, selection, directory)).rejects.toThrow();
  await FS.writeFile(Path.join(directory, "manifest.json"), JSON.stringify({
    target: "darwin-arm64", files: {},
  }));
  await expect(select(instanceId, selection, directory)).rejects.toThrow(/does not select/);
  expect(await FS.readdir(directory)).toEqual(["manifest.json"]);
});
it.skipIf(!isQualifiedNativeHost())("refuses SDK-only options before looking for a helper", async () => {
  const input = profile("/unused");
  await expect(select(instanceId, env({ ...input, expectedOptions: {
    ...input.expectedOptions, mcpServers: {},
  } }))).rejects.toThrow(/Unsupported controlled Claude options/);
});

it.skipIf(!isQualifiedNativeHost())("binds no-MCP to the verified selected runner, owner and cwd", async () => {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "claude-no-mcp-"));
  directories.push(directory);
  // Never executed. This test qualifies selector ownership, not a helper launch.
  const helper = "t3-code-ls-claude-stdio";
  const bytes = "selector-only fixture";
  await FS.writeFile(Path.join(directory, helper), bytes, { mode: 0o700 });
  await FS.writeFile(Path.join(directory, "manifest.json"), JSON.stringify({
    target: "linux-x64", rustTarget: "x86_64-unknown-linux-gnu",
    files: { [helper]: createHash("sha256").update(bytes).digest("hex") },
  }));
  const normal = await select(instanceId, env(profile(directory)), directory);
  const selected = await select(instanceId, env({ ...profile(directory), mcp: "disabled" }), directory);
  expect(normal).toBeDefined();
  expect(selected).toBeDefined();
  expect(disablesMcp(normal!, instanceId, instanceId, directory)).toBe(false);
  expect(disablesMcp(selected!, instanceId, instanceId, directory)).toBe(true);
  const processEnvironment = { HOME: directory, SYNTHETIC_UNRELATED_VALUE: "ignored" };
  expect(controlledEnvironment(normal!, processEnvironment)).toEqual(processEnvironment);
  expect(controlledEnvironment(selected!, processEnvironment)).toEqual({ HOME: directory });
  expect(() => disablesMcp(selected!, "foreign", instanceId, directory)).toThrow(/mismatch/);
  expect(() => disablesMcp(selected!, instanceId, "foreign", directory)).toThrow(/mismatch/);
  expect(() => disablesMcp(selected!, instanceId, instanceId, directory + "/other")).toThrow(/mismatch/);
  await expect(select(instanceId, env({ ...profile(directory), mcp: true }), directory)).rejects.toThrow(/MCP profile/);
  await FS.appendFile(Path.join(directory, helper), "tampered");
  await expect(select(instanceId, env({ ...profile(directory), mcp: "disabled" }), directory)).rejects.toThrow(/manifest/);
});
