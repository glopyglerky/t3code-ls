import * as Assert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const [mode, executable, program] = process.argv.slice(2);
Assert.ok(mode === "contract" || mode === "vendor");
const helper = await NodeFs.realpath(executable);
const provider = await NodeFs.realpath(program);

async function within(pending, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Claude helper proof timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function check(cwd, run, argv) {
  const child = NodeChildProcess.spawn(helper, argv, {
    cwd,
    env: { TMPDIR: cwd },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const exit = new Promise((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(null));
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  child.stdin.on("error", () => {});
  const startup = {
    type: "open",
    version: 1,
    profile: "initialize-only",
    program: provider,
    cwd,
    home: cwd,
  };
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");
  const next = async () => {
    const { value, done } = await within(output.next(), 20_000);
    Assert.equal(done, false, "helper exited before emitting its typed reply");
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("helper emitted a non-JSON reply");
    }
  };
  const ready = async () => {
    send(startup);
    const reply = await next();
    Assert.equal(reply.type, "ready");
    Assert.equal(reply.value.version, 1);
    const { pid } = reply.value;
    Assert.ok(Number.isSafeInteger(pid) && pid > 0);
    Assert.equal(await NodeFs.readlink(`/proc/${pid}/exe`), provider);
    Assert.match(
      await NodeFs.readFile(`/proc/${pid}/status`, "utf8"),
      new RegExp(`^PPid:\\s+${child.pid}$`, "m"),
    );
    return `/proc/${pid}`;
  };
  try {
    await run({ child, startup, send, next, ready, exit });
  } finally {
    child.stdin.end();
    try {
      await within(exit, 6_000);
    } catch (error) {
      if (child.kill("SIGTERM")) await within(exit, 20_000);
      throw error;
    }
    Assert.equal(stderrBytes, 0, "helper emitted stderr");
  }
}

async function assertReaped(processPath, exit, status = 0) {
  Assert.equal(await within(exit, 6_000), status);
  await Assert.rejects(NodeFs.access(processPath), { code: "ENOENT" });
}

async function withProfile(run, argv = []) {
  const profile = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-claude-helper-"));
  try {
    await check(profile, run, argv);
  } finally {
    await NodeFs.rm(profile, { recursive: true, force: true });
  }
}

if (mode === "contract") {
  await withProfile(
    async ({ startup, send, next, exit }) => {
      send(startup);
      Assert.deepEqual(await next(), {
        type: "error",
        value: { stage: "startup", code: "UnexpectedArguments" },
      });
      Assert.equal(await within(exit, 6_000), 1);
      await Assert.rejects(NodeFs.access(NodePath.join(startup.cwd, "adapter-child-started")), {
        code: "ENOENT",
      });
    },
    ["--vendor-handshake"],
  );
  await withProfile(async ({ startup, send, next, exit }) => {
    send({ ...startup, environment: { ANTHROPIC_API_KEY: "synthetic-fixture-value" } });
    Assert.deepEqual(await next(), {
      type: "error",
      value: { stage: "startup", code: "InvalidStartup" },
    });
    Assert.equal(await within(exit, 6_000), 1);
    await Assert.rejects(NodeFs.access(NodePath.join(startup.cwd, "adapter-child-started")), {
      code: "ENOENT",
    });
  });
  await withProfile(async ({ child, startup, next, exit }) => {
    child.stdin.end(JSON.stringify(startup));
    Assert.deepEqual(await next(), {
      type: "error",
      value: { stage: "startup", code: "OutputClosed" },
    });
    Assert.equal(await within(exit, 6_000), 1);
    await Assert.rejects(NodeFs.access(NodePath.join(startup.cwd, "adapter-child-started")), {
      code: "ENOENT",
    });
  });
  await withProfile(async ({ startup, send, next, exit }) => {
    send({ ...startup, program: NodePath.join(startup.cwd, "missing") });
    Assert.deepEqual(await next(), {
      type: "error",
      value: { stage: "startup", code: "Process(Spawn)" },
    });
    Assert.equal(await within(exit, 6_000), 1);
  });
  await withProfile(async ({ ready, send, next, exit }) => {
    const processPath = await ready();
    send({ type: "interrupt" });
    Assert.deepEqual(await next(), {
      type: "error",
      value: { stage: "command", code: "InitializationOnly" },
    });
    await assertReaped(processPath, exit, 1);
  });
  for (const end of ["eof", "signal"]) {
    await withProfile(async ({ child, ready, exit }) => {
      const processPath = await ready();
      if (end === "eof") child.stdin.end();
      else Assert.ok(child.kill("SIGTERM"));
      await assertReaped(processPath, exit);
    });
  }
  console.log(
    "Claude helper refused unsupported startup and command frames and reaped its child on EOF and SIGTERM.",
  );
} else {
  await withProfile(async ({ ready, send, next, exit }) => {
    const processPath = await ready();
    send({ type: "close" });
    const reply = await next();
    Assert.equal(reply.type, "closed");
    Assert.ok(reply.value.code === 0 || reply.value.signal === 9);
    await assertReaped(processPath, exit);
  });
  console.log("Pinned vendor CLI acknowledged initialization and was reaped without a prompt.");
}
