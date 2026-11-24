# Mobile outbox delivery policy

The Expo outbox can use the Rust delivery policy when the native build includes the library. The TypeScript policy serves older builds. Both routes keep the existing permission checks, persistence, and command identities.

Use the workspace lockfile and set `CARGO_TARGET_DIR` to the assigned build directory outside the checkout. Build the library separately for the architectures the app packages.

## iOS

Build a static library with each admitted SDK target. This example packages arm64 device and simulator slices. Add the x86_64 simulator slice to the simulator library with `lipo` for Intel builds.

```sh
mobile_controls=apps/mobile/modules/t3-native-controls
export CARGO_PROFILE_RELEASE_LTO=false
export RUSTFLAGS="-Cembed-bitcode=no"
for rust_target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo rustc --locked --release -p t3-code-ls-mobile-outbox \
    --target "$rust_target" --crate-type staticlib
done
xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libt3_outbox.a" \
  -headers "$mobile_controls/rust/include" \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libt3_outbox.a" \
  -headers "$mobile_controls/rust/include" \
  -output "$mobile_controls/ios/T3Outbox.xcframework"
```

Generate or reinstall the app pods after staging the framework.

## Android

Build a shared library with the configured NDK linker for each app ABI. For example, with the NDK arm64 linker set in `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`:

```sh
mobile_controls=apps/mobile/modules/t3-native-controls
cargo rustc --locked --release -p t3-code-ls-mobile-outbox \
  --target aarch64-linux-android --crate-type cdylib
install -Dm644 "$CARGO_TARGET_DIR/aarch64-linux-android/release/libt3_outbox.so" \
  "$mobile_controls/android/src/main/jniLibs/arm64-v8a/libt3_outbox.so"
```

Run the mobile build with the staged libraries. Remove generated libraries from the workspace after retaining the required package and evidence. iOS and Android process-restart and secure-storage qualification require app runs on their respective targets.

## Installed Android policy proof

The `Client recovery` workflow accepts
`candidate/t3code-ls-t12-outbox-runtime-*` for an isolated x64 Android runtime
proof. The existing ARM library and structural-package lanes are unchanged.
The baseline structural APK run `45126478250` at
`3a4f96b244513c3a8a68f09bfaf0547aff41a9e3` checked an ARM64 library and DEX
class; it did not launch the app.

Admission happens before compilation. The hosted fixture requires Linux x64,
read/write KVM access, the installed Android emulator/ADB/AVD tools and the exact
`system-images;android-36;google_apis;x86_64` package. It records installed image
metadata and tool versions, then boots and stops a disposable AVD. Missing tools,
permissions, image or boot readiness fail at the first named checkpoint. The
fixture does not install SDK packages, change host permissions or attach to a
pre-existing device. Both admission and execution run inside loopback-only network
namespaces. No Metro, application server, account or external provider is used.

`T3_ANDROID_OUTBOX_RUNTIME_PROOF=1` enables an explicit Expo config plugin for a
development package. It selects `outbox-runtime-proof.ts` instead of `App.tsx`,
embeds its JavaScript in a release APK and signs only this proof package with the
generated debug signing configuration. Release-mode execution avoids the
Expo development launcher and Metro dependency. The module's Gradle proof flag
exposes a bounded, synthetic result recorder; ordinary builds do not expose it.
The entry uses the real Expo module and production selector with
`requireNative: true`, comparing all 64 native fact cells against the retained
TypeScript policy and checking invalid inputs. Kotlin returns native JNI results
or the existing unavailable sentinel, so strict selection cannot pass by silently
falling back to TypeScript.

The hosted lane builds matching `x86_64-linux-android` JNI with the existing
Android Rust 1.99.1 pin, then builds a second APK without that library. Installed
positive execution must report all 64 cells and pass; the missing-library package
must report unavailable at strict selection. Each install is on the fixture's own
fresh emulator. APK membership, source/tree, policy inputs, APK hashes and runtime
receipts are retained. The exact positive APK is retained separately for three
days. The fixture bounds boot, command and receipt waits, emulator memory/cores
and logs, stops its emulator/ADB, and removes its AVD. Generated Gradle/Cargo roots
and staged libraries are removed after package copies are checkpointed.

This first slice proves installed JavaScript-to-Expo-to-Kotlin-to-Rust execution
only when the hosted gate passes. Outbox JSON persistence remains in TypeScript.
Normal mobile navigation, cached offline screen, process restart, reconnect and
one converged send remain the next J53 app proof. The CI entry deliberately does
not load normal app services and cannot supply that acceptance evidence. Android
ARM runtime, iOS runtime and performance remain separate qualification work.
Stock T3 `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` remains the product denominator;
method SHA-256 is
`5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`.
No Rust source, dependency or policy semantics change in this slice.
