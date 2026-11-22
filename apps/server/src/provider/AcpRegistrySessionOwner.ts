import {
  AcpRegistryOperationError,
  ThreadId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectionLookupResult } from "../orchestration-v2/ProjectionLookupRows.ts";
import { RedbClient } from "../persistence/RedbClient.ts";

export class AcpRegistrySessionOwner extends Context.Service<
  AcpRegistrySessionOwner,
  {
    readonly find: (input: {
      readonly driver: ProviderDriverKind;
      readonly instanceId: ProviderInstanceId;
      readonly sessionId: string;
    }) => Effect.Effect<ThreadId | null, AcpRegistryOperationError>;
  }
>()("t3/provider/AcpRegistrySessionOwner") {}

const ownerReadError = (cause: unknown) =>
  new AcpRegistryOperationError({
    reason: "session_import_failed",
    message: "Could not inspect ACP session ownership.",
    cause,
  });

export const layerSqlite = Layer.effect(
  AcpRegistrySessionOwner,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return AcpRegistrySessionOwner.of({
      find: Effect.fn("AcpRegistrySessionOwner.find")(({ driver, instanceId, sessionId }) =>
        sql<{ readonly thread_id: string }>`
        SELECT provider.thread_id
        FROM orchestration_v2_projection_provider_threads AS provider
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = provider.thread_id
        WHERE provider.driver = ${driver}
          AND provider.provider_instance_id = ${instanceId}
          AND json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
          AND thread.deleted_at IS NULL
        ORDER BY thread.updated_at DESC
        LIMIT 1
      `.pipe(
          Effect.map((rows) => (rows[0] ? ThreadId.make(rows[0].thread_id) : null)),
          Effect.mapError(ownerReadError),
        ),
      ),
    });
  }),
);

const OwnerResult = Schema.Struct({
  ...ProjectionLookupResult.fields,
  ids: Schema.Array(ThreadId),
});

export const layerNative = Layer.effect(
  AcpRegistrySessionOwner,
  Effect.gen(function* () {
    const client = yield* RedbClient;
    while (!(yield* client.prepareProjections).prepared) yield* Effect.yieldNow;
    return AcpRegistrySessionOwner.of({
      find: Effect.fn("AcpRegistrySessionOwner.find")(({ driver, instanceId, sessionId }) =>
        client
          .request(
            "application_projections_lookup",
            {
              query: {
                kind: "acp_session_owner",
                driver,
                instance_id: instanceId,
                session_id: sessionId,
              },
            },
            OwnerResult,
          )
          .pipe(
            Effect.map(({ ids }) => ids[0] ?? null),
            Effect.mapError(ownerReadError),
          ),
      ),
    });
  }),
);
