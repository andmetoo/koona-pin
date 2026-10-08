#!/usr/bin/env bash
# Root part of a job of .github/workflows/linux.yml: the packages of deps.sh and what the jobs need
# besides them (git, X11 and Wayland servers without a display, a session bus), Rust from rust-toolchain.toml, Bun
# from .bun-version (bun.sh), and the user «dev» who owns the checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
# tzdata and others would ask questions; a job has no one to answer.
export DEBIAN_FRONTEND=noninteractive
# Docker without an IPv6 route: apt picks the IPv6 addresses of archive.ubuntu.com and fails to connect.
# Recommended packages are hundreds of megabytes the build does not need.
if command -v apt-get > /dev/null; then
  printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
  # Downloaded packages stay in the cache volume, one folder per release and job (two jobs on one release
  # run at once, and apt locks its folder): the next run downloads nothing. The images' docker-clean only
  # empties the default folder.
  if [ -d /var/cache/koona-ci ]; then
    archives=/var/cache/koona-ci/apt/$(. /etc/os-release; echo "$ID-$VERSION_ID")-${GITHUB_JOB:-job}
    mkdir -p "$archives/partial"
    printf 'Dir::Cache::Archives "%s/";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' "$archives" >> /etc/apt/apt.conf.d/99koona-ci
  fi
fi
bash scripts/linux/deps.sh
. /etc/os-release
case "$ID" in
  ubuntu | debian) apt-get install -y --no-install-recommends git xz-utils unzip xvfb xauth dbus weston ca-certificates ;;
  fedora) dnf install -y git xz unzip xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon weston ;;
  arch) pacman -S --needed --noconfirm git xz unzip xorg-server-xvfb xorg-xauth dbus weston ;;
esac

export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
rust=$(tr -d '\r' < rust-toolchain.toml | sed -n 's/^channel *= *"\(.*\)"/\1/p')
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$rust" > /dev/null
bash scripts/linux/bun.sh

# The «check» job (Debian) runs Playwright UI: Chromium's system libraries (root only) at the version in
# bun.lock, and CJK fonts for the language tests (Р-51).
if [ "${GITHUB_JOB:-}" = check ]; then
  playwright=$(sed -n 's/^ *"playwright": \["playwright@\([0-9.]*\)".*/\1/p' bun.lock)
  bunx --bun "playwright@$playwright" install-deps chromium > /dev/null
  apt-get install -y -qq fonts-noto-cjk > /dev/null
  # The development registration is checked with the distribution's browsers (NP-100, smoke-registration.mjs).
  apt-get install -y -qq chromium firefox-esr gpg > /dev/null
  # Google Chrome and Microsoft Edge from their makers' repositories: they find the package's manifests
  # through the links in /etc/opt/chrome and /etc/opt/edge (NP-055).
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main" \
    > /etc/apt/sources.list.d/microsoft-edge.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable microsoft-edge-stable > /dev/null
fi
# The «build» job packs .deb and .rpm and checks them (bun run build:linux, NP-055).
if [ "${GITHUB_JOB:-}" = build ]; then
  apt-get install -y -qq rpm lintian desktop-file-utils appstream > /dev/null
fi

id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev
# The caches of linux.yml are restored as root before this script.
mkdir -p /home/dev/.bun/install/cache
chown -R dev /opt/cargo /opt/rustup /home/dev/.bun "$PWD"
