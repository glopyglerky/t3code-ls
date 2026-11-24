import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RedbClient } from "../persistence/RedbClient.ts";
import {
  ProjectionContextRowsError,
  TurnStartBatch,
  type ProjectionContextRows,
  type ProjectionContextQuery,
} from "./ProjectionContextRows.ts";

type NativeContextQuery =
  | ProjectionContextQuery
  | { readonly kind: "turn_start_batch"; readonly thread_id: string; readonly run_id: string };

export const make = Effect.gen(function* () {
  const client = yield* RedbClient;
  const environment = yield* HostProcess.Environment;
  while (!(yield* client.prepareProjections).prepared) yield* Effect.yieldNow;
  while (!(yield* client.prepareProjectionReads).prepared) yield* Effect.yieldNow;
  const read = Effect.fn("ProjectionContextRows.read")(
    <A>(query: NativeContextQuery, response: Schema.Decoder<A>) =>
      client
        .request("application_projections_context", { query }, response)
        .pipe(Effect.mapError((cause) => new ProjectionContextRowsError({ cause }))),
  );
  return {
    read,
    ...(environment.T3_CODE_LS_BATCH_TURN_START_CONTEXT === "1"
      ? {
          readTurnStartBatch: (threadId: string, runId: string) =>
            read(
              { kind: "turn_start_batch", thread_id: threadId, run_id: runId },
              Schema.NullOr(TurnStartBatch),
            ),
        }
      : {}),
    withReadTransaction: client.withReadTransaction,
  } satisfies ProjectionContextRows;
});
