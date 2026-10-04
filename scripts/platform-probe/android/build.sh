#!/usr/bin/env bash
# Runs inside the Android image. /src is the repository (read-only), results
# go to /out: the probe APK and the log of checking the real app for Android.
set -uo pipefail
mkdir -p /out
exec > >(tee /out/android.log) 2>&1
echo "java: $(java -version 2>&1 | head -1)"
echo "ndk: $NDK_HOME"
echo "rustc: $(rustc --version)"

# 1. The probe app: does a Tauri app with SQLite, rustls and the opener build into an APK?
rm -rf /work/probe && cp -r /src/scripts/platform-probe/mobile-app /work/probe
cd /work/probe
export CARGO_TARGET_DIR=/target/probe
start=$(date +%s)
npx --yes @tauri-apps/cli@2.12.1 android init --ci
npx --yes @tauri-apps/cli@2.12.1 android build --ci --debug --apk --target aarch64
echo "probe build: exit $? after $(( $(date +%s) - start )) s"
find src-tauri/gen/android -name "*.apk" -exec cp {} /out/ \; -exec ls -l {} \;
# What the generated Android project is made of: a share target would live here.
find src-tauri/gen/android/app/src/main -maxdepth 4 -type f | sed 's|^| |' | head -n 30

# 2. The real app: what stops it from compiling for Android (desktop-only code).
rm -rf /work/app && cp -r /src/src-tauri /work/app && rm -rf /work/app/target
cd /work/app
bin=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
export CC_aarch64_linux_android=$bin/aarch64-linux-android24-clang
export AR_aarch64_linux_android=$bin/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$bin/aarch64-linux-android24-clang
export CARGO_TARGET_DIR=/target/app
cargo check --lib --target aarch64-linux-android 2> /out/app-check.log
echo "app check: exit $?"
echo "errors: $(grep -c '^error' /out/app-check.log)"
grep -E '^(error|warning: unused)' /out/app-check.log | sort | uniq -c | sort -rn | head -n 30
