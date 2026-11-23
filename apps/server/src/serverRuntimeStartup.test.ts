import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  CommandId,
  EnvironmentId,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import {
  ServerActivation,
  StagedCandidateReadinessError,
  StagedCandidateStartup,
  afterStagedCandidateReadiness,
} from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

it.effect.each([
  "disabled-codex",
  "disabled-default",
  "launch-failure",
  "project-failure",
  "staged-admit",
  "staged-cancel",
  "staged-inspection-failure",
  "staged-report-failure",
  "staged-admission-failure",
] as const)("preserves startup failures and staged admission: %s", (scenario) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("bootstrap-project");
    const instanceId = ProviderInstanceId.make(
      scenario === "disabled-default" ? "custom" : "codex",
    );
    const events: ServerLifecycleStreamEvent[] = [];
    const startupEffects: string[] = [];
    const recovery = {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    };
    const imports = { importedThreadCount: 0, importedMessageCount: 0 };
    const dependencies = Layer.mergeAll(
      Layer.effectDiscard(Effect.sync(() => {
        startupEffects.push("construct-layers");
      })),
      NodeCrypto.layer,
      Path.layer,
      Layer.mock(ServerConfig.ServerConfig)({
        ...(yield* ServerConfig.deriveServerPaths("/bootstrap-project", undefined).pipe(
          Effect.provide(Path.layer),
        )),
        baseDir: "/bootstrap-project",
        logLevel: "Error",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        staticDir: undefined,
        devAllowedOrigins: [],
        desktopBootstrapToken: undefined,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        mode: "web",
        cwd: "/bootstrap-project",
        host: "localhost",
        port: 3773,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        autoBootstrapProjectFromCwd: true,
      }),
      Layer.mock(Keybindings.Keybindings)({
        start: Effect.sync(() => {
          startupEffects.push("keybindings");
        }),
      }),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        pendingThreadCount: Effect.succeed(0),
        reconcileShells: Effect.sync(() => {
          startupEffects.push("legacy-import");
          return imports;
        }),
        importPendingTranscripts: Effect.succeed(imports),
      }),
      Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
        recover: Effect.sync(() => {
          startupEffects.push("recovery");
          return recovery;
        }),
        prepareForShutdown: Effect.sync(() => {
          startupEffects.push("shutdown-prepare");
        }),
        reconcile: () => Effect.sync(() => {
          startupEffects.push("shutdown-reconcile");
          return recovery;
        }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        recoverDelegatedTasks: Effect.sync(() => {
          startupEffects.push("delegated-recovery");
        }),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        shutdown: Effect.sync(() => {
          startupEffects.push("sessions-shutdown");
        }),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({
        start: () => Effect.sync(() => {
          startupEffects.push("awareness-relay");
        }),
      }),
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: () => Effect.never }),
      Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
        publish: (event) =>
          Effect.sync(() => {
            const published = { ...event, sequence: events.length + 1 };
            events.push(published);
            return published;
          }),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        start: Effect.sync(() => {
          startupEffects.push("settings");
        }),
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          defaultModelSelection:
            scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("bootstrap-environment"),
          label: "Test environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ProjectService.ProjectService)({
        bootstrap: () =>
          scenario === "project-failure"
            ? Effect.die("project bootstrap failed")
            : Effect.succeed({
                created: true,
                project: {
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/bootstrap-project",
                  repositoryIdentity: null,
                  faviconPath: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  deletedAt: null,
                  defaultModelSelection:
                    scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
                },
              }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        countThreads: () => Effect.succeed(0),
        listActiveShellIndex: () => Effect.succeed([]),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          assert.equal(input.modelSelection.instanceId, instanceId);
          return scenario === "launch-failure"
            ? Effect.fail(
                new ThreadLaunch.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: CommandId.make("bootstrap-command"),
                  projectId,
                  cause: "test launch failure",
                }),
              )
            : Effect.fail(
                new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                  projectId,
                  instanceId,
                }),
              );
        },
      }),
      Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
        managed: false,
        protocol: undefined,
        prepareTrial: () => Effect.sync(() => {
          startupEffects.push("launcher-prepared");
          return undefined;
        }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(AnalyticsService.AnalyticsService)({}),
      // No provider logins or Connect link, so startup records no owners.
      FileSystem.layerNoop({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
    );
    const start = Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      const ready = yield* Effect.exit(startup.awaitCommandReady);
      assert.equal(Exit.isSuccess(ready), scenario !== "project-failure");
      const welcome = events.find((event) => event.type === "welcome");
      if (scenario === "project-failure") {
        assert.isUndefined(welcome);
      } else {
        assert.isDefined(welcome);
        if (welcome?.type === "welcome") {
          assert.equal(welcome.payload.bootstrapProjectId, projectId);
          assert.isUndefined(welcome.payload.bootstrapThreadId);
        }
      }
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.never),
      Effect.scoped,
      afterStagedCandidateReadiness,
    );
    if (!scenario.startsWith("staged-")) return yield* start;
    const prepared = yield* Deferred.make<void>();
    const admission = yield* Deferred.make<void>();
    const checkpoints: string[] = [];
    const rejected = new StagedCandidateReadinessError({ cause: "synthetic stage refusal" });
    const candidate = start.pipe(Effect.provideService(StagedCandidateStartup, {
      inspect: scenario === "staged-inspection-failure"
        ? Effect.fail(rejected)
        : Effect.sync(() => {
            checkpoints.push("inspected");
          }),
      reportPrepared: scenario === "staged-report-failure"
        ? Effect.fail(rejected)
        : Effect.sync(() => {
            checkpoints.push("prepared");
          }).pipe(
            Effect.andThen(Deferred.succeed(prepared, undefined)),
            Effect.asVoid,
          ),
      awaitAdmission: scenario === "staged-admission-failure"
        ? Deferred.await(admission).pipe(Effect.andThen(Effect.fail(rejected)))
        : Deferred.await(admission),
    }));
    const fiber = yield* candidate.pipe(Effect.forkScoped);
    if (scenario === "staged-inspection-failure" || scenario === "staged-report-failure") {
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(checkpoints, scenario === "staged-report-failure" ? ["inspected"] : []);
      assert.deepEqual(startupEffects, []);
      assert.deepEqual(events, []);
      return;
    }
    yield* Deferred.await(prepared);
    assert.deepEqual(checkpoints, ["inspected", "prepared"]);
    assert.deepEqual(startupEffects, []);
    assert.deepEqual(events, []);
    if (scenario === "staged-cancel") {
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(startupEffects, []);
      assert.deepEqual(events, []);
      return;
    }
    yield* Deferred.succeed(admission, undefined);
    if (scenario === "staged-admission-failure") {
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(startupEffects, []);
      assert.deepEqual(events, []);
      return;
    }
    yield* Fiber.join(fiber);
    assert.deepEqual(startupEffects.slice(0, 7), [
      "construct-layers", "keybindings", "settings", "legacy-import", "recovery",
      "delegated-recovery", "awareness-relay",
    ]);
    assert.ok(startupEffects.indexOf("launcher-prepared") > startupEffects.indexOf("recovery"));
    assert.ok(startupEffects.includes("shutdown-reconcile"));
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.gen(function* () {
    const workerInterrupted = yield* Ref.make(false);
    const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

    const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
      runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
      startRelay: Effect.yieldNow.pipe(
        Effect.andThen(Effect.die("awareness relay startup failed")),
      ),
      workerFiberRef,
    }).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    assert.isTrue(yield* Ref.get(workerInterrupted));
    assert.isNull(yield* Ref.get(workerFiberRef));
  }),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    const count = yield* Ref.make(0);
    const queued = yield* gate
      .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
      .pipe(Effect.forkScoped);

    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(count), 0);
    yield* gate.signalCommandReady;
    assert.equal(yield* Fiber.join(queued), 1);
  }),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.gen(function* () {
    const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
    const failure = yield* Deferred.make<void, never>();

    const queuedCommandFiber = yield* commandGate
      .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
      .pipe(Effect.forkScoped);

    yield* commandGate.failCommandReady(
      new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: "127.0.0.1",
        port: 3773,
        cause: new Error("test startup failure"),
      }),
    );

    const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
    assert.equal(error.message, "Server runtime startup failed before command readiness.");
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
