const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

module.exports = function withAndroidPreferencesProof(config) {
  if (process.env.T3_ANDROID_PREFERENCES_RUNTIME_PROOF !== "1") return config;
  if (process.env.APP_VARIANT !== "development") throw new Error("Preferences proof requires development");
  if (process.env.T3_ANDROID_OUTBOX_RUNTIME_PROOF === "1") throw new Error("Select one proof entry");
  if (config.android?.package !== "com.t3tools.t3code.dev") throw new Error("Unexpected proof base package");
  config.android.package = "com.t3tools.t3code.dev.preferencesproof";
  config.name = "T3 preferences proof";
  config.scheme = "t3code-preferences-proof";
  config.updates = { ...config.updates, enabled: false };
  config = withGradleProperties(config, (next) => {
    // Reuse only the bounded intent/receipt transport, never the outbox entry or its APK.
    next.modResults = next.modResults.filter((entry) => entry.key !== "t3OutboxRuntimeProof");
    next.modResults.push({ type: "property", key: "t3OutboxRuntimeProof", value: "true" });
    return next;
  });
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy") throw new Error("Preferences proof expects Groovy");
    if (next.modResults.contents.includes("// T3 installed outbox proof entry") ||
        next.modResults.contents.includes("// T3 installed preferences proof entry")) {
      throw new Error("Use a fresh generated Android project for preferences proof");
    }
    next.modResults.contents += `
// T3 installed preferences proof entry
react {
    entryFile = file("../../preferences-runtime-proof.ts")
    debuggableVariants = []
}
android {
    buildTypes {
        release { signingConfig signingConfigs.debug }
    }
}
`;
    return next;
  });
};
