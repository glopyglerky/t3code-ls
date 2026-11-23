import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DeleteProviderSessionRuntimeInput,
  GetProviderSessionRuntimeInput,
  ProviderSessionRuntimeDbRowSchema,
  ProviderSessionRuntimeRawDbRowSchema,
  ProviderSessionRuntimeRepository,
  RecordImportedTranscriptRequestSchema,
  type RecoverImportedTranscriptInput,
  repositoryFromRows,
} from "./ProviderSessionRuntime.ts";
import { RedbClient } from "./RedbClient.ts";

const Written = Schema.Struct({ written: Schema.Literal(true) });
const Recovered = Schema.Struct({ recovered: Schema.Boolean });

export const make = Effect.gen(function* () {
  const client = yield* RedbClient;
  while (!(yield* client.prepareRuntimeState).prepared) yield* Effect.yieldNow;
  const upsert = (ignore: boolean) => (input: typeof ProviderSessionRuntimeDbRowSchema.Type) =>
    Schema.encodeEffect(ProviderSessionRuntimeDbRowSchema)(input).pipe(
      Effect.flatMap((runtime) =>
        client.request(
          "application_runtime_state_write",
          {
            request: { kind: "runtime_upsert", runtime, ignore },
          },
          Written,
        ),
      ),
      Effect.asVoid,
    );
  return repositoryFromRows({
    upsertRuntimeRow: upsert(false),
    insertRuntimeRow: upsert(true),
    recordImportedTranscriptRow: (input) =>
      Schema.encodeEffect(RecordImportedTranscriptRequestSchema)(input).pipe(
        Effect.flatMap(({ threadId, source }) =>
          client.request(
            "application_runtime_state_write",
            {
              request: { kind: "runtime_import", thread_id: threadId, source },
            },
            Written,
          ),
        ),
        Effect.asVoid,
      ),
    recoverImportedTranscriptRow: Effect.fn(function* ({
      runtime,
      source,
      projectId,
      messages,
    }: RecoverImportedTranscriptInput) {
      const encodedRuntime = yield* Schema.encodeEffect(ProviderSessionRuntimeDbRowSchema)(runtime);
      const encodedSource = yield* Schema.encodeEffect(RecordImportedTranscriptRequestSchema)({
        threadId: runtime.threadId,
        source,
      });
      // Hash JSON strings so recovery keeps the helper frame small without losing Unicode escapes.
      const witnesses = messages.map(({ role, text }) => ({
        role,
        text_sha256: createHash("sha256").update(JSON.stringify(text)).digest("hex"),
      }));
      const { recovered } = yield* client.request(
        "application_runtime_state_write",
        {
          request: {
            kind: "runtime_recover_import",
            runtime: encodedRuntime,
            source: encodedSource.source,
            project_id: projectId,
            messages: witnesses,
          },
        },
        Recovered,
      );
      return recovered;
    }),
    getRuntimeRowByThreadId: (input) =>
      Schema.encodeEffect(GetProviderSessionRuntimeInput)(input).pipe(
        Effect.flatMap(({ threadId }) =>
          client.request(
            "application_runtime_state_read",
            {
              request: { kind: "runtime_get", thread_id: threadId },
            },
            Schema.NullOr(ProviderSessionRuntimeRawDbRowSchema),
          ),
        ),
        Effect.map((row) => (row === null ? Option.none() : Option.some(row))),
      ),
    listRuntimeRows: ({ excludeStopped }) =>
      client.request(
        "application_runtime_state_read",
        {
          request: { kind: "runtime_list", exclude_stopped: excludeStopped },
        },
        Schema.Array(ProviderSessionRuntimeRawDbRowSchema),
      ),
    deleteRuntimeByThreadId: (input) =>
      Schema.encodeEffect(DeleteProviderSessionRuntimeInput)(input).pipe(
        Effect.flatMap(({ threadId }) =>
          client.request(
            "application_runtime_state_write",
            {
              request: { kind: "runtime_delete", thread_id: threadId },
            },
            Written,
          ),
        ),
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(ProviderSessionRuntimeRepository, make);
