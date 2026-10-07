#!/usr/bin/env bash
# The «check» job of .github/workflows/linux.yml, as «dev»: what `npm run check` does on Windows, the
# generated IPC types against the repository, clippy and the release build.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/node/bin:$PATH
step() { printf '\n== %s\n' "$1"; }

step "Environment"
echo "glibc: $(ldd --version | head -1)"
echo "webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
echo "rustc: $(rustc --version), node: $(node --version)"

step "npm ci"
npm ci --no-audit --no-fund

step "Rust tests"
(cd src-tauri && cargo test --locked)

# The tests regenerate src/bindings (ts-rs, NP-007): Linux must produce what Windows committed.
step "Generated IPC types match the repository"
git config --global --add safe.directory "$PWD"
git diff --exit-code --stat -- src/bindings

step "TypeScript, Vite build, Vitest"
npm run build
npm test

step "Clippy"
(cd src-tauri && cargo clippy --locked --all-targets)

step "Release build"
(cd src-tauri && cargo build --release --features custom-protocol --locked)
ls -l src-tauri/target/release/koonapin src-tauri/target/release/koonapin-host
