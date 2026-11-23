import * as Assert from "node:assert/strict";
import type { RowPage } from "../apps/server/src/persistence/RedbClient.ts";

export const guestStateTables = {
  events: "orchestration_events",
  projects: "projection_projects",
  threads: "orchestration_v2_projection_threads",
  receipts: "orchestration_command_receipts",
  outbox: "orchestration_v2_effect_outbox",
} as const;

export type GuestState = Record<keyof typeof guestStateTables, RowPage["rows"]>;
type Row = RowPage["rows"][number]["row"];

export const guestStatePageLimit = 32;
const redeemCommand = "thread.guest-share.redeem";

export function cellValue(cell: Row[string] | undefined) {
  return cell !== null && typeof cell === "object" && "value" in cell ? cell.value : undefined;
}

function appendedRows(before: RowPage["rows"], after: RowPage["rows"], id: string) {
  const oldIds = new Set(before.map(({ row }) => cellValue(row[id])));
  Assert.deepEqual(
    after.filter(({ row }) => oldIds.has(cellValue(row[id]))),
    before,
  );
  return after.filter(({ row }) => !oldIds.has(cellValue(row[id]))).map(({ row }) => row);
}

export function assertRedeemCommit(before: GuestState, after: GuestState, threadId: string) {
  const updates = appendedRows(before.events, after.events, "event_id");
  const [update] = updates;
  Assert.equal(updates.length, 1);
  Assert.ok(update);
  Assert.equal(cellValue(update.event_type), "thread.guest-share-updated");
  Assert.equal(cellValue(update.stream_id), threadId);
  const receipts = appendedRows(before.receipts, after.receipts, "command_id");
  Assert.deepEqual(receipts.map((row) => cellValue(row.status)).sort(), ["accepted", "rejected"]);
  Assert.ok(receipts.every((row) => cellValue(row.command_type) === redeemCommand));
  const accepted = receipts.find((row) => cellValue(row.status) === "accepted");
  Assert.ok(accepted);
  Assert.deepEqual(accepted.command_id, update.command_id);
  Assert.deepEqual(accepted.result_sequence, update.sequence);
  Assert.deepEqual(after.projects, before.projects);
  Assert.deepEqual(after.outbox, before.outbox);
  Assert.equal(after.threads.length, 1);
}

export function assertRedeemReplay(before: GuestState, after: GuestState) {
  Assert.deepEqual(after.events, before.events);
  Assert.deepEqual(after.threads, before.threads);
  Assert.deepEqual(after.projects, before.projects);
  Assert.deepEqual(after.outbox, before.outbox);
  const receipts = appendedRows(before.receipts, after.receipts, "command_id");
  Assert.equal(receipts.length, 1);
  Assert.equal(cellValue(receipts[0]?.command_type), redeemCommand);
  Assert.equal(cellValue(receipts[0]?.status), "rejected");
}
