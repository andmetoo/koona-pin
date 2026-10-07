#!/usr/bin/env bash
# Runs inside a bare distribution image (scripts/linux/deps-check.mjs): installs what deps.sh lists and
# Rust, then builds the app, so the instructions of doc/testing.md «Linux» are proven on each
# distribution of the contract. /src is the repository, read-only; /out gets the versions.
set -euo pipefail
bash /src/scripts/linux/deps.sh > /tmp/deps.log 2>&1 || { tail -n 40 /tmp/deps.log; exit 1; }
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
if ! command -v cargo > /dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION" > /dev/null
fi
mkdir -p /work
tar -C /src --exclude=./src-tauri/target -cf - src-tauri rust-toolchain.toml | tar -C /work -xf -
cd /work/src-tauri
. /etc/os-release
{
  echo "system: ${PRETTY_NAME}"
  echo "glibc: $(ldd --version | head -1)"
  echo "webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
  echo "rustc: $(rustc --version)"
} | tee "/out/${NAME_TAG}.txt"
cargo build --locked --bins 2>&1 | tail -n 5
ls -l target/debug/koonapin target/debug/koonapin-host
echo "build: ok" | tee -a "/out/${NAME_TAG}.txt"
