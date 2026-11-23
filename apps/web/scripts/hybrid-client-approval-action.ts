// Packaged synthetic replay only. The caller retains application/profile ownership.
import * as Assert from "node:assert/strict";
import type { Locator, Page, Route, WebSocket } from "playwright";
import type { ReplayTurnIdentity } from "./hybrid-client-turn.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadDetailSnapshot,
} from "@t3tools/contracts";

export async function verifyApprovalAction<T extends object>(page: Page, hooks: {
  start(): Promise<{ threadId: string; requestId: string; identity: ReplayTurnIdentity; button: Locator; sha256: string }>;
  complete(threadId: string, identity: ReplayTurnIdentity): Promise<T>;
  snapshot(threadId: string): Promise<OrchestrationV2ThreadDetailSnapshot>;
  source: string;
}) {
  const mode = process.env.T3_CODE_LS_APPROVAL_PROOF;
  Assert.ok(mode === "dioxus" || mode === "dioxus-fallback");
  const decisions: Array<{ commandId: string; threadId: string; requestId: string; decision: string }> = [];
  const observe = (socket: WebSocket) => socket.on("framesent", ({ payload }) => {
    const text = payload.toString();
    if (!text.includes('"runtime-request.respond"')) return;
    const frame = JSON.parse(text);
    if (frame.tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand &&
        frame.payload?.type === "runtime-request.respond") {
      decisions.push(frame.payload);
    }
  });
  page.on("websocket", observe);
  const wasm = "**/pairing-wasm/local_pairing_bg.wasm";
  const block = (route: Route) => route.abort("blockedbyclient");
  if (mode === "dioxus-fallback") await page.route(wasm, block);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const pending = await hooks.start();
    Assert.equal(decisions.length, 0, "Loading or choosing fallback must not approve");
    const native = page.getByRole("group", { name: "Command approval", exact: true })
      .locator('button[data-approval-action-renderer="dioxus-wasm"]');
    Assert.equal(await native.count(), mode === "dioxus" ? 1 : 0);
    // Retain the exact node to exercise a detached stale control after completion.
    const node = await pending.button.elementHandle();
    Assert.ok(node);
    if (mode === "dioxus") {
      await pending.button.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected the Dioxus button");
        button.click();
        button.click();
      });
    } else {
      await pending.button.click();
    }
    const completed = await hooks.complete(pending.threadId, pending.identity);
    Assert.equal(decisions.length, 1, "Repeated clicks must dispatch one decision");
    Assert.equal(decisions[0]?.threadId, pending.threadId);
    Assert.equal(decisions[0]?.requestId, pending.requestId);
    Assert.equal(decisions[0]?.decision, "accept");
    Assert.ok(decisions[0]?.commandId);
    const resolved = async () => Assert.equal((await hooks.snapshot(pending.threadId))
      .projection.runtimeRequests.find((request) => request.id === pending.requestId)?.status, "resolved");
    await resolved();
    await node.evaluate((button) => (button as HTMLButtonElement).click());
    await page.reload({ waitUntil: "domcontentloaded" });
    await hooks.complete(pending.threadId, pending.identity);
    await resolved();
    Assert.equal(decisions.length, 1, "A stale control and reopen must not replay approval");
    return { ...completed, requestId: pending.requestId, source: hooks.source, sha256: pending.sha256,
      approvalAction: { mode, decisions, reopened: true } };
  } finally {
    page.off("websocket", observe);
    if (mode === "dioxus-fallback") await page.unroute(wasm, block);
  }
}
