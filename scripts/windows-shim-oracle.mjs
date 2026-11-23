// MIT; cmd semantics proof for the standalone managed CLI shim, not a product build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(process.platform, "win32", "This oracle requires actual Windows cmd.exe.");
const root = mkdtempSync(join(tmpdir(), "t3 shim oracle "));
const child = join(root, "child.mjs");
const shim = join(root, "t3.cmd");
const comspec = join(process.env.SystemRoot, "System32", "cmd.exe");
const argumentsToEcho = ["two words", "ampersand&literal", "!literal!"];
const results = [];
try {
  // The only removable file is this fixture's shim, next to this child.
  writeFileSync(child, `import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [code, remove, ...args] = process.argv.slice(2);
if (remove === 'yes') unlinkSync(fileURLToPath(new URL('./t3.cmd', import.meta.url)));
console.log(JSON.stringify({code: Number(code), args}));
process.exit(Number(code));
`);
  for (const tail of ["legacy", "explicit-exit"]) {
    for (const remove of [false, true]) {
      for (const code of [0, 1, 2, 130]) {
        // One legacy deletion is sufficient to establish the observed failure mechanism.
        if (tail === "legacy" && remove && code !== 0) continue;
        writeFileSync(shim, `@echo off\r\n"${process.execPath}" %*${tail === "explicit-exit" ? " & exit /b" : ""}`);
        const args = [child, String(code), remove ? "yes" : "no", ...argumentsToEcho];
        assert.ok([shim, process.execPath, ...args].every((arg) => !/[%"\r\n]/u.test(arg)), "Controlled paths must be cmd literals.");
        const command = `""${shim}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
        const observed = spawnSync(comspec, ["/d", "/v:off", "/s", "/c", command], {
          cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
          windowsVerbatimArguments: true, windowsHide: true,
        });
        const legacyDeletion = tail === "legacy" && remove;
        const checks = {
          childStarted: !observed.error && observed.signal === null,
          exitPreserved: observed.status === (legacyDeletion ? 1 : code),
          stderrExpected: legacyDeletion
            ? /^The batch file cannot be found\.?\s*$/iu.test(observed.stderr)
            : observed.stderr === "",
          argumentsPreserved: observed.stdout.trim() === JSON.stringify({ code, args: argumentsToEcho }),
          deletionExpected: existsSync(shim) === !remove,
        };
        results.push({ tail, remove, code, observedExitCode: observed.status, ...checks });
        assert.ok(Object.values(checks).every(Boolean), JSON.stringify(results.at(-1)));
      }
    }
  }
  console.log(`WINDOWS_SHIM_ORACLE ${JSON.stringify({ cases: results, passed: true })}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
