const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

module.exports = function withAndroidOutboxProof(config) {
  if (process.env.T3_ANDROID_OUTBOX_RUNTIME_PROOF !== "1") return config;
  if (process.env.APP_VARIANT !== "development") throw new Error("Outbox proof requires a development package");
  config = withGradleProperties(config, (next) => {
    next.modResults = next.modResults.filter((entry) => entry.key !== "t3OutboxRuntimeProof");
    next.modResults.push({ type: "property", key: "t3OutboxRuntimeProof", value: "true" });
    return next;
  });
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy") throw new Error("Outbox proof expects the Expo Groovy application");
    const marker = "// T3 installed outbox proof entry";
    if (next.modResults.contents.includes(marker)) throw new Error("Use a fresh generated Android project for the outbox proof");
    next.modResults.contents += `
${marker}
react {
    entryFile = file("../../outbox-runtime-proof.ts")
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
