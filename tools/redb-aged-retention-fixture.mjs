import * as Assert from "node:assert/strict";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Sink from "../apps/server/src/orchestration-v2/EventSink.ts";
import * as Events from "../apps/server/src/orchestration-v2/EventStore.ts";
import * as Outbox from "../apps/server/src/orchestration-v2/EffectOutbox.ts";
import * as Receipts from "../apps/server/src/orchestration-v2/CommandReceiptStore.ts";
import * as NativeSink from "../apps/server/src/orchestration-v2/NativeEventSink.ts";
import * as NativeProjections from "../apps/server/src/orchestration-v2/NativeProjectionStore.ts";
import * as NativeMaintenance from "../apps/server/src/orchestration-v2/NativeProjectionMaintenance.ts";
import * as Maintenance from "../apps/server/src/orchestration-v2/ProjectionMaintenance.ts";
import * as NativeRows from "../apps/server/src/orchestration-v2/NativeMaintenanceRows.ts";
import * as Rows from "../apps/server/src/orchestration-v2/MaintenanceRows.ts";
import * as NativeEvents from "../apps/server/src/persistence/NativeEventRows.ts";
import { createFixture } from "./database-fixture.mjs";
import { exportSqliteState } from "./export-sqlite-state.mjs";
import { at } from "./check-outbox-runtime.mjs";
import { fixedTime, fixedDateTime, sampleEvents, jsonPayloads, makeEvent } from "./redb-event-sink-fixtures.mjs";
import { createMigratedSqlite, hash, nativeRequest, normalized, withNative } from "./redb-domain-fixture.mjs";

const collect = (stream) => stream.pipe(Stream.runCollect, Effect.map(Array.from));
const old = fixedTime;
const cleanupTime = "2026-11-12T12:00:00.000Z";
const command = (id, events, effects = []) => ({
  commandId: id, threadId: "thread:main", commandType: "fixture.command",
  acceptedAt: fixedDateTime, events, effects,
});
const detached = (id) => makeEvent("provider-session.detached", {
  providerSessionId: `session:${id}`, detachedAt: fixedTime,
}, { id });

/** Exact engine-history owner, also called by DatabaseStorage's scheduled pass.
 * server.runStorageCleanup owns worktrees/logs/browser artifacts, not engine retention.
 * No providers or workers execute the retained synthetic outbox requests.
 */
export async function verifyAgedRetention(executable) {
  const fixture = await createFixture();
  try {
    const source = Path.join(fixture.root, "source.sqlite");
    const exported = Path.join(fixture.root, "source.ndjson");
    await createMigratedSqlite(source);
    const sourceHash = hash(await FS.readFile(source));
    exportSqliteState({ source, destination: exported });
    nativeRequest(executable, fixture, "initialize", {
      operation: "import_sqlite_application", path: exported,
    });
    const attachment = { type: "file", id: "retained-file", name: "retained.txt",
      mimeType: "text/plain", sizeBytes: 19 };
    const attachmentPath = Path.join(fixture.root, "retained.txt");
    await FS.writeFile(attachmentPath, "synthetic retained\n");
    const attachmentHash = hash(await FS.readFile(attachmentPath));
    const backupPath = Path.join(fixture.root, "before-retention.omdb");
    const initial = command("retention:accepted", [
      ...sampleEvents,
      makeEvent("run.updated", jsonPayloads.run, { id: "retention:running-usage-anchor" }),
      makeEvent("provider-turn.updated", { ...jsonPayloads.providerTurn,
        tokenUsage: { usedTokens: 73, inputTokens: 61, outputTokens: 12, updatedAt: fixedTime } },
        { id: "retention:usage" }),
      makeEvent("message.updated", { ...jsonPayloads.message, attachments: [attachment] },
        { id: "retention:attachment" }),
    ], ["active", "pending"].map((id) => ({
      id: `retention:${id}`, commandId: "retention:accepted", threadId: "thread:main",
      request: { type: "terminal.cleanup" },
    })));
    let beforeProjection, beforeEffects, beforeReceipt, beforeRows, finalRows, finalStats;
    let boundary, foreground;
    const services = (use) => withNative(executable, fixture, (client, database) =>
      Effect.gen(function* () {
        const graph = yield* Layer.build(NativeSink.layer);
        const sink = Context.get(graph, Sink.EventSinkV2);
        const events = Context.get(graph, Events.EventStoreV2);
        const outbox = Context.get(graph, Outbox.EffectOutboxV2);
        const receipts = Context.get(graph, Receipts.CommandReceiptStoreV2);
        const projections = yield* NativeProjections.make;
        const rows = yield* NativeRows.make;
        const eventRows = yield* NativeEvents.make;
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2.pipe(
          Effect.provide(NativeMaintenance.layer),
        );
        return yield* use({ client, database, sink, events, outbox, receipts,
          projections, rows, eventRows, maintenance });
      }).pipe(Effect.provide(SecureRandom.layerWebCrypto), Effect.timeout("30 seconds")),
    );
    await services(({ database, sink, outbox, receipts, projections, rows, eventRows, maintenance }) =>
      Effect.gen(function* () {
        yield* sink.commitProjectCommand({
          commandId: "retention:project", projectId: "project:main", commandType: "project.create",
          acceptedAt: fixedDateTime,
          event: { eventId: "retention:project-event", aggregateKind: "project", aggregateId: "project:main",
            type: "project.created", occurredAt: fixedTime, commandId: "retention:project",
            causationEventId: null, correlationId: "retention:project", metadata: {},
            payload: { projectId: "project:main", title: "Synthetic retention", workspaceRoot: fixture.root,
              defaultModelSelection: null, scripts: [], createdAt: fixedTime, updatedAt: fixedTime } },
        });
        yield* at(fixedTime, sink.commitCommand(initial));
        // Enough real committed events to require more than one 50-row deletion page.
        for (let page = 0; page < 3; page++)
          yield* sink.write({ events: Array.from({ length: 50 }, (_, i) =>
            detached(`retention:expired:${page * 50 + i}`)) });
        Assert.ok(Option.isSome(yield* outbox.claimNext({ workerId: "retention:worker" })));
        beforeProjection = normalized((yield* projections.getThreadSnapshot("thread:main")).projection);
        Assert.ok(beforeProjection.messages.some((row) => row.attachments.some((file) => file.id === attachment.id)));
        Assert.ok(beforeProjection.providerTurns.some((row) => row.tokenUsage?.usedTokens === 73));
        Assert.ok(beforeProjection.runtimeRequests.some((row) => row.status === "pending"));
        beforeEffects = normalized(yield* outbox.listByCommandId(initial.commandId));
        Assert.deepEqual(beforeEffects.map((row) => row.status).sort(), ["pending", "running"]);
        beforeReceipt = normalized(yield* receipts.getByCommandId(initial.commandId));
        Assert.ok(Option.isSome(yield* receipts.getByCommandId(initial.commandId)));
        beforeRows = normalized(yield* eventRows.read({ after_sequence: 0, limit: 4096 }));
        boundary = yield* sink.latestSequence();
        // Make the synthetic mark due through the production row adapter; no wall-clock wait.
        for (const name of ["thread-projections", "event-log-prune-mark"])
          yield* rows.write({ kind: "metadata", name, sequence: boundary,
            schema_version: 2, updated_at: old }, Rows.EmptyRows);
        yield* database.request({ operation: "storage_backup", destination: backupPath }, Schema.Unknown);
        let interrupted = false;
        const partial = yield* Effect.exit(at(cleanupTime, maintenance.pruneEventStore(
          Effect.gen(function* () {
            const current = yield* eventRows.read({ after_sequence: 0, limit: 4096 });
            if (current.length >= beforeRows.length) return;
            interrupted = true;
            return yield* Effect.fail("retention:interrupt-after-committed-page");
          }),
        )));
        Assert.ok(Exit.isFailure(partial));
        Assert.equal(interrupted, true, "Exercise recovery after a committed deletion page");
        Assert.equal(yield* eventRows.prunedThrough, boundary);
      }),
    );
    // Close/reopen after the interrupted pass. Retry must preserve partial progress.
    await services(({ sink, events, outbox, receipts, projections, eventRows, maintenance, database }) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make();
        const originalLatest = events.latestSequence;
        events.latestSequence = (input) => originalLatest(input).pipe(
          Effect.tap(() => Deferred.succeed(ready, undefined)),
        );
        const live = yield* Effect.forkScoped(collect(sink.stream({
          afterSequence: boundary, threadId: "thread:main",
          eventType: "provider-session.detached",
        }).pipe(Stream.take(1))));
        yield* Deferred.await(ready);
        events.latestSequence = originalLatest;
        let sent = false;
        const result = yield* at(cleanupTime, maintenance.pruneEventStore(Effect.gen(function* () {
          if (sent) return;
          sent = true;
          foreground = yield* sink.commitCommand(command("retention:foreground", [detached("retention:foreground-event")]));
          Assert.equal(foreground.committed, true);
          Assert.deepEqual(normalized(yield* Fiber.join(live)), normalized(foreground.storedEvents));
        })));
        Assert.equal(sent, true);
        Assert.ok(result.deletedEventCount > 0);
        Assert.equal(result.deletedReceiptCount, 0);
        Assert.equal(yield* eventRows.prunedThrough, boundary);
        Assert.deepEqual(normalized((yield* projections.getThreadSnapshot("thread:main")).projection), beforeProjection);
        Assert.deepEqual(normalized(yield* outbox.listByCommandId(initial.commandId)), beforeEffects);
        Assert.deepEqual(normalized(yield* receipts.getByCommandId(initial.commandId)), beforeReceipt);
        const highWater = yield* sink.latestSequence();
        Assert.equal((yield* sink.commitCommand(initial)).committed, false);
        Assert.equal(yield* sink.latestSequence(), highWater, "Receipt retry cannot resurrect pruned events");
        finalRows = normalized(yield* eventRows.read({ after_sequence: 0, limit: 4096 }));
        Assert.ok(finalRows.length < beforeRows.length - 50);
        Assert.ok(finalRows.some((row) => row.event_type === "thread.created"));
        Assert.ok(finalRows.some((row) => row.event_id === "retention:running-usage-anchor"));
        Assert.ok(finalRows.some((row) => row.event_id === "retention:foreground-event"));
        Assert.ok(!finalRows.some((row) => row.event_id === "retention:expired:0"));
        finalStats = normalized(yield* eventRows.stats({ kind: "application", after_sequence: 0, through_sequence: highWater }));
        Assert.equal(finalStats.event_count, finalRows.length);
        Assert.equal(finalStats.raw_payload_bytes, finalRows.reduce((sum, row) => sum + Buffer.byteLength(row.payload_json), 0));
        // Online physical compaction is refused rather than closing live application handles.
        const refused = yield* Effect.exit(database.request({ operation: "storage_compact" }, Schema.Unknown));
        Assert.ok(Exit.isFailure(refused));
        Assert.ok(JSON.stringify(refused).includes("NativeDatabaseRejected"));
      }),
    );
    await services(({ sink, outbox, receipts, projections, eventRows }) => Effect.gen(function* () {
      Assert.deepEqual(normalized((yield* projections.getThreadSnapshot("thread:main")).projection), beforeProjection);
      Assert.deepEqual(normalized(yield* outbox.listByCommandId(initial.commandId)), beforeEffects);
      Assert.deepEqual(normalized(yield* receipts.getByCommandId(initial.commandId)), beforeReceipt);
      Assert.deepEqual(normalized(yield* eventRows.read({ after_sequence: 0, limit: 4096 })), finalRows);
      Assert.deepEqual(normalized(yield* eventRows.stats({ kind: "application", after_sequence: 0,
        through_sequence: yield* sink.latestSequence() })), finalStats);
      Assert.equal((yield* sink.commitCommand(command("retention:foreground", [detached("must-not-write")]))).committed, false);
    }));
    // Restore is inspected in a separate owned database, never copied over the live store.
    await withNative(executable, { ...fixture, databasePath: backupPath }, () => Effect.gen(function* () {
      const eventRows = yield* NativeEvents.make;
      Assert.deepEqual(normalized(yield* eventRows.read({ after_sequence: 0, limit: 4096 })), beforeRows);
      const projections = yield* NativeProjections.make;
      Assert.deepEqual(normalized((yield* projections.getThreadSnapshot("thread:main")).projection), beforeProjection);
    }));
    Assert.equal(hash(await FS.readFile(source)), sourceHash);
    Assert.equal(hash(await FS.readFile(attachmentPath)), attachmentHash);
    return { beforeEvents: beforeRows.length, afterEvents: finalRows.length, boundary, finalStats,
      checks: ["Aged engine retention resumes after a committed-page interruption and reopen",
        "Foreground EventSink command commits and reaches a live replay subscriber between prune pages",
        "Accepted receipts, pending and active work, projections including history/usage and attachment references survive retention and reopen",
        "Pre-retention backup reopens independently; online compaction refuses; source and synthetic attachment bytes remain intact" ] };
  } finally {
    await fixture.close();
  }
}
