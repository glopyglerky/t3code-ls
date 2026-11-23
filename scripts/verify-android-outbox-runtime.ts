// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - owned hosted emulator fixture.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [phase, proofArgument] = process.argv.slice(2);
Assert.ok(phase === "admit" || phase === "run");
Assert.equal(process.argv.length, 4);
Assert.equal(process.env.GITHUB_ACTIONS, "true", "Only the admitted hosted lane may operate this fixture");
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"], "Use the hosted loopback-only network namespace");
const temporary = FS.realpathSync(process.env.RUNNER_TEMP!);
const proof = Path.resolve(proofArgument!);
Assert.equal(proof, Path.join(temporary, "outbox-runtime-proof"));
FS.mkdirSync(proof, { recursive: true, mode: 0o700 });
const scratch = Path.join(temporary, "outbox-runtime-avd");
const sdkArgument = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const sdk = Path.resolve(sdkArgument ?? ".");
const adb = Path.join(sdk, "platform-tools/adb");
const emulator = Path.join(sdk, "emulator/emulator");
const avdmanager = Path.join(sdk, "cmdline-tools/latest/bin/avdmanager");
const image = Path.join(sdk, "system-images/android-36/google_apis/x86_64");
const packageName = "com.t3tools.t3code.dev";
const avdName = "t3-outbox-runtime";
const serial = "emulator-5558";
const root = Path.resolve(import.meta.dirname, "..");
let commandEnvironment = { ...process.env };
for (const name of ["ADB_SERVER_SOCKET", "ADB_SERVER_PORT", "ANDROID_ADB_SERVER_PORT", "ANDROID_SERIAL", "ADB_VENDOR_KEYS"]) {
  delete commandEnvironment[name];
}
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Hosted Android proof interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const report: Record<string, unknown> = { schema: 1, status: "running", phase, checkpoint: "host-admission",
  systemImage: "system-images;android-36;google_apis;x86_64",
  stock: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f" };
const save = () => FS.writeFileSync(Path.join(proof, `${phase}.json`), JSON.stringify(report, null, 2) + "\n");
const checkpoint = (name: string) => { report.checkpoint = name; save(); };
const run = (command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) => {
  abort.signal.throwIfAborted();
  const result = ChildProcess.spawnSync(command, args, {
    env: options.env ?? commandEnvironment, input: options.input, encoding: "utf8", timeout: 30_000,
    maxBuffer: 1_048_576, killSignal: "SIGKILL",
  });
  if (!options.allowFailure) Assert.equal(result.status, 0,
    `${Path.basename(command)} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const device = (args: string[], allowFailure = false) => run(adb, ["-s", serial, ...args], { allowFailure });
let child: ChildProcess.ChildProcess | undefined;
let closed: Promise<void> | undefined;
let logBytes = 0;
let logOverflow = false;
let ownsScratch = false;
let ownsAdb = false;
let failure: unknown;

async function unusedPort(port: number) {
  const server = Net.createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stopOwnedEmulator() {
  if (child === undefined || closed === undefined || child.pid === undefined) return;
  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child?.exitCode !== null || child?.signalCode !== null) return;
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  // This namespace and the admitted console port belong only to this child.
  ChildProcess.spawnSync(adb, ["-s", serial, "emu", "kill"], { env: commandEnvironment, timeout: 5_000, stdio: "ignore" });
  killGroup("SIGTERM");
  if (!(await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]))) killGroup("SIGKILL");
  Assert.ok(await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]), "Owned emulator did not close");
}

try {
  checkpoint("host-admission");
  Assert.ok(sdkArgument !== undefined && Path.isAbsolute(sdkArgument), "Set an absolute installed Android SDK root");
  FS.accessSync("/dev/kvm", FS.constants.R_OK | FS.constants.W_OK);
  for (const executable of [adb, emulator, avdmanager]) FS.accessSync(executable, FS.constants.X_OK);
  Assert.ok(!FS.existsSync(scratch), "Use a fresh task-owned emulator directory");
  FS.mkdirSync(scratch, { mode: 0o700 }); ownsScratch = true;
  const env = { ...commandEnvironment, ANDROID_AVD_HOME: Path.join(scratch, "avds"),
    ANDROID_USER_HOME: Path.join(scratch, "android-user") };
  FS.mkdirSync(env.ANDROID_AVD_HOME); FS.mkdirSync(env.ANDROID_USER_HOME);
  commandEnvironment = env;
  report.acceleration = run(emulator, ["-accel-check"]).stdout;
  report.emulatorVersion = run(emulator, ["-version"]).stdout;
  report.adbVersion = run(adb, ["version"]).stdout;
  ownsAdb = true;
  const devices = run(adb, ["devices"]).stdout.trim().split("\n").slice(1).filter((line) => line.trim());
  Assert.equal(devices.length, 0, "Refusing a host with existing Android devices or emulators");
  await unusedPort(5558); await unusedPort(5559);
  checkpoint("installed-system-image");
  Assert.ok(FS.existsSync(Path.join(image, "package.xml")),
    "Missing staged system-images;android-36;google_apis;x86_64");
  report.systemImageMetadataSha256 = Crypto.createHash("sha256").update(FS.readFileSync(Path.join(image, "package.xml"))).digest("hex");
  checkpoint("create-owned-avd");
  run(avdmanager, ["create", "avd", "--name", avdName, "--package", String(report.systemImage),
    "--path", Path.join(scratch, "device.avd"), "--device", "pixel_6"], { env, input: "no\n" });
  FS.appendFileSync(Path.join(scratch, "device.avd/config.ini"),
    "\nhw.ramSize=2048\nhw.cpu.ncore=2\ndisk.dataPartition.size=2G\n");
  checkpoint("boot-owned-emulator");
  const log = FS.openSync(Path.join(proof, `${phase}-emulator.log`), "w", 0o600);
  child = ChildProcess.spawn(emulator, ["-avd", avdName, "-port", "5558", "-accel", "on",
    "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-memory", "2048", "-cores", "2",
    "-gpu", "swiftshader"],
  { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  closed = new Promise<void>((resolve) => child!.once("close", () => { FS.closeSync(log); resolve(); }));
  child.once("error", () => { logOverflow = true; });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data: Buffer) => {
    logBytes += data.length;
    if (logBytes <= 1_048_576) FS.writeSync(log, data);
    else logOverflow = true;
  });
  const bootDeadline = Date.now() + 120_000;
  while (device(["shell", "getprop", "sys.boot_completed"], true).stdout.trim() !== "1") {
    abort.signal.throwIfAborted();
    Assert.ok(!logOverflow && child.exitCode === null && child.signalCode === null, "Emulator exited or exceeded its log budget");
    Assert.ok(Date.now() < bootDeadline, "Owned emulator boot timed out");
    await delay(1_000, undefined, { signal: abort.signal });
  }
  Assert.equal(device(["shell", "getprop", "ro.kernel.qemu"]).stdout.trim(), "1");
  Assert.equal(device(["shell", "getprop", "ro.product.cpu.abi"]).stdout.trim(), "x86_64");
  Assert.equal(device(["emu", "avd", "name"]).stdout.trim().split("\n")[0], avdName);
  report.boot = { serial, abi: "x86_64", completed: true };

  if (phase === "run") {
    const admission = JSON.parse(FS.readFileSync(Path.join(proof, "admit.json"), "utf8"));
    Assert.equal(admission.status, "passed", "The same job must pass admission before building");
    Assert.equal(admission.systemImageMetadataSha256, report.systemImageMetadataSha256);
    Assert.equal(admission.emulatorVersion, report.emulatorVersion);
    Assert.equal(admission.adbVersion, report.adbVersion);
    report.source = run("git", ["-C", root, "rev-parse", "HEAD", "HEAD^{tree}"]).stdout.trim().split("\n");
    for (const variant of ["positive", "missing-library"] as const) {
      checkpoint(`${variant}:package`);
      const apk = Path.join(temporary, `outbox-runtime-${variant}.apk`);
      const members = run("unzip", ["-Z1", apk]).stdout.split("\n");
      Assert.ok(members.includes("assets/index.android.bundle"), "APK must embed its JS; Metro is never started");
      Assert.equal(members.includes("lib/x86_64/libt3_outbox.so"), variant === "positive");
      if (variant === "missing-library") Assert.ok(!members.some((member) => /^lib\/[^/]+\/libt3_outbox\.so$/u.test(member)));
      if (variant === "positive") {
        const library = ChildProcess.execFileSync("unzip", ["-p", apk, "lib/x86_64/libt3_outbox.so"], {
          env: commandEnvironment, timeout: 30_000, maxBuffer: 16_777_216,
        });
        Assert.equal(library.subarray(0, 4).toString("hex"), "7f454c46");
        Assert.equal(library[4], 2, "The installed JNI library must use ELF64");
        Assert.equal(library[5], 1, "The installed JNI library must be little-endian");
        Assert.equal(library.readUInt16LE(18), 62, "The installed JNI library must target x86_64");
        report.packagedLibrarySha256 = Crypto.createHash("sha256").update(library).digest("hex");
      }
      const hash = Crypto.createHash("sha256");
      for await (const data of FS.createReadStream(apk)) hash.update(data);
      report[`${variant}ApkSha256`] = hash.digest("hex"); save();
      checkpoint(`${variant}:install`);
      if (variant === "missing-library") {
        device(["shell", "am", "force-stop", packageName]);
        device(["uninstall", packageName]);
      }
      device(["install", "--no-streaming", apk]);
      checkpoint(`${variant}:launch`);
      device(["logcat", "-c"]);
      device(["shell", "am", "start", "-W", "-n", `${packageName}/.MainActivity`]);
      let receipt: Record<string, unknown> | undefined;
      const deadline = Date.now() + 60_000;
      while (receipt === undefined) {
        abort.signal.throwIfAborted();
        const read = device(["logcat", "-d", "-v", "raw", "-s", "T3OutboxRuntimeProof:I", "*:S"]);
        const frame = read.stdout.split("\n").find((line) => line.startsWith("{"));
        if (frame !== undefined) receipt = JSON.parse(frame);
        else {
          Assert.ok(Date.now() < deadline, `${variant}: installed JS/JNI receipt timed out`);
          await delay(500, undefined, { signal: abort.signal });
        }
      }
      report[variant] = receipt; save();
      Assert.equal(receipt.schema, 1);
      if (variant === "positive") {
        Assert.equal(receipt.status, "passed");
        Assert.equal(receipt.checkpoint, "complete");
        Assert.ok(Array.isArray(receipt.matrix) && receipt.matrix.length === 64);
        Assert.deepEqual([...new Set(receipt.matrix)].sort(), [0, 1, 2]);
      } else {
        Assert.equal(receipt.status, "failed");
        Assert.equal(receipt.checkpoint, "select-native");
        Assert.equal(receipt.failure, "Native outbox policy is unavailable");
      }
      FS.writeFileSync(Path.join(proof, `${variant}-logcat.txt`),
        device(["logcat", "-d", "-t", "300"]).stdout);
    }
  }
  report.status = "passed";
  checkpoint("complete");
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  failure = error;
  if (child !== undefined) {
    const diagnostic = ChildProcess.spawnSync(adb, ["-s", serial, "logcat", "-d", "-t", "300"], {
      env: commandEnvironment, timeout: 5_000, encoding: "utf8", maxBuffer: 1_048_576,
    });
    FS.writeFileSync(Path.join(proof, "failure-logcat.txt"), diagnostic.stdout ?? "");
  }
} finally {
  let emulatorClosed = false;
  try { await stopOwnedEmulator(); emulatorClosed = true; }
  catch (error) { report.status = "failed"; report.cleanupFailure = String(error); failure ??= error; }
  finally {
    if (ownsAdb) ChildProcess.spawnSync(adb, ["kill-server"], { env: commandEnvironment, timeout: 5_000, stdio: "ignore" });
    if (ownsScratch && emulatorClosed) FS.rmSync(scratch, { recursive: true, force: true });
    else if (ownsScratch) report.scratchRetained = "outbox-runtime-avd";
    save(); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}
if (failure !== undefined) throw failure;
console.log(JSON.stringify(report));
