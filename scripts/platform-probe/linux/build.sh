#!/usr/bin/env bash
# Runs inside the build image: the repository is mounted read-only at /src,
# the frontend is already built (dist), the binary lands in /out.
set -euo pipefail
mkdir -p /work /out
# tauri-build writes schemas next to the sources: build from a copy.
rm -rf /work/src-tauri /work/dist /work/app-icon.svg
cp -r /src/src-tauri /work/src-tauri
cp -r /src/dist /work/dist
rm -rf /work/src-tauri/target
cd /work/src-tauri
export CARGO_TARGET_DIR=/target
{
  echo "glibc: $(ldd --version | head -1)"
  echo "webkit2gtk-4.1 (build): $(pkg-config --modversion webkit2gtk-4.1)"
  echo "rustc: $(rustc --version)"
} | tee /out/build-info.txt
start=$(date +%s)
cargo build --release --features custom-protocol --locked 2>&1 | tail -n 30 | tee /out/build.log
echo "build seconds: $(( $(date +%s) - start ))" | tee -a /out/build-info.txt
cp /target/release/koonapin /target/release/koonapin-host /out/
ls -l /out
