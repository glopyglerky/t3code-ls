// @effect-diagnostics nodeBuiltinImport:off - isolated Node acceptance assertions.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { assertNoApplicationSqlite } from "../../web/scripts/hybrid-client-database.ts";

export const sha256 = (file: string) =>
  Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");

type Cell = { type: "text" | "integer"; value: string } | { type: "null" };
type Row = Record<string, Cell>;
type ScanPage = { next: string | null; rows: Array<{ row: Row }> };
type EventRow = { sequence: number; event_id: string; event_type: string; payload_json: string };
type Stats = { event_count: number; has_create_event: boolean; raw_payload_bytes: number };
type Thread = { id: string; projectId: string; historyOrigin: string };
type ProviderThread = { appThreadId: string; nativeThreadRef: { nativeId: string } };
type Message = { role: string; text: string; runId: string | null };
type TurnItem = { type: string; text: string; runId: string | null };

function text(row: Row, column: string) {
  const cell = row[column];
  Assert.ok(cell?.type === "text", `Missing text cell ${column}`);
  return cell.value;
}

const tables = [
  "threads",
  "provider_threads",
  "messages",
  "turn_items",
  "turn_item_counts",
  "runs",
  "provider_sessions",
  "metadata",
] as const;
const transactionId = "provider-import-proof";

export function inspectNativeImport(input: {
  executable: string;
  baseDir: string;
  threadId: string;
  closed?: boolean;
}) {
  const state = Path.join(input.baseDir, "userdata");
  const database = Path.join(state, "statev2.omdb");
  Assert.ok(FS.lstatSync(database).isFile());
  // The historical filename is an ownership fence with a text payload.
  Assert.equal(FS.readFileSync(Path.join(state, "server-owner.sqlite"), "utf8"), "t3code-omdb-owner-v1\n");
  assertNoApplicationSqlite(input.baseDir);

  const before = input.closed ? sha256(database) : undefined;
  const result = ChildProcess.spawnSync(input.executable, ["read-only-local", database], {
    input:
      [
        { operation: "application_schema" },
        { operation: "application_begin", transaction_id: transactionId, mode: "read" },
        ...tables.map((table) => ({
          operation: "application_scan",
          transaction_id: transactionId,
          table: `orchestration_v2_projection_${table}`,
          limit: 16,
        })),
        {
          operation: "application_scan",
          transaction_id: transactionId,
          table: "provider_session_runtime",
          limit: 16,
        },
        {
          operation: "application_events_latest",
          transaction_id: transactionId,
          kind: "application",
        },
        {
          operation: "application_events_latest",
          transaction_id: transactionId,
          kind: "agent",
          thread_id: input.threadId,
        },
        {
          operation: "application_events_read",
          transaction_id: transactionId,
          after_sequence: 0,
          thread_id: input.threadId,
          only_agent_events: true,
          limit: 16,
        },
        {
          operation: "application_events_stats",
          transaction_id: transactionId,
          kind: "agent",
          thread_id: input.threadId,
          after_sequence: 0,
          through_sequence: Number.MAX_SAFE_INTEGER,
        },
        { operation: "application_rollback", transaction_id: transactionId },
      ].map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    env: {},
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  Assert.ifError(result.error);
  Assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trimEnd().split("\n").map((line) => {
    const envelope: { ok: boolean; result: unknown; error?: unknown } = JSON.parse(line);
    Assert.equal(envelope.ok, true, `Native inspection rejected frame: ${JSON.stringify(envelope.error)}`);
    return envelope.result;
  });
  Assert.equal(replies.length, tables.length + 8);
  Assert.equal((replies[0] as { version: number }).version, 1);
  const scans = replies.slice(2, tables.length + 3).map((value) => {
    const page = value as ScanPage;
    Assert.equal(page.next, null, "The bounded fixture must fit in one complete table page");
    return page.rows.map(({ row }) => row);
  });
  const [threads, providerThreads, messages, items, itemCounts, runs, providerSessions, metadata, runtimes] = scans;
  Assert.ok(threads && providerThreads && messages && items && itemCounts && runs && providerSessions && metadata && runtimes);
  Assert.ok(runtimes.length <= 1, "Only the synthetic thread can have a provider runtime");
  const runtime = runtimes[0];
  if (runtime) {
    Assert.equal(text(runtime, "thread_id"), input.threadId);
    Assert.equal(text(runtime, "status"), "stopped");
  }
  const runtimePayload = runtime ? JSON.parse(text(runtime, "runtime_payload_json")) : null;
  const markers: unknown[] = runtimePayload?.importedTranscripts ?? [];
  Assert.ok(Array.isArray(markers));

  const [applicationSequence, threadSequence, events, stats] = replies.slice(tables.length + 3) as [
    number, number, EventRow[], Stats,
  ];
  Assert.ok(Number.isSafeInteger(applicationSequence) && Number.isSafeInteger(threadSequence));
  Assert.equal(stats.event_count, events.length);
  const payloads = <T>(rows: Row[]): T[] => rows.map((row) => JSON.parse(text(row, "payload_json")));
  if (before !== undefined) Assert.equal(sha256(database), before, "Closed omdb changed during inspection");
  assertNoApplicationSqlite(input.baseDir);
  return {
    history: {
      applicationSequence,
      threadSequence,
      stats,
      events,
      threads: payloads<Thread>(threads),
      providerThreads: payloads<ProviderThread>(providerThreads),
      messages: payloads<Message>(messages),
      turnItems: payloads<TurnItem>(items),
      itemCounts,
      runCount: runs.length,
      providerSessionCount: providerSessions.length,
      metadata,
    },
    runtimeCount: runtimes.length,
    resumeCursor: runtime ? JSON.parse(text(runtime, "resume_cursor_json")) : null,
    markers,
    closedDatabaseUnchanged: before === undefined ? null : true,
  };
}
