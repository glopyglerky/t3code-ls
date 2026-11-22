import {
  IssueLinkedThreadsResult,
  IssueOperationError,
  IssueTrackerKind,
  threadIssueKeysEqual,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RedbClient } from "../persistence/RedbClient.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(IssueLinkedThreadsResult);

/** The threads an issue is linked to; the rows and filters `linkedThreads` uses for pull requests. */
export const listLinkedIssueThreads = Effect.fn("listLinkedIssueThreads")(
  function* (key: ThreadIssueKey) {
    const sql = yield* SqlClient.SqlClient;
    // The CASE stops SQLite hoisting the side-chat check out of the link loop,
    // where it would re-parse every thread's payload, not just matching ones.
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      settled: number;
      tracker: ThreadIssueKey["tracker"];
      host: string;
      scope: string;
      key: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt",
        (json_extract(t.payload_json, '$.settledAt') IS NOT NULL
          OR json_extract(t.payload_json, '$.settledOverride') IS 'settled') AS settled,
        json_extract(link.value, '$.tracker') AS tracker,
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.scope') AS scope,
        json_extract(link.value, '$.key') AS key,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.issues') AS link
      WHERE t.deleted_at IS NULL
        AND CASE WHEN json_extract(link.value, '$.key') = ${key.key.trim()}
          THEN json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
          ELSE 0
        END
      ORDER BY "updatedAt" DESC, id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const threads = rows
      .filter((row) => threadIssueKeysEqual(row, key))
      .map(({ id, projectId, title, archivedAt, settled }) => ({
        id,
        projectId,
        title,
        archivedAt,
        settled: settled === 1,
      }));
    return yield* decodeLinkedThreads({ threads });
  },
  Effect.mapError(
    (cause) =>
      new IssueOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);

export class LinkedIssueThreads extends Context.Service<
  LinkedIssueThreads,
  {
    readonly list: (
      key: ThreadIssueKey,
    ) => Effect.Effect<IssueLinkedThreadsResult, IssueOperationError>;
  }
>()("t3/issue/linkedThreads/LinkedIssueThreads") {}

export const layerSqlite = Layer.effect(
  LinkedIssueThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return LinkedIssueThreads.of({
      list: Effect.fn("LinkedIssueThreads.list")((key) =>
        listLinkedIssueThreads(key).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    });
  }),
);

const NativeLinkedIssueRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  settled: Schema.Number,
  tracker: IssueTrackerKind,
  host: Schema.String,
  scope: Schema.String,
  key: Schema.String,
});

export const layerNative = Layer.effect(
  LinkedIssueThreads,
  Effect.gen(function* () {
    const client = yield* RedbClient;
    while (!(yield* client.prepareProjectionReads).prepared) yield* Effect.yieldNow;
    return LinkedIssueThreads.of({
      list: Effect.fn("listLinkedIssueThreads")(
        function* (key) {
          const rows = yield* client.request(
            "application_projections_history",
            { query: { kind: "linked_issue_threads", key: key.key.trim() } },
            Schema.Array(NativeLinkedIssueRow),
          );
          return yield* decodeLinkedThreads({
            threads: rows
              .filter((row) => threadIssueKeysEqual(row, key))
              .map(({ id, projectId, title, archivedAt, settled }) => ({
                id,
                projectId,
                title,
                archivedAt,
                settled: settled === 1,
              })),
          });
        },
        Effect.mapError(
          (cause) =>
            new IssueOperationError({
              operation: "linkedThreads",
              detail: "Could not load linked threads.",
              cause,
            }),
        ),
      ),
    });
  }),
);
