import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LOCALES } from "../src/i18n/locales.ts";

const [dist, mode] = process.argv.slice(2);
assert.ok(dist && (mode === "catalog" || mode === "unavailable"), "Expected DIST catalog|unavailable");
const releases = "https://github.com/pingdotgg/t3code/releases";
const hasCatalog = mode === "catalog";
const stableDmg = `${releases}/download/v42.0.0/fixture-arm64.dmg`;
const stableDeb = `${releases}/download/v42.0.0/fixture-amd64.deb`;
const nightlyDmg = `${releases}/download/v43.0.0-nightly.1/fixture-arm64.dmg`;

function getAnchor(html, target) {
  const matching = [...html.matchAll(/<a\s+[^>]*>/gu)].filter(([tag]) =>
    tag.includes(`data-asset="${target}"`)
  );
  assert.equal(matching.length, 1, `Expected one link for ${target}`);
  return matching[0][0];
}

for (const locale of LOCALES) {
  const path = join(dist, locale.path, "download", "index.html");
  const html = readFileSync(path, "utf8");
  const repositoryLink = [...html.matchAll(/<a\s+[^>]*>/gu)].find(([tag]) => tag.includes('class="nav-stars"'));
  assert.ok(repositoryLink?.[0].includes('aria-label="GitHub"'), path);
  const dmg = getAnchor(html, "arm64.dmg");
  const deb = getAnchor(html, "amd64.deb");
  const exe = getAnchor(html, "x64.exe");
  assert.ok(dmg.includes(`href="${hasCatalog ? stableDmg : releases}"`), path);
  assert.ok(deb.includes(`href="${hasCatalog ? stableDeb : releases}"`), path);
  assert.ok(exe.includes(`href="${releases}"`), path);
  assert.equal(dmg.includes(`data-nightly-download="${nightlyDmg}"`), hasCatalog, path);
  assert.ok(!html.includes("https://fixture.invalid/wrong"), path);
  assert.equal(html.includes("fixture-arm64.dmg"), hasCatalog, path);
  console.log(`${createHash("sha256").update(html).digest("hex")}  ${path}`);
}
