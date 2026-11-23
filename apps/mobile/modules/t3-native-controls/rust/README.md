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
