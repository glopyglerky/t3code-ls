import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import * as ConnectionStorage from "./storage";

const databaseName = "t3code:connection-runtime";
const fixtureStore = "unchanged-by-upgrade";
const fixtureKey = "fixture-key";
const fixtureValue = "saved on the older connection";

function result<A>(request: IDBRequest<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

it("reports a blocked database upgrade and retries after the older connection closes", async () => {
  await result(indexedDB.deleteDatabase(databaseName));
  const request = indexedDB.open(databaseName, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(fixtureStore).put(fixtureValue, fixtureKey);
  }, { once: true });
  const older = await result(request);
  const environmentId = EnvironmentId.make("blocked-open-fixture");
  const threadId = ThreadId.make("no-cached-thread");
  const loadThread = Effect.gen(function* () {
    const store = yield* Persistence.EnvironmentCacheStore;
    return yield* store.loadThread(environmentId, threadId);
  }).pipe(Effect.provide(ConnectionStorage.layer), Effect.timeout("2 seconds"));

  try {
    await expect(Effect.runPromise(loadThread)).rejects.toThrow(
      "An open connection in another tab is blocking the database upgrade",
    );
  } finally {
    older.close();
  }

  const beforeRetry = await result(indexedDB.open(databaseName));
  try {
    expect(beforeRetry.version).toBe(1);
  } finally {
    beforeRetry.close();
  }

  expect(Option.isNone(await Effect.runPromise(loadThread))).toBe(true);
  const reopened = await result(indexedDB.open(databaseName));
  try {
    expect(reopened.version).toBeGreaterThan(1);
    expect(await result(reopened.transaction(fixtureStore).objectStore(fixtureStore).get(fixtureKey)))
      .toBe(fixtureValue);
  } finally {
    reopened.close();
  }
  await result(indexedDB.deleteDatabase(databaseName));
});
