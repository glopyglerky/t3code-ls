// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalJsonInEffect:off - isolated archive proof.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Https from "node:https";
import * as OS from "node:os";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentCloudLinkStateResult,
  GuestRedeemRequest,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  guestSessionCookieName,
} from "@t3tools/contracts";
import {
  RelayEnvironmentLinkProofPayload,
  RelayManagedEndpointRecoveryProofPayload,
  RelayManagedEndpointRecoveryRegistrationRequest,
} from "@t3tools/contracts/relay";
import {
  RELAY_LINK_PROOF_TYP,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
  decodeRelayJwt,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assertNoApplicationSqlite } from "../../web/scripts/hybrid-client-database.ts";
import {
  type GuestState,
  assertRedeemCommit,
  assertRedeemReplay,
  cellValue,
  guestStatePageLimit,
  guestStateTables,
} from "../../../tools/omdb-guest-state.ts";
import {
  authenticatePackagedServer,
  reservePort,
  startPackagedServer,
} from "./packaged-server-fixture.ts";

const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const [outputPath, archiveEntry, browserFlag, ...extra] = process.argv.slice(2);
Assert.ok(
  outputPath && Path.isAbsolute(outputPath) && archiveEntry && Path.isAbsolute(archiveEntry),
);
Assert.equal(extra.length, 0);
Assert.ok(browserFlag === undefined || browserFlag === "--browser");
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(
  Object.keys(OS.networkInterfaces()),
  ["lo"],
  "Run in a loopback-only network namespace",
);
const proof = Path.join(FS.realpathSync(Path.dirname(outputPath)), Path.basename(outputPath));
Assert.ok(Path.relative(root, proof).startsWith(`..${Path.sep}`));
const entry = FS.realpathSync(archiveEntry);
Assert.ok(
  Path.relative(Path.dirname(entry), proof).startsWith(`..${Path.sep}`),
  "Keep the proof directory outside the extracted package",
);
FS.mkdirSync(proof, { mode: 0o700 });
const scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));

const stock = "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f";
const connectorHostname = "guest.fixture.invalid";
const otherHostname = "other.fixture.invalid";
const cloudUserId = "fixture-guest-account";
const tunnelId = "fixture-guest-tunnel";
const environmentCredential = Crypto.randomBytes(32).toString("base64url");
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Packaged guest authorization proof interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

const report: Record<string, unknown> = {
  status: "running",
  stock: { commit: stock, tree: "af9112ce82be93109079ca7b7a89f7182455eca5", license: "MIT" },
  edge: "loopback HTTPS relay and managed connector process fixtures",
};
const save = () =>
  FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const checkpoint = (phase: string) => {
  report.phase = phase;
  save();
};

const hashFile = (path: string) =>
  Crypto.createHash("sha256").update(FS.readFileSync(path)).digest("hex");
const encodeRedeem = Schema.encodeSync(Schema.fromJsonString(GuestRedeemRequest));
const decodeRefusal = Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }));
const decodeLinkState = Schema.decodeUnknownSync(EnvironmentCloudLinkStateResult);
const decodeRegistration = Schema.decodeUnknownSync(
  RelayManagedEndpointRecoveryRegistrationRequest,
);

function snapshot(executable: string, database: string): GuestState {
  const transaction_id = "guest-authorization-proof";
  const tables = Object.entries(guestStateTables);
  const requests = [
    { operation: "application_begin", transaction_id, mode: "read" },
    ...tables.map(([, table]) => ({
      operation: "application_scan",
      table,
      transaction_id,
      limit: guestStatePageLimit,
    })),
    { operation: "application_rollback", transaction_id },
  ];
  const response = ChildProcess.execFileSync(executable, ["read-only-local", database], {
    env: {},
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
  });
  const replies = response
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  Assert.equal(replies.length, requests.length);
  Assert.ok(
    replies.every((reply) => reply.ok === true),
    "Native inspection rejected a request",
  );
  return Object.fromEntries(
    tables.map(([label], index) => {
      const page = replies[index + 1].result;
      Assert.equal(page.next, null, `Fixture table exceeds its bound: ${label}`);
      Assert.ok(Array.isArray(page.rows));
      return [label, page.rows];
    }),
  ) as GuestState;
}

async function refuse(response: Response, status: number, reason: string) {
  Assert.equal(response.status, status);
  Assert.equal(response.headers.getSetCookie().length, 0, "A refusal set a cookie");
  Assert.equal(response.headers.get("cache-control"), "no-store");
  Assert.equal(decodeRefusal(await response.json()).reason, reason);
}

let active: ReturnType<typeof startPackagedServer> | undefined;
let relay: Https.Server | undefined;
let failure: unknown;
try {
  checkpoint("verify source and package");
  const git = (...args: string[]) =>
    ChildProcess.execFileSync("/usr/bin/git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  Assert.equal(git("status", "--porcelain=v1"), "");
  const nativeBin = Path.join(Path.dirname(entry), "native-bin");
  const databaseHelper = Path.join(nativeBin, "t3-code-ls-db");
  const guestHelper = Path.join(nativeBin, "t3-code-ls-guest-share");
  const manifestPath = Path.join(nativeBin, "manifest.json");
  const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  for (const helper of [databaseHelper, guestHelper]) {
    FS.accessSync(helper, FS.constants.X_OK);
    Assert.equal(hashFile(helper), manifest.files[Path.basename(helper)]);
  }
  report.source = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  report.artifacts = {
    entry: hashFile(entry),
    manifest: hashFile(manifestPath),
    databaseHelper: hashFile(databaseHelper),
    guestHelper: hashFile(guestHelper),
    toolchainLock: hashFile(Path.join(root, "toolchain.lock.json")),
    cargoLock: hashFile(Path.join(root, "Cargo.lock")),
    pnpmLock: hashFile(Path.join(root, "pnpm-lock.yaml")),
  };

  checkpoint("start isolated relay");
  const home = Path.join(scratch, "home");
  const state = Path.join(scratch, "state");
  const userdata = Path.join(state, "userdata");
  const database = Path.join(userdata, "statev2.omdb");
  const workspace = Path.join(scratch, "workspace");
  const temporary = Path.join(scratch, "tmp");
  const bin = Path.join(home, "bin");
  for (const directory of [bin, userdata, workspace, temporary]) {
    FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const certificate = Path.join(scratch, "relay.pem");
  const key = Path.join(scratch, "relay-key.pem");
  ChildProcess.execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Packaged guest fixture",
      "-addext",
      `subjectAltName=IP:127.0.0.1,DNS:${connectorHostname}`,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { env: {}, stdio: "ignore", timeout: 15_000 },
  );
  const { privateKey, publicKey } = Crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

  let identity: { environmentId: string; environmentPublicKey: string } | undefined;
  let expectedOrigin: { localHttpHost: string; localHttpPort: number } | undefined;
  let relayOrigin: string;
  const acceptedProofs = new Set<string>();
  const registrations = new Set<number>();
  relay = Https.createServer(
    {
      cert: FS.readFileSync(certificate),
      key: FS.readFileSync(key),
    },
    (request, response) => {
      if (request.method !== "POST" || !request.url?.endsWith("/tunnel/recovery")) {
        response.writeHead(404).end();
        return;
      }
      void (async () => {
        const linked = identity;
        Assert.ok(linked && expectedOrigin);
        Assert.equal(
          request.url,
          `/v1/environments/${encodeURIComponent(linked.environmentId)}/tunnel/recovery`,
        );
        Assert.ok(request.headers.authorization === `Bearer ${environmentCredential}`);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          Assert.ok(bytes <= 16_384);
          chunks.push(chunk);
        }
        const body = decodeRegistration(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        Assert.equal(body.cloudUserId, cloudUserId);
        Assert.equal(body.tunnelId, tunnelId);
        Assert.deepEqual(body.origin, expectedOrigin);
        const verified = await Effect.runPromise(
          verifyRelayJwt(RelayManagedEndpointRecoveryProofPayload, {
            publicKey: linked.environmentPublicKey,
            token: body.proof,
            typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
            issuer: `t3-env:${linked.environmentId}`,
            audience: relayOrigin,
          }).pipe(Effect.provide(NodeCrypto.layer)),
        );
        Assert.ok(verified.action === "register");
        Assert.equal(verified.sub, linked.environmentId);
        Assert.equal(verified.environmentId, linked.environmentId);
        Assert.equal(verified.cloudUserId, cloudUserId);
        Assert.equal(verified.tunnelId, tunnelId);
        Assert.deepEqual(verified.origin, body.origin);
        Assert.ok(!acceptedProofs.has(verified.jti));
        acceptedProofs.add(verified.jti);
        registrations.add(body.origin.localHttpPort);
        response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ready"}');
      })().catch(() => response.writeHead(403).end());
    },
  );
  const tlsRelay = relay;
  tlsRelay.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    tlsRelay.once("error", reject);
    tlsRelay.listen(0, "127.0.0.1", resolve);
  });
  const relayAddress = tlsRelay.address();
  Assert.ok(relayAddress && typeof relayAddress !== "string");
  relayOrigin = `https://127.0.0.1:${relayAddress.port}`;

  const connector = Path.join(scratch, "connector.mjs");
  const hostnameFile = Path.join(scratch, "connector-hostname");
  Assert.ok(!/\s/u.test(process.execPath));
  FS.writeFileSync(
    connector,
    `#!${process.execPath}\n` +
      FS.readFileSync(new URL("./guest-connector-fixture.mjs", import.meta.url), "utf8"),
    { mode: 0o700 },
  );
  const setConnectorHostname = (hostname: string) => {
    const next = hostnameFile + ".next";
    FS.writeFileSync(next, hostname, { mode: 0o600 });
    FS.renameSync(next, hostnameFile);
  };
  setConnectorHostname(connectorHostname);
  FS.symlinkSync("/usr/bin/git", Path.join(bin, "git"));
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: Path.join(home, ".config"),
    XDG_DATA_HOME: Path.join(home, ".local/share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    NODE_EXTRA_CA_CERTS: certificate,
    T3CODE_RELAY_URL: relayOrigin,
    T3CODE_CLOUDFLARED_PATH: connector,
    T3_CODE_LS_IMPLEMENTATION: "native",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    NO_COLOR: "1",
  };

  const provider = ProviderInstanceId.make("fixtureGuest");
  FS.writeFileSync(
    Path.join(userdata, "settings.json"),
    JSON.stringify({
      providerInstances: {
        ...Object.fromEntries(
          [
            "codex",
            "claudeAgent",
            "pi",
            "cursor",
            "grok",
            "fx",
            "opencode",
            "antigravity",
            "kiro",
            "muse",
          ].map((driver) => [driver, { driver, enabled: false }]),
        ),
        [provider]: {
          driver: "acpRegistry",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [Path.join(root, "apps/server/scripts/dev-replay-agent.ts")],
          },
        },
      },
    }),
  );

  const start = async (phase: string, port: number) => {
    expectedOrigin = { localHttpHost: "127.0.0.1", localHttpPort: port };
    const server = startPackagedServer({
      bundle: entry,
      executable: true,
      logPath: Path.join(proof, `${phase}.log`),
      signal: abort.signal,
      baseDir: state,
      env,
      port,
    });
    active = server;
    await server.ready;
    return server;
  };

  const waitForConnector = async (
    client: Awaited<ReturnType<typeof authenticatePackagedServer>>,
    hostname: string,
  ) => {
    const until = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    while (!until.aborted) {
      const link = decodeLinkState(await client.request("/api/connect/link-state"));
      if (link.linked && !link.linkRevoked && link.tunnelHostname === hostname) return;
      await delay(100, undefined, { signal: until });
    }
    until.throwIfAborted();
  };

  checkpoint("configure managed endpoint through desktop authorization");
  const initialPort = await reservePort();
  const initial = await start("initial", initialPort);
  const client = await authenticatePackagedServer(initial, abort.signal);
  const now = Math.floor(Date.now() / 1_000);
  const challenge = await Effect.runPromise(
    signRelayJwt({
      privateKey,
      typ: "t3-relay-link-challenge+jwt",
      payload: { iat: now, exp: now + 60 },
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  const linkProof = Schema.decodeUnknownSync(Schema.String)(
    await client.request("/api/connect/link-proof", {
      challenge,
      relayIssuer: relayOrigin,
      endpoint: {
        providerKind: "cloudflare_tunnel",
        httpBaseUrl: `https://${connectorHostname}`,
        wsBaseUrl: `wss://${connectorHostname}`,
      },
      origin: expectedOrigin,
    }),
  );
  const linkClaims = await Effect.runPromise(decodeRelayJwt(linkProof));
  const candidateIdentity = Schema.decodeUnknownSync(
    Schema.Struct({ environmentId: Schema.String, environmentPublicKey: Schema.String }),
  )(linkClaims);
  const verifiedLink = await Effect.runPromise(
    verifyRelayJwt(RelayEnvironmentLinkProofPayload, {
      publicKey: candidateIdentity.environmentPublicKey,
      token: linkProof,
      typ: RELAY_LINK_PROOF_TYP,
      issuer: `t3-env:${candidateIdentity.environmentId}`,
      audience: relayOrigin,
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  Assert.ok(verifiedLink.challenge === challenge);
  Assert.equal(verifiedLink.sub, candidateIdentity.environmentId);
  Assert.equal(verifiedLink.descriptor.environmentId, candidateIdentity.environmentId);
  Assert.deepEqual(verifiedLink.origin, expectedOrigin);
  Assert.ok(verifiedLink.scopes.includes("managed_tunnels"));
  identity = candidateIdentity;

  const endpointConfig = {
    cloudUserId,
    relayUrl: relayOrigin,
    relayIssuer: relayOrigin,
    environmentCredential,
    cloudMintPublicKey: publicKey,
    endpointRuntime: {
      providerKind: "cloudflare_tunnel",
      tunnelId,
      connectorToken: "fixture-guest-connector",
    },
  };
  const request = (server: typeof initial, path: string, init?: RequestInit) =>
    fetch(server.origin + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
  const unauthenticated = await request(initial, "/api/connect/relay-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(endpointConfig),
  });
  Assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  Assert.equal(registrations.size, 0);
  await client.request("/api/connect/relay-config", endpointConfig);
  await waitForConnector(client, connectorHostname);
  Assert.ok(
    registrations.has(initialPort),
    "Initial connector must have a verified relay registration",
  );

  checkpoint("open a synthetic invite through owner RPC");
  const settings = await client.rpc((rpc) =>
    rpc[WS_METHODS.serverUpdateSettings]({ patch: { guestSharingEnabled: true } }),
  );
  Assert.equal(settings.guestSharingEnabled, true);
  const projectId = ProjectId.make("fixture-packaged-guest");
  await client.createProject({
    projectId,
    title: "Packaged guest fixture",
    workspaceRoot: workspace,
  });
  const { threadId, projection } = await client.rpc((rpc) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      title: "Guest fixture thread",
      projectId,
      commandId: CommandId.make("fixture-packaged-guest:launch"),
      modelSelection: { instanceId: provider, model: "todo-list" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      generateTitle: false,
    }),
  );
  Assert.equal(projection.runs.length, 0);
  Assert.equal(projection.messages.length, 0);
  const { url, share } = await client.rpc((rpc) => rpc[WS_METHODS.guestShareCreate]({ threadId }));
  const invite = new URL(url);
  Assert.equal(invite.origin, `https://${connectorHostname}`);
  Assert.equal(invite.pathname, "/guest");
  const credential = invite.hash.slice(1);
  const [inviteId, signature] = credential.split(".");
  Assert.equal(inviteId, share.id);
  Assert.ok(signature);
  const badSignature = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
  Assert.equal(share.guestName, null);
  Assert.ok(FS.lstatSync(database).isFile());
  assertNoApplicationSqlite(state);

  const redeem = (server: typeof initial, name: string, token = credential) =>
    request(server, "/api/guest/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeRedeem({ credential: token, name }),
    });
  const session = (server: typeof initial, cookie: string) =>
    request(server, `/api/guest/session?share=${encodeURIComponent(share.id)}`, {
      headers: { cookie },
    });
  const read = () => snapshot(databaseHelper, database);

  checkpoint("refuse failed authorization without native writes");
  const before = read();
  Assert.equal(before.projects.length, 1);
  Assert.equal(before.threads.length, 1);
  await refuse(
    await redeem(initial, "Invalid signature", `${inviteId}.${badSignature}`),
    403,
    "invalid",
  );
  Assert.deepEqual(read(), before);
  setConnectorHostname(otherHostname);
  await waitForConnector(client, otherHostname);
  await refuse(await redeem(initial, "Wrong connector host"), 403, "inactive");
  Assert.deepEqual(read(), before);
  setConnectorHostname(connectorHostname);
  await waitForConnector(client, connectorHostname);

  checkpoint("redeem once under concurrent HTTP");
  const attempts = await Promise.all(
    ["Guest A", "Guest B"].map(async (name) => ({ name, response: await redeem(initial, name) })),
  );
  Assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [204, 409]);
  const winner = attempts.find(({ response }) => response.status === 204);
  const loser = attempts.find(({ response }) => response.status === 409);
  Assert.ok(winner && loser);
  await refuse(loser.response, 409, "used");
  Assert.equal(winner.response.headers.get("cache-control"), "no-store");
  const [setCookie, ...extraCookies] = winner.response.headers.getSetCookie();
  Assert.ok(setCookie && extraCookies.length === 0);
  for (const attribute of [
    /;\s*HttpOnly(?:;|$)/iu,
    /;\s*Secure(?:;|$)/iu,
    /;\s*SameSite=Strict(?:;|$)/iu,
    /;\s*Path=\/api\/guest(?:;|$)/iu,
  ]) {
    Assert.match(setCookie, attribute);
  }
  const [cookie] = setCookie.split(";");
  Assert.ok(cookie && cookie.startsWith(`${guestSessionCookieName(share.id)}=`));
  const after = read();
  assertRedeemCommit(before, after, threadId);
  const payload = cellValue(after.threads[0]?.row.payload_json);
  Assert.ok(typeof payload === "string");
  const storedShare = JSON.parse(payload).guestShare;
  Assert.equal(storedShare.id, share.id);
  Assert.equal(storedShare.guestName, winner.name);
  Assert.equal((await session(initial, cookie)).status, 204);
  Assert.deepEqual(read(), after);

  checkpoint("reopen packaged server on a fresh port");
  const reopenPort = await reservePort();
  Assert.notEqual(initialPort, reopenPort);
  Assert.ok(await initial.stop(), "Initial process must close");
  active = undefined;
  Assert.deepEqual(read(), after);
  const reopened = await start("reopened", reopenPort);
  Assert.ok(initial.pid && reopened.pid);
  Assert.notEqual(initial.pid, reopened.pid);
  const reopenedClient = await authenticatePackagedServer(reopened, abort.signal);
  await waitForConnector(reopenedClient, connectorHostname);
  Assert.ok(registrations.has(reopenPort), "Reopened server must reconfirm its new origin");
  Assert.deepEqual(read(), after);
  Assert.equal((await session(reopened, cookie)).status, 204);
  Assert.deepEqual(read(), after);
  await refuse(await redeem(reopened, "Replayed invite"), 409, "used");
  const afterReplay = read();
  assertRedeemReplay(after, afterReplay);

  checkpoint("revoke the old session from the reopened server");
  const replacement = await reopenedClient.rpc((rpc) =>
    rpc[WS_METHODS.guestShareCreate]({ threadId }),
  );
  Assert.notEqual(replacement.share.id, share.id);
  const afterRevocation = read();
  await refuse(await session(reopened, cookie), 403, "inactive");
  Assert.deepEqual(read(), afterRevocation);
  if (browserFlag === "--browser") {
    checkpoint("redeem in Chromium and validate the secure browser cookie");
    const { openPackagedGuestBrowser } = await import("../../web/scripts/packaged-guest-browser.ts");
    const browser = await openPackagedGuestBrowser({
      invite: replacement.url,
      cookieName: guestSessionCookieName(replacement.share.id),
      threadTitle: "Guest fixture thread",
      name: "Browser guest Café",
      cert: FS.readFileSync(certificate),
      key: FS.readFileSync(key),
      targetPort: reopenPort,
    });
    try {
      const browserCommitted = read();
      assertRedeemCommit(afterRevocation, browserCommitted, threadId);
      const rawThread = cellValue(browserCommitted.threads[0]?.row.payload_json);
      Assert.ok(typeof rawThread === "string");
      Assert.equal(JSON.parse(rawThread).guestShare.guestName, "Browser guest Café");
      checkpoint("reopen the same browser session after a packaged server restart");
      const restartPort = await reservePort();
      Assert.ok(restartPort !== initialPort && restartPort !== reopenPort);
      Assert.ok(await reopened.stop(), "The process serving the browser redemption must close");
      active = undefined;
      Assert.deepEqual(read(), browserCommitted);
      const restarted = await start("browser-reopened", restartPort);
      const restartedClient = await authenticatePackagedServer(restarted, abort.signal);
      await waitForConnector(restartedClient, connectorHostname);
      Assert.ok(registrations.has(restartPort));
      await browser.reopen(restartPort);
      Assert.deepEqual(read(), browserCommitted);
      checkpoint("refuse the revoked browser session without writing native state");
      const revoked = await restartedClient.rpc((rpc) => rpc[WS_METHODS.guestShareCreate]({ threadId }));
      Assert.notEqual(revoked.share.id, replacement.share.id);
      const browserRevoked = read();
      await browser.assertRevoked();
      Assert.deepEqual(read(), browserRevoked);
      Assert.ok(await restarted.stop(), "The restarted process must close");
      active = undefined;
      Assert.deepEqual(read(), browserRevoked);
      report.browser = { chromium: browser.chromium, secureScopedCookie: true, keyboardJoined: true,
        recoveredWithoutCredential: true, revokedAfterProcessReopen: true };
    } finally {
      await browser.close();
    }
  } else {
    Assert.ok(await reopened.stop(), "Reopened process must close");
    active = undefined;
    Assert.deepEqual(read(), afterRevocation);
  }
  assertNoApplicationSqlite(state);

  report.observed = {
    connectorRegistrations: registrations.size,
    nativeDatabase: "omdb",
    authorizationRefusalsPreservedNativeRows: true,
    concurrentStatuses: [204, 409],
    cookiesIssued: 1,
    durableRedemptionEvents: 1,
    validSessionAfterProcessReopen: true,
    replayRefusedAfterProcessReopen: true,
    revokedSessionRefusedWithoutNativeWrites: true,
  };
  report.status = "passed";
  checkpoint("complete");
} catch (error) {
  report.status = "failed";
  // A failed assertion may carry a cookie, token or signed payload in its values.
  report.failure = error instanceof Error ? error.name : "Unknown failure";
  failure = error;
} finally {
  try {
    const [processClosed, relayClosed] = await Promise.allSettled([
      active?.stop(),
      new Promise<void>((resolve, reject) => {
        const server = relay;
        if (!server?.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
    ]);
    if (processClosed.status === "rejected") throw processClosed.reason;
    if (relayClosed.status === "rejected") throw relayClosed.reason;
    FS.rmSync(scratch, { recursive: true, force: true });
    report.scratchRemoved = !FS.existsSync(scratch);
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = error instanceof Error ? error.name : "Unknown cleanup failure";
    failure ??= error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    save();
  }
}
if (failure !== undefined) {
  const label = failure instanceof Error ? failure.stack?.split("\n").slice(1, 5).join("\n") : "";
  throw new Error(
    `Guest authorization proof failed at ${report.phase}: ${report.failure ?? report.cleanupFailure}\n${label}`,
  );
}
