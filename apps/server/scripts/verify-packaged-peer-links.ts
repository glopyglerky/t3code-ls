// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalJsonInEffect:off - isolated packaged peer proof.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assertNoApplicationSqlite } from "../../web/scripts/hybrid-client-database.ts";
import { authenticatePackagedServer, reservePort, startPackagedServer } from "./packaged-server-fixture.ts";

// Run only in the same loopback-only Linux namespace as the packaged guest proof.
const [output, archiveEntry, ...extra] = process.argv.slice(2);
Assert.ok(output && archiveEntry && Path.isAbsolute(output) && Path.isAbsolute(archiveEntry));
Assert.equal(extra.length, 0);
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"]);
const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const entry = FS.realpathSync(archiveEntry);
const proof = Path.join(FS.realpathSync(Path.dirname(output)), Path.basename(output));
for (const protectedRoot of [root, Path.dirname(entry)]) {
  Assert.ok(Path.relative(protectedRoot, proof).startsWith(`..${Path.sep}`));
}
FS.mkdirSync(proof, { mode: 0o700 });
const scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("Packaged peer proof deadline exceeded")), 600_000);
const interrupt = () => abort.abort(new Error("Owned peer fixture interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
type Server = ReturnType<typeof startPackagedServer>;
type Client = Awaited<ReturnType<typeof authenticatePackagedServer>>;
const active = new Set<Server>();
const report: Record<string, unknown> = {
  status: "running", phase: "preflight",
  integrationBase: "eacf2d688e805abc401fdb544635367e45c63a35",
  integrationTree: "57f3e3829e80e7f2a2268275c49bc9d68cd18498",
  stock: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f",
  entrySha256: Crypto.createHash("sha256").update(FS.readFileSync(entry)).digest("hex"),
};
const checkpoint = (phase: string) => {
  report.phase = phase;
  FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n");
};
const post = async (origin: string, path: string, body: unknown, headers = {}) => {
  const response = await fetch(origin + path, {
    method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]),
  });
  if (response.status !== 200) {
    report.httpRefusal = { path, status: response.status };
    await response.body?.cancel();
  }
  Assert.equal(response.status, 200, `Unexpected status at ${path}`);
  return response;
};
// Register and approve a read-only external MCP client using a synthetic owner's code.
async function mcpReader(server: Server, owner: Client) {
  const pairing = await owner.request("/api/auth/pairing-token", { access: "read-only" }) as { credential: string };
  const redirect = "http://127.0.0.1/t3code-peer-link";
  const registered = await (await post(server.origin, "/oauth/mcp/register", {
    client_name: "Packaged peer read fixture", redirect_uris: [redirect],
  })).json() as { client_id: string };
  const verifier = Crypto.randomBytes(32).toString("base64url");
  const state = Crypto.randomBytes(16).toString("base64url");
  const resource = server.origin + "/mcp";
  const decision = await (await post(server.origin, "/oauth/mcp/decision", {
    authorization: { response_type: "code", client_id: registered.client_id, redirect_uri: redirect,
      code_challenge: Crypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", state, resource },
    decision: { _tag: "pairing-code", access: "read-only", code: pairing.credential },
  })).json() as { redirectTo: string };
  const target = new URL(decision.redirectTo);
  Assert.equal(target.origin + target.pathname, redirect);
  Assert.equal(target.searchParams.get("state"), state);
  const code = target.searchParams.get("code");
  Assert.ok(code);
  const token = await (await post(server.origin, "/oauth/mcp/token", {
    grant_type: "authorization_code", code, redirect_uri: redirect,
    client_id: registered.client_id, code_verifier: verifier, resource,
  })).json() as { access_token: string };
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.access_token}`, accept: "application/json, text/event-stream",
  };
  const initialized = await post(server.origin, "/mcp", {
    jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "packaged-peer-fixture", version: "1" },
    },
  }, headers);
  const session = initialized.headers.get("mcp-session-id");
  Assert.ok(session);
  await initialized.body?.cancel();
  headers["mcp-session-id"] = session;
  headers["mcp-protocol-version"] = "2025-06-18";
  const notification = await fetch(server.origin + "/mcp", {
    method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
  });
  Assert.equal(notification.status, 202);
  await notification.body?.cancel();
  let id = 0;
  return async (environmentId: string) => {
    const response = await post(server.origin, "/mcp", {
      jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name: "t3_environment_read", arguments: { environmentId } },
    }, headers);
    const text = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("") : text;
    return JSON.parse(json) as { error?: unknown; result?: { isError?: boolean; structuredContent?: { environmentId?: string }; content?: Array<{ text?: string }> } };
  };
}
let sentinel: Http.Server | undefined;
let failed = false;
try {
  const manifestPath = Path.join(Path.dirname(entry), "native-bin/manifest.json");
  const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  for (const [name, expected] of Object.entries(manifest.files)) {
    Assert.equal(Path.basename(name), name);
    const bytes = FS.readFileSync(Path.join(Path.dirname(manifestPath), name));
    Assert.equal(Crypto.createHash("sha256").update(bytes).digest("hex"), expected);
  }
  report.nativeManifestSha256 = Crypto.createHash("sha256").update(FS.readFileSync(manifestPath)).digest("hex");
  const ports = [await reservePort(), await reservePort()];
  Assert.notEqual(ports[0], ports[1]);
  const states = ["owner", "peer"].map((name) => Path.join(scratch, name));
  const start = async (index: number, phase: string) => {
    const state = states[index]!;
    const home = Path.join(state, "home");
    const tmp = Path.join(state, "tmp");
    const userdata = Path.join(state, "userdata");
    for (const dir of [home, tmp, userdata]) FS.mkdirSync(dir, { recursive: true });
    const settings = Path.join(userdata, "settings.json");
    if (!FS.existsSync(settings)) FS.writeFileSync(settings, JSON.stringify({ linkedEnvironmentsEnabled: true,
      enableProviderUpdateChecks: false, providerInstances: Object.fromEntries([
        "codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse",
      ].map((driver) => [driver, { driver, enabled: false }])) }));
    const server = startPackagedServer({ bundle: entry, executable: true, baseDir: state,
      port: ports[index]!, signal: abort.signal, logPath: Path.join(proof, `${phase}-${index}.log`),
      env: { HOME: home, PATH: "/nonexistent", TMPDIR: tmp, XDG_CONFIG_HOME: Path.join(home, ".config"),
        XDG_DATA_HOME: Path.join(home, ".local/share"), XDG_CACHE_HOME: Path.join(home, ".cache"),
        T3_CODE_LS_IMPLEMENTATION: "native", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1" } });
    active.add(server);
    await server.ready;
    return server;
  };
  const stop = async (server: Server) => { await server.stop(); active.delete(server); };
  const descriptor = async (server: Server) => {
    const response = await fetch(server.origin + "/.well-known/t3/environment", {
      redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    Assert.equal(response.status, 200);
    return await response.json() as { environmentId: string; capabilities: Record<string, unknown> };
  };
  checkpoint("start two selected-omdb packaged servers");
  let a = await start(0, "initial");
  let b = await start(1, "initial");
  let owner = await authenticatePackagedServer(a, abort.signal);
  let peer = await authenticatePackagedServer(b, abort.signal);
  checkpoint("enable linking through both authenticated settings routes");
  for (const client of [owner, peer]) {
    const settings = await client.rpc((rpc) => rpc[WS_METHODS.serverUpdateSettings]({
      patch: { linkedEnvironmentsEnabled: true },
    }));
    Assert.equal(settings.linkedEnvironmentsEnabled, true);
  }
  const identityA = await descriptor(a);
  const identityB = await descriptor(b);
  Assert.notEqual(identityA.environmentId, identityB.environmentId);
  const pairing = await peer.request("/api/auth/pairing-token", {}) as { credential: string };
  let unexpectedRequests = 0;
  let credentialRequests = 0;
  let probes = 0;
  sentinel = Http.createServer((request, response) => {
    if (request.headers.authorization !== undefined || request.method !== "GET") credentialRequests++;
    if (request.url !== "/.well-known/t3/environment") unexpectedRequests++;
    probes++;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ...identityB, capabilities: { ...identityB.capabilities, mcpModeLimitHeader: false },
    }));
  });
  await new Promise<void>((resolve) => sentinel!.listen(0, "127.0.0.1", resolve));
  const address = sentinel.address();
  Assert.ok(address && typeof address !== "string");
  checkpoint("refuse incompatible endpoint before credential exchange");
  const refused = await owner.rpc((rpc) => rpc[WS_METHODS.peerLinksLink]({
    url: `http://127.0.0.1:${address.port}`, pairingCode: pairing.credential, access: "read-only",
  }).pipe(Effect.flip));
  report.refusal = {
    kind: refused._tag,
    reason: refused._tag === "PeerLinkError" ? refused.reason : null,
    probes,
    credentialRequests,
    unexpectedRequests,
  };
  Assert.ok("reason" in refused);
  Assert.equal(refused.reason, "incompatible");
  Assert.ok(probes > 0);
  Assert.equal(credentialRequests, 0);
  Assert.equal(unexpectedRequests, 0);
  checkpoint("link both packaged servers through a plain pairing code");
  const linked = await owner.rpc((rpc) => rpc[WS_METHODS.peerLinksLink]({
    url: b.origin, pairingCode: pairing.credential, access: "read-only",
  }));
  Assert.equal(linked.environmentId, identityB.environmentId);
  const readIdentity = async (server: Server, client: Client) => {
    const read = await mcpReader(server, client);
    const result = await read(identityB.environmentId);
    Assert.equal(result.error, undefined);
    Assert.notEqual(result.result?.isError, true);
    Assert.equal(result.result?.structuredContent?.environmentId, identityB.environmentId);
    return read;
  };
  checkpoint("read linked identity without provider or tool effects");
  await readIdentity(a, owner);
  await stop(a); await stop(b);
  a = await start(0, "reopened"); b = await start(1, "reopened");
  owner = await authenticatePackagedServer(a, abort.signal);
  peer = await authenticatePackagedServer(b, abort.signal);
  Assert.equal((await descriptor(a)).environmentId, identityA.environmentId);
  Assert.equal((await descriptor(b)).environmentId, identityB.environmentId);
  const listed = await owner.rpc((rpc) => rpc[WS_METHODS.peerLinksList]({}));
  Assert.equal(listed.links.length, 1);
  Assert.equal(listed.links[0]?.environmentId, identityB.environmentId);
  const read = await readIdentity(a, owner);
  checkpoint("revoke peer authorization then restart both owners");
  const revoked = await peer.request("/api/auth/clients/revoke-others", {}) as { revokedCount: number };
  Assert.ok(revoked.revokedCount >= 1);
  const denied = await read(identityB.environmentId);
  Assert.equal(denied.result?.isError, true);
  Assert.ok(JSON.stringify(denied).includes("capability_denied"));
  await stop(a); await stop(b);
  a = await start(0, "revoked"); b = await start(1, "revoked");
  owner = await authenticatePackagedServer(a, abort.signal);
  Assert.equal((await descriptor(a)).environmentId, identityA.environmentId);
  Assert.equal((await descriptor(b)).environmentId, identityB.environmentId);
  const deniedAgain = await (await mcpReader(a, owner))(identityB.environmentId);
  Assert.equal(deniedAgain.result?.isError, true);
  Assert.ok(JSON.stringify(deniedAgain).includes("capability_denied"));
  await stop(a); await stop(b);
  for (const state of states) {
    Assert.ok(FS.statSync(Path.join(state, "userdata", "statev2.omdb")).isFile());
    assertNoApplicationSqlite(state);
  }
  Assert.equal(credentialRequests, 0);
  report.observed = { linkedRead: true, bothIdentitiesStable: true, durableRevocation: true,
    ineligibleEndpointCredentialRequests: credentialRequests, database: "omdb" };
  report.status = "passed";
} catch (error) {
  if (error instanceof Error) {
    const location = error.stack?.match(/verify-packaged-peer-links\.ts:(\d+):(\d+)/u);
    if (location) report.failedAt = { line: Number(location[1]), column: Number(location[2]) };
  }
  failed = true;
  report.status = "failed";
} finally {
  const stopped = await Promise.allSettled([...active].map((server) => server.stop()));
  await new Promise<void>((resolve) => {
    if (!sentinel?.listening) return resolve();
    sentinel.close(() => resolve()); sentinel.closeAllConnections();
  });
  if (stopped.some((result) => result.status === "rejected")) {
    report.status = "failed"; report.cleanupFailure = true; failed = true;
  } else {
    FS.rmSync(scratch, { recursive: true, force: true });
    report.scratchRemoved = !FS.existsSync(scratch);
  }
  clearTimeout(deadline);
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  checkpoint(String(report.phase));
}
if (failed) throw new Error(`Packaged peer proof failed at ${report.phase}; inspect the private proof directory`);
