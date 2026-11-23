// MIT; cmd semantics proof for the standalone managed CLI shim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(process.platform, "win32", "This oracle requires actual Windows cmd.exe.");
const matrix = process.argv[2] === "--matrix";
assert.deepEqual(process.argv.slice(2), matrix ? ["--matrix"] : []);

const systemRoot = process.env.SystemRoot;
const comspec = join(systemRoot, "System32", "cmd.exe");
const launch = `"${process.execPath}" %*`;
const controls = [
  ["legacy", launch],
  ["explicit-exit", `${launch} & exit /b`],
];
const candidates = [
  // Re-expand only the numeric tail. CALL on the launch itself would reparse argv.
  ["call-exit-code", `${launch} & call exit /b %%errorlevel%%`],
  ["conditional-exit-code", `${launch} && exit /b 0 || call exit /b %%errorlevel%%`],
  ["post-launch-goto", `${launch} & (goto) 2>nul`],
  ["goto-before-launch", `(goto) 2>nul & ${launch}`],
  ["missing-label-before-launch", `goto t3_oracle_missing_label 2>nul || ${launch}`],
  ["eof-before-launch", `goto :eof & ${launch}`],
];
const variants = matrix ? [...controls, ...candidates] : controls;
const exitCodes = matrix ? [0, 1, 2, 130, 3010] : [0, 1, 2, 130];
const contexts = matrix ? ["direct", "batch-caller"] : ["direct"];
const argumentsToEcho = ["two words", "ampersand&literal", "!literal!", "|<>()", ""];
const resumed = "WINDOWS_SHIM_CALLER_RESUMED";
const childContext = "WINDOWS_SHIM_CHILD_CONTEXT_PRESERVED";
const batchFileMissing = "The batch file cannot be found.";
const root = mkdtempSync(join(tmpdir(), "t3 shim oracle "));
const workingDirectory = join(root, "run cwd");
const child = join(root, "child.mjs");
const shim = join(root, "t3.cmd");
const caller = join(root, "caller.cmd");

function quoteLiteral(argument) {
  assert.ok(!/[%"\r\n]/u.test(argument), "Controlled paths and arguments must be cmd literals.");
  return `"${argument}"`;
}

function runCase(name, line, context, remove, code) {
  const called = context === "batch-caller";
  // The caller's own CALL pass doubles quoted carets. Test a literal caret in direct mode.
  const literals = called ? argumentsToEcho : [...argumentsToEcho, "caret^literal"];
  const args = [child, String(code), remove ? "yes" : "no", ...literals];
  const invocation = [shim, ...args].map(quoteLiteral).join(" ");
  writeFileSync(shim, `@echo off\r\n${line}`);
  if (called) {
    writeFileSync(caller, [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'set "T3_SHIM_ORACLE_ENV=active fixture"',
      `cd /d ${quoteLiteral(workingDirectory)}`,
      `call ${invocation}`,
      'set "T3_SHIM_ORACLE_STATUS=%errorlevel%"',
      `echo ${resumed}`,
      "exit /b %T3_SHIM_ORACLE_STATUS%",
    ].join("\r\n"));
  }
  const command = `"${called ? quoteLiteral(caller) : invocation}"`;
  const observed = spawnSync(comspec, ["/d", "/v:off", "/s", "/c", command], {
    cwd: called ? root : workingDirectory,
    env: { SystemRoot: systemRoot, T3_SHIM_ORACLE_ENV: called ? "outer fixture" : "active fixture" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
  const stdout = observed.stdout?.replaceAll("\r\n", "\n");
  const stderr = observed.stderr?.replaceAll("\r\n", "\n");
  const childStderr = code === 0 ? "" : `fixture child error ${code}\n`;
  const [childOutput, childContextOutput, ...callerOutput] = stdout?.split("\n") ?? [];
  const checks = {
    commandCompleted: !observed.error && observed.signal === null,
    argumentsPreserved: childOutput === JSON.stringify({ code, args: literals }),
    contextPreserved: childContextOutput === childContext,
    callerOutputExact: callerOutput.join("\n") === (called ? `${resumed}\n` : ""),
    stderrExact: stderr === childStderr,
    exitPreserved: observed.status === code,
    removalExpected: existsSync(shim) === !remove,
  };
  const missingBatchDiagnostic = stderr === `${childStderr}${batchFileMissing}\n`
    || stderr === `${childStderr}${batchFileMissing.slice(0, -1)}\n`;
  return {
    variant: name,
    context,
    remove,
    code,
    observedExitCode: observed.status,
    missingBatchDiagnostic,
    ...checks,
    passed: Object.values(checks).every(Boolean),
  };
}

try {
  quoteLiteral(process.execPath);
  mkdirSync(workingDirectory);
  // The child can remove only this case's freshly written shim in the owned temporary directory.
  writeFileSync(child, `import { realpathSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [requestedCode, remove, ...args] = process.argv.slice(2);
const code = Number(requestedCode);
const contextPreserved = process.env.T3_SHIM_ORACLE_ENV === 'active fixture'
  && realpathSync(process.cwd()) === realpathSync(fileURLToPath(new URL('./run cwd', import.meta.url)));
if (remove === 'yes') unlinkSync(fileURLToPath(new URL('./t3.cmd', import.meta.url)));
process.stdout.write(JSON.stringify({ code, args }) + '\\n');
process.stdout.write((contextPreserved ? '${childContext}' : 'WINDOWS_SHIM_CHILD_CONTEXT_CHANGED') + '\\n');
if (code !== 0) process.stderr.write('fixture child error ' + code + '\\n');
process.exitCode = code;
`);
  const results = [];
  for (const [name, line] of variants) {
    for (const context of contexts) {
      for (const remove of [false, true]) {
        for (const code of exitCodes) {
          if (!matrix && name === "legacy" && remove && code !== 0) continue;
          const result = runCase(name, line, context, remove, code);
          results.push(result);
          console.log(`WINDOWS_SHIM_CASE ${JSON.stringify(result)}`);
        }
      }
    }
  }
  const legacy = results.filter((row) => row.variant === "legacy");
  const unaffectedLegacy = legacy.filter((row) => !row.remove).every((row) => row.passed);
  const removedLegacy = legacy.find((row) => row.context === "direct" && row.remove && row.code === 0);
  const reproducedLegacyDeletion = removedLegacy.commandCompleted && removedLegacy.argumentsPreserved && removedLegacy.contextPreserved
    && removedLegacy.callerOutputExact && removedLegacy.removalExpected
    && removedLegacy.missingBatchDiagnostic && removedLegacy.observedExitCode === 1;
  const explicitExit = results.filter((row) => row.variant === "explicit-exit");
  const rejected = explicitExit.find((row) => row.context === "direct" && !row.remove && row.code === 1);
  const reproducedPlainExitRegression = rejected.commandCompleted && rejected.argumentsPreserved && rejected.contextPreserved
    && rejected.callerOutputExact && rejected.removalExpected && rejected.stderrExact
    && rejected.observedExitCode === 0;
  const passingCandidates = candidates.map(([name]) => name).filter((name) => {
    const rows = results.filter((row) => row.variant === name);
    return rows.length > 0 && rows.every((row) => row.passed);
  });
  const passed = unaffectedLegacy && reproducedLegacyDeletion && (matrix
    ? reproducedPlainExitRegression && passingCandidates.length > 0
    : explicitExit.every((row) => row.passed));
  const controlsPassed = { unaffectedLegacy, reproducedLegacyDeletion, reproducedPlainExitRegression };
  console.log(`WINDOWS_SHIM_ORACLE ${JSON.stringify({
    matrix, node: process.version, windows: release(), arch: process.arch,
    cases: results.length, controls: controlsPassed, passingCandidates, passed,
  })}`);
  if (!passed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
