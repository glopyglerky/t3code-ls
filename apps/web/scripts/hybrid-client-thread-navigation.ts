// @effect-diagnostics nodeBuiltinImport:off - isolated packaged browser verification.
import * as Assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

/** Called only with a real thread-read title link from the controlled replay
 * fixture. The owner must create its target through normal application routes.
 * This helper creates no DOM and never bypasses the selected-thread router. */
export async function verifyThreadNavigation(
  page: Page,
  link: Locator,
  expectedTarget: string,
  targetText: string,
  renderer: "dioxus" | "dioxus-fallback",
) {
  const sourceUrl = page.url();
  const editor = page.getByTestId("composer-editor");
  const draft = "Navigation must retain this unsent 雪 draft.";
  await editor.fill(draft);
  const anchor = link.locator("a").or(link.and(page.locator("a")));
  await revealThreadReadLink(page, anchor);
  if (renderer === "dioxus") {
    await assertEventuallyNative(anchor);
  } else {
    Assert.equal(await anchor.getAttribute("data-thread-link-renderer"), null);
  }
  const href = await anchor.getAttribute("href");
  Assert.equal(new URL(href!, sourceUrl).href, expectedTarget);
  await anchor.focus();
  Assert.ok(await anchor.evaluate((node) => document.activeElement === node));
  await page.keyboard.press("Enter");
  await page.waitForURL(expectedTarget);
  await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(expectedTarget);
  await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
  await page.goBack();
  await page.waitForURL(sourceUrl);
  await editor.waitFor({ state: "visible" });
  await page.waitForFunction((expected) => document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.innerText === expected, draft);
  await revealThreadReadLink(page, anchor);
  await anchor.focus();
  Assert.ok(await anchor.evaluate((node) => document.activeElement === node));
  return { renderer, sourceUrl, targetUrl: expectedTarget, keyboard: true, reopened: true, back: true, draftPreserved: true };
}

async function assertEventuallyNative(anchor: Locator) {
  await anchor.and(anchor.page().locator('[data-thread-link-renderer="dioxus-wasm"]')).waitFor({ state: "visible" });
}

// Install before first load in a fresh synthetic BrowserContext. The pairing
// mount shares this module, so authenticate the isolated profile before blocking
// and reload afterward; never reuse the module cache from a successful mount.
export async function denyThreadLinkWasm(page: Page) {
  let refusals = 0;
  await page.route("**/pairing-wasm/local_pairing_bg.wasm", async (route) => {
    refusals += 1;
    await route.abort("blockedbyclient");
  });
  return () => {
    Assert.ok(refusals > 0, "Fallback requires an observed denied Wasm request");
    return refusals;
  };
}

async function revealThreadReadLink(page: Page, anchor: Locator) {
  // The existing live-work disclosure intentionally has no nested link. Open
  // that production disclosure when the selected-thread view is collapsed.
  if (!(await anchor.isVisible())) {
    await page.getByRole("button").filter({ hasText: /Read (?:a T3 )?thread/u }).first().click();
  }
  await anchor.waitFor({ state: "visible" });
}
