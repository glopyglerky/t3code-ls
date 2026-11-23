// @effect-diagnostics nodeBuiltinImport:off - isolated packaged browser verification.
import * as Assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

/** Called only with a real timeline or sidebar title link from the controlled replay
 * fixture. The owner must create its target through normal application routes.
 * This helper creates no DOM and never bypasses the selected-thread router. */
export async function verifyThreadNavigation(
  page: Page,
  anchor: Locator,
  expectedTarget: string,
  targetText: string,
  renderer: "dioxus" | "dioxus-fallback",
  entry: "thread-read" | "sidebar" = "thread-read",
) {
  const sourceUrl = page.url();
  const reveal = async () => {
    if (entry === "thread-read") await revealThreadReadLink(page, anchor);
    else {
      await anchor.waitFor({ state: "visible" });
      Assert.equal(await anchor.locator("xpath=ancestor::*[@data-testid='sidebar-row-card']").count(), 1);
    }
  };
  const editor = page.getByTestId("composer-editor");
  const draft = "Navigation must retain this unsent 雪 draft.";
  await editor.fill(draft);
  await reveal();
  if (renderer === "dioxus") {
    await assertEventuallyNative(anchor);
  } else {
    Assert.equal(await anchor.getAttribute("data-thread-link-renderer"), null);
  }
  if (entry === "sidebar") {
    const nativeBehavior = await anchor.evaluate((node) => {
      const contextAllowed = node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const modifiers = ["ctrlKey", "metaKey", "shiftKey", "altKey"].every((key) => {
        let preserved = false;
        const cancel = (event: MouseEvent) => { preserved = !event.defaultPrevented; event.preventDefault(); };
        document.addEventListener("click", cancel, { once: true });
        node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, [key]: true }));
        document.removeEventListener("click", cancel);
        return preserved;
      });
      return { contextAllowed, modifiers };
    });
    Assert.deepEqual(nativeBehavior, { contextAllowed: true, modifiers: true });
    Assert.equal(page.url(), sourceUrl);
  }
  const href = await anchor.getAttribute("href");
  Assert.equal(new URL(href!, sourceUrl).href, expectedTarget);
  await anchor.focus();
  Assert.ok(await anchor.evaluate((node) => document.activeElement === node));
  await page.keyboard.press("Enter");
  await page.waitForURL(expectedTarget);
  await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
  if (entry === "sidebar") {
    await page.waitForFunction((href) => [...document.querySelectorAll<HTMLElement>('[data-sidebar-row][aria-current="page"] a')]
      .some((node) => node.getAttribute("href") === href), new URL(expectedTarget).pathname);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(expectedTarget);
  await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
  await page.goBack();
  await page.waitForURL(sourceUrl);
  await editor.waitFor({ state: "visible" });
  await page.waitForFunction((expected) => document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.innerText === expected, draft);
  await reveal();
  await anchor.focus();
  Assert.ok(await anchor.evaluate((node) => document.activeElement === node));
  if (entry === "sidebar") {
    // Plain pointer activation must take the same selected-thread route as Enter.
    await anchor.click();
    await page.waitForURL(expectedTarget);
    await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction((href) => [...document.querySelectorAll<HTMLElement>('[data-sidebar-row][aria-current="page"] a')]
      .some((node) => node.getAttribute("href") === href), new URL(expectedTarget).pathname);
    await page.goBack();
    await page.waitForURL(sourceUrl);
    await page.waitForFunction((expected) => document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.innerText === expected, draft);
    await reveal();
    await anchor.focus();
    Assert.ok(await anchor.evaluate((node) => document.activeElement === node));
  }
  return { renderer, entry, pointer: entry === "sidebar", selectedThread: entry === "sidebar", sourceUrl, targetUrl: expectedTarget, keyboard: true, reopened: true, back: true, draftPreserved: true };
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
  const collapsed = page.locator('[aria-expanded="false"]');
  const work = page.getByRole("button", { name: /^Worked for /u }).and(collapsed);
  const read = page.getByRole("button", { name: /^Read (?:a T3 )?thread/u }).and(collapsed);
  // Returning to the conversation can collapse the enclosing work group.
  await anchor.or(work).or(read).first().waitFor({ state: "visible" });
  if (!(await anchor.isVisible()) && (await work.isVisible())) await work.click();
  await anchor.or(read).first().waitFor({ state: "visible" });
  if (!(await anchor.isVisible())) await read.click();
  await anchor.waitFor({ state: "visible" });
}
