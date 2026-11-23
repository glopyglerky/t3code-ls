const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "expo/config-plugins") return {
    withGradleProperties: (config, run) => { config.properties = run({ modResults: [] }).modResults; return config; },
    withAppBuildGradle: (config, run) => { config.gradle = run({ modResults: { language: "groovy", contents: config.input ?? "" } }).modResults.contents; return config; },
  };
  return originalLoad.call(this, name, ...args);
};
const plugin = require("./withAndroidPreferencesProof.cjs");
Module._load = originalLoad;
const keys = ["T3_ANDROID_PREFERENCES_RUNTIME_PROOF", "T3_ANDROID_OUTBOX_RUNTIME_PROOF", "APP_VARIANT"];
function env(values, run) {
  const previous = keys.map((key) => process.env[key]);
  try { for (const key of keys) { delete process.env[key]; } Object.assign(process.env, values); run(); }
  finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
}
const selected = { T3_ANDROID_PREFERENCES_RUNTIME_PROOF: "1", APP_VARIANT: "development" };
const config = () => ({ android: { package: "com.t3tools.t3code.dev" }, updates: { enabled: true } });
test("ordinary profile is unchanged", () => env({}, () => {
  const original = config(); assert.equal(plugin(original), original); assert.equal(original.android.package, "com.t3tools.t3code.dev");
}));
test("requires development, expected base, and exclusive selector", () => {
  env({ ...selected, APP_VARIANT: "production" }, () => assert.throws(() => plugin(config()), /development/));
  env(selected, () => assert.throws(() => plugin({ android: { package: "other" } }), /base package/));
  env({ ...selected, T3_ANDROID_OUTBOX_RUNTIME_PROOF: "1" }, () => assert.throws(() => plugin(config()), /one proof/));
});
test("selects separate package and bundled preference entry with OTA disabled", () => env(selected, () => {
  const result = plugin(config());
  assert.equal(result.android.package, "com.t3tools.t3code.dev.preferencesproof");
  assert.equal(result.scheme, "t3code-preferences-proof");
  assert.equal(result.updates.enabled, false);
  assert.match(result.gradle, /entryFile = file\("..\/..\/preferences-runtime-proof.ts"\)/);
  assert.match(result.gradle, /debuggableVariants = \[\]/);
  assert.deepEqual(result.properties, [{ type: "property", key: "t3OutboxRuntimeProof", value: "true" }]);
}));
test("rejects reused generated proof projects", () => env(selected, () => {
  for (const input of ["// T3 installed outbox proof entry", "// T3 installed preferences proof entry"]) {
    assert.throws(() => plugin({ ...config(), input }), /fresh generated/);
  }
}));
