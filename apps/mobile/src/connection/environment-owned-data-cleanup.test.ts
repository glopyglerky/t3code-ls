import { EnvironmentId } from "@t3tools/contracts";
import { Persistence } from "@t3tools/client-runtime/platform";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { clearEnvironmentOwnedData } from "./environment-owned-data-cleanup";

const environmentId = EnvironmentId.make("fixture-removed-environment");

describe("mobile environment owned data cleanup", () => {
  it("waits for sibling cleanup and returns a typed durable deletion failure", async () => {
    let releaseDrafts!: () => void;
    const drafts = new Promise<void>((resolve) => { releaseDrafts = resolve; });
    const completed: string[] = [];
    let settled = false;
    const result = Effect.runPromiseExit(clearEnvironmentOwnedData(environmentId, {
      clearOutbox: async (id) => {
        expect(id).toBe(environmentId);
        throw new Error("fixture write refused");
      },
      clearDrafts: async () => {
        await drafts;
        completed.push("drafts");
      },
      clearErrors: () => { completed.push("errors"); },
    })).then((exit) => { settled = true; return exit; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDrafts();
    const exit = await result;
    expect(completed.sort()).toEqual(["drafts", "errors"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Persistence.ConnectionPersistenceError);
      expect(Cause.squash(exit.cause)).toMatchObject({
        operation: "clear-environment",
        message: "The environment was removed, but its queued messages could not be cleared from this device.",
      });
    }
  });

  it("attempts every owner when a synchronous cleanup throws", async () => {
    const completed: string[] = [];
    const result = await Effect.runPromiseExit(clearEnvironmentOwnedData(environmentId, {
      clearOutbox: async () => { completed.push("outbox"); },
      clearDrafts: async () => { completed.push("drafts"); },
      clearErrors: () => { throw new Error("fixture sync refusal"); },
    }));
    expect(completed.sort()).toEqual(["drafts", "outbox"]);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toBeInstanceOf(Persistence.ConnectionPersistenceError);
      expect(Cause.squash(result.cause)).toMatchObject({
        message: "The environment was removed, but its composer errors could not be cleared from this device.",
      });
    }
  });
});
