import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import { registerHooks } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { chromium } from "playwright";
import {
  authenticatePackagedServer,
  reservePort,
  startPackagedServer,
} from "../../server/scripts/packaged-server-fixture.ts";
import { EventSinkV2 } from "../../server/src/orchestration-v2/EventSink.ts";
import * as NativeEventSink from "../../server/src/orchestration-v2/NativeEventSink.ts";

// The standalone storage fixtures normally load from a dedicated test runtime.
// Use this checkout's locked server dependencies for both seeding and the client.
const domainFixture = new URL("../../../tools/redb-domain-fixture.mjs", import.meta.url).href;
const eventFixture = new URL("../../../tools/redb-event-sink-fixtures.mjs", import.meta.url).href;
const serverWorkspace = new URL("../../server/package.json", import.meta.url).href;
const dependencies = registerHooks({
  resolve(specifier, context, next) {
    const fixtureImport = context.parentURL === domainFixture || context.parentURL === eventFixture;
    return next(specifier, fixtureImport && (specifier.startsWith("@") || specifier.startsWith("effect/"))
      ? { ...context, parentURL: serverWorkspace }
      : context);
  },
});
const [{ nativeRequest, withNative }, { fixedTime, jsonPayloads, makeEvent }] = await Promise.all([
  import(domainFixture),
  import(eventFixture),
]).finally(() => dependencies.deregister());

const root = FS.realpathSync(Path.resolve(import.meta.dirname, "../../.."));
const [argument] = process.argv.slice(2);
Assert.ok(argument && Path.isAbsolute(argument) && process.argv.length === 3);
Assert.equal(process.platform, "linux");
Assert.equal(process.arch, "x64");
Assert.deepEqual(Object.keys(OS.networkInterfaces()), ["lo"], "Use the loopback-only hosted namespace");
const proof = Path.join(FS.realpathSync(Path.dirname(argument)), Path.basename(argument));
Assert.ok(Path.relative(root, proof).startsWith(`..${Path.sep}`));
FS.mkdirSync(proof, { mode: 0o700 });

const projectId = "history-fixture";
const parent = "thread:history-source";
const middle = "thread:history-middle";
const child = "thread:history-child";
const run = (threadId, ordinal) => `run:${threadId}:${ordinal}`;
const question = (ordinal) => `question:${ordinal}`;
const questionItem = (ordinal) => `item:${question(ordinal)}`;
const childPath = `/api/orchestration/threads/${encodeURIComponent(child)}`;
const headers = { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT };
const decodeBounded = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));
const decodePage = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));
const methods = ORCHESTRATION_V2_WS_METHODS;
const subscription = {
  threadId: child,
  acceptBoundedSnapshot: true,
  acceptHistoryInvalidation: true,
  requestCompletionMarker: true,
};

function seedEvents() {
  const event = (type, threadId, payload, runId) =>
    makeEvent(type, payload, { threadId, ...(runId === undefined ? {} : { runId }) });
  const thread = (id, source = null) => event("thread.created", id, {
    ...jsonPayloads.thread, id, title: id, projectId,
    lineage: {
      parentThreadId: source?.threadId ?? null,
      relationshipToParent: source === null ? null : "fork",
      rootThreadId: parent,
    },
    forkedFrom: source,
  });
  const completedRun = (threadId, ordinal) => {
    const id = run(threadId, ordinal);
    return event("run.created", threadId, {
      ...jsonPayloads.run, id, threadId, ordinal, providerThreadId: null, rootNodeId: null,
      activeAttemptId: null, userMessageId: `message:${id}`, status: "completed", completedAt: fixedTime,
    }, id);
  };
  const item = (fields) => ({
    ...jsonPayloads.turnItem, threadId: parent, providerThreadId: null, providerTurnId: null,
    nodeId: null, status: "completed", completedAt: fixedTime, ...fields,
  });
  const userTurn = (ordinal) => {
    const runId = run(parent, ordinal);
    const messageId = `message:${runId}`;
    const text = `History fixture turn ${ordinal}`;
    return [
      completedRun(parent, ordinal),
      event("message.updated", parent, {
        ...jsonPayloads.message, id: messageId, threadId: parent, runId, nodeId: null,
        role: "user", text, streaming: false, createdBy: "user", creationSource: "web",
      }, runId),
      event("turn-item.updated", parent, item({
        id: `item:history:${ordinal}`, runId, ordinal: ordinal * 2, type: "user_message",
        messageId, inputIntent: "turn_start", text, createdBy: "user", creationSource: "web",
        attachments: [],
      }), runId),
    ];
  };
  const pendingQuestion = (ordinal) => {
    const runId = run(parent, ordinal);
    const requestId = question(ordinal);
    const nodeId = `node:${requestId}`;
    return [
      event("node.updated", parent, {
        ...jsonPayloads.node, id: nodeId, threadId: parent, runId, rootNodeId: nodeId,
        kind: "user_input_request", status: "waiting", countsForRun: false,
        providerThreadId: null, providerTurnId: null, runtimeRequestId: requestId, checkpointScopeId: null,
      }, runId),
      event("runtime-request.updated", parent, {
        ...jsonPayloads.request, id: requestId, nodeId, providerTurnId: null,
        responseCapability: { type: "message" },
      }, runId),
      event("turn-item.updated", parent, item({
        id: questionItem(ordinal), ordinal: ordinal * 2 + 1, runId, nodeId, type: "user_input_request",
        status: "waiting", completedAt: null, requestId, responseMode: "message",
        questions: [{ id: "choice", header: "Fixture question", question: requestId, options: [] }],
      }), runId),
    ];
  };
  return [thread(parent), ...userTurn(1), ...pendingQuestion(1),
    ...Array.from({ length: 11 }, (_, index) => userTurn(index + 2)).flat(),
    thread(middle, { type: "run", threadId: parent, runId: run(parent, 12) }),
    completedRun(middle, 1), thread(child, { type: "run", threadId: middle, runId: run(middle, 1) }),
    ...userTurn(13), ...pendingQuestion(13)];
}

function assertNativeOwner(pid, executable, database) {
  Assert.ok(pid);
  const tasks = `/proc/${pid}/task`;
  const matches = FS.readdirSync(tasks).some((task) => {
    try {
      const children = FS.readFileSync(Path.join(tasks, task, "children"), "utf8").trim();
      return children.split(/\s+/u).filter(Boolean).some((id) => {
        try {
          const argv = FS.readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0");
          return argv[1] === "local" && argv[2] === database &&
            FS.readlinkSync(`/proc/${id}/exe`) === executable;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return false;
        }
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  });
  Assert.ok(matches, "The bundled application must own its omdb through the packaged helper");
  Assert.ok(FS.existsSync(database));
  Assert.ok(FS.readdirSync(Path.dirname(database)).every((file) => !/^state.*\.sqlite/u.test(file)));
}

function assertQuestion(rows, ordinal, status, visibility) {
  const matches = rows.filter(({ sourceItemId }) => sourceItemId === questionItem(ordinal));
  Assert.equal(matches.length, 1, `Expected one question from run ${ordinal}`);
  Assert.equal(matches[0].sourceThreadId, parent);
  Assert.equal(matches[0].visibility, visibility);
  Assert.equal(matches[0].item.status, status);
}

function assertChildRows(rows) {
  Assert.equal(new Set(rows.map(({ sourceThreadId, sourceItemId }) =>
    JSON.stringify([sourceThreadId, sourceItemId]))).size, rows.length, "History rows are unique");
  Assert.ok(!rows.some(({ sourceItemId }) =>
    sourceItemId === questionItem(13) || sourceItemId === "item:history:13"), "Fork cutoff leaked");
}

async function readJson(response) {
  Assert.ok(response.ok(), `Packaged HTTP returned ${response.status()}`);
  return response.json();
}

const scratch = FS.mkdtempSync(Path.join(proof, ".fixture-"));
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Packaged fork history proof interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const report = { status: "running", phase: "preflight", stock: "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f" };
const save = () => FS.writeFileSync(Path.join(proof, "proof.json"), JSON.stringify(report, null, 2) + "\n");
const phase = (name) => { report.phase = name; save(); };
let application;
let browser;

try {
  phase("preflight");
  const git = (...args) => ChildProcess.execFileSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 5_000,
  }).trim();
  const sha256 = (file) => Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
  Assert.equal(git("status", "--porcelain"), "", "Use a clean candidate checkout");
  report.source = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  const bundle = Path.join(root, "apps/server/dist/bin.mjs");
  const browserEntry = Path.join(Path.dirname(bundle), "client/index.html");
  const manifestFile = Path.join(root, "apps/server/dist/native-bin/manifest.json");
  const executable = Path.join(Path.dirname(manifestFile), "t3-code-ls-db");
  const manifest = JSON.parse(FS.readFileSync(manifestFile, "utf8"));
  Assert.equal(manifest.target, "linux-x64");
  Assert.equal(manifest.rustTarget, "x86_64-unknown-linux-gnu");
  Assert.equal(manifest.files["t3-code-ls-db"], sha256(executable));
  report.artifacts = {
    bundle: sha256(bundle), browserEntry: sha256(browserEntry),
    nativeManifest: sha256(manifestFile), nativeHelper: sha256(executable),
    toolchainLock: sha256(Path.join(root, "toolchain.lock.json")),
    databaseLock: sha256(Path.join(root, "database.lock.json")), node: process.version,
  };

  const baseDir = Path.join(scratch, "state");
  const userdata = Path.join(baseDir, "userdata");
  const workspace = Path.join(scratch, "workspace");
  const homeBin = Path.join(scratch, "bin");
  const temporary = Path.join(scratch, "tmp");
  for (const directory of [userdata, workspace, homeBin, temporary]) FS.mkdirSync(directory, { recursive: true });
  FS.symlinkSync("/usr/bin/git", Path.join(homeBin, "git"));
  FS.writeFileSync(Path.join(userdata, "settings.json"), JSON.stringify({ providerInstances:
    Object.fromEntries(["codex", "claudeAgent", "pi", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "muse"]
      .map((driver) => [driver, { driver, enabled: false }])) }));
  const env = {
    HOME: baseDir, PATH: homeBin, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: Path.join(baseDir, ".config"), XDG_DATA_HOME: Path.join(baseDir, ".local/share"),
    XDG_CACHE_HOME: Path.join(baseDir, ".cache"), T3_CODE_LS_IMPLEMENTATION: "native",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false", T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true", NO_COLOR: "1",
  };
  const databasePath = Path.join(userdata, "statev2.omdb");
  const fixture = { databasePath, cliArgs: (mode) => [`${mode}-local`, databasePath] };
  const start = async (name) => startPackagedServer({
    bundle, baseDir, env, signal: abort.signal, port: await reservePort(), logPath: Path.join(proof, `${name}.log`),
  });

  phase("initializing-packaged-profile");
  application = await start("initialize");
  await application.ready;
  assertNativeOwner(application.pid, executable, databasePath);
  const setup = await authenticatePackagedServer(application, abort.signal);
  await setup.createProject({ projectId, title: "Fork history fixture", workspaceRoot: workspace });
  await application.stop();
  application = undefined;

  // Add history to the project and database already initialized by the normal app.
  // Every observation and later write uses the packaged server.
  phase("seed");
  const events = seedEvents();
  await withNative(executable, fixture, () => Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const stored = yield* sink.write({ events });
    Assert.equal(stored.length, events.length);
  }).pipe(Effect.provide(NativeEventSink.layer), Effect.timeout("30 seconds")));

  phase("opening-browser-history");
  application = await start("application");
  await application.ready;
  assertNativeOwner(application.pid, executable, databasePath);
  const client = await authenticatePackagedServer(application, abort.signal);
  browser = await chromium.launch();
  report.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1200, height: 550 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const origin = application.origin;
  const wire = [];
  const browserSync = Promise.withResolvers();
  page.on("websocket", (socket) => {
    const requests = new Set();
    socket.on("framesent", ({ payload }) => {
      const text = payload.toString();
      if (!text.includes(methods.subscribeThread)) return;
      const request = JSON.parse(text);
      if (request.tag === methods.subscribeThread && request.payload?.threadId === child &&
        request.payload.acceptHistoryInvalidation === true) requests.add(request.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const text = payload.toString();
      if (!text.startsWith("{")) return;
      const frame = JSON.parse(text);
      if (frame._tag !== "Chunk" || !requests.has(frame.requestId)) return;
      for (const item of frame.values) {
        if (item.kind === "synchronized") browserSync.resolve();
        else wire.push(item);
      }
    });
  });
  const { environmentId } = await readJson(await page.request.get(`${origin}/.well-known/t3/environment`));
  const session = await readJson(await page.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: application.bootstrap },
  }));
  Assert.equal(session.authenticated, true);
  const loaded = await page.goto(`${origin}/${encodeURIComponent(environmentId)}/${encodeURIComponent(child)}`, {
    waitUntil: "domcontentloaded",
  });
  Assert.ok(loaded?.ok(), "Load the packaged browser entry");
  const scroll = page.locator(".messages-timeline-scroll");
  await scroll.waitFor({ state: "visible" });
  // Mounting the chat commits a visit. Let that child event land before fixing the replay watermark.
  await page.waitForFunction(async ({ path, headers }) => {
    const response = await fetch(path, { headers });
    if (!response.ok) return false;
    const snapshot = await response.json();
    return snapshot.projection.thread.lastVisitedAt != null;
  }, { path: childPath, headers }, { polling: 250 });
  const olderTurn = scroll.getByText("History fixture turn 2", { exact: true });
  Assert.equal(await olderTurn.count(), 0, "The older turn must start outside the loaded window");
  const observedHistory = (anchored) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === origin && decodeURIComponent(url.pathname) === `${decodeURIComponent(childPath)}/history` &&
      url.searchParams.has("throughEntryId") === anchored;
  });
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  const [firstHistory] = await Promise.all([
    observedHistory(false), page.getByRole("button", { name: "Load earlier turns" }).click(),
  ]);
  const firstPage = decodePage(await readJson(firstHistory));
  assertQuestion(firstPage.items, 1, "waiting", "inherited");
  assertChildRows(firstPage.items);
  await scroll.evaluate((element) => { element.scrollTop = 48; });
  await olderTurn.waitFor({ state: "visible" });
  await scroll.focus();
  const anchor = async () => {
    const [top, viewport] = await Promise.all([
      olderTurn.boundingBox(),
      scroll.evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        focused: document.activeElement === element,
        scrollTop: element.scrollTop,
        distanceFromEnd: element.scrollHeight - element.clientHeight - element.scrollTop,
      })),
    ]);
    Assert.ok(top && viewport.focused && viewport.scrollTop > 0 && viewport.distanceFromEnd > 0,
      "Keep focus and position inside the scrolled history");
    return top.y - viewport.top;
  };
  const before = await anchor();
  await Promise.race([
    browserSync.promise,
    new Promise((_, reject) => AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
      .addEventListener("abort", () => reject(new Error("The opted-in browser stream did not synchronize")), { once: true })),
  ]);

  const history = (id) => page.request.get(`${origin}/api/orchestration/threads/${encodeURIComponent(id)}`, { headers }).then(readJson);
  const result = await client.rpc((rpc) => Effect.gen(function* () {
    const received = yield* Queue.unbounded();
    yield* rpc[methods.subscribeThread](subscription).pipe(
      Stream.runForEach((item) => Queue.offer(received, item)), Effect.forkScoped,
    );
    const take = Queue.take(received).pipe(Effect.timeout("10 seconds"));
    const initial = yield* take;
    Assert.equal(initial.kind, "snapshot");
    Assert.deepEqual(yield* take, { kind: "synchronized" });
    const childSequence = initial.snapshotSequence;
    Assert.equal(firstPage.snapshotSequence, childSequence);
    wire.length = 0;
    const dismiss = (ordinal) => rpc[methods.dispatchCommand]({
      type: "thread.user-input.dismiss", commandId: Crypto.randomUUID(), threadId: parent, requestId: question(ordinal),
    });

    phase("ancestor-after-cutoff");
    const outside = yield* dismiss(13);
    Assert.ok(outside.sequence > childSequence);
    const parentSnapshot = yield* Effect.promise(() => history(parent));
    assertQuestion(parentSnapshot.projection.visibleTurnItems, 13, "cancelled", "local");
    Assert.ok(Option.isNone(yield* Queue.take(received).pipe(Effect.timeoutOption("750 millis"))),
      "An after-cutoff ancestor event must leave the child stream quiet");
    Assert.deepEqual(wire, []);

    phase("inherited-invalidation-and-browser-refresh");
    const mutation = yield* Effect.promise(async () => {
      const pending = observedHistory(true);
      const refreshed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === origin && decodeURIComponent(url.pathname) === `${decodeURIComponent(childPath)}/bounded`;
      });
      const committed = Effect.runPromise(dismiss(1), { signal: abort.signal });
      const [receipt, response, snapshot] = await Promise.all([committed, pending, refreshed]);
      return { receipt, page: decodePage(await readJson(response)), bounded: decodeBounded(await readJson(snapshot)) };
    });
    Assert.ok(mutation.receipt.sequence > outside.sequence);
    Assert.deepEqual(yield* take, { kind: "history-invalidated" });
    Assert.deepEqual(wire, [{ kind: "history-invalidated" }], "The browser wire frame must be payload-free");
    Assert.equal(mutation.bounded.snapshotSequence, childSequence);
    Assert.equal(mutation.page.snapshotSequence, childSequence);
    assertQuestion(mutation.page.items, 1, "cancelled", "inherited");
    assertChildRows([...boundedSnapshotProjection(mutation.bounded).visibleTurnItems, ...mutation.page.items]);
    Assert.deepEqual(mutation.page.items.map((row) => row.sourceItemId), firstPage.items.map((row) => row.sourceItemId));
    const scrollDelta = yield* Effect.promise(async () => {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const delta = Math.abs((await anchor()) - before);
      Assert.ok(delta <= 4, "Keep the same older turn at its scroll anchor");
      await page.close();
      return delta;
    });

    phase("child-live-and-replay");
    const childSequences = [];
    for (const title of ["First child update", "Second child update"]) {
      const receipt = yield* rpc[methods.dispatchCommand]({
        type: "thread.metadata.update", commandId: Crypto.randomUUID(), threadId: child, title,
      });
      const frame = yield* take;
      Assert.equal(frame.kind, "event");
      Assert.equal(frame.event.threadId, child);
      Assert.equal(frame.event.type, "thread.metadata-updated");
      Assert.equal(frame.event.payload.title, title);
      Assert.equal(frame.sequence, receipt.sequence);
      childSequences.push(receipt.sequence);
    }
    Assert.ok(childSequences[0] > mutation.receipt.sequence && childSequences[1] > childSequences[0]);
    const replay = yield* rpc[methods.subscribeThread]({ ...subscription, afterSequence: childSequence }).pipe(
      Stream.take(3), Stream.runCollect, Effect.timeout("10 seconds"),
    );
    Assert.deepEqual(replay.map((item) => item.kind === "event"
      ? [item.sequence, item.event.threadId, item.event.type]
      : item.kind), [...childSequences.map((sequence) => [sequence, child, "thread.metadata-updated"]), "synchronized"]);
    return { childSequence, outside: outside.sequence, inherited: mutation.receipt.sequence, childSequences,
      olderRows: mutation.page.items.length, scrollDelta };
  }).pipe(Effect.scoped));
  report.live = result;

  phase("restart-retention");
  await application.stop();
  application = await start("reopened");
  await application.ready;
  assertNativeOwner(application.pid, executable, databasePath);
  const reopened = await authenticatePackagedServer(application, abort.signal);
  const latest = await reopened.rpc((rpc) => rpc[methods.subscribeThread](subscription).pipe(Stream.runHead));
  Assert.ok(Option.isSome(latest) && latest.value.kind === "snapshot");
  Assert.equal(latest.value.snapshotSequence, result.childSequences.at(-1));
  Assert.equal(boundedSnapshotProjection(latest.value).thread.title, "Second child update");
  const reopenedSession = await readJson(await context.request.post(`${application.origin}/api/auth/browser-session`, {
    data: { credential: application.bootstrap },
  }));
  Assert.equal(reopenedSession.authenticated, true);
  const bounded = decodeBounded(await readJson(await context.request.get(`${application.origin}${childPath}/bounded`, { headers })));
  Assert.equal(bounded.snapshotSequence, latest.value.snapshotSequence);
  Assert.ok(bounded.historyCursor);
  const query = new URLSearchParams({ cursor: bounded.historyCursor });
  const retained = decodePage(await readJson(await context.request.get(`${application.origin}${childPath}/history?${query}`, { headers })));
  Assert.equal(retained.snapshotSequence, bounded.snapshotSequence);
  assertQuestion(retained.items, 1, "cancelled", "inherited");
  assertChildRows([...boundedSnapshotProjection(bounded).visibleTurnItems, ...retained.items]);
  await application.stop();
  application = undefined;
  const identity = nativeRequest(executable, fixture, "read-only", { operation: "application_generation_identity" });
  Assert.equal(identity.engine, "omdb");
  Assert.equal(identity.generation, "native");
  report.retained = { sequence: retained.snapshotSequence, olderRows: retained.items.length, identity };
  report.status = "passed";
  phase("complete");
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    // Keep the state for diagnosis if an owned process failed to stop.
    try {
      await application?.stop();
      FS.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      report.status = "failed";
      report.cleanupFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      save();
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
