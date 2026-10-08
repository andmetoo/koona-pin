#!/usr/bin/env bash
# The «build» job of .github/workflows/linux.yml, as «dev»: the release build, once, on the oldest glibc of
# the matrix (Debian 13), as Tauri advises for Linux, packed as .deb and .rpm (npm run build:linux, NP-055).
# The «distro» jobs install these very packages; Arch runs the bare binary. KOONAPIN_FEEDBACK_URL comes from
# the job's secret.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/node/bin:$PATH
step() { printf '\n== %s\n' "$1"; }
echo "glibc: $(ldd --version | head -1), webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
npm ci --no-audit --no-fund
npm run build:linux

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
packages=release/publish/linux/$version
deb=$packages/koonapin_${version}_amd64.deb

# Debian's checks of what a package may contain. Warnings fail the job too: the ones that stay are
# explained in src-tauri/linux/lintian-overrides.
step "lintian"
lintian --fail-on error,warning --display-info --info "$deb"
echo "ok: lintian"
step "Menu entry and AppStream"
tree=$(mktemp -d)
dpkg-deb -x "$deb" "$tree"
desktop-file-validate "$tree/usr/share/applications/koonapin.desktop"
appstreamcli validate --no-net --explain "$tree/usr/share/metainfo/app.koona.pin.metainfo.xml"
echo "ok: desktop-file-validate, appstreamcli validate"

mkdir -p dist-linux
cp "$packages"/* src-tauri/target/release/koonapin src-tauri/target/release/koonapin-host dist-linux/
ls -l dist-linux

# The WebDriver server of the native tests on WebKitGTK (NP-095, Р-57), for the «distro» jobs, which have no
# compiler. A tool of the tests, not of the packages: its own artifact.
step "tauri-driver"
tools=$(mktemp -d)
cargo install tauri-driver --version 2.1.0 --locked --root "$tools" --quiet
mkdir -p dist-tools
cp "$tools/bin/tauri-driver" dist-tools/
echo "ok: tauri-driver 2.1.0 — dist-tools/tauri-driver"
