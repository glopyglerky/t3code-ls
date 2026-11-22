#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as NativeProjectionRecords from "../apps/server/src/orchestration-v2/NativeProjectionRecordRows.ts";
import * as NativeProjectionCommit from "../apps/server/src/persistence/NativeProjectionCommitStore.ts";
import * as NativeThreadFind from "../apps/server/src/orchestration-v2/NativeThreadFind.ts";
import * as NativeEventRows from "../apps/server/src/persistence/NativeEventRows.ts";
import * as OrchestrationEventStore from "../apps/server/src/persistence/OrchestrationEventStore.ts";
import { createFixture } from "./database-fixture.mjs";
import { exportSqliteState } from "./export-sqlite-state.mjs";
import { upstreamSource } from "./upstream-source.mjs";
import { jsonPayloads, makeEvent, fixedTime } from "./redb-event-sink-fixtures.mjs";
import {
  createMigratedSqlite,
  finishProof,
  hash,
  loadUpstreamModule,
  nativeRequest,
  normalized,
  withNative,
  withSqlite,
} from "./redb-domain-fixture.mjs";

const [executable, proofPath] = process.argv.slice(2);
NodeAssert.ok(
  executable && NodePath.isAbsolute(executable),
  "Pass an absolute native database executable",
);
await NodeFSP.access(executable, NodeFSP.constants.X_OK);
// These retained parsers are shared by the production find adapter and oracle.
// Verify their immutable source identity instead of copying their algorithms.
const normalizationSources = await Promise.all(
  [
    "packages/shared/src/threadFindText.ts",
    "packages/shared/src/codexArtifactTemplates.ts",
    "packages/shared/src/assistantInsights.ts",
    "packages/shared/src/threadFindBlockTags.ts",
    "packages/shared/src/markdownHast.ts",
    "packages/shared/src/markdownLinks.ts",
    "packages/shared/src/markdownPipeline.ts",
    "packages/shared/src/codexFileCitations.ts",
    "packages/shared/src/codexMarkdownDirectives.ts",
  ].map(async (path) => {
    const sha256 = hash(upstreamSource(path));
    NodeAssert.equal(
      hash(await NodeFSP.readFile(new URL(`../${path}`, import.meta.url))),
      sha256,
      `${path} is the unchanged pinned shared parser`,
    );
    return { path, sha256 };
  }),
);
const findOracle = await loadUpstreamModule("apps/server/src/orchestration-v2/ThreadFind.ts");
const oracle = await loadUpstreamModule("apps/server/src/orchestration-v2/ProjectionStore.ts", {
  "./ThreadFind.ts": findOracle.url,
});
const fixture = await createFixture();
const checks = [];
const projectId = "project:find";
const main = "thread:find";
const child = "thread:find-child";
const grandchild = "thread:find-grandchild";
const runId = (thread) => `run:${thread}`;
const event = (type, payload, owner = main, id = `event:${type}:${payload.id}`) =>
  makeEvent(type, payload, { threadId: owner, id });
const thread = (id, parent = null) =>
  event(
    "thread.created",
    {
      ...jsonPayloads.thread,
      id,
      projectId,
      title: id,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: parent === null ? null : { type: "run", threadId: parent, runId: runId(parent) },
    },
    id,
  );
const run = (owner) =>
  event(
    "run.created",
    {
      ...jsonPayloads.run,
      id: runId(owner),
      threadId: owner,
      providerThreadId: null,
      activeAttemptId: null,
      rootNodeId: null,
      userMessageId: "item:find:000",
      status: "completed",
      completedAt: fixedTime,
    },
    owner,
  );
const item = (id, ordinal, text, type = "assistant_message", owner = main) => {
  const payload = {
    ...jsonPayloads.turnItem,
    id,
    type,
    threadId: owner,
    runId: runId(owner),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    startedAt: fixedTime,
    completedAt: fixedTime,
    ...(type === "proposed_plan"
      ? { planId: `plan:${id}`, markdown: text, streaming: false }
      : type === "user_message"
        ? {
            messageId: id,
            text,
            inputIntent: "turn_start",
            createdBy: "user",
            creationSource: "web",
            attachments: [],
          }
        : { messageId: id, text, streaming: false }),
  };
  return event("turn-item.updated", payload, owner);
};
const itemCorpus = Array.from({ length: 140 }, (_, index) =>
  item(
    `item:find:${String(index).padStart(3, "0")}`,
    index + 1,
    index % 7 === 0
      ? "needle needle. Café 東京 🦊"
      : index % 7 === 1
        ? "[Needle docs](https://needle-hidden.example/secret) and **needle**"
        : index % 7 === 2
          ? "Code \u0060needle\u0060, path /fixture/workspace/folder/file.ts"
          : index % 7 === 3
            ? "No matching word in this ordinary entry"
            : index % 7 === 4
              ? "# Needle plan\n\n- needle step\n- 東京 work"
              : index % 7 === 5
                ? "Question about needle plans?"
                : "A response with a needlessly similar prefix",
    index % 7 === 4 ? "proposed_plan" : index % 5 === 0 ? "user_message" : "assistant_message",
  ),
);
const seedEvents = [
  thread(main),
  run(main),
  ...itemCorpus,
  thread(child, main),
  run(child),
  item("item:child", 1, "Child needle", "assistant_message", child),
  thread(grandchild, child),
  run(grandchild),
  item("item:grandchild", 1, "Grandchild needle", "assistant_message", grandchild),
];
const projectEvent = {
  sequence: 0,
  eventId: "event:project:find",
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: fixedTime,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId,
    title: "Find fixture",
    workspaceRoot: "/fixture/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: fixedTime,
    updatedAt: fixedTime,
  },
};
const queries = [
  { query: "needle" },
  { query: "needle", index: 7 },
  { query: "needle", index: 9999 },
  { query: "needle", offset: -1 },
  { query: "needle", offset: 8 },
  { query: "needle", start: { entryId: "item:find:014", occurrence: 1 } },
  { query: "needle", start: { entryId: "item:find:014", occurrence: 9999 }, offset: -2 },
  { query: "needle", start: { entryId: "does-not-exist", occurrence: 0 } },
  { query: "東京" },
  { query: "🦊" },
  { query: "café" },
  { query: "folder" },
  { query: "needle-hidden" },
  { query: "not-in-the-thread" },
];
const normalizationCases = [
  {
    id: "bare-parentheses",
    text: "[a](/fixture/workspace/app/(route-a)/page.tsx) and [b](/fixture/workspace/app/(route-b)/page.tsx)",
    matches: [["app/(route-a)", 1]],
  },
  {
    id: "escaped-parentheses",
    text: String.raw`[a](/fixture/workspace/app/\(escaped-a\)/page.tsx) and [b](/fixture/workspace/app/\(escaped-b\)/page.tsx)`,
    matches: [["app/(escaped-a)", 1]],
  },
  {
    id: "entity-path",
    type: "user_message",
    text: "[a](/fixture/workspace/first&amp;branch/page.tsx) and [b](/fixture/workspace/second&amp;branch/page.tsx)",
    matches: [
      ["first&branch", 1],
      ["first&amp;branch", 0],
    ],
  },
  {
    id: "angle-parenthesis",
    text: "[a](</fixture/workspace/angle&branch)/page.tsx>) and [b](</fixture/workspace/other&branch)/page.tsx>)",
    matches: [["angle&branch)", 1]],
  },
  {
    id: "windows-plan",
    type: "proposed_plan",
    text: String.raw`[a](C:\repo\.first\x&amp;y\page.tsx) and [b](C:\repo\.second\x&amp;y\page.tsx)`,
    matches: [
      ["x&y", 2],
      ["x&amp;y", 0],
    ],
  },
  {
    id: "citation-entity",
    text: ':codex-file-citation{path="/fixture/workspace/literal&amp;copy;.txt" line_range_start="7"}',
    matches: [
      ["literal&copy;.txt", 1],
      ["literal©.txt", 0],
    ],
  },
  {
    id: "arabic-bare-url",
    text: "منشور على https://example.com/report، ونسخته",
    matches: [["report، ونسخته", 1]],
  },
  {
    id: "arabic-emphasized-url",
    text: "هل يعمل **http://localhost:3000**؟ نعم؛ www.example.com۔",
    matches: [
      ["3000؟", 1],
      ["3000**", 0],
      ["example.com۔", 1],
    ],
  },
];

async function withServices(kind, filename, use) {
  if (kind === "native")
    return withNative(executable, fixture, (client) =>
      Effect.gen(function* () {
        const timeline = yield* NativeProjectionRecords.makeTimelineIndex;
        const find = yield* NativeThreadFind.make((threadId) =>
          timeline(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
        );
        const writer = yield* NativeProjectionCommit.make;
        const events = yield* OrchestrationEventStore.OrchestrationEventStore.pipe(
          Effect.provide(
            OrchestrationEventStore.layerFromEventRows.pipe(Layer.provide(NativeEventRows.layer)),
          ),
        );
        return yield* use({
          find,
          transaction: client.withTransaction,
          apply: writer.apply,
          events,
        });
      }),
    );
  const module = kind === "upstream" ? oracle.module : ProjectionStore;
  return withSqlite(filename, (sql) =>
    Effect.gen(function* () {
      const store = yield* module.ProjectionStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      return yield* use({
        find: store,
        transaction: (effect) => sql.withTransaction(effect),
        apply: store.apply,
        events,
      });
    }).pipe(
      // Find borrows scoped caches for the whole stream. Keep their owning layer
      // alive until the service consumer, including every frame, has completed.
      Effect.provide(module.layer),
      Effect.provide(OrchestrationEventStore.layer),
    ),
  );
}

const checkTransactionCache = Effect.fn("checkRedbThreadFind.transactionCache")(function* ({
  find,
  transaction,
  apply,
  events,
}) {
  for (const [index, nested] of [false, true].entries()) {
    const name = nested ? "savepoint" : "root";
    const discardedText = `discardedcache${name}`;
    const committedText = `committedcache${name}`;
    const committedId = `item:find:cache-committed:${name}`;
    let staged;
    const stage = Effect.fn("checkRedbThreadFind.stageFind")(function* () {
      const next = item(`item:find:cache-discarded:${name}`, 1000 + index, discardedText);
      yield* events.appendAgentEvents({ events: [next] });
      yield* apply(next);
      staged = yield* find.searchThread({ threadId: main, query: discardedText });
      NodeAssert.equal(staged.totalMatches, 1);
      return yield* Effect.fail("discard staged find cache");
    });
    const check = Effect.fn("checkRedbThreadFind.reuseSequence")(function* () {
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(transaction(stage()))));
      yield* transaction(
        Effect.gen(function* () {
          const next = item(committedId, 1000 + index, committedText);
          yield* events.appendAgentEvents({ events: [next] });
          yield* apply(next);
        }),
      );
      const same = yield* find.searchThread({ threadId: main, query: discardedText });
      const different = yield* find.searchThread({ threadId: main, query: committedText });
      NodeAssert.equal(same.snapshotSequence, staged.snapshotSequence, `${name}: reused sequence`);
      NodeAssert.equal(same.totalMatches, 0, `${name}: discarded completed scan is invisible`);
      NodeAssert.equal(different.totalMatches, 1, `${name}: rendered snapshot shows replacement`);
      NodeAssert.equal(different.match?.entryId, committedId);
    });
    yield* nested ? transaction(check()) : check();
    NodeAssert.equal(
      (yield* find.searchThread({ threadId: main, query: discardedText })).totalMatches,
      0,
      `${name}: discarded text remains absent after commit`,
    );
    NodeAssert.equal(
      (yield* find.searchThread({ threadId: main, query: committedText })).match?.entryId,
      committedId,
    );
  }
});

const exercise = Effect.fn("checkRedbThreadFind.exercise")(function* ({
  find,
  transaction,
  apply,
  events,
}) {
  const output = [];
  for (const threadId of [main, child, grandchild]) {
    for (const query of queries) {
      const frames = yield* Stream.runCollect(find.searchThreadStream({ threadId, ...query }));
      NodeAssert.ok(frames.length >= 1);
      output.push(normalized(frames));
    }
  }
  const commit = (next) =>
    transaction(
      Effect.gen(function* () {
        yield* events.appendAgentEvents({ events: [next] });
        yield* apply(next);
      }),
    );
  for (const [index, test] of normalizationCases.entries()) {
    const entryId = `item:normalization:${test.id}`;
    yield* commit(item(entryId, 200 + index, test.text, test.type ?? "assistant_message"));
    for (const [query, count] of test.matches) {
      const result = yield* find.searchThread({ threadId: main, query });
      NodeAssert.equal(result.totalMatches, count, `${test.id}: displayed ${query}`);
      if (count > 0) NodeAssert.equal(result.match?.entryId, entryId, test.id);
      output.push(normalized(result));
    }
  }
  const before = yield* find.searchThread({ threadId: grandchild, query: "needle" });
  // A different query uses the rendered snapshot instead of the completed scan.
  yield* find.searchThread({ threadId: grandchild, query: "changed" });
  const mutation = {
    ...item("item:find:000", 1, "needle changed needle needle"),
    id: "event:find:changed",
  };
  yield* commit(mutation);
  const after = yield* find.searchThread({ threadId: grandchild, query: "needle" });
  NodeAssert.ok(
    after.snapshotSequence > before.snapshotSequence,
    "Ancestor event invalidates descendant cache revision",
  );
  NodeAssert.notEqual(after.totalMatches, before.totalMatches);
  output.push(normalized(after));
  for (const [owner, entry] of [
    [child, "item:child"],
    [grandchild, "item:grandchild"],
  ]) {
    const before = yield* find.searchThread({ threadId: grandchild, query: "needle" });
    yield* find.searchThread({ threadId: grandchild, query: "another query" });
    yield* commit({
      ...item(entry, 1, "needle changed needle needle", "assistant_message", owner),
      id: `event:find:changed:${owner}`,
    });
    const after = yield* find.searchThread({ threadId: grandchild, query: "needle" });
    NodeAssert.ok(
      after.snapshotSequence > before.snapshotSequence,
      `${owner} invalidates rendered snapshot`,
    );
    NodeAssert.notEqual(after.totalMatches, before.totalMatches);
    output.push(normalized(after));
  }
  const failed = yield* Effect.exit(
    transaction(
      Effect.gen(function* () {
        const discarded = item("item:discarded", 999, "needle needle needle");
        yield* events.appendAgentEvents({ events: [discarded] });
        yield* apply(discarded);
        NodeAssert.ok(
          (yield* find.searchThread({ threadId: main, query: "needle" })).totalMatches >
            after.totalMatches - 3,
        );
        return yield* Effect.fail("rollback find state");
      }),
    ),
  );
  NodeAssert.ok(Exit.isFailure(failed));
  output.push(normalized(yield* find.searchThread({ threadId: grandchild, query: "needle" })));
  const missing = yield* Effect.exit(find.searchThread({ threadId: "missing", query: "needle" }));
  NodeAssert.ok(Exit.isFailure(missing));
  return output;
});

try {
  const source = NodePath.join(fixture.root, "source.sqlite");
  await createMigratedSqlite(source, () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const store = yield* oracle.module.ProjectionStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* projects.apply(projectEvent);
      yield* events.appendAgentEvents({ events: seedEvents });
      for (const next of seedEvents) yield* store.apply(next);
    }).pipe(
      Effect.provide(ProjectStore.layer),
      Effect.provide(oracle.module.layer),
      Effect.provide(OrchestrationEventStore.layer),
    ),
  );
  const upstream = NodePath.join(fixture.root, "upstream.sqlite");
  const retained = NodePath.join(fixture.root, "retained.sqlite");
  await NodeFSP.copyFile(source, upstream);
  await NodeFSP.copyFile(source, retained);
  const sourceHash = hash(await NodeFSP.readFile(source));
  const exported = NodePath.join(fixture.root, "source.ndjson");
  exportSqliteState({ source, destination: exported });
  nativeRequest(executable, fixture, "initialize", {
    operation: "import_sqlite_application",
    path: exported,
  });
  const expected = await withServices("upstream", upstream, exercise);
  NodeAssert.deepEqual(
    await withServices("sqlite", retained, exercise),
    expected,
    "Retained find matches immutable upstream module",
  );
  NodeAssert.deepEqual(
    await withServices("native", source, exercise),
    expected,
    "Native find matches immutable upstream module",
  );
  checks.push(
    "Three real thread timelines, including nested inherited forks, use unchanged upstream visibility and find navigation",
    "140 imported message/plan items cross the 128-row payload batch and preserve bounded first-hit/completion frames",
    "Fourteen query/navigation forms preserve Markdown rendering, Unicode, counts, anchors, offsets and wraparound",
    "Eight real write/read cases preserve displayed parenthesis paths, escaped paths, entity decoding, Windows plan paths, literal ampersands in Codex citations and Arabic URL punctuation, with explicit nonempty and excluded-text counts",
    "The shared find/Markdown/citation parser bytes match the immutable upstream sources exactly",
    "Root, intermediate and descendant source events invalidate rendered snapshots across query changes; failed root writes leave no visible find state",
  );
  await withServices("native", source, ({ find }) =>
    Effect.gen(function* () {
      NodeAssert.deepEqual(
        normalized(yield* find.searchThread({ threadId: grandchild, query: "needle" })),
        expected.at(-1),
      );
    }),
  );
  checks.push(
    "A reopened helper reproduces committed find results from native rows without SQLite",
  );
  await withServices("native", source, checkTransactionCache);
  await withServices("sqlite", retained, checkTransactionCache);
  checks.push(
    "One persistent Find service never reuses rolled-back completed scans or rendered snapshots when root transactions or nested savepoints reuse an event sequence",
  );
  NodeAssert.equal(hash(await NodeFSP.readFile(source)), sourceHash);
  await finishProof({
    executable,
    fixture,
    proofPath,
    checks,
    sourceHash,
    oracles: [oracle.source, findOracle.source, ...normalizationSources],
    sourcePaths: [
      "apps/server/src/orchestration-v2/ThreadFind.ts",
      "apps/server/src/orchestration-v2/ThreadFindRows.ts",
      "apps/server/src/orchestration-v2/NativeThreadFind.ts",
      "apps/server/src/persistence/redb_thread_find.rs",
      "apps/server/src/orchestration-v2/NativeProjectionRecordRows.ts",
      "apps/server/src/persistence/NativeProjectionCommitStore.ts",
      ...normalizationSources.map(({ path }) => path),
      "tools/check-redb-thread-find.mjs",
    ],
  });
} finally {
  await fixture.close();
}
