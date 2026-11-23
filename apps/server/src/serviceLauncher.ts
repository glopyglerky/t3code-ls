// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { installedApplicationDatabase } from "@t3tools/shared/applicationDatabase";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseLegacyServiceState,
  disabledServiceTask,
  parseServiceState,
  serviceTaskIsDisabled,
  serviceUnitBaseDirOf,
  serviceUnitLogPathOf,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_LOCK_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
  SERVICE_UNIT_ENV,
  systemdUnitDirectoryOf,
} from "./cloud/serviceProtocol.ts";
import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "./legacyServerOwner.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * Migrations count toward it and can scale with the database: tens of GB on a cold page cache
 * take minutes. A missed window rolls back the database, so the next attempt pays the same cost.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;
const TERMINATE_GRACE_MS = 5_000;
// A replacement started by a handoff waits up to two minutes for the stopping launcher.
const LOCK_RETRY_MS = 500;
const LOCK_ATTEMPTS = 240;
// Match contracts' SERVER_EXIT_CODE_STATE_DIR_OWNED without depending on Effect.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const STATE_DIR_OWNER_POLL_MS = 30_000;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface SealedPendingState {
  readonly protocol: 5;
  readonly activeVersion: string;
  readonly update: PendingServiceUpdate;
}

type LauncherDurableState = ServiceState | SealedPendingState;

function sameSealedPendingState(left: LauncherDurableState, right: SealedPendingState): boolean {
  return left.protocol === 5 && left.activeVersion === right.activeVersion &&
    left.update.id === right.update.id && left.update.fromVersion === right.update.fromVersion &&
    left.update.targetVersion === right.update.targetVersion && left.update.dbPath === right.update.dbPath;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function parseSealedPendingState(contents: string, baseDir: string): SealedPendingState | undefined {
  const state: unknown = JSON.parse(contents);
  if (!isRecord(state) || !hasKeys(state, ["protocol", "activeVersion", "update"]) ||
    state.protocol !== 5 || typeof state.activeVersion !== "string" ||
    state.activeVersion.length > 256 || !isExactServiceVersion(state.activeVersion) ||
    !isRecord(state.update)) return undefined;
  const update = state.update;
  if (!hasKeys(update, ["id", "fromVersion", "targetVersion", "dbPath", "status"]) ||
    typeof update.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(update.id) ||
    update.fromVersion !== state.activeVersion || typeof update.targetVersion !== "string" ||
    update.targetVersion.length > 256 || !isExactServiceVersion(update.targetVersion) ||
    compareExactServiceVersions(update.targetVersion, state.activeVersion) <= 0 ||
    update.status !== "pending" || typeof update.dbPath !== "string" || !NodePath.isAbsolute(baseDir) ||
    update.dbPath !== NodePath.join(baseDir, "userdata", "statev2.omdb")) return undefined;
  return { protocol: 5, activeVersion: state.activeVersion, update: {
    id: update.id, fromVersion: state.activeVersion, targetVersion: update.targetVersion,
    dbPath: update.dbPath, status: "pending",
  } };
}

function isTrialFileIdentity(value: unknown): value is {
  device: string; inode: string; created: string;
} {
  return isRecord(value) && hasKeys(value, ["device", "inode", "created"]) &&
    typeof value.device === "string" && /^[0-9a-f]{16}$/u.test(value.device) &&
    typeof value.inode === "string" && /^[0-9a-f]{16}$/u.test(value.inode) &&
    typeof value.created === "string" && /^[0-9]{1,30}$/u.test(value.created);
}

async function readLauncherState(
  filePath: string,
  baseDir: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<LauncherDurableState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const ordinary = parseServiceState(contents) ?? adoptLegacyServiceState(contents);
  if (ordinary !== undefined) return ordinary;
  if (environment.T3_CODE_LS_SEALED_TRIAL_RECOVERY === "1" &&
    Buffer.byteLength(contents) <= 8192) {
    const sealed = parseSealedPendingState(contents, baseDir);
    if (sealed !== undefined) return sealed;
  }
  throw new Error("Service state is invalid or unsupported.");
}

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

export async function readBundledNativeTrialHelper(entry: string, executable: string): Promise<{
  readonly engineRevision: string;
  readonly targetSchemaSha256: string;
  readonly sealedTrialRollback: boolean;
  readonly sha256: string;
} | null> {
  // The update contract belongs to the installed native binary beside this runtime.
  const directory = NodePath.join(NodePath.dirname(await NodeFSP.realpath(entry)), "native-bin");
  const expected = NodePath.join(directory, "t3-code-ls-db");
  if (executable !== expected) return null;
  const readFlags = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
  const manifestFile = await NodeFSP.open(NodePath.join(directory, "manifest.json"), readFlags);
  let manifest;
  try {
    const metadata = await manifestFile.stat();
    if (!metadata.isFile() || metadata.size > 1_048_576) return null;
    manifest = JSON.parse(await manifestFile.readFile("utf8"));
  } finally {
    await manifestFile.close();
  }
  if (manifest?.target !== "linux-x64" || manifest.rustTarget !== "x86_64-unknown-linux-gnu") return null;
  const declaredDigest = manifest?.files?.["t3-code-ls-db"];
  if (typeof declaredDigest !== "string" || !/^[0-9a-f]{64}$/u.test(declaredDigest)) return null;

  const helper = await NodeFSP.open(expected, readFlags);
  try {
    const before = await helper.stat();
    if (!before.isFile()) return null;
    const digest = NodeCrypto.createHash("sha256");
    for await (const chunk of helper.createReadStream({ autoClose: false })) digest.update(chunk);
    if (digest.digest("hex") !== declaredDigest) return null;
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      expected,
      ["trial-capabilities"],
      { env: {}, shell: false, timeout: 5_000, maxBuffer: 8192, killSignal: "SIGKILL" },
    );
    const after = await NodeFSP.lstat(expected);
    if (
      !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.ctimeMs !== after.ctimeMs
    ) return null;
    const response = JSON.parse(stdout);
    const result = response?.result;
    return response?.ok === true && result?.version === 1 && result.engine === "omdb" &&
      typeof result.engineRevision === "string" && /^[0-9a-f]{40}$/u.test(result.engineRevision) &&
      typeof result.targetSchemaSha256 === "string" && /^[0-9a-f]{64}$/u.test(result.targetSchemaSha256)
      ? {
          engineRevision: result.engineRevision, targetSchemaSha256: result.targetSchemaSha256,
          sealedTrialRollback: result.sealedTrialRollback === 1, sha256: declaredDigest,
        }
      : null;
  } finally {
    await helper.close();
  }
}

/**
 * The unit or launch agent that `t3 service install` wrote. Its program names
 * the runtime that ran the install, and a remote update never replaces it, so
 * after a commit the launcher points it at the committed runtime. Otherwise the
 * next start lands on a runtime that nothing in the service state records.
 */
export interface ServiceUnit {
  readonly path: string;
  /** systemd and Task Scheduler keep a loaded copy; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

const runSchtasks = (...args: ReadonlyArray<string>) =>
  NodeUtil.promisify(NodeChildProcess.execFile)("schtasks", args, {
    windowsHide: true,
    timeout: 30_000,
  });

/**
 * Registering replaces the task, so one the CLI disabled to keep the service stopped is
 * registered disabled. The caller holds the unit lease, as the CLI does to disable it.
 */
export async function registerServiceTask(
  unitPath: string,
  taskName: string,
  schtasks: (...args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }> = runSchtasks,
): Promise<void> {
  const register = (xmlPath: string) => schtasks("/Create", "/XML", xmlPath, "/TN", taskName, "/F");
  const registered = await schtasks("/Query", "/TN", taskName, "/XML");
  if (!serviceTaskIsDisabled(registered.stdout)) {
    await register(unitPath);
    return;
  }
  const disabledPath = `${unitPath}.${process.pid}.disabled`;
  try {
    const unit = await NodeFSP.readFile(unitPath, "utf8");
    await NodeFSP.writeFile(disabledPath, disabledServiceTask(unit));
    await register(disabledPath);
  } finally {
    await NodeFSP.rm(disabledPath, { force: true });
  }
}

// The manager's environment can differ from the one it gives services (environment.d).
async function readSystemdUnitDirectory(): Promise<string | undefined> {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "busctl",
      [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      { timeout: 5_000 },
    );
    const { data } = JSON.parse(stdout) as { readonly data?: unknown };
    return Array.isArray(data) && data.every((entry) => typeof entry === "string")
      ? systemdUnitDirectoryOf(data)
      : undefined;
  } catch {
    return undefined;
  }
}

async function serviceUnitFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceUnit | undefined> {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (!unitName) return undefined;
  if (unitName.endsWith(".xml")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) return undefined;
    const path = NodePath.win32.join(localAppData, "t3code", unitName);
    const taskName = serviceTaskName(env.USERDOMAIN ?? "", env.USERNAME ?? "");
    return { path, reload: () => registerServiceTask(path, taskName) };
  }
  const home = env.HOME?.trim();
  if (!home) return undefined;
  if (unitName.endsWith(".plist")) {
    return {
      path: NodePath.join(home, "Library", "LaunchAgents", unitName),
      reload: () => Promise.resolve(),
    };
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const unitDir =
    (await readSystemdUnitDirectory()) ??
    NodePath.join(
      xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : NodePath.join(home, ".config"),
      "systemd",
      "user",
    );
  return {
    path: NodePath.join(unitDir, unitName),
    reload: () =>
      new Promise((resolve, reject) => {
        NodeChildProcess.spawn("systemctl", ["--user", "daemon-reload"], {
          stdio: "ignore",
          timeout: 30_000,
        })
          .once("error", reject)
          .once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(new Error(`systemctl --user daemon-reload exited with ${code ?? signal}`)),
          );
      }),
  };
}

// systemd's ExecStart value, or the plist string or task argument before __service-launcher.
// Only the version segment changes, so quoted or escaped paths stay as rendered.
// The launch agent's PATH names a versions directory without the executable; leave it.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s"]+)([\\/]t3)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<]+)([\\/]t3<\/string>\s*<string>__service-launcher<\/string>)/,
  /(<Arguments>--headless "[^"<]*?[\\/]runtime[\\/]versions[\\/])([^\\/"<]+)([\\/]t3\.exe" "__service-launcher")/,
] as const;

/**
 * The unit contents with their program pointed at `version`'s runtime. A unit
 * already at that version or a newer one is returned unchanged: `t3 update`
 * may have repointed it to a later version while this commit was in flight.
 */
function repointServiceUnit(contents: string, version: string): string {
  for (const program of SERVICE_UNIT_PROGRAMS) {
    const match = program.exec(contents);
    if (match === null) continue;
    const [, prefix = "", current = "", suffix = ""] = match;
    if (isExactServiceVersion(current) && compareExactServiceVersions(current, version) >= 0) {
      return contents;
    }
    return contents.replace(program, () => `${prefix}${version}${suffix}`);
  }
  return contents;
}

const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVICE_LOG_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The service manager holds the log open for appending, so it is copied aside and emptied in
 * place rather than renamed. The copy is best effort: on a full disk the truncate frees space.
 */
async function boundServiceLog(logPath: string): Promise<void> {
  const size = await NodeFSP.stat(logPath).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size <= SERVICE_LOG_MAX_BYTES) return;
  const archivePath = `${logPath}.1`;
  const pendingArchivePath = `${archivePath}.tmp`;
  await NodeFSP.copyFile(logPath, pendingArchivePath)
    .then(() => NodeFSP.rename(pendingArchivePath, archivePath))
    .catch(() => NodeFSP.rm(pendingArchivePath, { force: true }).catch(() => undefined));
  await NodeFSP.truncate(logPath, 0).catch(() => undefined);
}

async function serviceLogPath(
  options: LauncherOptions,
  serviceUnit: ServiceUnit | undefined,
): Promise<string | undefined> {
  if (options.logFile !== undefined) return options.logFile;
  if (serviceUnit === undefined) return undefined;
  const contents = await NodeFSP.readFile(serviceUnit.path, "utf8").catch(() => undefined);
  return contents === undefined ? undefined : serviceUnitLogPathOf(contents);
}

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const NATIVE_OWNER_MARKER = Buffer.from("t3code-omdb-owner-v1\n");

const databaseBackupDir = (baseDir: string, updateId: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(updateId)) throw new Error("Invalid database backup update ID.");
  return NodePath.join(baseDir, "runtime", "db-backup", updateId);
};

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

async function filePrefix(filePath: string, length: number): Promise<Buffer | undefined> {
  const file = await NodeFSP.open(filePath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK)
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
  if (file === undefined) return undefined;
  try {
    if (!(await file.stat()).isFile()) throw new Error("Expected a regular file.");
    const prefix = Buffer.alloc(length);
    const { bytesRead } = await file.read(prefix, 0, length, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

// SQLite also accepts an empty file as an uninitialized database.
const isSqlitePrefix = (prefix: Buffer | undefined) =>
  prefix !== undefined &&
  (prefix.length === 0 || prefix.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER));

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "T3CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

// Opened read-write: Windows refuses to flush a handle without write access.
async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Fsync makes renames durable; Windows returns EPERM and NTFS journals them itself.
async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

function runCp(args: ReadonlyArray<string>): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("cp", args, (error) => resolve(error === null));
  });
}

// macOS fs.copyFile clone flags fall back to full copies.
async function copyDatabaseFile(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args === undefined || !(await runCp(args))) await NodeFSP.copyFile(source, destination);
}

const GIB = 1024 ** 3;
// Cloned backups still need headroom for trial writes and migrations to diverge.
const CLONED_BACKUP_MIN_HEADROOM_BYTES = GIB;
const CLONED_BACKUP_HEADROOM_FRACTION = 0.1;
// While the online backup holds its snapshot, the live WAL and its copy can each reach the server's 128 MiB gate.
const ONLINE_BACKUP_WAL_HEADROOM_BYTES = 2 * 128 * 1024 ** 2;

async function statDatabaseFiles(dbPath: string): Promise<ReadonlyArray<NodeFS.Stats>> {
  const stats: Array<NodeFS.Stats> = [];
  for (const suffix of DB_FILE_SUFFIXES) {
    const stat = await NodeFSP.stat(`${dbPath}${suffix}`).catch((cause: unknown) => {
      if (suffix !== "" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
}

// cp -c silently copies across volumes; require one device matching the APFS system volume's filesystem type.
async function backupCanClone(dbPath: string, backupRoot: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  if (platform === "darwin") {
    const [backupDirectory, backupFs, systemFs] = await Promise.all([
      NodeFSP.stat(backupRoot),
      NodeFSP.statfs(backupRoot),
      NodeFSP.statfs("/"),
    ]);
    if (backupFs.type !== systemFs.type) return false;
    return (await statDatabaseFiles(dbPath)).every(
      (source) => source.dev === backupDirectory.dev && source.nlink === 1,
    );
  }
  if (platform !== "linux") return false;
  const probe = NodePath.join(backupRoot, `.clone-probe-${NodeCrypto.randomUUID()}`);
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      if (!(await runCp(["--reflink=always", source, `${probe}${suffix}`]))) return false;
    }
    return true;
  } finally {
    for (const suffix of DB_FILE_SUFFIXES) {
      await NodeFSP.rm(`${probe}${suffix}`, { force: true }).catch(() => undefined);
    }
  }
}

export interface BackupSpaceProbe {
  readonly readFreeBytes: (directory: string) => Promise<number>;
  readonly canClone: (dbPath: string, backupRoot: string) => Promise<boolean>;
}

const filesystemBackupSpaceProbe: BackupSpaceProbe = {
  readFreeBytes: async (directory) => {
    const stats = await NodeFSP.statfs(directory);
    return stats.bavail * stats.bsize;
  },
  canClone: backupCanClone,
};

// A killed launcher skips the backup's cleanup, and retries only clear their own update's copy.
// Update requests are refused while one is pending, so no staging directory is still in use here.
async function removeAbandonedBackupCopies(backupRoot: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(backupRoot)) {
    if (!entry.endsWith(".staging")) continue;
    await NodeFSP.rm(NodePath.join(backupRoot, entry), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Check before stopping the server so full disks refuse updates without an outage. */
export async function databaseBackupBlocker(
  baseDir: string,
  dbPath: string,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<string | undefined> {
  const { readFreeBytes, canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  const backupRoot = NodePath.join(baseDir, "runtime", "db-backup");
  await NodeFSP.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await removeAbandonedBackupCopies(backupRoot);
  const [files, free] = await Promise.all([statDatabaseFiles(dbPath), readFreeBytes(backupRoot)]);
  const size = files.reduce((total, file) => total + file.size, 0);
  const fullCopyBytes = size * 1.05 + ONLINE_BACKUP_WAL_HEADROOM_BYTES;
  if (free >= fullCopyBytes) return undefined;
  const clonedBytes = Math.max(
    CLONED_BACKUP_MIN_HEADROOM_BYTES,
    size * CLONED_BACKUP_HEADROOM_FRACTION,
  );
  const needed = (await canClone(dbPath, backupRoot)) ? clonedBytes : fullCopyBytes;
  if (free >= needed) return undefined;
  const gb = (bytes: number) => (bytes / GIB).toFixed(1);
  return `Not enough free disk space to back up the database before updating: ${gb(needed)} GB needed, ${gb(free)} GB free. Free up disk space and try again. The server was not stopped.`;
}

// A child-process copy: closing any descriptor this process opens on the database drops the snapshot's POSIX locks.
async function copyWithoutOpening(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  if (process.platform === "win32") return NodeFSP.copyFile(source, destination);
  if (!(await runCp([source, destination]))) throw new Error(`cp ${source} failed.`);
}

// Copies the main file while the server runs; an open read transaction stops SQLite resetting the WAL,
// which `finish` copies after the stop and which overrides any page the copy caught mid-checkpoint.
// `-shm` is left out: its backfill count would make SQLite trust those pages. Past the WAL size gate,
// a write-heavy server's new writes wait, uncommitted, until the server stops.
async function startOnlineDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<(() => Promise<void>) | undefined> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return undefined;
  const { canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  if (await canClone(pending.dbPath, NodePath.dirname(backupDir)).catch(() => true))
    return undefined;
  const NodeSqlite = await import("node:sqlite").catch(() => undefined);
  if (NodeSqlite === undefined) return undefined;

  const stagingDir = `${backupDir}.staging`;
  const discardStaging = () =>
    NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  const fallBack = async (cause: unknown) => {
    await discardStaging();
    process.stderr.write(
      `[service-launcher] Copying the database while the server runs failed; backing it up offline: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return undefined;
  };
  let snapshot: InstanceType<typeof NodeSqlite.DatabaseSync> | undefined;
  // SQLite keeps -wal beside the resolved file, not beside a symlink to it.
  let dbPath = pending.dbPath;
  const release = () => {
    try {
      snapshot?.close();
    } catch {}
    snapshot = undefined;
  };
  try {
    await discardStaging();
    await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    dbPath = await NodeFSP.realpath(pending.dbPath);
    snapshot = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const mode = String(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode);
    if (mode.toLowerCase() !== "wal") throw new Error(`journal_mode is ${mode}, not wal.`);
    snapshot.exec("BEGIN");
    snapshot.prepare("SELECT count(*) FROM sqlite_schema").get();
    const mainCopy = databaseBackupFile(stagingDir, "");
    await copyWithoutOpening(dbPath, mainCopy);
    await syncFile(mainCopy);
  } catch (cause) {
    release();
    return fallBack(cause);
  }
  return async () => {
    try {
      const wal = `${dbPath}-wal`;
      if (!(await pathExists(wal)))
        throw new Error("the WAL disappeared while the snapshot was open.");
      const walCopy = databaseBackupFile(stagingDir, "-wal");
      await copyWithoutOpening(wal, walCopy);
      await syncFile(walCopy);
      release();
      await NodeFSP.rename(stagingDir, backupDir);
      await syncDirectory(NodePath.dirname(backupDir));
    } catch (cause) {
      release();
      await fallBack(cause);
    }
  };
}

// Preserve completed backups; restarted trials may already have changed the live database.
async function backupDatabaseOnce(baseDir: string, pending: PendingServiceUpdate): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

// Mark before live writes so recovery cannot boot a partial restore.
async function markDatabaseRestorePending(backupDir: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, RESTORE_MARKER);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

// Resolve symlink targets even if a crashed cp -c left the final target missing.
async function restoreTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return undefined;
      throw cause;
    });
    if (link === undefined) return current;
    // Do not normalize .. before following directory symlinks; match filesystem resolution.
    current = NodePath.isAbsolute(link)
      ? link
      : `${await NodeFSP.realpath(NodePath.dirname(current))}${NodePath.sep}${link}`;
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);
  const directories = new Set([NodePath.dirname(pending.dbPath)]);
  // SQLite keeps -wal and -shm beside the resolved database file, not beside a symlink to it.
  const mainTarget = await restoreTarget(pending.dbPath);
  for (const suffix of DB_FILE_SUFFIXES) {
    const livePath = suffix === "" ? pending.dbPath : `${mainTarget}${suffix}`;
    if (livePath !== `${pending.dbPath}${suffix}`) {
      await NodeFSP.rm(`${pending.dbPath}${suffix}`, { force: true });
    }
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      // Restore into the symlink target; cloning would replace the link.
      const target = await restoreTarget(livePath);
      await copyDatabaseFile(source, target);
      await syncFile(target);
      directories.add(NodePath.dirname(target));
    } else {
      await NodeFSP.rm(livePath, { force: true });
    }
  }
  for (const directory of directories) await syncDirectory(directory);
}

async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? adoptLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

// An older coordinator can write protocol 2 beside a newer runtime. Adopt
// only its install record, in memory: rewriting it outside the selection lock
// could replace state a concurrent install wrote after this read.
function adoptLegacyServiceState(contents: string): ServiceState | undefined {
  const legacy = parseLegacyServiceState(contents);
  return legacy && { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: legacy.activeVersion };
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function replaceFileDurably(filePath: string, contents: string): Promise<void> {
  const directory = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  overIpc: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (overIpc) {
    await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
  } else {
    child.kill(signal);
  }
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

/** Task Scheduler names are machine-wide, so each Windows account runs its own task. */
export const serviceTaskName = (domain: string, userName: string) => `t3code-${domain}-${userName}`;

export const serviceLauncherLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_LAUNCHER_LOCK_FILE);

// An exclusive SQLite transaction, like the server's owner lock: the OS drops it when the holder dies.
async function tryAcquireSqliteLock(
  lockPath: string,
): Promise<{ readonly close: () => void } | undefined> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return db;
  } catch (cause) {
    db.close();
    if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return undefined;
    throw cause;
  }
}

export async function serviceLauncherIsRunning(lockPath: string): Promise<boolean> {
  if (!NodeFS.existsSync(lockPath)) return false;
  const lock = await tryAcquireSqliteLock(lockPath);
  lock?.close();
  return lock === undefined;
}

/** Resolves once no launcher holds the lock; the caller bounds the wait through `signal`. */
export async function waitForServiceLauncherExit(
  lockPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (await serviceLauncherIsRunning(lockPath)) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Mirror acquireServerOwnership: the lock, then a live pre-lock server-runtime.json owner;
// leave other failures for server startup to report.
export async function stateDirOwned(baseDir: string): Promise<boolean> {
  const stateDir = NodePath.join(baseDir, "userdata");
  const lock = await tryAcquireSqliteLock(NodePath.join(stateDir, "server-owner.sqlite")).catch(
    () => null,
  );
  if (lock === null) return false;
  if (lock === undefined) return true;
  lock.close();
  let record: unknown;
  try {
    record = JSON.parse(
      await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null || "ownerId" in record) return false;
  const pid = "pid" in record ? record.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
  }
  const recordedAt = Date.parse(
    "startedAt" in record && typeof record.startedAt === "string" ? record.startedAt : "",
  );
  if (!Number.isFinite(recordedAt)) return true;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  const output = await new Promise<string | undefined>((resolve) =>
    NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    ),
  );
  return legacyOwnerStartedBeforeRecord(output, recordedAt, platform);
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: LauncherDurableState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  readonly #completion = Promise.withResolvers<void>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #serviceUnit: ServiceUnit | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #stateDirOwnerPollMs: number;
  #stateDirFreeProbes = 0;
  readonly #output: number | undefined;
  readonly #lockPath: string | undefined;
  readonly #stopChildOverIpc: boolean;

  constructor(
    baseDir: string,
    state: LauncherDurableState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly serviceUnit?: ServiceUnit;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly stateDirOwnerPollMs?: number;
      /** Launcher and server output, for managers that cannot redirect it. */
      readonly output?: number;
      /** Makes this the only launcher for its home; a replacement waits for the one stopping. */
      readonly lockPath?: string;
      /** Windows `kill()` is TerminateProcess, which skips the server's shutdown finalizers. */
      readonly stopChildOverIpc?: boolean;
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#stateDirOwnerPollMs = options.stateDirOwnerPollMs ?? STATE_DIR_OWNER_POLL_MS;
    this.#backupSpaceProbe = options.backupSpaceProbe;
    this.#serviceUnit = options.serviceUnit;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#output = options.output;
    this.#lockPath = options.lockPath;
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
    this.#stopChildOverIpc = options.stopChildOverIpc ?? process.platform === "win32";
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      const lock =
        this.#lockPath === undefined ? undefined : await this.#acquireLock(this.#lockPath);
      try {
        // The launcher that held the lock may have moved the state since main read it.
        if (lock !== undefined) this.#state = await this.#readState();
        // A stop that arrived before this point leaves nothing to start or recover.
        if (!this.#stopRequested) this.#enqueue(() => this.#recover());
        await this.#completion.promise;
      } finally {
        if (lock !== undefined) {
          // Releasing the lock says this launcher is done with the home.
          await this.#transitions.catch(() => undefined);
          lock.close();
        }
      }
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  async #acquireLock(lockPath: string): Promise<{ readonly close: () => void } | undefined> {
    for (let attempt = 1; !this.#stopRequested; attempt++) {
      const lock = await tryAcquireSqliteLock(lockPath);
      if (lock !== undefined) return lock;
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error("Another T3 Code service launcher still runs for this T3 home.");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return undefined;
  }

  #terminate(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    return terminateChild(child, signal, this.#stopChildOverIpc);
  }

  #log(line: string): void {
    if (this.#output === undefined) process.stderr.write(line);
    else NodeFS.writeSync(this.#output, line);
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await this.#terminate(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // Write synchronously on signal receipt; a terminating child needs the marker in its finalizer.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {}
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let in-progress updates start replacements first; replacements observe the marker and own pre-activation tunnel cleanup.
      this.#stopping = true;
      // An exit-78 transition queued before this one may have started the owner poll.
      this.#clearTimer();
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await this.#terminate(child, signal);
      this.#done = true;
      this.#completion.resolve();
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #selectState(next: ServiceState): Promise<void> {
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      const selected = await this.#readState();
      // Local installs replace the selection and clear its update record. An old
      // launcher must not restore its own selection when asked to update again.
      if (
        (this.#state.protocol === 5 && !sameSealedPendingState(selected, this.#state)) ||
        selected.protocol !== this.#state.protocol ||
        selected.activeVersion !== this.#state.activeVersion ||
        selected.update?.id !== this.#state.update?.id ||
        selected.update?.status !== this.#state.update?.status
      ) {
        throw new Error("Service selection changed. Restart the service before updating.");
      }
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    } finally {
      release();
    }
  }

  async #recover(): Promise<void> {
    if (this.#state.protocol === 5) {
      await this.#recoverSealedTrial(this.#state);
      return;
    }
    // Clear old stop markers to preserve future tunnels; clear restart-pending only for the awaited version to avoid CLI races.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const restartPending = restartPendingPath(this.#baseDir);
    try {
      const release = await acquireServiceSelectionLock(this.#statePath);
      try {
        const selected = await readServiceState(this.#statePath);
        const awaitedVersion = await NodeFSP.readFile(restartPending, "utf8").catch(
          () => undefined,
        );
        const awaited = awaitedVersion?.trim();
        if (
          selected.activeVersion === this.#state.activeVersion &&
          selected.update?.id === this.#state.update?.id &&
          selected.update?.status === this.#state.update?.status &&
          awaited !== undefined &&
          isExactServiceVersion(awaited) &&
          compareExactServiceVersions(awaited, this.#state.activeVersion) <= 0
        ) {
          await NodeFSP.rm(restartPending, { force: true });
        }
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      try {
        await this.#startChild(this.#state.activeVersion, "active", update);
      } finally {
        if (update !== undefined) await this.#repointServiceUnit(this.#state.activeVersion);
      }
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      return;
    }
    await this.#startTrial(update);
  }

  #readState(): Promise<LauncherDurableState> {
    return readLauncherState(this.#statePath, this.#baseDir, this.#environment);
  }

  async #recoverSealedTrial(state: SealedPendingState): Promise<void> {
    if (this.#environment.T3_CODE_LS_SEALED_TRIAL_RECOVERY !== "1" ||
      process.platform !== "linux" || process.arch !== "x64" ||
      this.#environment.T3_CODE_LS_DB_EXECUTABLE !== undefined) {
      throw new Error("Sealed native trial recovery requires an opted-in Linux x64 installed helper.");
    }
    const selected = await this.#readState();
    if (!sameSealedPendingState(selected, state)) {
      throw new Error("The sealed native trial selection changed.");
    }
    const pending = state.update;
    if (!(await runtimeExists(this.#baseDir, pending.fromVersion))) {
      throw new Error("The sealed native trial's previous runtime is unavailable.");
    }
    const { entryPath } = runtimePaths(this.#baseDir, pending.fromVersion);
    const selection = installedApplicationDatabase(entryPath, this.#environment);
    if (selection.kind !== "omdb") throw new Error("The previous runtime does not select native storage.");
    const helper = await readBundledNativeTrialHelper(entryPath, selection.executable);
    if (helper?.sealedTrialRollback !== true) {
      throw new Error("The previous runtime's installed helper does not qualify sealed rollback.");
    }
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      selection.executable,
      ["trial-rollback-sealed", this.#baseDir, pending.id],
      { env: {}, shell: false, timeout: 60_000, maxBuffer: 8192, killSignal: "SIGKILL" },
    );
    const response: unknown = JSON.parse(stdout);
    const result = isRecord(response) && hasKeys(response, ["ok", "result"]) && response.ok === true
      ? response.result : undefined;
    const activation = isRecord(result) ? result.activation : undefined;
    const database = isRecord(result) ? result.database : undefined;
    if (!isRecord(result) || !hasKeys(result, ["activation", "database", "preserved_database", "reused"]) ||
      !isRecord(activation) || !hasKeys(activation, [
        "update_id", "from_version", "target_version", "target_entry_sha256",
        "target_helper_sha256", "target_schema_sha256",
      ]) || !isTrialFileIdentity(database) || !isTrialFileIdentity(result.preserved_database) ||
      activation.update_id !== pending.id || activation.from_version !== pending.fromVersion ||
      activation.target_version !== pending.targetVersion || typeof result.reused !== "boolean" ||
      ![activation.target_entry_sha256, activation.target_helper_sha256, activation.target_schema_sha256]
        .every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest))) {
      throw new Error("The sealed rollback receipt does not match the pending trial.");
    }
    const verified = await readBundledNativeTrialHelper(entryPath, selection.executable);
    const restored = await NodeFSP.lstat(pending.dbPath, { bigint: true });
    if (verified?.sealedTrialRollback !== true || verified.sha256 !== helper.sha256 ||
      !restored.isFile() || restored.nlink !== 1n ||
      restored.dev.toString(16).padStart(16, "0") !== database.device ||
      restored.ino.toString(16).padStart(16, "0") !== database.inode ||
      restored.birthtimeNs.toString() !== database.created) {
      throw new Error("The sealed rollback helper or restored database changed.");
    }
    const outcome = terminalUpdate({ pending, status: "rolled-back", reason: "sealed-trial-recovery" });
    await this.#selectState({
      protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: pending.fromVersion, update: outcome,
    });
    if (this.#stopRequested) return;
    try {
      await this.#startChild(pending.fromVersion, "active", outcome);
    } finally {
      await this.#repointServiceUnit(pending.fromVersion);
    }
  }

  async #databaseTrialBlocker(
    update: Pick<PendingServiceUpdate, "dbPath" | "fromVersion" | "targetVersion">,
    existingBackup?: { readonly directory: string; readonly restoring: boolean },
  ): Promise<string | undefined> {
    try {
      if (!NodePath.isAbsolute(update.dbPath)) return "The database path is not absolute.";
      const stateDir = NodePath.join(this.#baseDir, "userdata");
      const marker = await filePrefix(
        NodePath.join(stateDir, "server-owner.sqlite"),
        NATIVE_OWNER_MARKER.length + 1,
      );
      if (marker !== undefined && !marker.equals(NATIVE_OWNER_MARKER) && !isSqlitePrefix(marker)) {
        return "The database ownership marker could not be verified.";
      }

      const selection = async (version: string) => {
        const { entryPath } = runtimePaths(this.#baseDir, version);
        const entry = await NodeFSP.lstat(entryPath).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined;
          throw cause;
        });
        if (entry === undefined) return undefined;
        if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error("Invalid runtime entry.");
        return installedApplicationDatabase(entryPath, this.#environment);
      };
      const [active, target] = await Promise.all([
        selection(update.fromVersion),
        selection(update.targetVersion),
      ]);
      const nativeOwned = marker?.equals(NATIVE_OWNER_MARKER) === true;
      if (nativeOwned || active?.kind === "omdb" || target?.kind === "omdb") {
        const source = NodePath.join(stateDir, "statev2.omdb");
        if (
          nativeOwned &&
          active?.kind === "omdb" &&
          target?.kind === "omdb" &&
          NodePath.resolve(update.dbPath) === NodePath.resolve(source) &&
          (await filePrefix(source, 1))?.length === 1
        ) {
          // A component override is valid for testing the normal server. The launcher
          // needs a capability bound to each version's own installed helper.
          if (this.#environment.T3_CODE_LS_DB_EXECUTABLE !== undefined) {
            return "The native database trial requires the installed native helper for each runtime.";
          }
          const [currentHelper, candidateHelper] = await Promise.all([
            readBundledNativeTrialHelper(runtimePaths(this.#baseDir, update.fromVersion).entryPath, active.executable),
            readBundledNativeTrialHelper(runtimePaths(this.#baseDir, update.targetVersion).entryPath, target.executable),
          ]).catch(() => [null, null]);
          if (currentHelper == null || candidateHelper == null) {
            return "The native database trial could not verify both installed helpers.";
          }
          if (currentHelper.engineRevision !== candidateHelper.engineRevision) {
            return "The native database trial requires a supported transition between the installed storage engines.";
          }
          return "The native database trial requires a durable checkpoint and an isolated database generation before activation.";
        }
        return "The native database ownership, existing source and selected runtimes do not establish a compatible service trial.";
      }

      const live = await filePrefix(update.dbPath, SQLITE_HEADER.length);
      let sqliteBackup = false;
      if (existingBackup !== undefined && (await pathExists(existingBackup.directory))) {
        const backupPath = databaseBackupFile(existingBackup.directory, "");
        sqliteBackup = isSqlitePrefix(await filePrefix(backupPath, SQLITE_HEADER.length));
        if (!sqliteBackup) return "The SQLite backup format could not be verified.";
      }
      // A stopped restore may leave a missing file or a partial header at its original path.
      const interruptedCopy =
        (live === undefined || SQLITE_HEADER.subarray(0, live.length).equals(live)) &&
        existingBackup?.restoring &&
        sqliteBackup;
      if (!isSqlitePrefix(live) && !interruptedCopy) {
        return "The SQLite database format could not be verified.";
      }
      return undefined;
    } catch {
      return "The database source or selected runtime could not be verified.";
    }
  }

  async #verifyPendingTrial(pending: PendingServiceUpdate, restoring = false): Promise<void> {
    const blocker = await this.#databaseTrialBlocker(pending, {
      directory: databaseBackupDir(this.#baseDir, pending.id),
      restoring,
    });
    if (blocker !== undefined) {
      throw new Error(
        `${blocker} Service update ${pending.id} requires recovery. The pending selection and database files were preserved.`,
      );
    }
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    await this.#verifyPendingTrial(pending);
    try {
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(update === undefined ? {} : { update }),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
      env: { ...this.#environment, [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) },
      stdio:
        this.#output === undefined
          ? ["inherit", "inherit", "inherit", "ipc"]
          : ["ignore", this.#output, this.#output, "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#enqueue(() => Promise.reject(error)));
        resolve();
      });
    });
    if (this.#stopping) {
      await this.#terminate(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    await this.#handlePrepared(child, message.updateId);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactServiceVersions(message.targetVersion, child.version) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }
    const trialBlocker = await this.#databaseTrialBlocker({
      dbPath: message.dbPath,
      fromVersion: child.version,
      targetVersion: message.targetVersion,
    });
    if (!child.process.connected) return;
    if (trialBlocker !== undefined) {
      await reject(`${trialBlocker} The active server remains running.`);
      return;
    }
    // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
    const backupBlocker = await databaseBackupBlocker(
      this.#baseDir,
      message.dbPath,
      this.#backupSpaceProbe,
    ).catch(
      (error: unknown) =>
        `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
    );
    if (!child.process.connected) return;
    if (backupBlocker !== undefined) {
      await reject(backupBlocker);
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, protocol: SERVICE_LAUNCHER_PROTOCOL, update: pending };
    try {
      await this.#selectState(next);
    } catch (error) {
      await reject(error instanceof Error ? error.message : String(error));
      return;
    }
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const state = this.#state;
    const pending = state.update;
    if (
      state.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
      this.#child !== child ||
      child.role !== "active" ||
      pending?.status !== "pending"
    ) {
      return;
    }
    this.#timer = undefined;
    const blocker = await this.#databaseTrialBlocker(pending);
    if (blocker !== undefined) {
      await this.#selectState({
        ...state,
        update: terminalUpdate({ pending, status: "failed", reason: blocker }),
      });
      return;
    }
    // Anything thrown outside its own fallback still leaves the offline backup to run.
    const finishOnlineBackup = await startOnlineDatabaseBackup(
      this.#baseDir,
      pending,
      this.#backupSpaceProbe,
    ).catch(() => undefined);
    this.#child = null;
    await this.#terminate(child.process);
    await finishOnlineBackup?.();
    // A stop during a minutes-long copy should not start a trial; restart resumes the pending update.
    if (this.#stopRequested) return;
    await this.#startTrial(pending);
  }

  async #handlePrepared(child: ManagedChild, updateId: string): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    await this.#verifyPendingTrial(pending);
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await this.#selectState(next);
    child.role = "active";
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    try {
      await sendMessage(child.process, { type: "committed", updateId: committed.id });
    } finally {
      await this.#repointServiceUnit(committed.targetVersion);
    }
  }

  // Selection is durable before this best-effort unit reconciliation.
  async #repointServiceUnit(version: string): Promise<void> {
    const unit = this.#serviceUnit;
    if (unit === undefined) return;
    try {
      const release = await acquireServiceSelectionLock(unit.path);
      try {
        // The installer writes state before the unit under this lease. Do not
        // acquire its state lease here: the installer takes that lease first.
        const selected = await readServiceState(this.#statePath);
        if (
          selected.activeVersion !== this.#state.activeVersion ||
          selected.update?.id !== this.#state.update?.id ||
          selected.update?.status !== this.#state.update?.status
        ) {
          return;
        }
        const contents = await NodeFSP.readFile(unit.path, "utf8");
        const installedBaseDir = serviceUnitBaseDirOf(contents);
        if (
          installedBaseDir === undefined ||
          NodePath.resolve(installedBaseDir) !== NodePath.resolve(this.#baseDir)
        ) {
          return;
        }
        const repointed = repointServiceUnit(contents, version);
        if (repointed !== contents) await replaceFileDurably(unit.path, repointed);
        // A previous rename may have succeeded before reload failed.
        await unit.reload();
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not point ${unit.path} at t3@${version}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (code === STATE_DIR_OWNED_EXIT_CODE) {
      await this.#idleWhileStateDirOwned();
      return;
    }
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  // Stay idle until the lock frees to avoid supervisor restart loops. A pending update resumes its
  // trial, since the other owner may have migrated the database past fromVersion. It stays pending
  // only once its backup is gone, so no later trial, even after a launcher restart, restores it over
  // the other owner's writes; exit 78 comes before the child opens the database.
  async #idleWhileStateDirOwned(): Promise<void> {
    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#verifyPendingTrial(pending);
      const discarded = await discardDatabaseBackup(this.#baseDir, pending.id).then(
        () => true,
        () => false,
      );
      if (!discarded) {
        const next: ServiceState = {
          ...this.#state,
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
        };
        await this.#selectState(next);
        await this.#repointServiceUnit(next.activeVersion);
      }
    }
    this.#log(
      "[service-launcher] Another T3 Code server owns this T3 home. This service starts again once it stops.\n",
    );
    this.#stateDirFreeProbes = 0;
    // The interval also keeps Node alive: signal listeners alone do not.
    this.#timer = setInterval(
      () => this.#enqueue(() => this.#reclaimStateDir()),
      this.#stateDirOwnerPollMs,
    );
  }

  async #reclaimStateDir(): Promise<void> {
    if (this.#stopRequested) {
      this.#clearTimer();
      return;
    }
    if (this.#timer === undefined || this.#child !== null) return;
    const owned = await stateDirOwned(this.#baseDir);
    // A stop during the probe clears the timer.
    if (this.#timer === undefined) return;
    // A relaunching desktop app frees the home for a few seconds; leave it that gap.
    this.#stateDirFreeProbes = owned ? 0 : this.#stateDirFreeProbes + 1;
    if (this.#stateDirFreeProbes < 2) return;
    this.#clearTimer();
    this.#log("[service-launcher] The T3 home is free again. Starting the server.\n");
    const update = this.#state.update;
    if (update?.status === "pending") await this.#startTrial(update);
    else await this.#startChild(this.#state.activeVersion, "active", update);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await this.#terminate(child.process);
    }
    await this.#verifyPendingTrial(pending, true);
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await this.#selectState(next);
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    try {
      await this.#startChild(next.activeVersion, "active", outcome);
    } finally {
      await this.#repointServiceUnit(next.activeVersion);
    }
  }
}

/** Task Scheduler cannot set variables or redirect output, so a Windows task passes them as flags. */
export interface LauncherOptions {
  readonly baseDir?: string | undefined;
  readonly logFile?: string | undefined;
  readonly serviceUnit?: string | undefined;
}

export async function main(options: LauncherOptions = {}): Promise<void> {
  const baseDir = options.baseDir ?? process.env.T3CODE_HOME;
  if (baseDir === undefined || baseDir.trim() === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const output =
    options.logFile === undefined ? undefined : NodeFS.openSync(options.logFile, "a", 0o600);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const windows = process.platform === "win32";
  let logTimer: NodeJS.Timeout | undefined;
  try {
    // What the service manager started the launcher with. It locates the unit; service.env
    // changes only what the server gets.
    const managerEnvironment = {
      ...process.env,
      T3CODE_HOME: baseDir,
      ...(options.serviceUnit === undefined ? {} : { [SERVICE_UNIT_ENV]: options.serviceUnit }),
    };
    const environment = await readServiceEnvironment(baseDir, managerEnvironment);
    const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    const contents = await NodeFSP.readFile(statePath, "utf8");
    let state: LauncherDurableState | undefined = parseServiceState(contents);
    if (state === undefined) {
      state = adoptLegacyServiceState(contents);
      if (state === undefined) state = await readLauncherState(statePath, baseDir, environment);
      else if (!(await runtimeExists(baseDir, state.activeVersion))) {
        throw new Error(`Selected t3@${state.activeVersion} runtime is missing or incomplete.`);
      }
    }
    const serviceUnit = await serviceUnitFromEnvironment(managerEnvironment);
    const logPath = await serviceLogPath(options, serviceUnit);
    if (logPath !== undefined) {
      await boundServiceLog(logPath);
      logTimer = setInterval(
        () => void boundServiceLog(logPath),
        SERVICE_LOG_CHECK_INTERVAL_MS,
      ).unref();
    }
    const launcher = new Launcher(baseDir, state, {
      environment,
      ...(serviceUnit === undefined ? {} : { serviceUnit }),
      ...(output === undefined ? {} : { output }),
      ...(windows ? { lockPath: serviceLauncherLockPath(baseDir) } : {}),
    });
    // Ending a scheduled task kills its console host without a signal; the console read fails instead.
    const watchConsole = windows && process.stdin.isTTY === true;
    const onConsoleLost = () => void launcher.stop("SIGTERM");
    if (watchConsole) {
      process.stdin.on("error", () => undefined);
      process.stdin.once("close", onConsoleLost);
      process.stdin.resume();
    }
    try {
      await launcher.run();
    } finally {
      if (watchConsole) {
        process.stdin.off("close", onConsoleLost);
        process.stdin.destroy();
      }
    }
  } catch (cause) {
    if (output !== undefined) {
      NodeFS.writeSync(
        output,
        `[service-launcher] ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
    // Agents the server left behind keep the console host, and so the task, running; ending it
    // lets the next repeating trigger start the service again.
    if (windows && options.serviceUnit !== undefined) {
      const taskName = serviceTaskName(process.env.USERDOMAIN ?? "", process.env.USERNAME ?? "");
      NodeChildProcess.spawnSync("schtasks", ["/End", "/TN", taskName], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    throw cause;
  } finally {
    clearInterval(logTimer);
    if (output !== undefined) NodeFS.closeSync(output);
  }
}
