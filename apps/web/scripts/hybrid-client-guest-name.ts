// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - synthetic packaged guest UI proof.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import { GUEST_NAME_MAX_LENGTH, GuestStreamEvent, GuestShareId, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Page } from "playwright";
import { makeThreadProjectionFixture } from "../src/test-fixtures.ts";

/** Packaged UI proof. Guest HTTP is synthetic; this does not qualify server authorization. */
export async function verifyGuestNameForm(page: Page, origin: string,
  renderer: "retained" | "dioxus" | "dioxus-fallback", expectedWasmHash?: string) {
  const shareId = "guest-name-fixture";
  const credential = `${shareId}.synthetic-signature`;
  const calls: Array<{ credential: string; name: string }> = [];
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const seen = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const awaitRequest = async (index: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([seen[index]!.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic guest redemption did not arrive")), 15_000);
    })]); } finally { clearTimeout(timer); }
  };
  let wasmRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/pairing-wasm/local_pairing_bg.wasm") wasmRequests++; });
  if (renderer === "dioxus-fallback") await page.route("**/pairing-wasm/local_pairing_bg.wasm", (route) => route.abort("blockedbyclient"));
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(GuestStreamEvent)));
  const projection = makeThreadProjectionFixture();
  const events: GuestStreamEvent[] = [
    { type: "view", view: { shareId: GuestShareId.make(shareId), title: "Shared guest fixture", guestName: "Changed name",
      expiresAt: "2099-01-01T00:00:00.000Z", messages: [], model: { driver: ProviderDriverKind.make("codex"), name: "Fixture", shortName: "Fixture" } } },
    { type: "thread", item: { kind: "snapshot", snapshotSequence: 1, projection } },
  ];
  await page.route("**/api/guest/**", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    Assert.equal(url.origin, origin);
    if (url.pathname.endsWith("/session")) {
      return route.fulfill({ status: request.headers().cookie?.includes("guest-name-proof=session") ? 204 : 401 });
    }
    if (url.pathname.endsWith("/redeem")) {
      Assert.equal(request.method(), "POST");
      const body = request.postDataJSON(); calls.push(body);
      seen[calls.length - 1]?.resolve();
      Assert.equal(body.credential, credential);
      if (calls.length === 1) { await gates[0]!.promise; return route.abort("failed"); }
      if (calls.length === 2) { await gates[1]!.promise; return route.fulfill({ status: 403, json: { message: "Fixture invite refused" } }); }
      Assert.equal(calls.length, 3, "No duplicate or automatic redemption is allowed");
      return route.fulfill({ status: 204, headers: { "set-cookie": "guest-name-proof=session; Path=/; HttpOnly; SameSite=Lax" } });
    }
    if (url.pathname.endsWith("/stream")) return route.fulfill({ status: 200,
      contentType: "text/event-stream", body: events.map((event) => `data: ${encode(event)}\n\n`).join("") });
    throw new Error(`Unexpected synthetic guest request: ${url.pathname}`);
  });
  try {
    const wasm = renderer === "dioxus" ? page.waitForResponse((response) => new URL(response.url()).pathname === "/pairing-wasm/local_pairing_bg.wasm") : undefined;
    await page.goto(`${origin}/guest#${credential}`);
    let wasmSha256: string | undefined;
    if (wasm !== undefined) {
      const response = await wasm; Assert.equal(response.status(), 200);
      const body = await response.body(); Assert.equal(body.subarray(0, 4).toString("hex"), "0061736d");
      wasmSha256 = Crypto.createHash("sha256").update(body).digest("hex");
      Assert.equal(wasmSha256, expectedWasmHash, "The packaged route must serve the selected Wasm bytes");
    }
    if (renderer === "dioxus-fallback") await page.getByRole("button", { name: "Use standard form" }).click();
    const selected = renderer === "dioxus" ? "dioxus-wasm" : "retained";
    const form = page.locator(`form[data-guest-name-renderer="${selected}"]`);
    await form.waitFor();
    const input = form.getByRole("textbox", { name: "Your name" });
    Assert.equal(await input.evaluate((node: HTMLInputElement) => node.maxLength), GUEST_NAME_MAX_LENGTH);
    await page.waitForFunction(() => document.activeElement?.id === "guest-name");
    Assert.ok(await input.evaluate((node) => document.activeElement === node), "The form must focus its semantic name input");
    await input.pressSequentially("x".repeat(GUEST_NAME_MAX_LENGTH + 1));
    Assert.equal((await input.inputValue()).length, GUEST_NAME_MAX_LENGTH, "Native input must enforce its typed name limit");
    Assert.equal(new URL(page.url()).hash, "");
    Assert.ok(!(await form.innerHTML()).includes(credential));
    await input.fill("   ");
    await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
    Assert.equal(calls.length, 0);
    await input.fill("  Sam🦊  ");
    await form.evaluate((node: HTMLFormElement) => { node.requestSubmit(); node.requestSubmit(); });
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("form button[type=submit]")?.disabled);
    await awaitRequest(0);
    Assert.equal(calls.length, 1, "Pending duplicate submissions must be fenced");
    await input.fill(" Changed name ");
    gates[0]!.resolve();
    await form.getByRole("alert").filter({ hasText: "Could not reach the server." }).waitFor();
    Assert.equal(await input.inputValue(), " Changed name ");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("form button[type=submit]")?.disabled);
    await awaitRequest(1);
    gates[1]!.resolve();
    await form.getByRole("alert").filter({ hasText: "Fixture invite refused" }).waitFor();
    await input.press("Enter");
    await page.getByRole("heading", { name: "Shared guest fixture" }).waitFor();
    Assert.deepEqual(calls.map((call) => call.name), ["Sam🦊", "Changed name", "Changed name"]);
    await page.reload();
    await page.getByRole("heading", { name: "Shared guest fixture" }).waitFor();
    Assert.equal(calls.length, 3, "Session reopen must not consume the invite again");
    Assert.equal(wasmRequests, renderer === "retained" ? 0 : 1);
    return { renderer, selected, wasmSha256, wasmRequests, submissions: calls.length,
      failureRetainsName: true, duplicateFenced: true, keyboardJoined: true, sessionReopened: true,
      guestHttp: "synthetic browser route; server authorization not qualified" };
  } finally { gates[0]!.resolve(); gates[1]!.resolve(); }
}
