// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off - owns the Linux PTY helper's Node stdio transport.
import * as ChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { nativeExecutable } from "@t3tools/shared/nativeExecutable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_CHUNK_BYTES = 8192;
const MAX_PENDING_OPERATIONS = 16;
const REQUEST_TIMEOUT_MS = 5000;
const IDLE_POLL_MS = 20;

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

class PtyHostConnection {
  readonly child: ChildProcess.ChildProcessWithoutNullStreams;
  private frame: Buffer = Buffer.alloc(0);
  private pending: {
    readonly resolve: (response: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | undefined;
  private error: Error | undefined;

  constructor(executable: string) {
    this.child = ChildProcess.spawn(executable, ["--stdio-v1"], {
      env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.once("error", () => this.close(new Error("Could not start the native PTY host.")));
    this.child.once("close", () => this.close(new Error("The native PTY host exited.")));
    this.child.stdin.on("error", () => this.close(new Error("The native PTY input closed.")));
  }

  private receive(chunk: Buffer): void {
    if (this.error) return;
    if (!this.pending || this.frame.length + chunk.length > MAX_FRAME_BYTES) {
      this.close(new Error("Invalid native PTY response length or order."));
      return;
    }
    const frame = this.frame.length === 0 ? chunk : Buffer.concat([this.frame, chunk]);
    const newline = frame.indexOf(10);
    if (newline < 0) {
      this.frame = frame;
      return;
    }
    try {
      if (newline !== frame.length - 1) throw new Error("Unexpected native PTY frame.");
      const response: unknown = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(frame.subarray(0, newline)),
      );
      if (typeof response !== "object" || response === null ||
        !("version" in response) || response.version !== 1) throw new Error("Invalid native PTY response.");
      const pending = this.pending;
      this.pending = undefined;
      this.frame = Buffer.alloc(0);
      clearTimeout(pending.timer);
      pending.resolve(response as Record<string, unknown>);
    } catch {
      this.close(new Error("Invalid native PTY response."));
    }
  }

  request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.error) return Promise.reject(this.error);
    if (this.pending) return Promise.reject(new Error("Native PTY requests must run in order."));
    const frame = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error("Native PTY request is too large."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error("The native PTY request timed out.")), REQUEST_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(frame);
    });
  }

  close(error: Error): void {
    if (this.error) return;
    this.error = error;
    const pending = this.pending;
    this.pending = undefined;
    this.frame = Buffer.alloc(0);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    // EOF lets the native owner signal and reap the child's group.
    this.child.stdin.end();
  }
}

class NativePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  private readonly host: PtyHostConnection;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder("utf8", { ignoreBOM: true });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private closing = false;
  private terminating = false;
  private cursor = 0;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private terminalExitCode: number | undefined;

  constructor(pid: number, host: PtyHostConnection) {
    this.pid = pid;
    this.host = host;
    host.child.once("close", () => {
      this.closing = true;
      clearTimeout(this.timer);
      this.exitEvent = { exitCode: this.terminalExitCode ?? 255, signal: null };
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
      this.dataListeners.clear();
    });
  }

  private enqueue<A>(operation: () => Promise<A>): Promise<A> {
    if (this.closing || this.queued >= MAX_PENDING_OPERATIONS) {
      return Promise.reject(new Error("The native PTY is closed or its request queue is full."));
    }
    this.queued += 1;
    const next = this.tail.then(operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next.finally(() => { this.queued -= 1; });
  }

  write(data: string): Promise<{ readonly acceptedBytes: number }> {
    if (this.terminating) return Promise.reject(new Error("The native PTY is terminating."));
    // The public terminal contract permits at most 65,536 UTF-16 units per request.
    if (data.length > 65_536) return Promise.reject(new Error("Terminal input is too large."));
    const bytes = Buffer.from(data, "utf8");
    return this.enqueue(async () => {
      let acceptedBytes = 0;
      while (acceptedBytes < bytes.length && !this.closing && !this.terminating) {
        const chunk = bytes.subarray(acceptedBytes, acceptedBytes + MAX_CHUNK_BYTES);
        const { accepted } = await this.host.request({ operation: "write", bytes: Array.from(chunk) });
        if (!nonnegativeInteger(accepted) || accepted > chunk.length) {
          const error = new Error("Invalid native PTY input receipt.");
          this.host.close(error);
          throw error;
        }
        acceptedBytes += accepted;
        if (accepted !== chunk.length) break;
      }
      return { acceptedBytes };
    });
  }

  resize(cols: number, rows: number): void {
    void this.enqueue(async () => {
      if (this.closing) return;
      const response = await this.host.request({ operation: "resize", cols, rows });
      if (response.resized !== true) throw new Error("Invalid native PTY resize receipt.");
    }).catch((error: Error) => this.host.close(error));
  }

  kill(signal?: string): void {
    if (this.closing) return;
    if (signal === "SIGTERM") {
      if (this.terminating) return;
      this.terminating = true;
      void this.enqueue(async () => {
        const { signalled } = await this.host.request({ operation: "terminate" });
        if (typeof signalled !== "boolean") throw new Error("Invalid native PTY termination receipt.");
      }).then(() => this.poll(0)).catch((error: Error) => this.host.close(error));
      return;
    }
    this.closing = true;
    clearTimeout(this.timer);
    void this.tail.then(async () => {
      const { exitCode } = await this.host.request({ operation: "close" });
      if (nonnegativeInteger(exitCode)) this.terminalExitCode = exitCode;
      this.host.close(new Error("The native PTY was closed."));
    }).catch((error: Error) => this.host.close(error));
  }

  private poll(delay: number): void {
    if (this.closing || this.reading || this.timer !== undefined ||
      (this.dataListeners.size === 0 && !this.terminating)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.queued >= MAX_PENDING_OPERATIONS) {
        this.poll(IDLE_POLL_MS);
        return;
      }
      this.reading = true;
      void this.enqueue(() => this.receive()).then((nextDelay) => {
        this.reading = false;
        this.poll(nextDelay);
      }).catch((error: Error) => this.host.close(error));
    }, delay);
  }

  private async receive(): Promise<number> {
    if (this.closing) return IDLE_POLL_MS;
    const { start, end, bytes, ended } = await this.host.request({ operation: "read" });
    if (start !== this.cursor || !nonnegativeInteger(end) || typeof ended !== "boolean" ||
      !Array.isArray(bytes) || bytes.length > MAX_CHUNK_BYTES || end !== this.cursor + bytes.length ||
      !bytes.every((byte) => nonnegativeInteger(byte) && byte <= 255)) {
      throw new Error("Invalid native PTY output cursor.");
    }
    if ((this.dataListeners.size === 0 && !this.terminating) || this.closing) return IDLE_POLL_MS;
    const text = this.decoder.decode(Uint8Array.from(bytes), { stream: !ended });
    if (text.length > 0) for (const listener of this.dataListeners) listener(text);
    if (bytes.length > 0) {
      const { acknowledged } = await this.host.request({ operation: "acknowledge", end });
      if (acknowledged !== end) throw new Error("Invalid native PTY output acknowledgement.");
      this.cursor = end;
    }
    if (ended) this.kill();
    return bytes.length > 0 ? 0 : IDLE_POLL_MS;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    this.poll(0);
    return () => { this.dataListeners.delete(callback); };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => { this.exitListeners.delete(callback); };
  }
}

async function spawnPty(executable: string, input: PtyAdapter.PtySpawnInput, signal: AbortSignal) {
  if (!NodePath.isAbsolute(input.cwd)) {
    throw new Error("The native PTY requires an absolute workspace path.");
  }
  // AgentScope resolves PATH before calling the adapter. An unresolved shell can
  // advance to the manager's next shell candidate without spawning a helper.
  if (!NodePath.isAbsolute(input.shell)) throw new Error("Terminal shell not found.");
  await NodeFS.access(input.shell, NodeFS.constants.X_OK);
  signal.throwIfAborted();
  const host = new PtyHostConnection(executable);
  const abort = () => host.close(new Error("Native PTY startup was cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const { pid } = await host.request({
      operation: "spawn",
      executable: input.shell,
      args: input.args ?? [],
      cwd: input.cwd,
      env: { ...input.env, TERM: input.env.TERM ?? "xterm-256color" },
      cols: input.cols,
      rows: input.rows,
    });
    if (!nonnegativeInteger(pid) || pid === 0) throw new Error("Invalid native PTY child identity.");
    return new NativePtyProcess(pid, host);
  } catch (cause) {
    host.close(cause instanceof Error ? cause : new Error("Native PTY startup failed."));
    throw cause;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export const layer = (executable: string) => Layer.succeed(PtyAdapter.PtyAdapter, {
  spawn: Effect.fn("NativePtyAdapter.spawn")((input: PtyAdapter.PtySpawnInput) => Effect.tryPromise({
    try: (signal) => spawnPty(executable, input, signal),
    catch: (cause) => new PtyAdapter.PtySpawnError({ adapter: "native-pty", shell: input.shell, cause }),
  })),
});

async function verifyBundledHost(executable: string): Promise<void> {
  const flags = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
  const manifestFile = await NodeFS.open(NodePath.join(NodePath.dirname(executable), "manifest.json"), flags);
  let manifest;
  try {
    const metadata = await manifestFile.stat();
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("Invalid native PTY manifest.");
    manifest = JSON.parse(await manifestFile.readFile("utf8"));
  } finally {
    await manifestFile.close();
  }
  const declared = manifest?.files?.["t3-code-ls-pty-host"];
  if (manifest?.target !== "linux-x64" || manifest.rustTarget !== "x86_64-unknown-linux-gnu" ||
    (manifest.implementation !== undefined && manifest.implementation !== "native") ||
    typeof declared !== "string" || !/^[0-9a-f]{64}$/u.test(declared)) {
    throw new Error("The bundled native manifest does not select the Linux PTY host.");
  }
  const helper = await NodeFS.open(executable, flags);
  try {
    const before = await helper.stat();
    if (!before.isFile() || before.size > 134_217_728) throw new Error("Invalid bundled native PTY host.");
    const hash = NodeCrypto.createHash("sha256");
    for await (const chunk of helper.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await NodeFS.lstat(executable);
    if (hash.digest("hex") !== declared || !after.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.ctimeMs !== after.ctimeMs) {
      throw new Error("The bundled native PTY host does not match its manifest.");
    }
    await NodeFS.access(executable, NodeFS.constants.X_OK);
  } finally {
    await helper.close();
  }
}

const select = Effect.fn("NativePtyAdapter.select")(function* () {
  const env = yield* HostProcess.Environment;
  const override = env.T3_CODE_LS_PTY_HOST_EXECUTABLE;
  const bundled = env.T3_CODE_LS_BUNDLED_PTY_HOST;
  if (bundled !== undefined && bundled !== "1") {
    return yield* Effect.die(new Error("T3_CODE_LS_BUNDLED_PTY_HOST must be 1 when selected."));
  }
  if (env.T3_CODE_LS_IMPLEMENTATION === "upstream" || (override === undefined && bundled === undefined)) {
    return NodePtyAdapter.layer;
  }
  if (bundled === "1" && override !== undefined) {
    return yield* Effect.die(new Error("Select one native PTY helper source."));
  }
  const executable = override ?? nativeExecutable("pty-host");
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  if (platform !== "linux" || architecture !== "x64" || !NodePath.isAbsolute(executable)) {
    return yield* Effect.die(new Error("The native PTY requires an absolute helper path on Linux x64."));
  }
  if (bundled === "1") {
    yield* Effect.tryPromise({
      try: () => verifyBundledHost(executable),
      catch: (cause) => new Error("Could not verify the bundled native PTY host.", { cause }),
    }).pipe(Effect.orDie);
  }
  return layer(executable);
});

export const selectedLayer = Layer.unwrap(select());
