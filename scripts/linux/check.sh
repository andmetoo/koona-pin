#!/usr/bin/env bash
# Runs inside the image of scripts/linux/Dockerfile (scripts/linux/check.mjs starts it). The repository
# is mounted read-only at /src; the copy in /work lives in a volume with its node_modules and Cargo
# target, so the next run is incremental. Without arguments: what `npm run check` does, then clippy and
# the release build, into /work/.out. With arguments: that command in /work after the copy (`bash`
# for a shell).
set -euo pipefail

# Windows-only folders and what builds, tests and tools leave (.gitignore) stay out of the copy;
# excluded paths in /work survive --delete, so node_modules and target are kept.
rsync -a --delete \
  --exclude=/.git/ --exclude=/.claude/ --exclude=/.cache/ --exclude=/.env \
  --exclude=/node_modules/ --exclude=/dist/ --exclude=/release/ \
  --exclude=/.test-data/ --exclude=/test-results/ --exclude=/playwright-report/ \
  --exclude=target/ --exclude=/scripts/platform-probe/mobile-app/src-tauri/gen/ --exclude=/.out/ \
  /src/ /work/
cd /work

# npm ci only when package-lock.json changed: Linux needs its own native packages (esbuild, rollup).
lock=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.package-lock.sha256 2>/dev/null)" != "$lock" ]; then
  npm ci --no-audit --no-fund
  echo "$lock" > node_modules/.package-lock.sha256
fi

if [ $# -gt 0 ]; then
  exec "$@"
fi

step() { printf '\n== %s\n' "$1"; }
# What check.mjs copies to release/test/linux: a Windows folder is not writable for this user.
rm -rf .out && mkdir .out

step "Environment"
{
  echo "glibc: $(ldd --version | head -1)"
  echo "webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
  echo "rustc: $(rustc --version)"
  echo "node: $(node --version)"
} | tee .out/environment.txt

step "Rust tests"
npm run precheck --silent
(cd src-tauri && cargo test --locked)

# The tests regenerate src/bindings (ts-rs, NP-007): Linux must produce what Windows committed.
step "Generated IPC types match the repository"
diff -r --strip-trailing-cr /src/src/bindings src/bindings

step "TypeScript, Vite build, Vitest"
npm run build
npm test

step "Clippy"
(cd src-tauri && cargo clippy --locked --all-targets)

step "Release build"
(cd src-tauri && cargo build --release --features custom-protocol --locked)
cp src-tauri/target/release/koonapin src-tauri/target/release/koonapin-host .out/
ls -l .out
