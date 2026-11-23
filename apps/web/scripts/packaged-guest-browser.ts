// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated hosted browser fixture.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as Http from "node:http";
import * as Https from "node:https";
import { chromium } from "playwright";

export async function openPackagedGuestBrowser(input: {
  invite: string;
  cookieName: string;
  threadTitle: string;
  name: string;
  cert: Buffer;
  key: Buffer;
  targetPort: number;
  renderer?: "dioxus" | "dioxus-fallback" | undefined;
  expectedWasmHash?: string | undefined;
}) {
  const invite = new URL(input.invite);
  Assert.equal(invite.protocol, "https:");
  Assert.equal(invite.hostname, "guest.fixture.invalid");
  let targetPort = input.targetPort;
  let authority = "";
  const proxy = Https.createServer({ cert: input.cert, key: input.key }, (request, response) => {
    if (request.headers.host !== authority || !request.url?.startsWith("/") ||
      request.url.startsWith("//") || !["GET", "POST"].includes(request.method ?? "")) {
      response.writeHead(400).end();
      return;
    }
    const upstream = Http.request({
      host: "127.0.0.1", port: targetPort, path: request.url, method: request.method,
      headers: { ...request.headers, "x-forwarded-proto": "https" }, agent: false,
    }, (reply) => {
      if (response.destroyed) {
        reply.destroy();
        return;
      }
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
      response.once("close", () => reply.destroy());
    });
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  const shutdownProxy = () => new Promise<void>((resolve, reject) => {
    proxy.close((error) => error ? reject(error) : resolve());
    proxy.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  Assert.ok(address !== null && typeof address !== "string");
  invite.port = String(address.port);
  authority = invite.host;
  const spki = new Crypto.X509Certificate(input.cert).publicKey.export({ type: "spki", format: "der" });
  const pin = Crypto.createHash("sha256").update(spki).digest("base64");
  const browser = await chromium.launch({ args: [
    "--no-proxy-server",
    `--host-resolver-rules=MAP ${invite.hostname} 127.0.0.1, MAP * ~NOTFOUND`,
    `--ignore-certificate-errors-spki-list=${pin}`,
  ] }).catch(async (cause) => {
    await shutdownProxy();
    throw cause;
  });
  const close = async () => {
    try { await browser.close(); } finally { await shutdownProxy(); }
  };
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const wasmPath = "/pairing-wasm/local_pairing_bg.wasm";
    let wasmRequests = 0;
    let blockedWasmRequests = 0;
    let redemptions = 0;
    let credentialLeak = false;
    const credential = invite.hash.slice(1);
    Assert.ok(credential.length > 0);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === wasmPath) wasmRequests++;
      const redeem = url.origin === invite.origin && url.pathname === "/api/guest/redeem" && request.method() === "POST";
      if (redeem) redemptions++;
      if (request.url().includes(credential) ||
        Object.values(request.headers()).some((value) => value.includes(credential)) ||
        (!redeem && request.postData()?.includes(credential))) credentialLeak = true;
    });
    const assertTraffic = () => {
      Assert.equal(credentialLeak, false, "Invite credential left the redemption boundary");
      Assert.equal(redemptions, 1, "Session recovery must not redeem the invite again");
      Assert.equal(wasmRequests, input.renderer === undefined ? 0 : 1);
      Assert.equal(blockedWasmRequests, input.renderer === "dioxus-fallback" ? 1 : 0);
    };
    if (input.renderer === "dioxus-fallback") {
      await page.route(`**${wasmPath}`, (route) => {
        blockedWasmRequests++;
        return route.abort("blockedbyclient");
      });
    }
    const wasm = input.renderer === "dioxus" ? page.waitForResponse((reply) =>
      new URL(reply.url()).origin === invite.origin && new URL(reply.url()).pathname === wasmPath) : undefined;
    const title = page.getByRole("heading", { name: input.threadTitle, exact: true });
    const form = page.getByRole("heading", { name: "Join a shared thread", exact: true });
    const navigation = await page.goto(invite.href, { waitUntil: "domcontentloaded" });
    Assert.ok(navigation?.ok());
    let wasmSha256: string | undefined;
    if (wasm !== undefined) {
      const response = await wasm;
      Assert.equal(response.status(), 200);
      Assert.match(response.headers()["content-type"] ?? "", /^application\/wasm(?:;|$)/u);
      const bytes = await response.body();
      Assert.equal(bytes.subarray(0, 4).toString("hex"), "0061736d");
      wasmSha256 = Crypto.createHash("sha256").update(bytes).digest("hex");
      Assert.equal(wasmSha256, input.expectedWasmHash, "Served Wasm must match the extracted archive module");
    }
    if (input.renderer === "dioxus-fallback") {
      await page.getByRole("alert").filter({ hasText: "Could not open the guest name form." }).waitFor();
      Assert.equal(redemptions, 0, "Failed Wasm loading must not redeem the invite");
      await page.getByRole("button", { name: "Use standard form", exact: true }).click();
    }
    await form.waitFor({ state: "visible" });
    const selected = input.renderer === "dioxus" ? "dioxus-wasm" : "retained";
    const nameForm = page.locator(`form[data-guest-name-renderer="${selected}"]`);
    await nameForm.waitFor({ state: "visible" });
    Assert.equal(redemptions, 0, "The user must submit before redemption");
    const name = nameForm.getByRole("textbox", { name: "Your name", exact: true });
    await name.fill(input.name);
    const [redeemed] = await Promise.all([
      page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/guest/redeem" && reply.request().method() === "POST"),
      name.press("Enter"),
    ]);
    Assert.equal(redeemed.status(), 204);
    Assert.deepEqual(redeemed.request().postDataJSON(), { credential, name: input.name });
    await title.waitFor({ state: "visible" });
    Assert.equal(new URL(page.url()).hash, "", "The invite credential must be removed from the location");
    const cookies = (await context.cookies(`${invite.origin}/api/guest/session`))
      .filter(({ name }) => name === input.cookieName);
    Assert.equal(cookies.length, 1);
    const { secure, httpOnly, sameSite, path, domain } = cookies[0]!;
    Assert.deepEqual({ secure, httpOnly, sameSite, path, domain },
      { secure: true, httpOnly: true, sameSite: "Strict", path: "/api/guest", domain: invite.hostname });
    Assert.equal((await context.cookies(invite.origin + "/guest")).some(({ name }) => name === input.cookieName), false);
    assertTraffic();
    const reloadForSession = async () => {
      const [session] = await Promise.all([
        page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/guest/session"),
        page.reload({ waitUntil: "domcontentloaded" }),
      ]);
      return session.status();
    };
    return {
      chromium: browser.version(),
      renderer: input.renderer ?? "retained",
      selected,
      wasmSha256,
      wasmRequests,
      blockedWasmRequests,
      close,
      async reopen(port: number) {
        targetPort = port;
        Assert.equal(await reloadForSession(), 204);
        await title.waitFor({ state: "visible" });
        Assert.equal(await form.count(), 0);
        assertTraffic();
      },
      async assertRevoked() {
        Assert.equal(await reloadForSession(), 403);
        await page.getByText("This link has ended or is not valid", { exact: true }).waitFor({ state: "visible" });
        Assert.equal(await title.count(), 0);
        assertTraffic();
      },
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}
