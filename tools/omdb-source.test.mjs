import * as Assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Test from "node:test";

const root = new URL("../", import.meta.url);
const pin = JSON.parse(FS.readFileSync(new URL("database.lock.json", root), "utf8"));
const manifest = FS.readFileSync(new URL("crates/storage/Cargo.toml", root), "utf8");
const cargoLock = FS.readFileSync(new URL("Cargo.lock", root), "utf8");
const fixtureRevision = "efaf649fb270ce70257e53862295cc10e4bddab0";
const directRevision = "2fc790d14fb62f39137b13f7943df433bec082c2";

Test.test("storage pins the production fork and the opt-in comparison engine separately", () => {
  const revision = pin.sourceCommit;
  const repository = "https://github.com/glopyglerky/omdb";

  Assert.equal(pin.product, "omdb");
  Assert.match(revision, /^[a-f0-9]{40}$/);
  Assert.equal(pin.sourceUrl, `${repository}/tree/${revision}`);
  Assert.equal(pin.crate.name, "redb");
  Assert.equal(pin.crate.version, pin.version);
  Assert.equal(pin.crate.git, repository);
  Assert.equal(pin.crate.rev, revision);

  const dependency = manifest.match(/^redb\s*=\s*\{([^\n]+)\}/m);
  Assert.ok(dependency, "the native storage package must declare its omdb source");
  Assert.equal(dependency[1].match(/version\s*=\s*"=([^"]+)"/)?.[1], pin.version);
  Assert.ok(dependency[1].includes(`git = "${repository}"`));
  Assert.ok(dependency[1].includes(`rev = "${revision}"`));

  const fixture = manifest.match(/^redb-bench-compare\s*=\s*\{([^\n]+)\}/m)?.[1];
  Assert.ok(fixture?.includes(`git = "${repository}"`));
  Assert.ok(fixture.includes(`rev = "${fixtureRevision}"`));
  Assert.match(fixture, /\boptional\s*=\s*true\b/);
  Assert.match(fixture, /\bdefault-features\s*=\s*false\b/);
  Assert.match(manifest, /^ordered-engine-fixture\s*=\s*\["dep:redb-bench-compare"\]$/m);

  const entries = [...cargoLock.matchAll(/^\[\[package\]\]\nname = "redb"\nversion = "([^"]+)"\nsource = "([^"]+)"/gm)]
    .map(([, version, source]) => [version, source]).sort();
  Assert.deepEqual(entries, [
    [pin.version, `git+${repository}?rev=${revision}#${revision}`],
    ["5.0.0", `git+https://github.com/cberner/redb?rev=${directRevision}#${directRevision}`],
  ].sort());
});

Test.test("Cargo selects only omdb for default storage and adds the comparison engines on opt-in", {
  skip: process.env.T3_CODE_LS_VERIFY_OMDB_GRAPH !== "1",
}, () => {
  const toolchain = process.env.T3_CODE_LS_TOOLCHAIN;
  Assert.ok(toolchain && Path.isAbsolute(toolchain));
  const cargo = Path.join(toolchain, "bin", "cargo");
  const select = (options) => execFileSync(cargo, [
    "tree", "--locked", "-p", "t3-code-ls-storage", "--edges", "normal", "--prefix", "none", ...options,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 }).split("\n");
  const engines = (graph) => [...new Set(graph.filter((line) => /^redb v/u.test(line))
    .map((line) => line.replace(/ \(\*\)$/u, "")))];
  const production = select([]);
  Assert.equal(engines(production).length, 1);
  Assert.ok(engines(production)[0].includes(`?rev=${pin.sourceCommit}`));
  Assert.ok(!production.some((line) => /^(redb-bench-compare|fjall) v/u.test(line)));
  const fixture = select(["--features", "ordered-engine-fixture"]);
  Assert.equal(engines(fixture).length, 2);
  Assert.ok(engines(fixture).includes(engines(production)[0]));
  Assert.ok(engines(fixture).some((line) => line.includes(`?rev=${directRevision}`)));
  Assert.ok(fixture.some((line) => /^fjall v/u.test(line)));
});
