import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskWebhookFilter,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertInput,
  managedPolicyDeniedMessage,
  scheduledTaskThreadMode,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  PersistenceTransactions,
  sqliteLayer as sqliteTransactions,
} from "../persistence/PersistenceTransactions.ts";
import {
  ScheduledRows,
  TaskRows,
  TaskIds,
  DeliveryRows,
  PendingRows,
  AnyRows,
  NextDueRows,
  NextPendingRows,
  CountRows,
  RelayIds,
  type Row,
} from "./ScheduledRows.ts";
import * as SqliteScheduledRows from "./SqliteScheduledRows.ts";

import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import {
  acceptWebhookDedupe,
  acceptImmediateWebhookDedupe,
  releaseWebhookReplay,
  decodePendingTask,
  encodePendingTask,
  decodePendingRequest,
  dedupeError,
} from "./webhookDedupe.ts";
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "./webhookFilter.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
const isScheduledTaskError = Schema.is(ScheduledTaskError);
const PROMPT_TOO_LONG = "The filled-in prompt is too long.";
const WEBHOOK_DELIVERY_RETENTION = 50;
const WEBHOOK_DEDUPE_DELIVERY_RETENTION = 20;
const WEBHOOK_FILTERED_DELIVERY_RETENTION = 20;
const WEBHOOK_DEDUPE_LOG_PER_MINUTE = 10;
const WEBHOOK_FILTERED_LOG_PER_MINUTE = 10;
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
const loggedWebhookPrompt = (prompt: string) => {
  const limit = WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT;
  const before = prompt.charCodeAt(limit - 1);
  const after = prompt.charCodeAt(limit);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return prompt.slice(0, splitsPair ? limit - 1 : limit);
};
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
// Enforce the relay's per-task/minute limit here too; tunnel hostnames are public.
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
const RELAY_CLAIM_RETENTION_HOURS = 48;
const RELAY_UNRESOLVED_ERROR =
  "Dispatch could not be confirmed. This delivery will not run again automatically.";
const webhookFireKey = (taskId: string, deliveryId: string) => `${taskId}:webhook:${deliveryId}`;
// User replay keys are hex digests, so the relay receipt has its own namespace.
const relayReceiptKey = (id: string) => `relay-admission:${id}`;
const LEGACY_DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);

interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "t3/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

class WebhookDeliverySkipped extends Schema.TaggedError<WebhookDeliverySkipped>()(
  "WebhookDeliverySkipped",
  { reason: Schema.String },
) {}

interface RateWindow {
  readonly accepted: ReadonlyArray<{ readonly at: number }>;
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  readonly relayDeliveryId?: string;
  readonly receivedAt?: string;
}

export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "coalesced"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "filtered"
  | "not_found"
  | "blocked_by_policy"
  | "unresolved"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      readonly outcome: "accepted" | "duplicate" | "coalesced" | "prompt_too_long" | "filtered";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | { readonly _tag: "blocked_by_policy" }
  | {
      readonly _tag: "rate_limited";
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" }
  | {
      readonly _tag: "unresolved";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
    };

const webhookFilters = (filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined) =>
  filters?.length ? { filters } : {};

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);
const RelayPromptJson = Schema.fromJsonString(Schema.String);
const encodeRelayPrompt = Schema.encodeEffect(RelayPromptJson);
const decodeRelayPrompt = Schema.decodeUnknownEffect(RelayPromptJson);

/**
 * Clients that predate thread modes send none, and may send a thread loaded before the first run
 * bound one. An edit keeps the stored mode; binding a thread to a new-thread task continues it.
 */
function resolveThreadMode(
  input: Pick<ScheduledTaskUpsertInput, "threadId" | "threadMode">,
  existing: Pick<ScheduledTask, "threadId" | "threadMode"> | null,
): ScheduledTaskThreadMode {
  if (input.threadMode !== undefined) return input.threadMode;
  const stored = existing === null ? "new_thread" : scheduledTaskThreadMode(existing);
  return stored === "new_thread" && input.threadId != null ? "continue" : stored;
}

interface ScheduledTaskRow {
  readonly task_id: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly thread_mode: string;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
}

interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly pending_window: number;
  readonly error: string | null;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    /** Deletes only tasks that still target this thread, including their webhook deliveries. */
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, ScheduledTaskError>;
    /** Points tasks bound to these threads at the project the threads moved to. */
    readonly moveThreadTasks: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, ScheduledTaskError>;
    /** The dispatched thread, or null if dispatch failed; leaves the task's binding unchanged. */
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<
      ScheduledTaskRunNowResult & { readonly threadId: ThreadId | null },
      ScheduledTaskError
    >;
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /** Verifies, logs and dispatches; returns after logging while the run continues in the background. */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const RUN_OUTCOME_WAIT_MS = 24 * 60 * 60 * 1_000;
const UNSUCCESSFUL_RUN_ERRORS = {
  failed: "The run failed.",
  interrupted: "The run was stopped.",
  cancelled: "The run was cancelled.",
  rolled_back: "The run was rolled back.",
} as const;
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // Decoded intervals can overflow DateTime; unrepresentable occurrences have no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

/**
 * Next run after an interrupted run. A one-time task counts from the run's start
 * (`lastRunAt`), so a manual run that began before its time does not use it up.
 */
function nextRunAfterRun(
  task: Pick<ScheduledTask, "enabled" | "schedule" | "lastRunAt">,
  now: DateTime.DateTime,
): string | null {
  const startedAt =
    task.schedule.type === "once" && task.lastRunAt !== null
      ? DateTime.make(task.lastRunAt)
      : Option.none();
  return nextRunAt(
    task,
    Option.getOrElse(startedAt, () => now),
  );
}

/** An enabled one-time task with a past time would never run, so saving it is an error. */
function requireFutureOnce(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  now: DateTime.DateTime,
  taskId: ScheduledTaskId,
) {
  return task.enabled && task.schedule.type === "once" && nextRunAt(task, now) === null
    ? taskError("The run time has passed. Pick a time in the future.", { taskId })
    : Effect.void;
}

function errorMessage(error: unknown): string {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  return failure instanceof Error ? failure.message : String(failure);
}

function webhookPath(taskId: string | null, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(String(taskId))}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url:
      base === null
        ? null
        : `${base}/${encodeURIComponent(String(row.task_id))}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

// Runs per task row; list and lookup operations already own the span.
const decodeRow = Effect.fnUntraced(
  function* (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      threadMode: row.thread_mode,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
    });
  },
  (effect, row, _origin?) =>
    effect.pipe(
      Effect.mapError((cause) => {
        const taskId = decodeTaskId(row.task_id);
        return taskError("Could not decode schedule task row.", {
          ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
          cause,
        });
      }),
    ),
);

const listDueTasksWithRows = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const store = yield* ScheduledRows;
  const rows = yield* store.read({ kind: "tasks", due_before: iso(now) }, TaskRows);
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is freeform; skip unparseable values before they defect the poll.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

/** Compatibility entry point for callers that already provide the SQLite layer. */
export const listDueTasks = (now: DateTime.DateTime) =>
  listDueTasksWithRows(now).pipe(Effect.provide(SqliteScheduledRows.layer));

export const layerWithRows = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const store = yield* ScheduledRows;
    const transactions = yield* PersistenceTransactions;
    const patchTask = (
      taskId: string,
      patch: Row,
      expected: Row = {},
      different: Row = {},
      increment = false,
    ) =>
      store.write(
        {
          kind: "patch_task",
          task_id: taskId,
          patch,
          expected,
          different,
          increment_run_count: increment,
        },
        TaskIds,
      );
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const mac = yield* Mac.Mac;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const commandReceipts = yield* Effect.serviceOption(CommandReceiptStoreV2);
    const serviceScope = yield* Effect.scope;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
    const webhookPolicyOrganization = ManagedPolicy.deniedBy(managedPolicy, "webhookTasks");
    // Existing webhook tasks stay stored but report why they do not run.
    const webhookPolicyBlock =
      webhookPolicyOrganization === undefined
        ? undefined
        : managedPolicyDeniedMessage(webhookPolicyOrganization, "webhook tasks");
    const withPolicy = (task: ScheduledTask): ScheduledTask =>
      webhookPolicyBlock !== undefined && task.schedule.type === "webhook"
        ? { ...task, blockedByPolicy: webhookPolicyBlock }
        : task;
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Include creation time so late deliveries cannot decrement a recreated task's count.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const immediateRelayHandoffs = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<boolean>>>(
      new Map(),
    );
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
    const webhookRejectedRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(
      new Map(),
    );
    const webhookDedupeLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const pendingInFlight = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
    const webhookFilteredLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const dueTasks = DueHint.make();
    const pendingWebhooks = DueHint.make();
    // Every scheduled_tasks write that can change next_run_at, enabled or run state notifies.
    const notifyChanged = dueTasks.invalidate.pipe(
      Effect.andThen(PubSub.publish(changesPubSub, undefined)),
      Effect.asVoid,
    );

    // Created order is stable while toggles, edits and runs change updated_at.
    const selectAllRows = () => store.read({ kind: "tasks" }, TaskRows);

    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      return yield* Effect.forEach(
        rows,
        (row) => decodeRow(row, origin).pipe(Effect.map(withPolicy)),
        { concurrency: 1 },
      );
    });

    const getRows = (id: ScheduledTaskId) => store.read({ kind: "tasks", task_id: id }, TaskRows);

    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return withPolicy(yield* decodeRow(row, yield* readWebhookOrigin));
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = random.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run transitions own run-state columns; settings saves must not overwrite them.
    // Check existence in the write so edits cannot undo concurrent deletion.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      /** The schedule this save read, when it left the schedule unchanged. */
      keptSchedule: ScheduledTask["schedule"] | null,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        readonly secretChanged: boolean;
      },
    ) =>
      store
        .write(
          {
            kind: "save_task",
            require_existing: requireExisting,
            kept_schedule_json: keptSchedule === null ? null : JSON.stringify(keptSchedule),
            secret_changed: webhook.secretChanged,
            row: {
              task_id: task.id,
              title: task.title,
              prompt: task.prompt,
              enabled: task.enabled ? 1 : 0,
              schedule_json: JSON.stringify(task.schedule),
              project_id: task.projectId,
              thread_id: task.threadId,
              thread_mode: scheduledTaskThreadMode(task),
              workspace_strategy_json: JSON.stringify(task.workspaceStrategy),
              model_selection_json: JSON.stringify(task.modelSelection),
              runtime_mode: task.runtimeMode,
              interaction_mode: task.interactionMode,
              created_by: task.createdBy,
              creation_source: task.creationSource,
              created_at: task.createdAt,
              updated_at: task.updatedAt,
              next_run_at: task.nextRunAt,
              last_run_at: task.lastRunAt,
              last_run_status: task.lastRunStatus,
              last_run_error: task.lastRunError,
              run_count: task.runCount,
              webhook_token: webhook.token,
              webhook_secret: webhook.secret,
            },
          },
          TaskIds,
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not save schedule task.", { taskId: task.id, cause }),
          ),
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.void
              : taskError("Schedule task not found.", { taskId: task.id }),
          ),
        );

    const deleteRow = (id: ScheduledTaskId) =>
      store
        .write({ kind: "delete_tasks", task_id: id }, TaskIds)
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    const markRunning = (id: ScheduledTaskId, startedAtIso: string, webhookDeliveryId?: string) =>
      patchTask(id, {
        updated_at: startedAtIso,
        last_run_at: startedAtIso,
        last_run_webhook_delivery_id: webhookDeliveryId ?? null,
        last_run_status: "running",
        last_run_error: null,
      }).pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0 ? Effect.void : taskError("Schedule task not found.", { taskId: id }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
      readonly webhook?: { readonly deliveryId: string; readonly createdAt: string };
    }) =>
      patchTask(
        input.id,
        {
          updated_at: input.completedAtIso,
          next_run_at: input.nextRunAtIso,
          last_run_status: input.status,
          last_run_error: input.error,
        },
        {
          last_run_status: "running",
          last_run_at: input.startedAtIso,
          ...(input.webhook === undefined
            ? {}
            : {
                last_run_webhook_delivery_id: input.webhook.deliveryId,
                created_at: input.webhook.createdAt,
              }),
        },
        {},
        true,
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // A failure between markRunning and markCompleted must still write a terminal record:
    // runDueTasks skips 'running' rows forever, and the dispatch may already have gone out,
    // so next_run_at must advance. Pending webhook attempts count only with their completion.
    const releaseStuckRun = Effect.fn("ScheduledTaskService.releaseStuckRun")(
      function* (
        task: ScheduledTask,
        startedAtIso: string,
        message: string,
        pendingDeliveryId?: string,
      ) {
        const now = yield* localNow;
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return;
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* store.write(
          {
            kind: "recover_task",
            task_id: task.id,
            match_pending_task: false,
            ...(pendingDeliveryId === undefined ? {} : { pending_delivery_id: pendingDeliveryId }),
            patch: {
              last_run_status: "failed",
              last_run_error: message,
              next_run_at: nextRunAfterRun({ ...source, lastRunAt: startedAtIso }, now),
              updated_at: iso(now),
            },
          },
          AnyRows,
        );
        yield* notifyChanged;
      },
      (effect, task, _startedAtIso, _message, _pendingDeliveryId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not release stuck schedule task run", {
              taskId: task.id,
              cause,
            }),
          ),
        ),
    );

    // Reads every run row but only the queued runs' messages, so the cost per
    // due interval tracks the thread's run count, not its transcript.
    const hasQueuedOccurrence = Effect.fn("ScheduledTaskService.hasQueuedOccurrence")(function* (
      taskId: ScheduledTaskId,
      threadId: ThreadId,
    ) {
      const { runs } = yield* threadManagement.getThreadRecords(threadId, ["runs"]);
      const queued = runs.filter((run) => run.status === "queued");
      if (queued.length === 0) return false;
      const queuedMessageIds = new Set(queued.map((run) => run.userMessageId));
      const { messages } = yield* threadManagement.getThreadRecords(threadId, ["messages"], {
        messageIds: [...queuedMessageIds],
      });
      return messages.some(
        (message) => queuedMessageIds.has(message.id) && message.scheduledTaskId === taskId,
      );
    });

    // The run already started the thread, so a failed write only costs the binding.
    // A thread deleted before the binding landed already ran its task cleanup, so apply that
    // cleanup here; a later deletion finds the binding. An unconfirmed lookup keeps the binding.
    const bindThread = Effect.fn("ScheduledTaskService.bindThread")(
      function* (task: ScheduledTask, threadId: ThreadId) {
        yield* patchTask(
          task.id,
          { thread_id: threadId },
          { created_at: task.createdAt, project_id: task.projectId, thread_id: null },
          { thread_mode: "new_thread" },
        );
        const shell = yield* threadManagement.getThreadShell(threadId);
        if (shell === null || shell.deletedAt != null) yield* deleteForThread(threadId);
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not bind a scheduled task to its first thread.", cause),
      ),
    );

    // A dispatch is recorded once the message is accepted; the provider can still
    // reject the turn after that, so follow the run and record its failure.
    const recordRunFailure = Effect.fn("ScheduledTaskService.recordRunFailure")(function* (
      task: ScheduledTask,
      startedAtIso: string,
      threadId: ThreadId,
      messageId: MessageId,
      deliveryId?: string,
    ) {
      const shell = yield* threadManagement.getThreadShell(threadId);
      if (shell === null) return;
      const thread = { projectId: shell.projectId, threadId };
      const { runs } = yield* threadManagement.getProjectThreadRecords(thread, ["runs"]);
      const dispatched = runs.find((run) => run.userMessageId === messageId);
      if (dispatched === undefined) return;
      const { run } = yield* threadManagement.waitForThread({
        ...thread,
        runId: dispatched.id,
        timeoutMs: RUN_OUTCOME_WAIT_MS,
      });
      if (
        run === null ||
        run.status === "completed" ||
        !ThreadManagementService.isTerminalRunStatus(run.status)
      )
        return;
      const { turnItems, messages } = yield* threadManagement.getProjectThreadRecords(thread, [
        "turnItems",
        "messages",
      ]);
      // A queued message promoted to a steer cancels its run and joins the active one.
      if (
        run.status === "cancelled" &&
        messages.find((message) => message.id === messageId)?.runId !== run.id
      )
        return;
      const error =
        latestRootProviderFailure(run, turnItems)?.message ?? UNSUCCESSFUL_RUN_ERRORS[run.status];
      const updated = yield* patchTask(
        task.id,
        { last_run_status: "failed", last_run_error: error },
        {
          created_at: task.createdAt,
          last_run_at: startedAtIso,
          last_run_status: "succeeded",
          last_run_webhook_delivery_id: deliveryId ?? null,
        },
      );
      if (updated.length > 0) yield* notifyChanged;
    });

    const recordRelayReceipt = (
      taskId: ScheduledTaskId,
      relayId: string,
      ownerId: string,
      now: DateTime.DateTime,
    ) =>
      store
        .write(
          {
            kind: "claim_replay",
            task_id: taskId,
            replay_key: relayReceiptKey(relayId),
            delivery_id: ownerId,
            now: DateTime.toEpochMillis(now),
            expires_at: DateTime.toEpochMillis(
              DateTime.add(now, { hours: RELAY_CLAIM_RETENTION_HOURS }),
            ),
          },
          AnyRows,
        )
        .pipe(Effect.mapError(dedupeError));

    const checkWebhookTask = (active: ScheduledTask | null, admitted: ScheduledTask) => {
      const reason =
        active === null
          ? "The task was deleted before this delivery ran."
          : active.createdAt !== admitted.createdAt
            ? "The task was replaced before this delivery ran."
            : active.schedule.type !== "webhook"
              ? "The task's trigger changed before this delivery ran."
              : (webhookPolicyBlock ??
                (active.enabled ? null : "The task was paused before this delivery ran."));
      return active === null || reason !== null
        ? Effect.fail(new WebhookDeliverySkipped({ reason: reason! }))
        : Effect.succeed(active);
    };

    const claimReadyRelay = (task: ScheduledTask, deliveryId: string, startedAtIso: string) =>
      transactions.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* getRows(task.id);
          const active = yield* checkWebhookTask(
            row === undefined ? null : yield* decodeRow(row),
            task,
          );
          const claimed = yield* store.write(
            {
              kind: "patch_pending",
              delivery_id: deliveryId,
              states: ["relay_ready"],
              patch: { state: "relay_running", task_json: yield* encodePendingTask(active) },
            },
            AnyRows,
          );
          if (claimed.length === 0) {
            return yield* new WebhookDeliverySkipped({
              reason: "This delivery is no longer ready.",
            });
          }
          yield* markRunning(active.id, startedAtIso, deliveryId);
          return active;
        }),
      );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly dispatched: Ref.Ref<ThreadId | null>;
        readonly immediateRelayId?: string;
        readonly durableRelay?: boolean;
      },
    ) {
      // Read before reserving: nothing between the reservation and its release may fail.
      const startedAt = yield* localNow;
      const startedAtIso = iso(startedAt);
      const durableRelay = webhook?.durableRelay === true;
      const run = Effect.gen(function* () {
        // Re-read stale poll snapshots so deleted, paused or postponed tasks cannot fire.
        const active = yield* durableRelay
          ? claimReadyRelay(task, webhook.deliveryId, startedAtIso)
          : findTask(task.id);
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return { task, threadId: null, dispatchFailed: false };
        }
        if (
          webhook !== undefined &&
          !durableRelay &&
          (yield* store.read(
            {
              kind: "pending",
              delivery_id: webhook.deliveryId,
              states: ["completed"],
              first: false,
            },
            PendingRows,
          )).length > 0
        )
          return {
            task: { ...active, lastRunStatus: "succeeded" as const },
            threadId: null,
            dispatchFailed: false,
          };
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return { task: active, threadId: null, dispatchFailed: false };
        }
        // A thread that stays busy would otherwise collect one copy of the
        // prompt per interval. A failed read falls through to the normal send.
        if (
          trigger === "scheduled" &&
          active.schedule.type !== "once" &&
          active.threadId !== null &&
          (yield* hasQueuedOccurrence(active.id, ThreadId.make(active.threadId)).pipe(
            Effect.orElseSucceed(() => false),
          ))
        ) {
          yield* rescheduleMissedRun(active, startedAt, "previous occurrence still queued");
          return { task: active, threadId: null, dispatchFailed: false };
        }
        if (webhook === undefined) yield* markRunning(active.id, startedAtIso);
        else if (!durableRelay) {
          yield* checkWebhookTask(active, task);
          yield* transactions
            .withTransaction(
              Effect.gen(function* () {
                yield* markRunning(active.id, startedAtIso, webhook.deliveryId);
                // Recovery must distinguish this delivery from other windows waiting on the same task.
                yield* store.write(
                  {
                    kind: "patch_pending",
                    delivery_id: webhook.deliveryId,
                    patch: { state: "running" },
                  },
                  AnyRows,
                );
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                taskError("Could not start webhook run.", { taskId: task.id, cause }),
              ),
            );
        }

        yield* notifyChanged;

        const fireKey =
          webhook === undefined
            ? `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`
            : webhookFireKey(active.id, webhook.deliveryId);
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        const prompt = webhook?.prompt ?? active.prompt;
        const threadMode = scheduledTaskThreadMode(active);

        // A bound thread can move to another project (No project to a project) while
        // this fires. Follow it; one move needs at most two retries. Same ids replay safely.
        const sendBound = (
          threadId: ThreadId,
          projectId: ProjectId,
          retries: number,
        ): ReturnType<typeof threadManagement.sendToThread> =>
          threadManagement
            .sendToThread({
              projectId,
              commandId,
              threadId,
              messageId,
              scheduledTaskId: active.id,
              text: prompt,
              attachments: [],
              mode: "queue",
              ...(threadMode === "fresh_session" ? { freshContext: true } : {}),
              createdBy: active.createdBy,
              creationSource: active.creationSource,
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementThreadNotFoundError: (error) =>
                  retries === 0
                    ? Effect.fail(error)
                    : threadManagement.getThreadShell(threadId).pipe(
                        Effect.orElseSucceed(() => null),
                        Effect.flatMap((shell) =>
                          shell === null || shell.projectId === projectId
                            ? Effect.fail(error)
                            : sendBound(threadId, shell.projectId, retries - 1),
                        ),
                      ),
              }),
            );

        // Capture defects and interrupts too so dispatch failures still reach markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch
                  .launch({
                    commandId,
                    projectId: active.projectId,
                    title: active.title,
                    modelSelection: active.modelSelection,
                    runtimeMode: active.runtimeMode,
                    interactionMode: active.interactionMode,
                    workspaceStrategy: active.workspaceStrategy,
                    initialMessage: {
                      messageId,
                      scheduledTaskId: active.id,
                      text: prompt,
                      attachments: [],
                    },
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  })
                  .pipe(
                    Effect.map((launched) => launched.threadId),
                    Effect.tap((threadId) =>
                      threadMode === "new_thread" ? Effect.void : bindThread(active, threadId),
                    ),
                  ),
              )
            : yield* Effect.exit(
                // The stored selection only seeds fresh threads. A bound run
                // follows the thread's current provider, so it passes none.
                sendBound(ThreadId.make(active.threadId), active.projectId, 2).pipe(
                  Effect.as(ThreadId.make(active.threadId)),
                ),
              );

        const runSucceeded = result._tag === "Success";
        if (webhook !== undefined && runSucceeded) yield* Ref.set(webhook.dispatched, result.value);
        if (durableRelay && !runSucceeded)
          return { task: active, threadId: null, dispatchFailed: true };
        const completedAt = yield* localNow;
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        const threadId = runSucceeded ? result.value : null;
        // One transaction, so an edit cannot land between reading the schedule and
        // writing the next run computed from it. The origin is read first: it reads
        // files, and the transaction holds SQLite's writer lock.
        const origin = yield* readWebhookOrigin;
        const record = Effect.gen(function* () {
          const [row] = yield* getRows(task.id);
          const current = row === undefined ? null : yield* decodeRow(row, origin);
          const scheduleSource = current ?? task;
          const completed: ScheduledTask = {
            ...scheduleSource,
            updatedAt: iso(completedAt),
            lastRunAt: startedAtIso,
            // A manual run that starts before a one-time run must not use it up.
            nextRunAt: nextRunAt(
              scheduleSource,
              scheduleSource.schedule.type === "once" ? startedAt : completedAt,
            ),
            lastRunStatus,
            lastRunError,
            runCount: scheduleSource.runCount + 1,
          };
          if (current === null) return { recorded: completed, written: false };
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          const completion = markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
            ...(durableRelay
              ? { webhook: { deliveryId: webhook.deliveryId, createdAt: active.createdAt } }
              : {}),
          });
          let written = false;
          if (durableRelay) {
            written = yield* completion;
            if (written) {
              yield* recordRelayReceipt(
                active.id,
                webhook.immediateRelayId!,
                webhook.deliveryId,
                completedAt,
              );
              yield* store.write(
                { kind: "delete_pending", delivery_id: webhook.deliveryId },
                AnyRows,
              );
            }
          } else if (webhook === undefined) written = yield* completion;
          else {
            const pending = yield* store.read(
              { kind: "pending", delivery_id: webhook.deliveryId, first: false },
              PendingRows,
            );
            if (pending.length === 0) {
              written = yield* completion;
              if (runSucceeded && webhook.immediateRelayId !== undefined)
                yield* recordRelayReceipt(
                  active.id,
                  webhook.immediateRelayId,
                  webhook.deliveryId,
                  startedAt,
                );
            } else {
              const counted = yield* store.write(
                {
                  kind: "patch_pending",
                  delivery_id: webhook.deliveryId,
                  not_states: ["completed", "failed"],
                  patch: { state: runSucceeded ? "completed" : "failed" },
                },
                AnyRows,
              );
              if (counted.length > 0) written = yield* completion;
            }
          }
          // A row recreated mid-run is not this run's, so report what is stored.
          return { recorded: written ? completed : current, written };
        });
        const { recorded, written } = yield* transactions
          .withTransaction(record)
          .pipe(
            Effect.mapError((cause) =>
              isScheduledTaskError(cause)
                ? cause
                : taskError(
                    webhook === undefined
                      ? "Could not record schedule task run."
                      : "Could not record webhook completion.",
                    { taskId: task.id, cause },
                  ),
            ),
          );
        if (written) yield* notifyChanged;
        if (written && threadId !== null) {
          yield* recordRunFailure(
            active,
            startedAtIso,
            threadId,
            messageId,
            webhook?.deliveryId,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record scheduled run outcome", {
                taskId: active.id,
                cause,
              }),
            ),
            Effect.forkIn(serviceScope),
          );
        }
        // The stored row can belong to a replacement, so report this dispatch separately.
        return { task: recorded, threadId, dispatchFailed: !runSucceeded };
      }).pipe(
        Effect.onError((cause) =>
          durableRelay
            ? Effect.void
            : releaseStuckRun(task, startedAtIso, errorMessage(cause), webhook?.deliveryId),
        ),
      );

      // Reserve and release as one bracket so an interrupt cannot leave the task marked busy.
      return yield* Effect.acquireUseRelease(
        Ref.modify(activeRuns, (active) => {
          if (active.has(task.id)) return [false, active] as const;
          const next = new Set(active);
          next.add(task.id);
          return [true, next] as const;
        }),
        (reserved) =>
          reserved
            ? run
            : trigger !== "scheduled"
              ? Effect.fail(taskError("Schedule task is already running.", { taskId: task.id }))
              : Effect.succeed({ task, threadId: null, dispatchFailed: false }),
        (reserved) =>
          reserved
            ? Ref.update(activeRuns, (active) => {
                const next = new Set(active);
                next.delete(task.id);
                return next;
              })
            : Effect.void,
      );
    });

    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
      reason = "missed",
      runError?: string,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping schedule task run", {
        taskId: task.id,
        reason,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      const updated = yield* patchTask(
        task.id,
        {
          next_run_at: next,
          updated_at: iso(now),
          ...(runError === undefined
            ? {}
            : { last_run_status: "failed", last_run_error: runError }),
        },
        { next_run_at: task.nextRunAt, last_run_at: task.lastRunAt },
      ).pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      if (updated.length > 0) yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const nowMs = DateTime.toEpochMillis(now);
      if (yield* dueTasks.isIdle(nowMs)) return;
      const readVersion = yield* dueTasks.version;
      const [next] = yield* store
        .read({ kind: "next_due" }, NextDueRows)
        .pipe(Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })));
      // Compare as text like listDueTasks: expanded years (`+011533-…`) sort first but parse far ahead.
      const nextRunAt = next?.next_run_at ?? null;
      if (nextRunAt === null || nextRunAt > iso(now)) {
        const nextDueAt =
          nextRunAt === null
            ? Option.some(Infinity)
            : DateTime.make(nextRunAt).pipe(Option.map(DateTime.toEpochMillis));
        if (Option.isSome(nextDueAt) && nextDueAt.value > nowMs) {
          yield* dueTasks.record(readVersion, nextDueAt.value, nowMs);
        }
        return;
      }
      const tasks = yield* listDueTasksWithRows(now).pipe(
        Effect.provideService(ScheduledRows, store),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          Effect.suspend(() =>
            isMissedFixedTimeRun(task.schedule, dueAt, now)
              ? rescheduleMissedRun(
                  task,
                  now,
                  "missed",
                  "Missed a scheduled run because the server was not running at that time.",
                )
              : runTask(task, "scheduled"),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover crash-left running rows that the due-task filter would otherwise skip forever.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            if (
              store.durableRelayWebhooks &&
              row.task_id !== null &&
              row.last_run_webhook_delivery_id !== null
            ) {
              const runningRelay = yield* store.read(
                {
                  kind: "pending",
                  delivery_id: row.last_run_webhook_delivery_id,
                  task_id: row.task_id,
                  states: ["relay_running"],
                  first: true,
                },
                PendingRows,
              );
              if (runningRelay.length > 0) return;
            }
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* store.write(
                {
                  kind: "recover_task",
                  task_id: row.task_id,
                  match_pending_task: true,
                  patch: {
                    last_run_status: "failed",
                    last_run_error: "Run was interrupted by a server restart.",
                    next_run_at: nextRunAfterRun(decoded.success, now),
                    updated_at: iso(now),
                  },
                },
                AnyRows,
              );
              return;
            }
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* store.write(
              {
                kind: "recover_task",
                task_id: row.task_id,
                match_pending_task: true,
                patch: {
                  last_run_status: "failed",
                  last_run_error: "Run was interrupted by a server restart.",
                  updated_at: iso(now),
                },
              },
              AnyRows,
            );
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({
          tasks,
          timeZone: DateTime.zoneToString(DateTime.zoneMakeLocal()),
        })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const requireDestinationThread = Effect.fn("ScheduledTaskService.requireDestinationThread")(
      function* (threadId: ThreadId, projectId: ProjectId, taskId: ScheduledTaskId) {
        const thread = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(
            Effect.mapError((cause) =>
              taskError("Could not read the destination thread.", { taskId, cause }),
            ),
          );
        if (thread === null || thread.deletedAt !== null) {
          return yield* taskError("That thread no longer exists.", { taskId });
        }
        if (thread.archivedAt !== null) {
          return yield* taskError(
            "That thread is archived. Unarchive it or pick another destination.",
            { taskId },
          );
        }
        if (thread.projectId !== projectId) {
          return yield* taskError("That thread belongs to a different project.", { taskId });
        }
      },
    );

    const upsert: ScheduledTaskService["Service"]["upsert"] = Effect.fn(
      "ScheduledTaskService.upsert",
    )(function* (input) {
      // A webhook task the policy blocks can still be edited while it is off.
      if (input.enabled && input.schedule.type === "webhook" && webhookPolicyBlock !== undefined) {
        return yield* taskError(
          webhookPolicyBlock,
          input.id === undefined ? {} : { taskId: input.id },
        );
      }
      const now = yield* localNow;
      const uuid =
        input.commandId === undefined
          ? yield* random
              .uuidV4()
              .pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
          : null;
      const id =
        input.id ??
        ScheduledTaskId.make(
          input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
        );
      // Look up by the *resolved* id so idempotent creates (commandId replays)
      // keep their run history, and so real load failures propagate instead
      // of silently resetting an existing row.
      const existingTask = yield* findTask(id);
      const threadMode = resolveThreadMode(input, existingTask);
      const keptThreadId = input.threadId ?? existingTask?.threadId ?? null;
      // A bound thread belongs to its project, so moving the task leaves it for a new one.
      const movedOffThread =
        existingTask !== null &&
        existingTask.projectId !== input.projectId &&
        keptThreadId === existingTask.threadId;
      const threadId = threadMode === "new_thread" || movedOffThread ? null : keptThreadId;
      // An unchanged destination is not rechecked, so a task on an archived thread stays editable.
      if (threadId !== null && threadId !== existingTask?.threadId) {
        yield* requireDestinationThread(threadId, input.projectId, id);
      }
      // Refused on save rather than at run time; a disabled task can still be saved, so one
      // stored above the ceiling can be turned off before its mode is lowered. A task bound to a
      // thread runs in that thread's mode, which the orchestrator checks instead. Checked before
      // the save consumes a webhook secret.
      const modeDenial =
        input.enabled && threadId === null
          ? managedRuntimeModeDenial(managedPolicy.summary, input.runtimeMode)
          : undefined;
      if (modeDenial !== undefined) return yield* taskError(modeDenial, { taskId: id });
      // Keep the existing next_run_at when the schedule itself is untouched:
      // editing a title or prompt must not postpone (or resurrect) a due
      // run — only schedule/enabled changes restart the clock.
      const schedule: ScheduledTask["schedule"] =
        input.schedule.type === "webhook"
          ? {
              type: "webhook",
              signature:
                input.schedule.signature == null
                  ? null
                  : {
                      header: input.schedule.signature.header.toLowerCase(),
                      encoding: input.schedule.signature.encoding,
                      prefix: input.schedule.signature.prefix,
                    },
              maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              ...(input.schedule.dedupe === undefined
                ? existingTask?.schedule.type === "webhook" &&
                  existingTask.schedule.dedupe !== undefined
                  ? { dedupe: existingTask.schedule.dedupe }
                  : {}
                : { dedupe: input.schedule.dedupe }),
              ...webhookFilters(
                // Omitted keeps the stored filters, so a client that predates
                // them can re-save a task without clearing them.
                input.schedule.filters ??
                  (existingTask?.schedule.type === "webhook"
                    ? existingTask.schedule.filters
                    : undefined),
              ),
            }
          : input.schedule.type === "once"
            ? { type: "once", runAt: iso(DateTime.makeUnsafe(input.schedule.runAt)) }
            : input.schedule;
      const webhook =
        input.schedule.type === "webhook"
          ? yield* Effect.gen(function* () {
              const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
              const token = existing?.token ?? (yield* newWebhookToken);
              const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
              // A secretRef is a value the user entered for an agent; this
              // save consumes it, so it cannot be used again. A replay of a
              // save that already used it keeps the secret that save stored.
              const replay = input.commandId !== undefined && existing?.secret != null;
              const fromRef =
                signature?.secretRef === undefined
                  ? undefined
                  : yield* secretRequests
                      .consume({ ref: signature.secretRef, projectId: input.projectId })
                      .pipe(
                        Effect.catch((error) =>
                          replay
                            ? Effect.void
                            : Effect.fail(taskError(error.message, { taskId: id })),
                        ),
                      );
              // A ref, when given, is the only source: a plain secret sent
              // alongside it must not replace what a replayed save stored.
              const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
              const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
              const secretChanged =
                signature == null || provided !== undefined || existing === null;
              if (signature != null && secret === null) {
                return yield* taskError("A webhook signature check needs a signing secret.", {
                  taskId: id,
                });
              }
              return { token, secret, secretChanged };
            })
          : { token: null, secret: null, secretChanged: true };
      const workspaceStrategy: ScheduledTask["workspaceStrategy"] =
        input.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(input.projectId))
          ? { type: "root" }
          : input.workspaceStrategy;
      const scheduleUnchanged =
        existingTask !== null &&
        existingTask.enabled === input.enabled &&
        isSameSchedule(existingTask.schedule, schedule);
      if (!scheduleUnchanged)
        yield* requireFutureOnce({ enabled: input.enabled, schedule }, now, id);
      const task: ScheduledTask = {
        id,
        title: input.title,
        prompt: input.prompt,
        enabled: input.enabled,
        schedule,
        projectId: input.projectId,
        threadId,
        threadMode,
        workspaceStrategy,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
        creationSource: input.creationSource ?? "web",
        createdAt: existingTask?.createdAt ?? iso(now),
        updatedAt: iso(now),
        nextRunAt: scheduleUnchanged
          ? existingTask.nextRunAt
          : nextRunAt({ enabled: input.enabled, schedule }, now),
        lastRunAt: existingTask?.lastRunAt ?? null,
        lastRunStatus: existingTask?.lastRunStatus ?? "never",
        lastRunError: existingTask?.lastRunError ?? null,
        runCount: existingTask?.runCount ?? 0,
      };
      yield* saveTask(
        task,
        input.requireExisting === true,
        scheduleUnchanged ? existingTask.schedule : null,
        webhook,
      );
      yield* notifyChanged;
      return { task: (yield* findTask(id)) ?? task };
    });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = Effect.fn(
      "ScheduledTaskService.setEnabled",
    )(function* (input) {
      const existing = yield* loadTask(input.id);
      if (existing.enabled === input.enabled) return { task: existing };
      if (
        input.enabled &&
        existing.schedule.type === "webhook" &&
        webhookPolicyBlock !== undefined
      ) {
        return yield* taskError(webhookPolicyBlock, { taskId: input.id });
      }
      const modeDenial =
        input.enabled && existing.threadId === null
          ? managedRuntimeModeDenial(managedPolicy.summary, existing.runtimeMode)
          : undefined;
      if (modeDenial !== undefined) {
        return yield* taskError(modeDenial, { taskId: input.id });
      }
      const now = yield* localNow;
      yield* requireFutureOnce(
        { enabled: input.enabled, schedule: existing.schedule },
        now,
        input.id,
      );
      const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
      // RETURNING so a task deleted between the load and this UPDATE is a
      // visible not-found error, not a false success.
      const updated = yield* patchTask(input.id, {
        enabled: input.enabled ? 1 : 0,
        next_run_at: next,
        updated_at: iso(now),
      }).pipe(
        Effect.mapError((cause) =>
          taskError("Could not update schedule task.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task not found.", { taskId: input.id });
      }
      yield* notifyChanged;
      return {
        task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
      };
    });

    const forgetWebhookTask = (id: ScheduledTaskId) =>
      Effect.all(
        [
          Ref.update(webhookRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookRejectedRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookDedupeLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookFilteredLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookPermits, (permits) => {
            const next = new Map(permits);
            next.delete(id);
            return next;
          }),
        ],
        { discard: true },
      );

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(forgetWebhookTask(input.id)),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const deleteForThread = Effect.fn("ScheduledTaskService.deleteForThread")(function* (
      threadId: ThreadId,
    ) {
      // Check the current binding in the transaction: an automation may have
      // been unbound or moved since thread deletion queued this cleanup.
      const removed = yield* store
        .write({ kind: "delete_tasks", thread_id: threadId }, TaskIds)
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete thread's schedule tasks.", { cause }),
          ),
        );
      yield* Effect.forEach(
        removed,
        ({ task_id }) => forgetWebhookTask(ScheduledTaskId.make(task_id)),
        {
          discard: true,
        },
      );
      if (removed.length > 0) yield* notifyChanged;
    });

    const moveThreadTasks: ScheduledTaskService["Service"]["moveThreadTasks"] = Effect.fn(
      "ScheduledTaskService.moveThreadTasks",
    )(function* (input) {
      if (input.threadIds.length === 0) return;
      const moved = yield* store
        .write(
          {
            kind: "patch_task",
            thread_ids: input.threadIds,
            expected: {},
            different: { project_id: input.projectId },
            patch: { project_id: input.projectId },
            increment_run_count: false,
          },
          TaskIds,
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not move the thread's schedule tasks.", { cause }),
          ),
        );
      if (moved.length > 0) yield* notifyChanged;
    });

    const runNow: ScheduledTaskService["Service"]["runNow"] = Effect.fn(
      "ScheduledTaskService.runNow",
    )(function* (input: ScheduledTaskRunNowInput) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type === "webhook") {
        return yield* taskError("Webhook tasks run when their URL receives a request.", {
          taskId: input.id,
        });
      }
      return yield* runTask(task, "manual").pipe(
        Effect.mapError((cause) =>
          isScheduledTaskError(cause)
            ? cause
            : taskError("Could not run schedule task.", { taskId: input.id, cause }),
        ),
      );
    });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = Effect.fn(
      "ScheduledTaskService.rotateWebhookToken",
    )(function* (input) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type !== "webhook") {
        return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
      }
      const token = yield* newWebhookToken;
      const now = yield* localNow;
      // Matching created_at keeps a rotation from landing on a task deleted
      // and recreated under the same id since it was loaded.
      const updated = yield* patchTask(
        input.id,
        { webhook_token: token, updated_at: iso(now) },
        { created_at: task.createdAt },
      ).pipe(
        Effect.mapError((cause) =>
          taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
      }
      yield* notifyChanged;
      return { task: yield* loadTask(input.id) };
    });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      pendingWindow: row.outcome === "accepted" && row.pending_window === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      store.read({ kind: "deliveries", task_id: input.id }, DeliveryRows).pipe(
        Effect.map((rows) => ({
          deliveries: rows
            .filter(
              (row) => input.acceptAnyOutcome === true || LEGACY_DELIVERY_OUTCOMES.has(row.outcome),
            )
            .map(decodeDeliverySummary),
        })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = Effect.fn(
      "ScheduledTaskService.getWebhookDelivery",
    )(function* (input) {
      const rows = yield* store
        .read(
          { kind: "deliveries", task_id: input.id, delivery_id: input.deliveryId },
          DeliveryRows,
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
          ),
        );
      const row = rows[0];
      if (
        row === undefined ||
        (input.acceptAnyOutcome !== true && !LEGACY_DELIVERY_OUTCOMES.has(row.outcome))
      ) {
        return yield* taskError("Webhook delivery not found.", { taskId: input.id });
      }
      return {
        delivery: {
          ...decodeDeliverySummary(row),
          query: row.query,
          headers: deliveryHeaders(row),
          body: row.body,
          bodyTruncated: row.body_truncated === 1,
          renderedPrompt: row.rendered_prompt,
        },
      };
    });

    const deliveryRequestBody = (request: WebhookTriggerRequest) => {
      const truncated = request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      return {
        truncated,
        // Streaming decode drops a character the byte limit split, instead of ending in U+FFFD.
        body: truncated
          ? new TextDecoder().decode(request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT), {
              stream: true,
            })
          : request.bodyText,
      };
    };
    const replaceDeliveryRequest = (deliveryId: string, request: WebhookTriggerRequest) => {
      const logged = deliveryRequestBody(request);
      return store
        .write(
          {
            kind: "patch_delivery",
            delivery_id: deliveryId,
            patch: {
              method: request.method,
              query: redactQuery(request.query),
              headers_json: encodeHeadersJson(redactHeaders(request.headers)),
              body: logged.body,
              body_bytes: request.body.byteLength,
              body_truncated: logged.truncated ? 1 : 0,
            },
          },
          AnyRows,
        )
        .pipe(Effect.asVoid, Effect.mapError(dedupeError));
    };

    // Each suppression bucket retains its own rows, never real run history.
    const deliveryBucket = (outcome: string, error: string | undefined) =>
      outcome === "filtered"
        ? "filtered"
        : outcome === "duplicate" ||
            outcome === "coalesced" ||
            outcome === "rate_limited" ||
            error === PROMPT_TOO_LONG
          ? "dedupe"
          : "main";
    const pruneDeliveries = (taskId: string, retentionBucket: ReturnType<typeof deliveryBucket>) =>
      store.write(
        {
          kind: "prune_deliveries",
          task_id: taskId,
          bucket: retentionBucket,
          limit:
            retentionBucket === "main"
              ? WEBHOOK_DELIVERY_RETENTION
              : retentionBucket === "filtered"
                ? WEBHOOK_FILTERED_DELIVERY_RETENTION
                : WEBHOOK_DEDUPE_DELIVERY_RETENTION,
        },
        AnyRows,
      );

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const { truncated, body: loggedBody } = deliveryRequestBody(input.request);
      return transactions
        .withTransaction(
          Effect.gen(function* () {
            // Require the task to exist so deletes cannot leave deliveries for a recreated task.
            yield* store.write(
              {
                kind: "record_delivery",
                row: {
                  delivery_id: input.id,
                  task_id: input.taskId,
                  received_at: input.receivedAt,
                  method: input.request.method,
                  query: redactQuery(input.request.query),
                  headers_json: encodeHeadersJson(redactHeaders(input.request.headers)),
                  body: loggedBody,
                  body_bytes: input.request.body.byteLength,
                  body_truncated: truncated ? 1 : 0,
                  outcome: input.outcome,
                  signature_verified: input.signatureVerified ? 1 : 0,
                  missing_fields_json: encodeMissingFieldsJson(input.missing),
                  rendered_prompt:
                    input.renderedPrompt === null
                      ? null
                      : loggedWebhookPrompt(input.renderedPrompt),
                  error: input.error ?? null,
                },
              },
              AnyRows,
            );
            yield* pruneDeliveries(input.taskId, deliveryBucket(input.outcome, input.error));
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      transactions
        .withTransaction(
          Effect.gen(function* () {
            const [updated] = yield* store.write(
              {
                kind: "patch_delivery",
                delivery_id: deliveryId,
                patch: { outcome: "dispatch_failed", error: message },
              },
              TaskIds,
            );
            // An oversized prompt moves the row into the suppression bucket.
            if (updated !== undefined)
              yield* pruneDeliveries(updated.task_id, deliveryBucket("dispatch_failed", message));
          }),
        )
        .pipe(Effect.ignore);

    /** Sliding one-minute window for deliveries that can start work. */
    const takeRateSlot = (
      id: ScheduledTaskId,
      nowMs: number,
      rateWindows = webhookRateWindows,
      reservation = { at: nowMs },
    ) =>
      Ref.modify(
        rateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((entry) => nowMs - entry.at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, reservation], rejectedLogged: false }),
          ];
        },
      );

    const takeDedupeLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(webhookDedupeLogWindows, (windows) => {
        const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
        return recent.length >= WEBHOOK_DEDUPE_LOG_PER_MINUTE
          ? ([false, windows] as const)
          : ([true, new Map(windows).set(id, [...recent, nowMs])] as const);
      });
    const releaseReplay = (deliveryId: string) =>
      releaseWebhookReplay(deliveryId).pipe(
        Effect.provideService(ScheduledRows, store),
        Effect.mapError(dedupeError),
      );
    /** Sliding one-minute window of filtered requests written to the delivery log. */
    const takeFilteredLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookFilteredLogWindows,
        (windows): readonly [boolean, ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>] => {
          const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
          return recent.length >= WEBHOOK_FILTERED_LOG_PER_MINUTE
            ? [false, windows]
            : [true, new Map(windows).set(id, [...recent, nowMs])];
        },
      );

    const webhookPermit = Effect.fn("ScheduledTaskService.webhookPermit")(function* (
      id: ScheduledTaskId,
    ) {
      const existing = (yield* Ref.get(webhookPermits)).get(id);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(webhookPermits, (permits) => {
        const raced = permits.get(id);
        return raced === undefined
          ? [created, new Map(permits).set(id, created)]
          : [raced, permits];
      });
    });

    const releaseFailedDelivery = Effect.fn("ScheduledTaskService.releaseFailedDelivery")(
      function* (deliveryId: string) {
        yield* releaseReplay(deliveryId);
        yield* store
          .write({ kind: "release_failed_relays", delivery_id: deliveryId }, AnyRows)
          .pipe(Effect.mapError(dedupeError));
      },
      (effect) => transactions.withTransaction(effect).pipe(Effect.mapError(dedupeError)),
    );

    const failReadyRelay = (deliveryId: string, reason: string) =>
      transactions.withTransaction(
        Effect.gen(function* () {
          const [ready] = yield* store.read(
            { kind: "pending", delivery_id: deliveryId, states: ["relay_ready"], first: true },
            PendingRows,
          );
          if (ready === undefined) return;
          yield* markDeliveryFailed(deliveryId, reason);
          yield* releaseFailedDelivery(deliveryId);
          yield* store.write({ kind: "delete_pending", delivery_id: deliveryId }, AnyRows);
        }),
      );

    const reconcileRunningRelay = Effect.fn("ScheduledTaskService.reconcileRunningRelay")(
      function* (
        entry: (typeof PendingRows.Type)[number],
        observedThreadId: ThreadId | null = null,
      ) {
        const taskId = ScheduledTaskId.make(entry.task_id);
        const deliveryId = entry.delivery_id;
        const attempted = yield* decodePendingTask(entry.task_json).pipe(Effect.option);
        const fireKey = webhookFireKey(taskId, deliveryId);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        let confirmed = observedThreadId;
        let rejected = false;
        // A bound send can be proven by its accepted command and durable message/run.
        // Fresh launches also need workspace preparation after their message receipt.
        if (
          confirmed === null &&
          Option.isSome(commandReceipts) &&
          Option.isSome(attempted) &&
          attempted.value.threadId !== null
        ) {
          const threadId = ThreadId.make(attempted.value.threadId);
          const receipt = yield* commandReceipts.value
            .getByCommandId(CommandId.make(`scheduled-task:${fireKey}`))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (
            Option.isSome(receipt) &&
            receipt.value.commandType === "message.dispatch" &&
            receipt.value.threadId === threadId
          ) {
            rejected = receipt.value.status === "rejected";
            if (!rejected) {
              const projection = yield* threadManagement
                .getThreadRecords(threadId, ["messages", "runs"], { messageIds: [messageId] })
                .pipe(Effect.option);
              if (Option.isSome(projection)) {
                const { messages, runs } = projection.value;
                const message = messages.find(
                  (message) => message.id === messageId && message.scheduledTaskId === taskId,
                );
                if (
                  message &&
                  runs.some((run) => run.id === message.runId && run.userMessageId === messageId)
                )
                  confirmed = threadId;
              }
            }
          }
        }
        const failure = rejected ? "The run failed to start." : RELAY_UNRESOLVED_ERROR;
        const now = yield* localNow;
        const startedAtIso = yield* transactions.withTransaction(
          Effect.gen(function* () {
            const [pending] = yield* store.read(
              { kind: "pending", delivery_id: deliveryId, states: ["relay_running"], first: true },
              PendingRows,
            );
            if (pending === undefined) return null;
            const [row] = yield* getRows(taskId);
            const ownsRun =
              row !== undefined &&
              row.last_run_webhook_delivery_id === deliveryId &&
              row.last_run_status === "running" &&
              (Option.isNone(attempted) || row.created_at === attempted.value.createdAt);
            if (ownsRun) {
              yield* patchTask(
                taskId,
                {
                  last_run_status: confirmed === null ? "failed" : "succeeded",
                  last_run_error: confirmed === null ? failure : null,
                  updated_at: iso(now),
                },
                {},
                {},
                rejected || confirmed !== null,
              );
            }
            if (rejected) {
              yield* markDeliveryFailed(deliveryId, failure);
              yield* releaseFailedDelivery(deliveryId);
              yield* store.write({ kind: "delete_pending", delivery_id: deliveryId }, AnyRows);
            } else if (confirmed === null) {
              yield* store.write(
                {
                  kind: "patch_pending",
                  delivery_id: deliveryId,
                  patch: { state: "relay_unresolved", task_json: "", request_json: "" },
                },
                AnyRows,
              );
              yield* markDeliveryFailed(deliveryId, RELAY_UNRESOLVED_ERROR);
            } else {
              yield* recordRelayReceipt(
                taskId,
                deliveryId.slice("delivery:relay:".length),
                deliveryId,
                now,
              );
              yield* store.write({ kind: "delete_pending", delivery_id: deliveryId }, AnyRows);
            }
            return ownsRun ? row.last_run_at : null;
          }),
        );
        yield* notifyChanged;
        if (confirmed !== null && startedAtIso !== null && Option.isSome(attempted)) {
          yield* recordRunFailure(
            attempted.value,
            startedAtIso,
            confirmed,
            messageId,
            deliveryId,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record scheduled run outcome", { taskId, cause }),
            ),
            Effect.forkIn(serviceScope),
          );
        }
      },
    );

    const runWebhookDelivery = Effect.fn("ScheduledTaskService.runWebhookDelivery")(function* (
      task: ScheduledTask,
      deliveryId: string,
      prompt: string,
      immediateRelayId?: string,
      durableRelay = false,
    ) {
      const runOutcome = (outcome: "started" | "skipped" | "failed") =>
        Effect.all([
          Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
          Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
        ]);
      const dispatched = yield* Ref.make<ThreadId | null>(null);
      return yield* runTask(task, "webhook", {
        deliveryId,
        prompt,
        dispatched,
        ...(immediateRelayId === undefined ? {} : { immediateRelayId }),
        durableRelay,
      }).pipe(
        Effect.flatMap(({ dispatchFailed }) => {
          if (!dispatchFailed) return runOutcome("started").pipe(Effect.as(true));
          const failed = runOutcome("failed");
          return durableRelay
            ? failed.pipe(Effect.as(false))
            : failed.pipe(
                Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                Effect.andThen(releaseFailedDelivery(deliveryId)),
                Effect.as(true),
              );
        }),
        Effect.catchTags({
          WebhookDeliverySkipped: (skipped) =>
            runOutcome("skipped").pipe(
              Effect.andThen(
                durableRelay
                  ? failReadyRelay(deliveryId, skipped.reason)
                  : markDeliveryFailed(deliveryId, skipped.reason).pipe(
                      Effect.andThen(releaseFailedDelivery(deliveryId)),
                    ),
              ),
              Effect.as(true),
            ),
        }),
        // Dispatch success owns the replay key even if later bookkeeping fails.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const observedThreadId = yield* Ref.get(dispatched);
            const started = observedThreadId !== null;
            if (durableRelay && Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
            yield* Effect.logWarning(
              "Webhook dispatch failed",
              durableRelay ? { taskId: task.id, deliveryId } : { taskId: task.id, cause },
            );
            yield* runOutcome(started ? "started" : "failed");
            if (durableRelay) {
              if (observedThreadId === null) return false;
              const [running] = yield* store.read(
                {
                  kind: "pending",
                  delivery_id: deliveryId,
                  states: ["relay_running"],
                  first: true,
                },
                PendingRows,
              );
              if (running !== undefined) yield* reconcileRunningRelay(running, observedThreadId);
              return true;
            }
            yield* markDeliveryFailed(
              deliveryId,
              started
                ? "The run started, but completion could not be recorded."
                : "The run failed to start.",
            );
            if (!started) {
              yield* transactions
                .withTransaction(
                  Effect.gen(function* () {
                    const counted = yield* store.write(
                      {
                        kind: "patch_pending",
                        delivery_id: deliveryId,
                        states: ["running"],
                        patch: { state: "failed" },
                      },
                      AnyRows,
                    );
                    if (counted.length > 0)
                      yield* patchTask(task.id, {}, { created_at: task.createdAt }, {}, true);
                  }),
                )
                .pipe(Effect.mapError(dedupeError));
              yield* releaseFailedDelivery(deliveryId);
            }
            // Pending windows retry the same command id to finish bookkeeping.
            return !started;
          }),
        ),
      );
    });

    // Delivery attributes belong to the enclosing triggerWebhook span.
    const observeDelivery = Effect.fnUntraced(function* (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.webhook.outcome": outcome,
        "scheduled_task.webhook.source": source,
      });
      yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
      if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
        const heldMs = Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
        );
        yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
        yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
      }
    });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        // Accepted deliveries may have queued a coalescing window.
        Effect.ensuring(pendingWebhooks.invalidate),
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    // triggerWebhook owns the operation span and its task-id annotation.
    const triggerWebhookUnobserved = Effect.fnUntraced(function* (request: WebhookTriggerRequest) {
      // Refused before any lookup or log, so a blocked hook neither runs nor records a delivery.
      if (webhookPolicyBlock !== undefined) {
        return yield* observeDelivery(request, "blocked_by_policy", undefined, undefined).pipe(
          Effect.as({ _tag: "blocked_by_policy" as const }),
        );
      }
      const taskId = decodeTaskId(request.hookId);
      const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
        Effect.as({ _tag: "not_found" as const }),
      );
      if (Option.isNone(taskId)) return yield* notFound;
      const rows = yield* getRows(taskId.value).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
        ),
      );
      const row = rows[0];
      // A wrong token is indistinguishable from an unknown hook, so the URL
      // does not reveal which hooks exist.
      if (
        row === undefined ||
        row.webhook_token === null ||
        !(yield* constantTimeEquals(request.token, row.webhook_token).pipe(
          Effect.provideService(Digest.Digest, digest),
        ))
      ) {
        return yield* notFound;
      }
      const task = yield* decodeRow(row);
      yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
      const schedule = task.schedule;
      if (schedule.type !== "webhook") return yield* notFound;

      const now = yield* localNow;
      // Anyone can reach the tunnel directly and set the relay's header, so
      // a receive time is never later than now: a future one would pin the
      // delivery in the log and slip past the task's max age.
      const receivedAt =
        request.receivedAt === undefined
          ? now
          : DateTime.min(
              Option.getOrElse(DateTime.make(request.receivedAt), () => now),
              now,
            );
      const observe = (outcome: WebhookDeliveryOutcome) =>
        observeDelivery(request, outcome, receivedAt, now);
      const deliveryId = ScheduledTaskWebhookDeliveryId.make(
        request.relayDeliveryId === undefined
          ? `delivery:${yield* random
              .uuidV4()
              .pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
          : `delivery:relay:${request.relayDeliveryId}`,
      );
      const relayId = request.relayDeliveryId;
      const durableRelay = relayId !== undefined && store.durableRelayWebhooks === true;
      const receipt = (ownerId: string = deliveryId) =>
        relayId === undefined ? Effect.void : recordRelayReceipt(task.id, relayId, ownerId, now);
      const releaseClaim = <A>(result: A) =>
        relayId === undefined
          ? Effect.succeed(result)
          : store
              .write({ kind: "delete_relay", relay_delivery_id: relayId }, AnyRows)
              .pipe(Effect.mapError(dedupeError), Effect.as(result));
      const queueKey = `${task.id}\u0000${task.createdAt}`;
      let queueReserved = false;
      const release = Effect.suspend(() => {
        if (!queueReserved) return Effect.void;
        queueReserved = false;
        return Ref.update(webhookQueued, (counts) => {
          const next = new Map(counts);
          const count = (next.get(queueKey) ?? 1) - 1;
          if (count <= 0) next.delete(queueKey);
          else next.set(queueKey, count);
          return next;
        });
      });
      const handoffKey = `${task.id}\u0000${deliveryId}`;
      let handoff: Deferred.Deferred<boolean> | undefined;
      const clearHandoff = Effect.suspend(() =>
        handoff === undefined
          ? Effect.void
          : Ref.update(immediateRelayHandoffs, (handoffs) => {
              if (handoffs.get(handoffKey) !== handoff) return handoffs;
              const next = new Map(handoffs);
              next.delete(handoffKey);
              return next;
            }),
      );

      const admitDelivery = Effect.fnUntraced(
        function* () {
          if (relayId !== undefined) {
            if (durableRelay) {
              const [current] = yield* getRows(task.id).pipe(Effect.mapError(dedupeError));
              if (
                current?.created_at !== task.createdAt ||
                current.webhook_token !== row.webhook_token
              ) {
                return yield* notFound;
              }
            }
            const claimed = yield* store
              .write(
                {
                  kind: "claim_relay",
                  relay_delivery_id: relayId,
                  task_id: task.id,
                  seen_at: iso(now),
                },
                RelayIds,
              )
              .pipe(
                Effect.mapError((cause) =>
                  taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
                ),
              );
            if (claimed.length === 0) {
              const receipts = yield* store
                .read(
                  {
                    kind: "has_replay",
                    task_id: task.id,
                    replay_key: relayReceiptKey(relayId),
                    now: DateTime.toEpochMillis(now),
                  },
                  AnyRows,
                )
                .pipe(Effect.mapError(dedupeError));
              if (receipts.length > 0) {
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              if (durableRelay) {
                const ready = yield* store
                  .read(
                    {
                      kind: "pending",
                      task_id: task.id,
                      delivery_id: deliveryId,
                      states: ["relay_ready"],
                      first: true,
                    },
                    PendingRows,
                  )
                  .pipe(Effect.mapError(dedupeError));
                if (ready.length > 0)
                  return { _tag: "start_pending" as const, outcome: "duplicate" as const };
              }
              return {
                _tag: "claimed" as const,
                handoff: (yield* Ref.get(immediateRelayHandoffs)).get(handoffKey),
              };
            }
            yield* store
              .write(
                {
                  kind: "prune_relays",
                  before: iso(DateTime.subtract(now, { hours: RELAY_CLAIM_RETENTION_HOURS })),
                },
                AnyRows,
              )
              .pipe(Effect.mapError(dedupeError));
          }
          const log = (
            outcome: ScheduledTaskWebhookDeliveryOutcome,
            details: {
              readonly signatureVerified?: boolean;
              readonly missing?: ReadonlyArray<string>;
              readonly renderedPrompt?: string;
              readonly error?: string;
            } = {},
          ) =>
            recordDelivery({
              id: deliveryId,
              taskId: task.id,
              receivedAt: iso(receivedAt),
              request,
              outcome,
              signatureVerified: details.signatureVerified ?? false,
              missing: details.missing ?? [],
              renderedPrompt: details.renderedPrompt ?? null,
              ...(details.error === undefined ? {} : { error: details.error }),
            });

          // Reject floods before signature work or rejection-log writes; valid
          // deliveries give this reservation back once validation succeeds.
          const rejectionReservation = { at: DateTime.toEpochMillis(now) };
          const rejectionSlot = yield* takeRateSlot(
            task.id,
            DateTime.toEpochMillis(now),
            webhookRejectedRateWindows,
            rejectionReservation,
          );
          if (rejectionSlot !== "allowed") {
            if (rejectionSlot === "first_rejected") yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          if (!task.enabled) {
            yield* log("disabled");
            yield* receipt();
            yield* observe("disabled");
            return { _tag: "disabled" as const };
          }
          const signature = schedule.signature;
          if (signature !== null) {
            const verified =
              row.webhook_secret !== null &&
              (yield* verifyWebhookSignature({
                signature,
                secret: row.webhook_secret,
                headers: request.headers,
                body: request.body,
              }).pipe(Effect.provideService(Mac.Mac, mac)));
            if (!verified) {
              yield* log("rejected_signature");
              yield* receipt();
              yield* observe("rejected_signature");
              return { _tag: "rejected_signature" as const };
            }
          }
          const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
          if (
            maxAgeMinutes !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
              maxAgeMinutes * 60_000
          ) {
            yield* log("expired", { signatureVerified: signature !== null });
            yield* receipt();
            yield* observe("expired");
            return { _tag: "expired" as const };
          }

          const refundRejectionSlot = Ref.update(webhookRejectedRateWindows, (windows) => {
            const current = windows.get(task.id);
            if (current === undefined) return windows;
            return new Map(windows).set(task.id, {
              ...current,
              accepted: current.accepted.filter((entry) => entry !== rejectionReservation),
            });
          });

          const failedFilter = findFailedWebhookFilter(schedule.filters ?? [], request);
          if (failedFilter !== null) {
            if (yield* takeFilteredLogSlot(task.id, DateTime.toEpochMillis(now))) {
              yield* log("filtered", {
                signatureVerified: signature !== null,
                error: describeFailedWebhookFilter(failedFilter),
              });
            }
            yield* refundRejectionSlot;
            yield* observe("filtered");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "filtered" as const,
            });
          }

          const runWindow = (yield* Ref.get(webhookRateWindows)).get(task.id);
          if (
            schedule.dedupe === undefined &&
            (runWindow?.accepted.filter((entry) => DateTime.toEpochMillis(now) - entry.at < 60_000)
              .length ?? 0) >= WEBHOOK_RATE_LIMIT_PER_MINUTE
          ) {
            if ((yield* takeRateSlot(task.id, DateTime.toEpochMillis(now))) === "first_rejected")
              yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          const reserve = takeRateSlot(task.id, DateTime.toEpochMillis(now)).pipe(
            Effect.flatMap((slot) => (slot === "allowed" ? Effect.void : Effect.fail(slot))),
          );
          const checkCapacity = Effect.gen(function* () {
            const [row] = yield* store.read({ kind: "pending_count", task_id: task.id }, CountRows);
            if (
              (row?.count ?? 0) + ((yield* Ref.get(webhookQueued)).get(queueKey) ?? 0) >=
              WEBHOOK_MAX_QUEUED_PER_TASK
            )
              return yield* Effect.fail("queue_full" as const);
          }).pipe(
            Effect.mapError((cause) => (cause === "queue_full" ? cause : dedupeError(cause))),
          );
          const admit = <A, E>(effect: Effect.Effect<A, E>) =>
            transactions.withTransaction(effect).pipe(
              Effect.catch((cause) =>
                cause === "first_rejected" || cause === "rejected" || cause === "queue_full"
                  ? Effect.succeed({
                      outcome:
                        cause === "queue_full"
                          ? ("queue_full" as const)
                          : ("rate_limited" as const),
                      log: cause === "first_rejected",
                    })
                  : Effect.fail(isScheduledTaskError(cause) ? cause : dedupeError(cause)),
              ),
            );
          const deduped =
            schedule.dedupe === undefined
              ? "run"
              : yield* admit(
                  Effect.gen(function* () {
                    const outcome = yield* acceptWebhookDedupe(
                      task,
                      request,
                      deliveryId,
                      DateTime.toEpochMillis(now),
                      reserve,
                      takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)),
                      checkCapacity,
                      (ownerId) =>
                        replaceDeliveryRequest(ownerId, request).pipe(
                          Effect.andThen(receipt(ownerId)),
                        ),
                    ).pipe(Effect.provideService(ScheduledRows, store));
                    if (
                      outcome === "pending" ||
                      outcome === "coalesced" ||
                      (outcome === "duplicate" &&
                        (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now))))
                    )
                      yield* log(outcome === "pending" ? "accepted" : outcome, {
                        signatureVerified: signature !== null,
                      });
                    return outcome;
                  }),
                );
          if (typeof deduped !== "string") {
            yield* refundRejectionSlot;
            if (deduped.log) yield* log("rate_limited");
            yield* observe(deduped.outcome);
            return yield* releaseClaim({ _tag: "rate_limited", outcome: deduped.outcome } as const);
          }
          if (deduped !== "run") {
            if (deduped !== "coalesced" && deduped !== "coalesced_unlogged")
              yield* refundRejectionSlot;
            const outcome =
              deduped === "pending"
                ? "accepted"
                : deduped === "coalesced_unlogged"
                  ? "coalesced"
                  : deduped;
            yield* observe(outcome);
            if (deduped === "duplicate")
              return yield* releaseClaim({ _tag: "accepted", deliveryId, outcome } as const);
            if (deduped === "pending") yield* receipt();
            return { _tag: "accepted", deliveryId, outcome } as const;
          }
          const frameId = yield* random.randomBytes(6).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
            Effect.mapError((cause) => taskError("Could not generate frame id.", { cause })),
          );
          const rendered = renderWebhookPrompt(task.prompt, request, frameId);
          // Providers trim the prompt before checking, so whitespace around
          // it is free.
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* log("dispatch_failed", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              error: PROMPT_TOO_LONG,
            });
            yield* releaseReplay(deliveryId);
            yield* observe("prompt_too_long");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "prompt_too_long" as const,
            });
          }
          // Bound the deliveries one task holds, so steady traffic to a stuck
          // task cannot pile up parked fibers.
          yield* refundRejectionSlot;
          // Serialize immediate reservations with persisted window admission.
          const reserveImmediate = Effect.gen(function* () {
            yield* checkCapacity;
            yield* reserve;
            if (durableRelay) return;
            yield* Ref.update(webhookQueued, (counts) =>
              new Map(counts).set(queueKey, (counts.get(queueKey) ?? 0) + 1),
            );
            queueReserved = true;
          });
          const admitted = yield* admit(
            Effect.gen(function* () {
              const outcome = yield* acceptImmediateWebhookDedupe(
                task,
                request,
                deliveryId,
                DateTime.toEpochMillis(now),
                reserveImmediate,
              ).pipe(Effect.provideService(ScheduledRows, store));
              if (outcome === "duplicate") {
                if (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)))
                  yield* log("duplicate", { signatureVerified: signature !== null });
              } else {
                if (durableRelay)
                  yield* store.write(
                    {
                      kind: "insert_ready_relay",
                      delivery_id: deliveryId,
                      task_id: task.id,
                      due_at: DateTime.toEpochMillis(now),
                      task_json: yield* encodePendingTask(task),
                      prompt_json: yield* encodeRelayPrompt(rendered.prompt),
                    },
                    AnyRows,
                  );
                yield* log("accepted", {
                  signatureVerified: signature !== null,
                  missing: rendered.missing,
                  renderedPrompt: rendered.prompt,
                });
              }
              return outcome;
            }),
          ).pipe(Effect.onError(() => release));
          if (typeof admitted !== "string") {
            yield* release;
            if (admitted.log) yield* log("rate_limited");
            yield* observe(admitted.outcome);
            return yield* releaseClaim({
              _tag: "rate_limited",
              outcome: admitted.outcome,
            } as const);
          }
          if (admitted === "duplicate") {
            yield* release;
            yield* observe("duplicate");
            return yield* releaseClaim({
              _tag: "accepted",
              deliveryId,
              outcome: "duplicate",
            } as const);
          }
          if (durableRelay) return { _tag: "start_pending" as const, outcome: "accepted" as const };
          if (relayId !== undefined) {
            handoff = yield* Deferred.make<boolean>();
            const current = handoff;
            yield* Ref.update(immediateRelayHandoffs, (handoffs) =>
              new Map(handoffs).set(handoffKey, current),
            );
          }
          return { _tag: "start_immediate" as const, prompt: rendered.prompt };
        },
        (effect) =>
          relayId === undefined
            ? effect
            : transactions
                .withTransaction(effect)
                .pipe(
                  Effect.mapError((cause) =>
                    isScheduledTaskError(cause) ? cause : dedupeError(cause),
                  ),
                ),
      );
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // The transaction settles the claim and admission before a retry can observe either.
          // Wait for an immediate handoff outside the transaction so its worker can write.
          const admission = yield* admitDelivery();
          if (admission._tag === "start_pending") {
            yield* dispatchPendingTask(task.id, true);
            yield* observe(admission.outcome);
            return { _tag: "accepted" as const, deliveryId, outcome: admission.outcome };
          }
          if (admission._tag === "claimed") {
            if (admission.handoff !== undefined && (yield* Deferred.await(admission.handoff))) {
              yield* observe("duplicate");
              return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
            }
            yield* observe("unresolved");
            return { _tag: "unresolved" as const, deliveryId };
          }
          if (admission._tag !== "start_immediate") return admission;
          const permit = yield* webhookPermit(task.id);
          yield* runWebhookDelivery(task, deliveryId, admission.prompt, relayId).pipe(
            permit.withPermits(1),
            Effect.ensuring(Effect.andThen(release, clearHandoff)),
            Effect.forkIn(serviceScope),
          );
          if (handoff !== undefined) yield* Deferred.succeed(handoff, true);
          yield* observe("accepted");
          return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              if (handoff !== undefined) yield* Deferred.succeed(handoff, false);
              yield* clearHandoff;
              yield* release;
              if (relayId === undefined) yield* releaseReplay(deliveryId).pipe(Effect.ignore);
            }),
          ),
        ),
      );
    });

    const dispatchPendingTask = (
      taskId: ScheduledTaskId,
      wakeCurrent = false,
    ): Effect.Effect<void> => {
      // One worker per task waits on its permit, then drains persisted rows in order.
      // Other tasks remain independent and ticks never reload an active task's payloads.
      const dispatch = Effect.gen(function* () {
        while (true) {
          const [entry] = yield* store.read(
            {
              kind: "pending",
              task_id: taskId,
              states: [
                "dispatching",
                "running",
                "completed",
                "failed",
                "relay_ready",
                "relay_running",
              ],
              first: true,
            },
            PendingRows,
          );
          if (entry === undefined) return;
          if (entry.state === "relay_running") {
            yield* reconcileRunningRelay(entry);
            continue;
          }
          if (entry.state === "relay_ready") {
            const payload = yield* Effect.all({
              task: decodePendingTask(entry.task_json),
              prompt: decodeRelayPrompt(entry.request_json),
            }).pipe(Effect.option);
            if (Option.isNone(payload)) {
              yield* failReadyRelay(
                entry.delivery_id,
                "The pending webhook payload could not be prepared.",
              );
              continue;
            }
            if (
              yield* runWebhookDelivery(
                payload.value.task,
                entry.delivery_id,
                payload.value.prompt,
                entry.delivery_id.slice("delivery:relay:".length),
                true,
              )
            )
              continue;
            const [running] = yield* store.read(
              {
                kind: "pending",
                delivery_id: entry.delivery_id,
                states: ["relay_running"],
                first: true,
              },
              PendingRows,
            );
            if (running === undefined) return;
            yield* reconcileRunningRelay(running);
            continue;
          }
          const remove = store.write(
            { kind: "delete_pending", delivery_id: entry.delivery_id },
            AnyRows,
          );
          if (entry.state === "completed" || entry.state === "failed") {
            if (entry.state === "failed") {
              yield* markDeliveryFailed(entry.delivery_id, "The run failed to start.");
              yield* releaseFailedDelivery(entry.delivery_id);
            }
            yield* remove;
            continue;
          }
          const prepared = yield* Effect.gen(function* () {
            // A running row was already sent, so recovery keeps the prompt it was sent with.
            const current = entry.state === "dispatching" ? yield* findTask(taskId) : null;
            const snapshot = yield* decodePendingTask(entry.task_json);
            // The snapshot keeps the identity runTask checks; the prompt is the one saved now.
            const task =
              current?.createdAt === snapshot.createdAt && current.prompt !== snapshot.prompt
                ? { ...snapshot, prompt: current.prompt }
                : snapshot;
            const request = yield* decodePendingRequest(entry.request_json);
            const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
            return {
              task,
              taskJson: task === snapshot ? null : yield* encodePendingTask(task),
              rendered: renderWebhookPrompt(task.prompt, request, frameId),
            };
          }).pipe(Effect.exit);
          if (Exit.isFailure(prepared)) {
            if (Cause.hasInterruptsOnly(prepared.cause))
              return yield* Effect.failCause(prepared.cause);
            yield* markDeliveryFailed(
              entry.delivery_id,
              "The pending webhook payload could not be prepared.",
            );
            yield* releaseFailedDelivery(entry.delivery_id);
            yield* remove;
            continue;
          }
          const { task, taskJson, rendered } = prepared.value;
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* markDeliveryFailed(entry.delivery_id, PROMPT_TOO_LONG);
            yield* releaseFailedDelivery(entry.delivery_id);
          } else {
            if (taskJson !== null)
              yield* store.write(
                {
                  kind: "patch_pending",
                  delivery_id: entry.delivery_id,
                  patch: { task_json: taskJson },
                },
                AnyRows,
              );
            yield* store.write(
              {
                kind: "patch_delivery",
                delivery_id: entry.delivery_id,
                patch: {
                  outcome: "accepted",
                  error: null,
                  rendered_prompt: loggedWebhookPrompt(rendered.prompt),
                  missing_fields_json: encodeMissingFieldsJson(rendered.missing),
                },
              },
              AnyRows,
            );
            if (!(yield* runWebhookDelivery(task, entry.delivery_id, rendered.prompt))) return;
          }
          yield* remove;
        }
      });
      // A commit can arrive while the worker is finishing its final empty read.
      // Remember that wakeup so the exiting worker hands it off without waiting for a tick.
      return Effect.acquireUseRelease(
        Ref.modify(pendingInFlight, (active) =>
          active.has(taskId)
            ? ([false, wakeCurrent ? new Map(active).set(taskId, true) : active] as const)
            : ([true, new Map(active).set(taskId, false)] as const),
        ),
        (reserved) =>
          reserved
            ? webhookPermit(taskId).pipe(
                Effect.flatMap((permit) => dispatch.pipe(permit.withPermits(1))),
                Effect.catch((cause) =>
                  Effect.logWarning("Pending webhook dispatch failed", { cause }),
                ),
                Effect.withSpan("ScheduledTaskService.dispatchPendingWebhook", { root: true }),
              )
            : Effect.void,
        (reserved) =>
          reserved
            ? Ref.modify(pendingInFlight, (active) => {
                const next = new Map(active);
                next.delete(taskId);
                return [active.get(taskId) === true, next] as const;
              }).pipe(
                Effect.flatMap((wake) => (wake ? dispatchPendingTask(taskId, true) : Effect.void)),
              )
            : Effect.void,
      ).pipe(Effect.interruptible, Effect.forkIn(serviceScope), Effect.asVoid);
    };

    const dispatchPending = Effect.fn("ScheduledTaskService.dispatchPendingWebhooks")(function* () {
      const now = DateTime.toEpochMillis(yield* localNow);
      if (yield* pendingWebhooks.isIdle(now)) return;
      const readVersion = yield* pendingWebhooks.version;
      yield* store.write({ kind: "expire_pending", now }, AnyRows);
      const tasks = yield* store.read({ kind: "active_pending_tasks" }, TaskIds);
      // Workers can leave rows behind to retry, so keep polling while any are claimed.
      if (tasks.length === 0) {
        const [next] = yield* store.read({ kind: "next_pending" }, NextPendingRows);
        yield* pendingWebhooks.record(readVersion, next?.due_at ?? Infinity, now);
      }
      yield* Effect.forEach(
        tasks,
        ({ task_id }) => dispatchPendingTask(ScheduledTaskId.make(task_id)),
        {
          discard: true,
        },
      );
    });
    yield* scheduler.register("webhook-coalescing", dispatchPending());

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      deleteForThread,
      moveThreadTasks,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    });
  }),
);

/** Production retains its existing SQLite owner until whole-server cutover. */
export const layer = layerWithRows.pipe(
  Layer.provide(SqliteScheduledRows.layer),
  Layer.provide(sqliteTransactions),
);
