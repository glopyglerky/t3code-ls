import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HookInboxStore from "../../src/hooks/HookInboxStore.ts";
import { commitHold } from "../../src/hooks/HookInboxTransaction.ts";

const PROTOCOL = "t3-relay-inbox-workerd-v1";
const BASE_TIME = Date.UTC(2035, 0, 1);

export class InboxProbe {
  constructor(ctx) {
    this.ctx = ctx;
    this.bootId = crypto.randomUUID();
    this.alarmRuns = 0;
    this.layer = SqliteClient.layer({ storage: ctx.storage });
    ctx.blockConcurrencyWhile(() => Effect.runPromise(
      HookInboxStore.migrate.pipe(Effect.provide(this.layer)),
    ));
  }

  async inspect() {
    return {
      held: this.ctx.storage.sql.exec(`SELECT seq,id,received_at,method,raw_hook_id,
        raw_token,hook_key,query,headers,hex(body) AS body FROM held_hooks ORDER BY seq`).toArray(),
      target: this.ctx.storage.sql.exec("SELECT * FROM held_hooks_target ORDER BY id").toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/inspect") {
      return Response.json({ protocol: PROTOCOL, bootId: this.bootId, alarmRuns: this.alarmRuns,
        state: await this.inspect() });
    }
    if (url.pathname !== "/hold" || request.method !== "POST") return new Response(null, { status: 404 });
    const { id, target, offset, failAt } = await request.json();
    if (!/^(?:first|second|third)$/.test(id) || ![0, -60000, -120000].includes(offset) ||
      !["none", "state", "alarm"].includes(failAt) ||
      !/^https:\/\/(?:first|second|third)\.invalid\/$/.test(target)) {
      return new Response(null, { status: 400 });
    }
    const now = BASE_TIME + offset;
    const hook = {
      id, receivedAt: new Date(now).toISOString(), method: "POST", rawHookId: "synthetic%2Fhook",
      rawToken: "synthetic%2Ftoken", hookKey: "synthetic/hook", query: "fixture=1",
      headers: { "content-type": "application/octet-stream", "x-fixture": "synthetic" },
      body: new Uint8Array([0, 255, 10]),
    };
    let staged;
    const storage = {
      transaction: this.ctx.storage.transaction.bind(this.ctx.storage),
      getAlarm: this.ctx.storage.getAlarm.bind(this.ctx.storage),
      setAlarm: async (at) => {
        await this.ctx.storage.setAlarm(at);
        if (failAt === "alarm") {
          staged = await this.inspect();
          throw new Error("injected-after-alarm");
        }
      },
    };
    const operation = Effect.gen(function* () {
      const liveClock = yield* Clock.Clock;
      const fixedClock = Object.create(liveClock, {
        currentTimeMillisUnsafe: { value: () => now },
        currentTimeMillis: { value: Effect.succeed(now) },
        currentTimeNanosUnsafe: { value: () => BigInt(now) * 1000000n },
        currentTimeNanos: { value: Effect.succeed(BigInt(now) * 1000000n) },
      });
      return yield* commitHold(storage, HookInboxStore.hold(hook, target).pipe(
        Effect.tap(() => failAt === "state" ? Effect.promise(async () => {
          staged = await this.inspect();
          throw new Error("injected-after-state");
        }) : Effect.void),
      ), {
        get: () => Effect.promise(() => storage.getAlarm()),
        set: (at) => Effect.promise(() => storage.setAlarm(at)),
      }).pipe(Effect.provideService(Clock.Clock, fixedClock));
    }.bind(this)).pipe(Effect.provide(this.layer));
    let accepted;
    try {
      accepted = await Effect.runPromise(operation);
    } catch (error) {
      if (!String(error).includes(`injected-after-${failAt}`)) throw error;
      return Response.json({ protocol: PROTOCOL, accepted: false, fault: failAt,
        staged, state: await this.inspect() }, { status: 409 });
    }
    await this.ctx.storage.sync();
    return Response.json({ protocol: PROTOCOL, accepted, state: await this.inspect() });
  }

  alarm() {
    this.alarmRuns++;
    throw new Error("The fixture clock must keep alarms in the future");
  }
}

export default {
  fetch(request, env) {
    return env.INBOX.get(env.INBOX.idFromName("synthetic-inbox")).fetch(request);
  },
};
