// Dependency-free workload/model and fail-closed comparison for the T04 fixture.
import * as Assert from "node:assert/strict";
import * as FS from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const stockCommit = "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f";
export const pageSize = 5;
const json = (value) => JSON.parse(JSON.stringify(value));

export function completedWorkCases({ command, sampleEvents, makeEvent, fixedTime }) {
  const commands = Array.from({ length: 40 }, (_, index) => {
    const commandId = `command:completed:${index}`;
    return { ...command, commandId,
      events: index === 0 ? sampleEvents.filter((event) => event.type === "thread.created") : [makeEvent("provider-session.detached", {
        providerSessionId: "session:main", detachedAt: fixedTime,
      }, { id: `event:completed:${index}`, threadId: command.threadId })],
      effects: [{ ...command.effects[0], id: `effect:completed:${index}`, commandId }],
    };
  });
  return [{ name: "warm-synthetic", commands: commands.slice(0, 8) },
    { name: "aged-synthetic", commands: commands.slice(8) }];
}

// Expected values come from deterministic input, never from an engine result.
export function expectedWork(commands) {
  let sequence = 0;
  const results = commands.map((input) => {
    const storedEvents = input.events.map((event) => ({ sequence: ++sequence, commandId: input.commandId, event }));
    return { receipt: { commandId: input.commandId, threadId: input.threadId,
      commandType: input.commandType, acceptedAt: input.acceptedAt,
      resultSequence: sequence, status: "accepted", error: null }, storedEvents };
  });
  return json({ commands: results, history: results.flatMap((result) => result.storedEvents) });
}

export function readCompletedWork({ events, receipts, snapshot, expected, Effect, Stream, Option, normalized }) {
  return Effect.gen(function* () {
    const read = (input) => events.read(input).pipe(Stream.runCollect, Effect.map((rows) => normalized(Array.from(rows))));
    const threadId = expected.commands[0].receipt.threadId;
    const throughSequence = expected.history.at(-1).sequence;
    const pages = [];
    for (let offset = 0; offset < expected.history.length; offset += pageSize) {
      const afterSequence = offset === 0 ? 0 : expected.history[offset - 1].sequence;
      const rows = yield* read({ threadId, afterSequence, throughSequence, limit: pageSize });
      Assert.deepEqual(rows, expected.history.slice(offset, offset + pageSize));
      pages.push(rows);
    }
    Assert.deepEqual(yield* read({ threadId, afterSequence: throughSequence, throughSequence, limit: pageSize }), []);
    const offset = Math.min(Math.floor(expected.history.length / 2), expected.history.length - pageSize);
    const jump = yield* read({ threadId, afterSequence: expected.history[offset - 1].sequence, throughSequence, limit: pageSize });
    Assert.deepEqual(jump, expected.history.slice(offset, offset + pageSize));
    const receiptRows = [];
    for (const want of expected.commands) {
      const receipt = yield* receipts.getByCommandId(want.receipt.commandId);
      Assert.ok(Option.isSome(receipt));
      Assert.deepEqual(normalized(receipt.value), want.receipt);
      receiptRows.push(normalized(receipt.value));
    }
    const state = yield* snapshot;
    Assert.equal(state.orchestration_events.length, expected.history.length);
    Assert.equal(state.orchestration_command_receipts.length, expected.commands.length);
    Assert.equal(state.orchestration_v2_effect_outbox.length, expected.commands.length);
    return { pages, jump, receipts: receiptRows, state };
  });
}

export function compareCompletedWork(arms) {
  Assert.equal(arms.length, 2);
  Assert.deepEqual(arms.map((arm) => arm.engine), ["direct-redb", "fjall"]);
  Assert.equal(arms[0].executableSha256, arms[1].executableSha256);
  for (const key of ["workloadSha256", "fixtureSha256"]) {
    Assert.match(arms[0][key], /^[a-f0-9]{64}$/);
    Assert.equal(arms[0][key], arms[1][key]);
  }
  Assert.match(arms[0].executableSha256, /^[a-f0-9]{64}$/);
  for (const arm of arms) {
    Assert.equal(arm.kind, "t04-ordered-event-sink");
    Assert.equal(arm.profile, `t04-${arm.engine}-efaf649-v1`);
    Assert.equal(arm.orderedDependency, "efaf649fb270ce70257e53862295cc10e4bddab0");
    for (const check of ["lost-ack-exact-receipt-after-reopen", "lost-ack-no-duplicate-publication"]) Assert.ok(arm.checks.includes(check));
    Assert.deepEqual(arm.completedWork.map((row) => row.phase), ["warm-synthetic", "aged-synthetic"]);
    for (const [index, row] of arm.completedWork.entries()) {
      Assert.deepEqual(row.counts, index === 0
        ? { commandsWritten: 8, eventsWritten: 8, receiptsRead: 8, historyRowsRead: 13, pagesRead: 4 }
        : { commandsWritten: 32, eventsWritten: 32, receiptsRead: 40, historyRowsRead: 45, pagesRead: 10 });
      Assert.equal(row.canonical.receipts.length, row.counts.receiptsRead);
      Assert.equal(row.canonical.pages.flat().length, index === 0 ? 8 : 40);
      Assert.equal(row.canonical.jump.length, pageSize);
      Assert.equal(row.reopenedEqual, true);
      Assert.match(row.elapsedNs, /^[1-9][0-9]*$/);
      for (const count of Object.values(row.counts)) Assert.ok(Number.isSafeInteger(count) && count > 0);
    }
  }
  Assert.equal(arms[0].stateSha256, arms[1].stateSha256);
  Assert.equal(arms[0].recoveredStateSha256, arms[1].recoveredStateSha256);
  // Check every phase and both arms before exposing any engine timings.
  for (let index = 0; index < 2; index++) {
    Assert.deepEqual(arms[0].completedWork[index].counts, arms[1].completedWork[index].counts);
    Assert.deepEqual(arms[0].completedWork[index].canonical, arms[1].completedWork[index].canonical);
  }
  return { kind: "t04-j04-completed-work-comparison", stockDenominator: stockCommit,
    stockProfile: "SQLite WAL/NORMAL, not executed by this comparison",
    strictSqlite: "unqualified: needs identical EventSink/receipt/history composition, verified connection pragmas and acknowledged sync boundary",
    conclusion: "diagnostic only; one sample per phase, no limiter/noise study or speed/acceptance claim",
    scope: "serial synthetic history; warm follows an untimed empty-candidate read, aged follows eight committed commands; setup, reopen and faults excluded; new helper/transport and assertions included",
    faultEvidence: arms.map(({ engine, checks, recoveredStateSha256 }) => ({ engine, checks, recoveredStateSha256 })),
    phases: arms[0].completedWork.map((row, index) => ({ phase: row.phase, counts: row.counts,
      elapsedNs: Object.fromEntries(arms.map((arm) => [arm.engine, arm.completedWork[index].elapsedNs])) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [redb, fjall, output, ...extra] = process.argv.slice(2);
  Assert.ok(redb && fjall && output);
  Assert.equal(extra.length, 0);
  const arms = await Promise.all([redb, fjall].map(async (path) => JSON.parse(await FS.readFile(path, "utf8"))));
  const comparison = compareCompletedWork(arms);
  await FS.writeFile(output, JSON.stringify(comparison, null, 2) + "\n");
  console.log(JSON.stringify(comparison));
}
