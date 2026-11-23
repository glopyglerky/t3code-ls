// @effect-diagnostics nodeBuiltinImport:off -- isolated package manifest refusal checks
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it } from "vitest";
import { isQualifiedNativeHost } from "@t3tools/shared/nativeExecutable";
import { selectControlledClaudeStdioRunner as select } from "./ClaudeStdioSelection.ts";

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
