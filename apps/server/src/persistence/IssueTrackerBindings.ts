import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { RedbClient } from "./RedbClient.ts";
import { TextCell, readRows, textCell } from "./NativeTableRows.ts";
import { IssueTrackerKind, IssueTrackerProjectBinding, ProjectId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const BindingRow = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  scope: Schema.String,
  additionalScopes: Schema.fromJsonString(Schema.Array(Schema.String)),
});

/**
 * Which standalone issue tracker scopes each project reads beside its git host's own issues. A
 * project is bound to one tracker at most, and only while it has a row.
 */
export class IssueTrackerBindingsRepository extends Context.Service<
  IssueTrackerBindingsRepository,
  {
    readonly list: (
      projectId?: ProjectId,
    ) => Effect.Effect<
      ReadonlyMap<ProjectId, IssueTrackerProjectBinding>,
      IssueTrackerBindingsRepositoryError
    >;
    /** Null unbinds. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly binding: IssueTrackerProjectBinding | null;
      /** When the binding was saved, as an ISO instant. */
      readonly updatedAt: string;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** Unbinds every project that pointed at the tracker, when its credential is removed. */
    readonly removeTracker: (
      tracker: IssueTrackerKind,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
  }
>()("t3/persistence/IssueTrackerBindings/IssueTrackerBindingsRepository") {}

const mapBindings = (rows: ReadonlyArray<typeof BindingRow.Type>) =>
  new Map(
    rows.map(
      ({ projectId, additionalScopes, ...binding }) =>
        [
          projectId,
          additionalScopes.length === 0 ? binding : { ...binding, additionalScopes },
        ] as const,
    ),
  );

const encodeAdditionalScopes = Schema.encodeEffect(BindingRow.fields.additionalScopes);

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): IssueTrackerBindingsRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const select = sql`
    SELECT project_id AS "projectId", tracker AS "tracker", scope AS "scope",
      additional_scopes AS "additionalScopes"
    FROM issue_tracker_bindings
  `;
  const listRows = SqlSchema.findAll({
    Request: Schema.UndefinedOr(ProjectId),
    Result: BindingRow,
    execute: (projectId) =>
      projectId === undefined ? select : sql`${select} WHERE project_id = ${projectId}`,
  });

  return IssueTrackerBindingsRepository.of({
    list: Effect.fn("IssueTrackerBindingsRepository.list")((projectId?: ProjectId) =>
      listRows(projectId).pipe(
        Effect.map(mapBindings),
        Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
      ),
    ),
    set: Effect.fn("IssueTrackerBindingsRepository.set")(
      function* (input) {
        if (input.binding === null) {
          yield* sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId}`;
          return;
        }
        const additionalScopes = yield* encodeAdditionalScopes(
          input.binding.additionalScopes ?? [],
        );
        yield* sql`
              INSERT INTO issue_tracker_bindings (project_id, tracker, scope, additional_scopes, updated_at)
              VALUES (
                ${input.projectId}, ${input.binding.tracker}, ${input.binding.scope},
                ${additionalScopes}, ${input.updatedAt}
              )
              ON CONFLICT (project_id)
              DO UPDATE SET tracker = excluded.tracker, scope = excluded.scope,
                additional_scopes = excluded.additional_scopes, updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(toSqlOrDecodeError("setIssueTrackerBinding", "IssueTrackerBinding")),
    ),
    removeTracker: Effect.fn("IssueTrackerBindingsRepository.removeTracker")(
      function* (tracker) {
        yield* sql`DELETE FROM issue_tracker_bindings WHERE tracker = ${tracker}`;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerBindings", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueTrackerBindingsRepository, make);

const decodeNativeRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    project_id: TextCell,
    tracker: TextCell,
    scope: TextCell,
    additional_scopes: TextCell,
    updated_at: TextCell,
  }),
);
const decodeBinding = Schema.decodeUnknownEffect(BindingRow);

const makeNative = Effect.gen(function* () {
  const client = yield* RedbClient;
  const table = "issue_tracker_bindings";

  return IssueTrackerBindingsRepository.of({
    list: Effect.fn("IssueTrackerBindingsRepository.list")(
      function* (projectId) {
        const rows = yield* projectId === undefined
          ? client.withReadTransaction(readRows(client, table))
          : client
              .get(table, [textCell(projectId)])
              .pipe(Effect.map((row) => (row === null ? [] : [row])));
        const bindings = yield* Effect.forEach(rows, (row) =>
          decodeNativeRow(row).pipe(
            Effect.flatMap((record) =>
              decodeBinding({
                projectId: record.project_id.value,
                tracker: record.tracker.value,
                scope: record.scope.value,
                additionalScopes: record.additional_scopes.value,
              }),
            ),
          ),
        );
        return mapBindings(bindings);
      },
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
    ),
    set: Effect.fn("IssueTrackerBindingsRepository.set")(
      function* ({ projectId, binding, updatedAt }) {
        const key = [textCell(projectId)];
        if (binding === null) {
          yield* client.delete(table, key);
          return;
        }
        const additionalScopes = yield* encodeAdditionalScopes(binding.additionalScopes ?? []);
        yield* client.put(table, key, {
          project_id: textCell(projectId),
          tracker: textCell(binding.tracker),
          scope: textCell(binding.scope),
          additional_scopes: textCell(additionalScopes),
          updated_at: textCell(updatedAt),
        });
      },
      Effect.mapError(toSqlOrDecodeError("setIssueTrackerBinding", "IssueTrackerBinding")),
    ),
    removeTracker: Effect.fn("IssueTrackerBindingsRepository.removeTracker")((tracker) =>
      client
        .withTransaction(
          Effect.gen(function* () {
            for (const row of yield* readRows(client, table)) {
              const record = yield* decodeNativeRow(row);
              if (record.tracker.value === tracker)
                yield* client.delete(table, [record.project_id]);
            }
          }),
        )
        .pipe(
          Effect.mapError(toSqlOrDecodeError("removeIssueTrackerBindings", "IssueTrackerBinding")),
        ),
    ),
  });
});

export const layerNative = Layer.effect(IssueTrackerBindingsRepository, makeNative);
