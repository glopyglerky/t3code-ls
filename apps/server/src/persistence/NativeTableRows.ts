import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RedbClientShape, Row, RowPage } from "./RedbClient.ts";

export const TextCell = Schema.Struct({ type: Schema.Literal("text"), value: Schema.String });
export const BitCell = Schema.Struct({
  type: Schema.Literal("integer"),
  value: Schema.Literals(["0", "1"]),
});

export const textCell = (value: string) => ({ type: "text", value }) as const;
export const bitCell = (value: boolean) => ({ type: "integer", value: value ? "1" : "0" }) as const;

/** Use inside one read snapshot or while holding the writer reservation. */
export const readRows = Effect.fnUntraced(function* (client: RedbClientShape, table: string) {
  const rows: Row[] = [];
  let after: string | null = null;
  do {
    const page: RowPage = yield* client.scan(table, { after, limit: 64 });
    for (const { row } of page.rows) rows.push(row);
    after = page.next;
  } while (after !== null);
  return rows;
});
