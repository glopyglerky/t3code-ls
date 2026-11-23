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
const directory = Path.join(fixture.root, "ordered");
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
async function run(use) {
  return withNative(executable, fixture, (unused, source) => Effect.gen(function* () {
    const ordered = yield* NativeDatabase.make({
      executable, databasePath: fixture.databasePath, mode: "ordered-fixture-local",
    });
    const transport = NativeDatabase.NativeDatabase.of({
      // Repository preparation validates only the empty seed. All domain
      // sessions select the candidate before application_begin is sent.
      request: (input, response) => {
        Assert.match(input.operation, /^application_(events|receipts|positions|projects|projections|outbox)_prepare$/);
        return source.request(input, response);
      },
      withSession: (useSession) => ordered.withSession((session) =>
        Effect.gen(function* () {
          yield* session.request(selection(), Schema.Struct({ selected: Schema.Boolean, profile: Schema.String }));
          return yield* useSession({
            discard: session.discard,
            request: (input, response) => {
              transcript.push(structuredClone(input));
              return session.request(input, response);
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
      return yield* use({ sink, client, snapshot });
    }).pipe(Effect.provideService(RedbClient.RedbClient, client));
  }).pipe(Effect.provide(SecureRandom.layerWebCrypto)));
}
try {
  nativeRequest(executable, fixture, "initialize", { operation: "application_bootstrap" });
  for (const name of ["events", "receipts", "positions", "projects", "projections", "outbox"]) {
    let result;
    do { result = nativeRequest(executable, fixture, "connect", { operation: `application_${name}_prepare` }); }
    while (!result.prepared);
  }
  const seedHash = hash(await FS.readFile(fixture.databasePath));
  // Refuse unknown profiles before creating any candidate or admitting a writer.
  const badDirectory = Path.join(fixture.root, "unknown");
  const unknown = frames([
    { ...selection(true), profile: "unknown", directory: badDirectory },
    { operation: "application_begin", transaction_id: "must-not-begin" },
  ]);
  Assert.ok(unknown.every((response) => response.ok === false));
  await Assert.rejects(FS.stat(badDirectory), { code: "ENOENT" });
  Assert.equal(frames([selection(true)], "local")[0].ok, false);
  await Assert.rejects(FS.stat(directory), { code: "ENOENT" });
  Assert.equal(frames([selection(true)])[0].ok, true);
  Assert.equal(frames([selection(true)])[0].ok, false, "Initialization cannot reuse a profile");
  Assert.equal(frames([{ ...selection(), profile: alternateProfile }])[0].ok, false);
  Assert.equal(frames([selection(), { operation: "application_bootstrap" }])[1].ok, false);
  const first = await run(({ sink, snapshot }) => at(fixedTime, Effect.gen(function* () {
    const committed = yield* sink.commitCommand(command);
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
  Assert.equal(hash(await FS.readFile(fixture.databasePath)), seedHash, "Seed must remain unchanged");
  for (const operation of ["application_begin", "application_receipts_insert", "application_events_append",
    "application_projections_apply_many", "application_outbox_enqueue", "application_receipts_upsert", "application_commit"]) {
    Assert.ok(transcript.some((frame) => frame.operation === operation), operation);
  }
  const receipt = {
    kind: "t04-ordered-event-sink", profile,
    orderedDependency: "efaf649fb270ce70257e53862295cc10e4bddab0",
    checks: ["unknown-profile-no-session", "ordinary-mode-refusal", "exclusive-initialization", "different-engine-refusal",
      "unscoped-operation-refusal", "EventSink-atomic-commit", "exact-JSON-replay-after-reopen",
      "failed-staging-no-commit-after-reopen", "seed-unchanged"],
    stateSha256: hash(JSON.stringify(first.state)), frames: transcript.map((frame) => frame.operation),
  };
  if (proofPath) await FS.writeFile(proofPath, JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  await fixture.close();
}
