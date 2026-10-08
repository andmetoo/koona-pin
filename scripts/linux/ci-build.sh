#!/usr/bin/env bash
# The «build» job of .github/workflows/linux.yml, as «dev»: the release binary, once, on the oldest glibc
# of the matrix (Debian 13), as Tauri advises for Linux. The «distro» jobs run this very binary.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/node/bin:$PATH
echo "glibc: $(ldd --version | head -1), webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
npm ci --no-audit --no-fund
npm run build
(cd src-tauri && cargo build --release --features custom-protocol --locked)
mkdir -p dist-linux
cp src-tauri/target/release/koonapin src-tauri/target/release/koonapin-host dist-linux/
ls -l dist-linux
