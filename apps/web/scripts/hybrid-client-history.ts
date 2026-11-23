// @effect-diagnostics nodeBuiltinImport:off - isolated packaged-browser proof only.
// MIT. Transcript/import lineage: tools/src/startup_probe/reopen.rs and browser/reopen-seed.js
// at 126ee67adb8a0042d79c8bbc4ba600faa28026f8. This slice uses 1 x 200 messages;
// the separately measured 32 x 200 workspace remains a separate qualification.
import * as Assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { OrchestrationV2ThreadBoundedSnapshot, OrchestrationV2ThreadHistoryPage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import type { Page } from "playwright";

export const savedHistoryThread = "import:codex:0251af00-0000-4000-8000-000000000000";
const count = 200;
const text = (index: number) => `Reopen fixture 0000 ${index % 2 === 0 ? "user" : "assistant"} ${String(index).padStart(4, "0")}\n${"Synthetic saved history. ".repeat(8).trim()}`;
const headers = { "x-t3-orchestration-protocol": "2" };
const decodeBounded = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));
const decodePage = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));

export function prepareSavedHistory(stateDirectory: string) {
  const homePath = Path.join(stateDirectory, "synthetic-codex");
  FS.mkdirSync(homePath, { recursive: true });
  return { driver: "codex", enabled: true,
    config: { setupMode: "existing", homePath, binaryPath: Path.join(homePath, "absent-codex") } };
}

export async function importSavedHistory(page: Page, stateDirectory: string, workspaceRoot: string) {
  const directory = Path.join(stateDirectory, "synthetic-codex/sessions/2026/11/01");
  FS.mkdirSync(directory, { recursive: true });
  FS.mkdirSync(workspaceRoot, { recursive: true });
  const id = savedHistoryThread.replace("import:codex:", "");
  const records = [{ type: "session_meta", payload: { id, cwd: workspaceRoot } },
    ...Array.from({ length: count }, (_, index) => ({
      timestamp: `2026-11-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ...(index % 2 === 0
        ? { type: "event_msg", payload: { type: "user_message", message: text(index) } }
        : { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: text(index) }] } }),
    }))];
  const transcript = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  FS.writeFileSync(Path.join(directory, `rollout-2026-11-01T00-00-00-${id}.jsonl`), transcript, { flag: "wx" });
  const script = FS.readFileSync(new URL("./hybrid-client-history-seed.js", import.meta.url), "utf8");
  const receipt = await page.evaluate(({ script, workspaceRoot, threadId }) =>
    new Promise<{ valid: boolean; error?: string; route?: string; imported?: unknown }>((done) => {
      new Function(script).apply(null, [workspaceRoot, 1, threadId, done]);
    }), { script, workspaceRoot, threadId: savedHistoryThread });
  Assert.equal(receipt.valid, true, receipt.error);
  Assert.ok(receipt.route);
  Assert.deepEqual(receipt.imported, { importedCount: 1, skippedCount: 0 });
  const beforeResponse = await page.request.get(new URL(
    `/api/orchestration/threads/${encodeURIComponent(savedHistoryThread)}/bounded`, page.url()).href, { headers });
  Assert.ok(beforeResponse.ok());
  const before = decodeBounded(await beforeResponse.json());
  Assert.ok(before.hasMoreHistory && before.historyCursor);
  const newest = boundedSnapshotProjection(before).messages.map(({ id, text, streaming }) => ({ id, text, streaming }));
  Assert.ok(newest.some((message) => message.text === text(count - 1)));
  return { ...receipt, route: receipt.route, threads: 1, messages: count,
    beforeRestart: { snapshotSequence: before.snapshotSequence, newest },
    transcriptSha256: Crypto.createHash("sha256").update(transcript).digest("hex"),
    seedSha256: Crypto.createHash("sha256").update(script).digest("hex") };
}

export async function verifySavedHistory(page: Page, seed: Awaited<ReturnType<typeof importSavedHistory>>) {
  const path = `/api/orchestration/threads/${encodeURIComponent(savedHistoryThread)}`;
  const origin = new URL(page.url()).origin;
  const observedPage = (anchored: boolean) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === origin && decodeURIComponent(url.pathname) === decodeURIComponent(path) + "/history" &&
      url.searchParams.has("throughEntryId") === anchored;
  });
  await page.goto(origin + seed.route, { waitUntil: "domcontentloaded" });
  const scroll = page.locator(".messages-timeline-scroll");
  await scroll.waitFor({ state: "visible" });
  // Read the authoritative bounded owner independently of HTTP/WS transport selection.
  const response = await page.request.get(origin + path + "/bounded", { headers });
  Assert.ok(response.ok());
  const initial = decodeBounded(await response.json());
  Assert.equal(initial.projection.thread.id, savedHistoryThread);
  Assert.ok(initial.hasMoreHistory && initial.historyCursor, "Saved history must exceed the authoritative window");
  const projection = boundedSnapshotProjection(initial);
  Assert.ok(initial.snapshotSequence >= seed.beforeRestart.snapshotSequence);
  Assert.deepEqual(projection.messages.map(({ id, text, streaming }) => ({ id, text, streaming })),
    seed.beforeRestart.newest, "Reopen must retain exact saved message identities, text and completion");
  const newest = projection.messages.find((message) => message.text === text(count - 1));
  Assert.ok(newest);
  Assert.ok(!projection.messages.some((message) => message.text === text(1)), "Old match must be outside the initial window");
  Assert.equal(await scroll.getByText(text(1).split("\n")[0]!, { exact: false }).count(), 0);
  const draft = "Saved history search preserves this unsent 雪 draft.";
  const editor = page.getByTestId("composer-editor");
  await editor.fill(draft);
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  const olderResponse = observedPage(false);
  await page.getByRole("button", { name: "Load earlier turns", exact: true }).click();
  const older = await olderResponse;
  Assert.ok(older.ok());
  const history = decodePage(await older.json());
  Assert.ok(history.items.length > 0);
  Assert.ok(history.snapshotSequence >= initial.snapshotSequence);
  Assert.equal(history.historyViewRevision, initial.historyViewRevision);
  const rows = [...history.items, ...projection.visibleTurnItems];
  Assert.equal(new Set(rows.map((row) => `${row.sourceThreadId}:${row.sourceItemId}`)).size, rows.length);
  // Page positions are local and renumbered. Compare the independent transcript
  // order across the page boundary instead of treating them as global ranks.
  const messages = rows.flatMap((row) => row.item.type === "user_message" || row.item.type === "assistant_message"
    ? [row.item.text] : []);
  Assert.ok(messages.length > projection.messages.length);
  const firstIndex = count - messages.length;
  Assert.deepEqual(messages, Array.from({ length: messages.length }, (_, index) => text(firstIndex + index)),
    "Older page and current window must preserve exact contiguous transcript order");
  Assert.ok(rows.every((row) => row.sourceThreadId === savedHistoryThread));
  Assert.ok(!rows.some((row) => "text" in row.item && row.item.text === text(1)),
    "One page must still leave the oldest match unloaded");
  await editor.focus();
  await editor.press("End");
  await page.keyboard.press("Control+f");
  const bar = page.getByRole("search", { name: "Find in thread" });
  await bar.waitFor({ state: "visible" });
  const input = bar.getByRole("searchbox", { name: "Find in thread" });
  const jumps: Array<{ index: number; text: string; messageId: string | undefined }> = [];
  for (const index of [1, count - 1, 1]) {
    const query = text(index).split("\n")[0]!;
    const soughtPage = jumps.length === 0 ? observedPage(true) : undefined;
    await input.fill(query);
    await bar.getByText("1/1", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction((query) => Array.from(CSS.highlights.get("t3-thread-find-active") ?? []).some((range) => {
      if (!(range instanceof Range)) return false;
      const element = range.startContainer.parentElement?.closest<HTMLElement>("[data-message-id]");
      const bounds = range.getBoundingClientRect();
      return range.toString() === query && element?.dataset.messageId && bounds.height > 0 &&
        bounds.top >= 0 && bounds.bottom <= innerHeight;
    }), query);
    const active = await page.evaluate(() => {
      const ranges = Array.from(CSS.highlights.get("t3-thread-find-active") ?? []);
      const range = ranges[0]!;
      return { text: range.toString(), messageId: range.startContainer.parentElement
        ?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId };
    });
    Assert.equal(active.text, query);
    Assert.ok(active.messageId);
    if (soughtPage) {
      const soughtResponse = await soughtPage;
      Assert.ok(soughtResponse.ok());
      const sought = decodePage(await soughtResponse.json());
      const row = sought.items.find((row) => row.item.type === "assistant_message" &&
        row.item.messageId === active.messageId);
      Assert.ok(row && row.item.type === "assistant_message");
      Assert.equal(row.sourceThreadId, savedHistoryThread);
      Assert.equal(row.item.text, text(index));
      Assert.ok(sought.snapshotSequence >= initial.snapshotSequence);
    }
    if (index === count - 1) Assert.equal(active.messageId, newest.id);
    else if (jumps.length === 2) Assert.equal(active.messageId, jumps[0]!.messageId);
    Assert.ok(await input.evaluate((element) => document.activeElement === element), "Search jumps retain input focus");
    Assert.equal(await editor.innerText(), draft);
    jumps.push({ index, ...active });
  }
  await bar.getByRole("button", { name: "Close find", exact: true }).click();
  await bar.waitFor({ state: "hidden" });
  Assert.equal(await editor.innerText(), draft);
  await editor.focus();
  await editor.press("End");
  await editor.press("!");
  Assert.equal(await editor.innerText(), draft + "!");
  await editor.press("Backspace");
  Assert.equal(await editor.innerText(), draft);
  return { threadId: savedHistoryThread, snapshotSequence: initial.snapshotSequence,
    historyViewRevision: initial.historyViewRevision ?? null, initialMessages: projection.messages.length,
    olderRows: history.items.map(({ sourceThreadId, sourceItemId, position }) => ({ sourceThreadId, sourceItemId, position })),
    jumps, draftPreserved: true, searchFocusPreserved: true, coverage: "1 thread, 200 alternating messages; 32-thread benchmark remains separate" };
}
