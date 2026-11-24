import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { fetchLatestRelease, RELEASES_URL } from "../src/lib/releases.ts";

const api = "https://api.github.com/repos/pingdotgg/t3code/releases";
const tag = "v42.0.0";
const asset = {
  name: "fixture-arm64.dmg",
  browser_download_url: `${RELEASES_URL}/download/${tag}/fixture-arm64.dmg`,
};
const stable = {
  tag_name: tag,
  html_url: `${RELEASES_URL}/tag/${tag}`,
  published_at: "2026-01-01T00:00:00Z",
  assets: [asset],
};

function withStorage(t: TestContext, getStorage: () => unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: getStorage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
}

test("denied browser storage still allows a valid release refresh", async (t) => {
  withStorage(t, () => { throw new Error("Storage denied"); });
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(stable));

  assert.deepEqual(await fetchLatestRelease(), stable);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0]?.arguments[0], `${api}/latest`);
});

test("malformed cache and a failed cache write preserve the valid nightly result", async (t) => {
  const nightly = {
    ...stable,
    tag_name: "v43.0.0-nightly.1",
    html_url: `${RELEASES_URL}/tag/v43.0.0-nightly.1`,
    assets: [{
      ...asset,
      browser_download_url: `${RELEASES_URL}/download/v43.0.0-nightly.1/${asset.name}`,
    }],
  };
  const writes: string[] = [];
  withStorage(t, () => ({
    getItem: () => "{",
    setItem(key: string) {
      writes.push(key);
      throw new Error("Quota exceeded");
    },
  }));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json([
    null,
    stable,
    { ...nightly, draft: true },
    { ...nightly, published_at: "invalid" },
    nightly,
  ]));

  assert.deepEqual(await fetchLatestRelease("nightly"), nightly);
  assert.deepEqual(writes, ["t3code-nightly-release"]);
  assert.equal(fetch.mock.calls[0]?.arguments[0], `${api}?per_page=10`);
});

test("refresh only admits assets for the returned release and keeps a clean cache", async (t) => {
  const records = new Map<string, string>();
  withStorage(t, () => ({ getItem: records.get.bind(records), setItem: records.set.bind(records) }));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    ...stable,
    html_url: "https://fixture.invalid/other",
    assets: [
      { ...asset, browser_download_url: "https://fixture.invalid/wrong" },
      { ...asset, browser_download_url: `${RELEASES_URL}/download/v1.0.0/${asset.name}` },
      null,
      asset,
    ],
  }));

  assert.deepEqual(await fetchLatestRelease(), stable);
  assert.deepEqual(await fetchLatestRelease(), stable);
  assert.equal(fetch.mock.callCount(), 1);
});

test("an unavailable release surfaces the static fallback without changing the cache", async (t) => {
  const writes: string[] = [];
  withStorage(t, () => ({ getItem: () => null, setItem: (key: string) => writes.push(key) }));
  t.mock.method(globalThis, "fetch", async () => Response.json(stable, { status: 503 }));

  await assert.rejects(fetchLatestRelease(), /GitHub API responded 503/u);
  assert.deepEqual(writes, []);
});
