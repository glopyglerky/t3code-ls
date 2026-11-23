// Local-only bindings: real Workerd SQLite behind the D1 interface and a synthetic R2 bucket.
// This fixture deliberately makes no claim about Cloudflare D1/R2 service semantics.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cache from "../../src/Cache.ts";
import * as Admission from "../../src/Admission.ts";
import * as Savings from "../../src/Savings.ts";

export class InboxProbe {
  constructor(state) {
    this.state = state;
    this.objects = new Map();
    const prepare = (sql, args = []) => {
      const execute = () => {
        const results = [...state.storage.sql.exec(sql, ...args)];
        const changes = [...state.storage.sql.exec("SELECT changes() AS n")][0].n;
        return { results, success: true, meta: { changes } };
      };
      return { bind: (...values) => prepare(sql, values),
        all: async () => execute(), run: async () => execute(), execute };
    };
    this.database = { prepare, batch: async (statements) =>
      state.storage.transactionSync(() => statements.map(statement => statement.execute())) };
    const artifacts = {
      put: async (key, bytes) => {
        this.objects.set(key, new Uint8Array(bytes).slice());
        return { key };
      },
      get: async (key) => {
        const bytes = this.objects.get(key);
        return bytes === undefined ? null : { size: bytes.length,
          body: new Response(bytes.slice()).body };
      },
    };
    const bindings = { INDEX: this.database, ARTIFACTS: artifacts,
      developerKeys: JSON.stringify({ fixture: "5cc962b7c0dbb13470f449712067f6de0b1059ce8b6fa9d3f7234f3b708c0bea" }), readerKeys: "{}",
      readLimit: { limit: async () => ({ success: true }) },
      storeLimit: { limit: async () => ({ success: true }) } };
    this.runtime = Cache.layer.pipe(Layer.provide([
      Admission.layer, Layer.succeed(Cache.Bindings, bindings),
      Savings.layer.pipe(Layer.provide(Layer.succeed(Savings.Database, this.database))),
    ]));
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/setup") {
      // Execute complete migration text so trigger bodies are not split at semicolons.
      this.state.storage.sql.exec(await request.text());
      this.state.storage.sql.exec(`INSERT INTO scopes
        (scope_id, endpoint, repository, repository_id, repository_owner_id, branch)
        VALUES ('t3code','https://cache.example','fixture/cache','1','2','refs/heads/main')`);
      return Response.json({ protocol: "t3-relay-inbox-workerd-v1" });
    }
    if (path === "/fixture/refuse") {
      this.state.storage.sql.exec("UPDATE scopes SET writes_enabled = 0");
      return new Response(null, { status: 204 });
    }
    if (path === "/fixture/inspect") {
      return Response.json({ generations: [...this.state.storage.sql.exec(
        "SELECT generation_id, state, blob_id FROM generations ORDER BY rowid")],
        entries: [...this.state.storage.sql.exec("SELECT generation_id FROM entries")],
        objects: this.objects.size });
    }
    return Effect.runPromise(Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      return yield* cache.handle(request, { waitUntil: promise => this.state.waitUntil(promise) });
    }.bind(this)).pipe(Effect.provide(this.runtime)));
  }
}
export default {
  fetch(request, env) { return env.INBOX.get(env.INBOX.idFromName("fixture")).fetch(request); },
};
