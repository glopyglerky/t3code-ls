// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// This internal entry runs before the CLI and application layer graphs are loaded.
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Sea from "node:sea";
import { installedApplicationDatabase } from "@t3tools/shared/applicationDatabase";
import { readBundledNativeTrialHelper } from "../serviceLauncher.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readVerification(): Promise<string> {
  const timer = setTimeout(() => process.stdin.destroy(new Error("Preparation input timed out.")), 15_000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 65_536) throw new Error("Preparation input exceeds its bound.");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export async function runServicePrepareIsolated(args: readonly string[]): Promise<void> {
  try {
    const [home, updateId] = args;
    if (args.length !== 2 || home === undefined || !Path.isAbsolute(home) ||
      updateId === undefined || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(updateId) ||
      process.platform !== "linux" || process.arch !== "x64" || !Sea.isSea()) {
      throw new Error("Isolated preparation requires an installed Linux x64 executable, home and update ID.");
    }
    const input = await readVerification();
    const verification: unknown = JSON.parse(input);
    const request = isRecord(verification) ? verification.request : undefined;
    const activation = isRecord(request) ? request.activation : undefined;
    const preparation = isRecord(verification) ? verification.preparation : undefined;
    if (!isRecord(request) || !isRecord(activation) || !isRecord(preparation) ||
      request.update_id !== updateId || activation.update_id !== updateId ||
      typeof activation.target_version !== "string" ||
      !/^[0-9A-Za-z.+-]{1,256}$/u.test(activation.target_version)) {
      throw new Error("Preparation must bind an installed candidate and update ID.");
    }
    const entry = await FS.realpath(process.execPath);
    if (entry !== Path.join(home, "runtime", "versions", activation.target_version, "t3")) {
      throw new Error("The preparation process is not the installed candidate.");
    }
    const selection = installedApplicationDatabase(entry, {});
    if (selection.kind !== "omdb") throw new Error("The installed candidate does not select native storage.");
    const helper = await readBundledNativeTrialHelper(entry, selection.executable);
    if (helper === null || helper.sha256 !== activation.target_helper_sha256 ||
      helper.targetSchemaSha256 !== activation.target_schema_sha256) {
      throw new Error("The installed candidate helper does not match the preparation.");
    }
    const file = await FS.open("/proc/self/exe", "r");
    try {
      const image = await file.stat({ bigint: true });
      const installed = await FS.lstat(entry, { bigint: true });
      if (!image.isFile() || !installed.isFile() || image.dev !== installed.dev ||
        image.ino !== installed.ino || image.size !== installed.size) {
        throw new Error("The installed candidate changed after this process started.");
      }
      const digest = Crypto.createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
      if (digest.digest("hex") !== activation.target_entry_sha256) {
        throw new Error("The running candidate does not match the prepared executable.");
      }
    } finally {
      await file.close();
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = ChildProcess.execFile(selection.executable,
        ["trial-verify-isolated", home, updateId],
        { env: {}, encoding: "utf8", timeout: 60_000, maxBuffer: 8192, killSignal: "SIGKILL" },
        (error, stdout) => error === null ? resolve(stdout) : reject(error));
      child.stdin?.on("error", reject);
      child.stdin?.end(input);
    });
    const result: unknown = JSON.parse(stdout);
    if (!isRecord(result) || result.ok !== true || !isRecord(result.result) ||
      result.result.verified !== true) {
      throw new Error("The isolated candidate preparation failed verification.");
    }
    process.stdout.write(JSON.stringify({ protocol: 1, status: "prepared-isolated", updateId,
      preparation }) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Isolated preparation failed.") + "\n");
    process.exitCode = 1;
  }
}
