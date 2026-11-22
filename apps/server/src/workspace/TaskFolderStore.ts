import { ProjectId, TaskFolder, TaskFolderError, TaskFolderRepository } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { RedbClient } from "../persistence/RedbClient.ts";
import { BitCell, TextCell, bitCell, readRows, textCell } from "../persistence/NativeTableRows.ts";

/**
 * The record of each task folder. Reads live here so the services that only need to know where a
 * thread works do not depend on Git; `TaskFolders` owns every change.
 */
export class TaskFolderStore extends Context.Service<
  TaskFolderStore,
  {
    /** The task folder that is, or contains, `target`. */
    readonly findContaining: (target: string) => Effect.Effect<TaskFolder | null, TaskFolderError>;
    readonly list: Effect.Effect<ReadonlyArray<TaskFolder>, TaskFolderError>;
    readonly put: (taskFolder: TaskFolder) => Effect.Effect<void, TaskFolderError>;
    readonly remove: (root: string) => Effect.Effect<void, TaskFolderError>;
  }
>()("t3/workspace/TaskFolderStore") {}

const TaskFolderRow = Schema.Struct({
  root: Schema.String,
  projectId: ProjectId,
  projectRoot: Schema.String,
  anchor: Schema.String,
  projectPath: Schema.String,
  projectIsWorktree: Schema.BooleanFromBit,
  repositories: Schema.fromJsonString(Schema.Array(TaskFolderRepository)),
});

const makePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // What Git and sandboxes resolve a path to: the nearest real ancestor plus what is missing.
  const realLocation = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  const ancestors = (target: string) => {
    const result = [target];
    for (let parent = path.dirname(target); parent !== result.at(-1); parent = path.dirname(parent))
      result.push(parent);
    return result;
  };

  return { path, realLocation, ancestors };
});

const failed = (cause: unknown) =>
  new TaskFolderError({ operation: "read", detail: "Could not read task folders.", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { path, realLocation, ancestors } = yield* makePaths;

  const selectColumns = sql`
    root,
    project_id AS "projectId",
    project_root AS "projectRoot",
    anchor,
    project_path AS "projectPath",
    project_is_worktree AS "projectIsWorktree",
    repositories_json AS "repositories"
  `;

  // Both spellings on both sides: a worktrees directory reached through a symlink is stored as
  // named and as resolved, and a caller may hold either.
  const findRows = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: TaskFolderRow,
    execute: (candidates) => sql`
      SELECT ${selectColumns} FROM task_folders
      WHERE ${sql.in("root", candidates)} OR ${sql.in("real_root", candidates)}
      ORDER BY length(root) DESC
      LIMIT 1
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskFolderRow,
    execute: () => sql`SELECT ${selectColumns} FROM task_folders ORDER BY root`,
  });

  const encodeRepositories = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(TaskFolderRepository)),
  );

  const findContaining: TaskFolderStore["Service"]["findContaining"] = Effect.fn(
    "TaskFolderStore.findContaining",
  )(function* (target) {
    if (!path.isAbsolute(target)) return null;
    const named = path.resolve(target);
    const candidates = [
      ...new Set([...ancestors(named), ...ancestors(yield* realLocation(named))]),
    ];
    const rows = yield* findRows(candidates).pipe(Effect.mapError(failed));
    return rows[0] ?? null;
  });

  const put: TaskFolderStore["Service"]["put"] = Effect.fn("TaskFolderStore.put")(function* (
    taskFolder,
  ) {
    const repositories = yield* encodeRepositories(taskFolder.repositories);
    const realRoot = yield* realLocation(taskFolder.root);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
        INSERT INTO task_folders (
          root, real_root, project_id, project_root, anchor, project_path,
          project_is_worktree, repositories_json, created_at
        ) VALUES (
          ${taskFolder.root}, ${realRoot}, ${taskFolder.projectId}, ${taskFolder.projectRoot},
          ${taskFolder.anchor}, ${taskFolder.projectPath},
          ${taskFolder.projectIsWorktree ? 1 : 0}, ${repositories}, ${createdAt}
        )
        ON CONFLICT (root) DO UPDATE SET
          real_root = excluded.real_root,
          project_path = excluded.project_path,
          project_is_worktree = excluded.project_is_worktree,
          repositories_json = excluded.repositories_json
      `;
  }, Effect.mapError(failed));

  return TaskFolderStore.of({
    findContaining,
    list: listRows(undefined).pipe(Effect.mapError(failed)),
    put,
    remove: Effect.fn("TaskFolderStore.remove")(function* (root) {
      yield* sql`DELETE FROM task_folders WHERE root = ${root}`.pipe(Effect.mapError(failed));
    }),
  });
});

export const layer = Layer.effect(TaskFolderStore, make);

const NativeTaskFolderRow = Schema.Struct({
  root: TextCell,
  real_root: TextCell,
  project_id: TextCell,
  project_root: TextCell,
  anchor: TextCell,
  project_path: TextCell,
  project_is_worktree: BitCell,
  repositories_json: TextCell,
  created_at: TextCell,
});
const decodeNativeRow = Schema.decodeUnknownEffect(NativeTaskFolderRow);
const decodeTaskFolder = Schema.decodeUnknownEffect(TaskFolderRow);

const makeNative = Effect.gen(function* () {
  const client = yield* RedbClient;
  const { path, realLocation, ancestors } = yield* makePaths;
  const table = "task_folders";
  while (!(yield* client.prepareTaskFolders).prepared) yield* Effect.yieldNow;
  const encodeRepositories = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(TaskFolderRepository)),
  );

  const decode = (row: typeof NativeTaskFolderRow.Type) =>
    decodeTaskFolder({
      root: row.root.value,
      projectId: row.project_id.value,
      projectRoot: row.project_root.value,
      anchor: row.anchor.value,
      projectPath: row.project_path.value,
      projectIsWorktree: Number(row.project_is_worktree.value),
      repositories: row.repositories_json.value,
    });

  const rows = client.withReadTransaction(
    readRows(client, table).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeNativeRow(row))),
    ),
  );
  return TaskFolderStore.of({
    list: rows.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.toSorted((a, b) =>
            Buffer.compare(Buffer.from(a.root.value), Buffer.from(b.root.value)),
          ),
          decode,
        ),
      ),
      Effect.mapError(failed),
    ),
    findContaining: Effect.fn("TaskFolderStore.findContaining")(function* (target) {
      if (!path.isAbsolute(target)) return null;
      const named = path.resolve(target);
      const candidates = [
        ...new Set([...ancestors(named), ...ancestors(yield* realLocation(named))]),
      ];
      const row = yield* client.request(
        "application_task_folders_find",
        { paths: candidates },
        Schema.NullOr(NativeTaskFolderRow),
      );
      return row === null ? null : yield* decode(row);
    }, Effect.mapError(failed)),
    put: Effect.fn("TaskFolderStore.put")(function* (folder) {
      const realRoot = yield* realLocation(folder.root);
      const repositories = yield* encodeRepositories(folder.repositories);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* client.request(
        "application_task_folders_upsert",
        {
          row: {
            root: textCell(folder.root),
            real_root: textCell(realRoot),
            project_id: textCell(folder.projectId),
            project_root: textCell(folder.projectRoot),
            anchor: textCell(folder.anchor),
            project_path: textCell(folder.projectPath),
            project_is_worktree: bitCell(folder.projectIsWorktree),
            repositories_json: textCell(repositories),
            created_at: textCell(now),
          },
        },
        Schema.Null,
      );
    }, Effect.mapError(failed)),
    remove: Effect.fn("TaskFolderStore.remove")((root) =>
      client
        .request("application_task_folders_delete", { root }, Schema.Null)
        .pipe(Effect.asVoid, Effect.mapError(failed)),
    ),
  });
});

export const layerNative = Layer.effect(TaskFolderStore, makeNative);
