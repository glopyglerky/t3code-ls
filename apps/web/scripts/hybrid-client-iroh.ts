// @effect-diagnostics nodeBuiltinImport:off - isolated Node acceptance runner owns its processes.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

interface IrohEndpoint {
  readonly id: string;
  readonly addrs: ReadonlyArray<{ readonly Ip?: string }>;
}

export async function startIrohFixture(executable: string, directory: string, target: number) {
  const children: NodeChildProcess.ChildProcess[] = [];
  const stop = async () => {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        child.kill("SIGINT");
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  const identity = (name: string) => NodePath.join(directory, name);
  const endpointId = (name: string) =>
    NodeChildProcess.execFileSync(executable, ["identity", "--identity", identity(name)], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

  const launch = async <A>(args: readonly string[]): Promise<A> => {
    const child = NodeChildProcess.spawn(executable, [...args, "--loopback"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    const output = NodeReadline.createInterface({ input: child.stdout });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await new Promise<string>((resolve, reject) => {
        output.once("line", resolve);
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Iroh fixture exited before readiness (${code})`)),
        );
        timer = setTimeout(() => reject(new Error("Iroh fixture readiness timed out")), 15_000);
      });
      return JSON.parse(line) as A;
    } finally {
      clearTimeout(timer);
      output.close();
    }
  };

  try {
    const descriptor = "/.well-known/t3/environment";
    let targetAddress: string | undefined;
    for (const ip of ["127.0.0.1", "[::1]"]) {
      const address = `${ip}:${target}`;
      const response = await fetch(`http://${address}${descriptor}`, {
        signal: AbortSignal.timeout(1500),
      }).catch(() => undefined);
      if (response?.ok) {
        await response.body?.cancel();
        targetAddress = address;
        break;
      }
      await response?.body?.cancel();
    }
    NodeAssert.ok(targetAddress, "The development web listener has no reachable loopback address");
    const peer = endpointId("iroh-client.key");
    const server = await launch<{ endpoint: IrohEndpoint }>([
      "serve",
      "--identity",
      identity("iroh-server.key"),
      "--target",
      targetAddress,
      "--allow",
      peer,
    ]);
    const addresses = server.endpoint.addrs.flatMap(({ Ip }) => (Ip ? ["--address", Ip] : []));
    NodeAssert.ok(addresses.length > 0, "Iroh host must publish its loopback address");
    const forward = (name: string) =>
      launch<{ listen: string }>([
        "forward",
        "--identity",
        identity(name),
        "--remote",
        server.endpoint.id,
        ...addresses,
      ]);
    const refused = await forward("iroh-unadmitted.key");
    await NodeAssert.rejects(
      fetch(`http://${refused.listen}${descriptor}`, {
        signal: AbortSignal.timeout(5000),
      }),
      (error: unknown) => error instanceof TypeError && error.message === "fetch failed",
      "An unadmitted Iroh peer must receive no application response",
    );
    const client = await forward("iroh-client.key");
    const response = await fetch(`http://${client.listen}${descriptor}`, {
      signal: AbortSignal.timeout(5000),
    });
    NodeAssert.ok(response.ok, "The admitted peer must reach T3's environment descriptor");
    await response.body?.cancel();
    const port = new URL(`http://${client.listen}`).port;
    NodeAssert.ok(port && port !== String(target), "Iroh forwarder must have its own port");
    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
