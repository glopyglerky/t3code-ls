#!/usr/bin/env node
// Isolated T04 fixture. No provider, activation, installed profile or migration.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as EventStore from "../apps/server/src/orchestration-v2/EventStore.ts";
import * as CommandReceiptStore from "../apps/server/src/orchestration-v2/CommandReceiptStore.ts";
import { completedWorkCases, expectedWork, readCompletedWork } from "./ordered-completed-work.mjs";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as EventSink from "../apps/server/src/orchestration-v2/EventSink.ts";
import * as NativeEventSink from "../apps/server/src/orchestration-v2/NativeEventSink.ts";
import * as NativeDatabase from "../apps/server/src/orchestration-v2/NativeDatabase.ts";
import * as RedbClient from "../apps/server/src/persistence/RedbClient.ts";
import { createFixture } from "./database-fixture.mjs";
import { nativeRequest, withNative, hash, normalized } from "./redb-domain-fixture.mjs";
import { fixedTime, fixedDateTime, sampleEvents, makeEvent } from "./redb-event-sink-fixtures.mjs";
import { at } from "./check-outbox-runtime.mjs";

const [executable, proofPath, engine = "direct-redb", ...extra] = process.argv.slice(2);
Assert.ok(executable && Path.isAbsolute(executable));
Assert.equal(extra.length, 0);
Assert.ok(["direct-redb", "fjall"].includes(engine));
const fixture = await createFixture();
let directory = Path.join(fixture.root, "ordered");
const profile = `t04-${engine}-efaf649-v1`;
const alternateProfile = engine === "direct-redb" ? "t04-fjall-efaf649-v1" : "t04-direct-redb-efaf649-v1";
const selection = (initialize = false) => ({
  operation: "application_ordered_fixture_select", profile, directory, initialize,
});
function frames(requests, mode = "ordered-fixture-local") {
  const output = ChildProcess.execFileSync(executable, [mode, fixture.databasePath], {
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    env: {}, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  return output.trim().split("\n").map((line) => JSON.parse(line));
}
const command = {
  commandId: "command:ordered-wire", threadId: "thread:main",
  commandType: "fixture.command", acceptedAt: fixedDateTime,
  events: sampleEvents,
  effects: [{ id: "effect:ordered-wire", commandId: "command:ordered-wire",
    threadId: "thread:main", request: { type: "terminal.cleanup" } }],
};
const snapshotTables = ["orchestration_events", "orchestration_command_receipts",
  "orchestration_v2_effect_outbox", "orchestration_v2_projection_threads"];
const transcript = [];
const prepared = new Map();
async function run(use, fault = {}) {
  return withNative(executable, fixture, () => Effect.gen(function* () {
    const ordered = yield* NativeDatabase.make({
      executable, databasePath: fixture.databasePath, mode: "ordered-fixture-local",
    });
    const transport = NativeDatabase.NativeDatabase.of({
      // The helper has already prepared the empty seed. Reuse those exact
      // preparation receipts so layering the client never reopens its writer.
      // Every domain session still opens the candidate before application_begin.
      request: (input, response) => {
        Assert.ok(prepared.has(input.operation), input.operation);
        return Schema.decodeUnknownEffect(response)(prepared.get(input.operation));
      },
      withSession: (useSession) => ordered.withSession((session) =>
        Effect.gen(function* () {
          yield* session.request(selection(), Schema.Struct({ selected: Schema.Boolean, profile: Schema.String }));
          return yield* useSession({
            discard: session.discard,
            request: (input, response) => {
              transcript.push(structuredClone(input));
              return Effect.gen(function* () {
                const result = yield* session.request(input, response);
                if (input.operation === "application_commit" && fault.dropCommit) {
                  // Fixture-owned barrier: the exact helper acknowledged a real
                  // successful commit before its acknowledgement is withheld.
                  Assert.deepEqual(result, { committed: true });
                  fault.dropCommit = false;
                  fault.acknowledged = structuredClone(input);
                  yield* session.discard;
                  fault.discarded = true;
                  return yield* new NativeDatabase.NativeDatabaseOutcomeUnknown({ stage: "response" });
                }
                return result;
              });
            },
          });
        }).pipe(Effect.ensuring(session.discard)),
      ),
    });
    const client = yield* RedbClient.make.pipe(Effect.provideService(NativeDatabase.NativeDatabase, transport));
    return yield* Effect.gen(function* () {
      const services = yield* Layer.build(NativeEventSink.layer);
      const sink = Context.get(services, EventSink.EventSinkV2);
      const snapshot = client.withReadTransaction(Effect.gen(function* () {
        const result = {};
        for (const table of snapshotTables) {
          const rows = [];
          let after = null;
          do {
            const page = yield* client.scan(table, { after, limit: 256 });
            rows.push(...page.rows);
            after = page.next;
          } while (after !== null);
          result[table] = rows;
        }
        return result;
      }));
      return yield* use({ sink, client, snapshot,
        events: Context.get(services, EventStore.EventStoreV2),
        receipts: Context.get(services, CommandReceiptStore.CommandReceiptStoreV2),
      });
    }).pipe(Effect.provideService(RedbClient.RedbClient, client));
  }).pipe(Effect.provide(SecureRandom.layerWebCrypto)));
}
try {
  nativeRequest(executable, fixture, "initialize", { operation: "application_bootstrap" });
  for (const name of ["events", "receipts", "positions", "projects", "projections", "outbox"]) {
    const operation = `application_${name}_prepare`;
    let result;
    do {
      result = nativeRequest(executable, fixture, "connect", { operation });
    } while (!result.prepared);
    prepared.set(operation, result);
  }
  // Ordinary local mode opens the writable omdb file even when the request
  // refuses. Finish that control before freezing the read-only fixture seed.
  Assert.equal(frames([selection(true)], "local")[0].ok, false);
  await Assert.rejects(FS.stat(directory), { code: "ENOENT" });
  const seedHash = hash(await FS.readFile(fixture.databasePath));
  const assertSeed = async (phase) => {
    Assert.equal(hash(await FS.readFile(fixture.databasePath)), seedHash, `Seed changed during ${phase}`);
  };
  // Refuse unknown profiles before creating any candidate or admitting a writer.
  const badDirectory = Path.join(fixture.root, "unknown");
  const unknown = frames([
    { ...selection(true), profile: "unknown", directory: badDirectory },
    { operation: "application_begin", transaction_id: "must-not-begin" },
  ]);
  Assert.ok(unknown.every((response) => response.ok === false));
  await Assert.rejects(FS.stat(badDirectory), { code: "ENOENT" });
  await assertSeed("unknown-profile refusal");
  Assert.equal(frames([selection(true)])[0].ok, true);
  await assertSeed("candidate schema staging");
  Assert.equal(frames([selection(true)])[0].ok, false, "Initialization cannot reuse a profile");
  Assert.equal(frames([{ ...selection(), profile: alternateProfile }])[0].ok, false);
  Assert.equal(frames([selection(), { operation: "application_bootstrap" }])[1].ok, false);
  const first = await run(({ sink, snapshot }) => at(fixedTime, Effect.gen(function* () {
    const published = [];
    yield* sink.observeCommittedThreadEvents(new Map([[command.threadId, (event) => published.push(event.id)]]));
    const committed = yield* sink.commitCommand(command);
    Assert.deepEqual(published, committed.storedEvents.map(({ event }) => event.id));
    Assert.ok(published.length > 0, "Publication observer positive control");
    Assert.equal(committed.committed, true);
    const state = yield* snapshot;
    for (const table of snapshotTables) Assert.ok(state[table].length > 0, table);
    return { committed: normalized(committed), state };
  })));
  // A new transport/helper and reopened engine must return the original JSON.
  await run(({ sink, snapshot }) => Effect.gen(function* () {
    const replay = yield* sink.commitCommand({ ...command, events: [], effects: [] });
    Assert.equal(replay.committed, false);
    Assert.equal(JSON.stringify(normalized(replay.storedEvents)), JSON.stringify(first.committed.storedEvents));
    Assert.deepEqual(yield* snapshot, first.state);
    const failureStart = transcript.length;
    const failure = yield* Effect.exit(sink.commitCommand({
      ...command, commandId: "command:failed-staging",
      events: [makeEvent("provider-session.detached", {
        providerSessionId: "session:staged", detachedAt: fixedTime,
      }, { id: "event:staged", threadId: "thread:main" }),
      // A duplicate event id with a different payload fails after staging work.
      makeEvent("provider-session.detached", {
        providerSessionId: "session:collision", detachedAt: fixedTime,
      }, { id: "event:staged", threadId: "thread:main" })],
      effects: [],
    }));
    Assert.ok(Exit.isFailure(failure));
    const failedFrames = transcript.slice(failureStart);
    Assert.equal(failedFrames.filter((frame) => frame.operation === "application_events_append").length, 2);
    Assert.ok(!failedFrames.some((frame) => frame.operation === "application_commit"));
    Assert.deepEqual(yield* snapshot, first.state);
  }));
  await run(({ snapshot }) => snapshot.pipe(Effect.tap((state) => Effect.sync(() => Assert.deepEqual(state, first.state)))));
  await assertSeed("EventSink commit, rollback and reopen");
  for (const operation of ["application_begin", "application_receipts_insert", "application_events_append",
    "application_projections_apply_many", "application_outbox_enqueue", "application_receipts_upsert", "application_commit"]) {
    Assert.ok(transcript.some((frame) => frame.operation === operation), operation);
  }
  const unknownCommand = {
    ...command, commandId: "command:ordered-lost-ack",
    events: [makeEvent("provider-session.detached", {
      providerSessionId: "session:main", detachedAt: fixedTime,
    }, { id: "event:ordered-lost-ack", threadId: command.threadId })],
    effects: [{ ...command.effects[0], id: "effect:ordered-lost-ack", commandId: "command:ordered-lost-ack" }],
  };
  const fault = { dropCommit: true };
  const unknownStart = transcript.length;
  const unknownPublished = [];
  await run(({ sink }) => at(fixedTime, Effect.gen(function* () {
    yield* sink.observeCommittedThreadEvents(new Map([[command.threadId, (event) => unknownPublished.push(event.id)]]));
    const failure = yield* sink.commitCommand(unknownCommand).pipe(Effect.catch(Effect.succeed));
    Assert.equal(failure?._tag, "EventSinkWriteError");
    Assert.equal(failure.cause?._tag, "NativeDatabaseOutcomeUnknown");
    Assert.equal(failure.cause.stage, "response");
    Assert.equal(fault.dropCommit, false);
    Assert.equal(fault.discarded, true);
    Assert.deepEqual(unknownPublished, []);
  })), fault);
  const unknownFrames = transcript.slice(unknownStart);
  Assert.equal(unknownFrames.filter((frame) => frame.operation === "application_begin").length, 1);
  Assert.equal(unknownFrames.filter((frame) => frame.operation === "application_commit").length, 1);
  Assert.deepEqual(unknownFrames.at(-1), fault.acknowledged);
  Assert.ok(!unknownFrames.some((frame) => frame.operation === "application_rollback"));
  await assertSeed("lost acknowledgement after real commit");
  // A new client/helper selects and reopens the same candidate. Receipt lookup
  // resolves the original operation; replay must never publish the missed event.
  const recovered = await run(({ sink, client, snapshot }) => Effect.gen(function* () {
    const published = [];
    yield* sink.observeCommittedThreadEvents(new Map([[command.threadId, (event) => published.push(event.id)]]));
    const state = yield* snapshot;
    const textCell = (value) => ({ type: "text", value });
    const belongsToCommand = ({ row }) => row.command_id.type === "text"
      && row.command_id.value === unknownCommand.commandId;
    const events = state.orchestration_events.filter(belongsToCommand);
    const effects = state.orchestration_v2_effect_outbox.filter(belongsToCommand);
    const receipts = state.orchestration_command_receipts.filter(belongsToCommand);
    Assert.equal(events.length, 1);
    Assert.deepEqual(events[0].row.event_id, textCell(unknownCommand.events[0].id));
    Assert.equal(effects.length, 1);
    Assert.deepEqual(effects[0].row.effect_id, textCell(unknownCommand.effects[0].id));
    Assert.equal(receipts.length, 1);
    for (const table of snapshotTables.slice(0, 3)) Assert.equal(state[table].length, first.state[table].length + 1);
    const sequence = Number(events[0].row.sequence.value);
    Assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
    const sequenceCell = { type: "integer", value: String(sequence) };
    Assert.deepEqual(events[0].row.sequence, sequenceCell);
    const expectedReceipt = {
      command_id: unknownCommand.commandId, aggregate_kind: "thread", aggregate_id: command.threadId,
      command_type: command.commandType, accepted_at: fixedTime,
      result_sequence: sequence, status: "accepted", error: null,
    };
    Assert.deepEqual(receipts[0].row, {
      command_id: textCell(expectedReceipt.command_id), aggregate_kind: textCell("thread"),
      aggregate_id: textCell(command.threadId), command_type: textCell(command.commandType),
      accepted_at: textCell(fixedTime), result_sequence: sequenceCell,
      status: textCell("accepted"), error: { type: "null" },
    });
    const lookup = yield* client.request("application_receipts_get", {
      command_id: unknownCommand.commandId,
    }, Schema.Unknown);
    Assert.deepEqual(lookup, expectedReceipt);
    const replayStart = transcript.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = yield* sink.commitCommand({ ...unknownCommand, events: [], effects: [] });
      Assert.equal(replay.committed, false);
      Assert.deepEqual(normalized(replay.receipt), normalized({
        commandId: unknownCommand.commandId, threadId: command.threadId,
        commandType: command.commandType, acceptedAt: fixedDateTime,
        resultSequence: expectedReceipt.result_sequence, status: "accepted", error: null,
      }));
      Assert.equal(replay.storedEvents.length, 1);
      Assert.equal(replay.storedEvents[0].event.id, unknownCommand.events[0].id);
      Assert.deepEqual(normalized(replay.storedEvents[0].event), normalized(unknownCommand.events[0]));
      Assert.deepEqual(yield* snapshot, state);
      Assert.deepEqual(published, []);
    }
    const replayFrames = transcript.slice(replayStart);
    Assert.equal(replayFrames.filter((frame) => frame.operation === "application_receipts_get"
      && frame.command_id === unknownCommand.commandId).length, 2);
    for (const operation of ["application_events_append", "application_projections_apply_many",
      "application_outbox_enqueue", "application_receipts_upsert"]) {
      Assert.ok(!replayFrames.some((frame) => frame.operation === operation), operation);
    }
    return state;
  }));
  await run(({ snapshot }) => snapshot.pipe(Effect.tap((state) => Effect.sync(() => Assert.deepEqual(state, recovered)))));
  Assert.deepEqual(unknownPublished, []);
  await assertSeed("lost-ack receipt recovery and repeated replay after reopen");
  // This fresh candidate is separate from the fault cases above. Timings are
  // diagnostic complete application work, including helper/transport overhead.
  directory = Path.join(fixture.root, "completed-work");
  Assert.equal(frames([selection(true)])[0].ok, true);
  // Untimed empty-candidate read warms the local cache; every run still opens a new helper.
  await run(({ snapshot }) => snapshot);
  const cases = completedWorkCases({ command, sampleEvents, makeEvent, fixedTime });
  const completedWork = [];
  const allCommands = [];
  for (const phase of cases) {
    allCommands.push(...phase.commands);
    const expected = expectedWork(allCommands);
    const start = process.hrtime.bigint();
    const observed = await run(({ sink, events, receipts, snapshot }) => at(fixedTime, Effect.gen(function* () {
      for (const input of phase.commands) {
        const committed = yield* sink.commitCommand(input);
        Assert.equal(committed.committed, true);
        const want = expected.commands.find((row) => row.receipt.commandId === input.commandId);
        Assert.deepEqual(normalized({ receipt: committed.receipt, storedEvents: committed.storedEvents }), want);
      }
      return yield* readCompletedWork({ events, receipts, snapshot, expected, Effect, Stream, Option, normalized });
    })));
    const elapsedNs = String(process.hrtime.bigint() - start);
    // New helper/client and actual engine reopen. Do not fold reopen or faults
    // into the warm application-work measurement.
    const reopened = await run(({ events, receipts, snapshot }) =>
      readCompletedWork({ events, receipts, snapshot, expected, Effect, Stream, Option, normalized }));
    Assert.deepEqual(reopened, observed);
    await assertSeed(`completed-work ${phase.name} reopen`);
    completedWork.push({ phase: phase.name, elapsedNs, canonical: observed,
      counts: { commandsWritten: phase.commands.length, eventsWritten: phase.commands.reduce((n, c) => n + c.events.length, 0),
        receiptsRead: allCommands.length, historyRowsRead: expected.history.length + 5,
        pagesRead: Math.ceil(expected.history.length / 5) + 2 }, reopenedEqual: true });
  }
  const receipt = {
    kind: "t04-ordered-event-sink", profile, engine,
    executableSha256: hash(await FS.readFile(executable)),
    completedWork,
    workloadSha256: hash(JSON.stringify(normalized(cases))),
    fixtureSha256: hash(await FS.readFile(new URL(import.meta.url))),
    orderedDependency: "efaf649fb270ce70257e53862295cc10e4bddab0",
    checks: ["unknown-profile-no-session", "ordinary-mode-refusal", "exclusive-initialization", "different-engine-refusal",
      "unscoped-operation-refusal", "EventSink-atomic-commit", "exact-JSON-replay-after-reopen",
      "failed-staging-no-commit-after-reopen", "seed-unchanged",
      "lost-ack-after-real-commit-outcome-unknown", "lost-ack-session-discarded",
      "lost-ack-exact-receipt-after-reopen", "lost-ack-one-event-one-effect",
      "lost-ack-no-duplicate-publication"],
    recoveredStateSha256: hash(JSON.stringify(recovered)),
    stateSha256: hash(JSON.stringify(first.state)), frames: transcript.map((frame) => frame.operation),
  };
  if (proofPath) await FS.writeFile(proofPath, JSON.stringify(receipt, null, 2) + "\n");
  // Retain raw samples in per-arm proof files. Only the comparison gate reports timings.
  process.stdout.write(JSON.stringify({ kind: receipt.kind, engine, checks: receipt.checks,
    completedWork: completedWork.map(({ phase, counts, reopenedEqual }) => ({ phase, counts, reopenedEqual })),
  }) + "\n");
} finally {
  await fixture.close();
}
