// @effect-diagnostics nodeBuiltinImport:off - synthetic, loopback-only packaged application proof.
import * as Assert from "node:assert/strict";
import * as Http from "node:http";
import * as FS from "node:fs";
import * as Path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Page, WebSocket as BrowserSocket } from "playwright";

export function stagePreviewFixtureBrowser(stateDirectory: string) {
  const source = process.env.T3_CODE_LS_PREVIEW_BROWSER_HOME;
  Assert.ok(source && Path.isAbsolute(source), "A prepared fixture browser is required");
  const receipt = JSON.parse(FS.readFileSync(Path.join(source, "preview-browser.json"), "utf8")) as {
    source: string; platform: string; architecture: string; executable: string; executableSha256: string; version: string;
  };
  Assert.equal(receipt.source, "PreviewBrowser");
  Assert.equal(receipt.platform, "linux");
  Assert.equal(receipt.architecture, "x64");
  Assert.match(receipt.executable, /^tools\/chrome-headless-shell\/linux64\/[0-9.]+\/chrome-headless-shell$/u);
  const binary = Path.join(source, receipt.executable);
  Assert.equal(FS.realpathSync(binary), binary);
  Assert.equal(createHash("sha256").update(FS.readFileSync(binary)).digest("hex"), receipt.executableSha256);
  FS.cpSync(Path.join(source, "tools"), Path.join(stateDirectory, "tools"), { recursive: true, errorOnExist: true, force: false });
  return receipt;
}

interface StreamObservation {
  readonly socket: BrowserSocket;
  readonly threadId: string;
  readonly tabId: string;
  frames: number;
  closed: boolean;
  viewport: { width: number; height: number } | null;
  controller: string | null;
}

export async function verifyPreviewLifetime(page: Page, threadId: string, screenshot: string) {
  const events: string[] = [];
  const appUrl = page.url();
  const appPages = page.context().pages().length;
  const prefix = `/controlled-preview-${randomUUID()}`;
  const pageHtml = (second: boolean) => `<!doctype html><meta charset="utf-8"><title>Controlled preview ${second ? "second" : "first"}</title>
<style>body{margin:0;background:#fff;color:#111;font:20px sans-serif}button{position:absolute;left:20px;top:20px;width:180px;height:60px;font:20px sans-serif}a{position:absolute;left:20px;top:110px}h1{position:absolute;left:20px;top:160px;font:24px sans-serif}#motion{position:absolute;left:20px;top:230px;width:90px;height:90px;background:#15803d}</style>
<button id="count">Count: 0</button><a href="${prefix}/${second ? "first" : "second"}">${second ? "First" : "Second"} page</a><h1>Controlled preview ${second ? "second" : "first"}</h1><div id="motion"></div>
<script>let count=0;document.getElementById('count').onclick=async()=>{count++;document.getElementById('count').textContent='Count: '+count;document.title='Preview count '+count;await fetch('${prefix}/interaction',{method:'POST',body:String(count)})};let step=0;setInterval(()=>{document.getElementById('motion').style.background=step++%2?'#15803d':'#1d4ed8'},200)</script>`;
  const server = Http.createServer((request, response) => {
    if (request.method === "GET" && [prefix + "/first", prefix + "/second"].includes(request.url ?? "")) {
      if (events.length < 64) events.push(request.url!.endsWith("second") ? "second" : "first");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
      response.end(pageHtml(request.url!.endsWith("second")));
    } else if (request.method === "POST" && request.url === prefix + "/interaction") {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); if (body.length > 16) request.destroy(); });
      request.on("end", () => {
        if (!/^[1-9][0-9]?$/u.test(body) || events.length >= 64) { response.writeHead(400).end(); return; }
        events.push(`count:${body}`);
        response.writeHead(204).end();
      });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  Assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const streams: StreamObservation[] = [];
  const onSocket = (socket: BrowserSocket) => {
    const url = new URL(socket.url());
    if (url.pathname !== "/api/preview-stream/ws") return;
    Assert.equal(url.host, new URL(page.url()).host);
    Assert.equal(url.searchParams.get("threadId"), threadId);
    Assert.ok(streams.length < 24, "Preview reconnects must stay bounded");
    const stream: StreamObservation = { socket, threadId, tabId: url.searchParams.get("tabId") ?? "", frames: 0, closed: false, viewport: null, controller: null };
    Assert.ok(stream.tabId);
    streams.push(stream);
    socket.on("close", () => { stream.closed = true; });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") { stream.frames++; return; }
      const value = JSON.parse(payload) as { type?: string; width?: number; height?: number; controller?: string };
      if (value.type === "viewport" && Number.isInteger(value.width) && Number.isInteger(value.height) && value.width! > 0 && value.width! <= 7680 && value.height! > 0 && value.height! <= 4320) stream.viewport = { width: value.width!, height: value.height! };
      if (value.type === "control") stream.controller = value.controller ?? null;
    });
  };
  page.on("websocket", onSocket);
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      Assert.ok(Date.now() < deadline, description);
      await page.waitForTimeout(50);
    }
  };
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  const canvas = page.locator("[data-server-browser-surface] canvas:visible");
  const openBrowser = async () => {
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    const launcher = page.getByLabel("Open a surface", { exact: true });
    const addSurface = page.getByRole("button", { name: "Add panel surface", exact: true });
    await launcher.or(addSurface).first().waitFor({ state: "visible" });
    if (await launcher.isVisible()) await launcher.getByRole("button", { name: /^Browser/u }).click();
    else {
      await page.getByRole("button", { name: "Add panel surface", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Browser/u }).first().click();
    }
    const location = page.getByRole("textbox", { name: "Search or enter URL", exact: true });
    await location.fill(origin + prefix + "/first");
    await location.press("Enter");
    await canvas.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close Controlled preview first", exact: true }).waitFor({ state: "visible" });
    await waitFor(() => streams.some((s) => !s.closed && s.frames > 0 && s.controller === "you" && s.viewport !== null), "The real preview must stream a controllable page");
    return streams.findLast((s) => !s.closed && s.frames > 0)!;
  };
  const clickPage = async (x: number, y: number) => {
    const before = streams.reduce((n, stream) => n + stream.frames, 0);
    await waitFor(() => streams.reduce((n, stream) => n + stream.frames, 0) > before,
      "The synthetic animation must produce a fresh real preview frame before input");
    const stream = streams.findLast((s) => !s.closed && s.frames > 0 && s.viewport && s.controller === "you");
    Assert.ok(stream?.viewport);
    const bounds = await canvas.boundingBox();
    Assert.ok(bounds);
    const bitmap = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }));
    const fit = Math.min(bounds.width / bitmap.width, bounds.height / bitmap.height);
    const width = bitmap.width * fit;
    const height = bitmap.height * fit;
    await page.mouse.click(bounds.x + (bounds.width - width) / 2 + x * width / stream.viewport.width,
      bounds.y + (bounds.height - height) / 2 + y * height / stream.viewport.height);
  };
  try {
    const first = await openBrowser();
    await clickPage(80, 120);
    await waitFor(() => events.includes("second"), "Page link must navigate inside the owned preview");
    Assert.equal(page.url(), appUrl);
    Assert.equal(page.context().pages().length, appPages);
    await page.getByRole("button", { name: "Close Controlled preview second", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Close Controlled preview first", exact: true }).waitFor({ state: "visible" });
    await clickPage(80, 50);
    await waitFor(() => events.includes("count:1"), "Normal streamed pointer input must reach the local page");
    await page.getByRole("button", { name: "Close Preview count 1", exact: true }).waitFor({ state: "visible" });
    const beforeHide = streams.length;
    await toggle.click();
    await canvas.waitFor({ state: "hidden" });
    await waitFor(() => streams.every((s) => s.closed), "A hidden panel must release its viewer sockets");
    const stoppedFrames = streams.reduce((n, s) => n + s.frames, 0);
    await page.waitForTimeout(250);
    Assert.equal(streams.reduce((n, s) => n + s.frames, 0), stoppedFrames);
    await toggle.click();
    await canvas.waitFor({ state: "visible" });
    await waitFor(() => streams.length > beforeHide && streams.some((s) => !s.closed && s.frames > 0), "Showing the panel must reconnect its stream");
    Assert.equal(streams.findLast((s) => !s.closed)!.tabId, first.tabId);
    await clickPage(80, 50);
    await waitFor(() => events.includes("count:2"), "The retained page must remain interactive after reconnect");
    await page.getByRole("button", { name: "Close Preview count 2", exact: true }).click();
    await waitFor(() => streams.every((s) => s.closed), "Closing a preview tab must detach the viewer");
    const reopened = await openBrowser();
    Assert.notEqual(reopened.tabId, first.tabId);
    const priorCount = events.filter((e) => e === "count:1").length;
    await clickPage(80, 50);
    await waitFor(() => events.filter((e) => e === "count:1").length === priorCount + 1, "The reopened tab must have fresh page state");
    await canvas.screenshot({ path: screenshot });
    await page.getByRole("button", { name: "Close Preview count 1", exact: true }).click();
    await waitFor(() => streams.every((s) => s.closed), "Final close must detach every fixture viewer");
    if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
    Assert.equal(page.url(), appUrl);
    Assert.equal(page.context().pages().length, appPages);
    return { runtime: "server", loopbackOnly: true, navigationOwned: true, pointerRoundTrip: true,
      hiddenViewerDetached: true, sameTabReconnected: true, closedViewerDetached: true, reopenedFresh: true,
      pageEvents: events, frames: streams.reduce((n, s) => n + s.frames, 0), streamConnections: streams.length,
      sandbox: process.env.T3CODE_SERVER_BROWSER_SANDBOX === "0" ? "disabled-for-isolated-fixture" : "enabled" };
  } finally {
    page.off("websocket", onSocket);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
