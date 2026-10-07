#!/usr/bin/env bash
# Root part of a job of .github/workflows/linux.yml: the packages of deps.sh and what the jobs need
# besides them (git, X11 and Wayland servers without a display, a session bus), Rust from rust-toolchain.toml, Node
# from .nvmrc, and the user «dev» who owns the checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
# tzdata and others would ask questions; a job has no one to answer.
export DEBIAN_FRONTEND=noninteractive
# Docker without an IPv6 route: apt picks the IPv6 addresses of archive.ubuntu.com and fails to connect.
# Recommended packages are hundreds of megabytes the build does not need.
if command -v apt-get > /dev/null; then
  printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
fi
# archive.ubuntu.com is slow from the owner's network (0.7 MB/s, 20 minutes of packages), and
# mirrors.ubuntu.com offers nothing else for Serbia; de.archive.ubuntu.com gives 17 MB/s. apt takes the
# list in order and moves on when a mirror fails: UBUNTU_MIRROR first if set (act --env UBUNTU_MIRROR=…).
if [ "$(. /etc/os-release; echo "$ID")" = ubuntu ]; then
  printf '%s\n' ${UBUNTU_MIRROR:-} http://de.archive.ubuntu.com/ubuntu/ http://archive.ubuntu.com/ubuntu/ > /etc/apt/koona-mirrors.txt
  sed -i 's|http://archive.ubuntu.com/ubuntu/\?|mirror+file:/etc/apt/koona-mirrors.txt|' /etc/apt/sources.list.d/ubuntu.sources
fi
bash scripts/linux/deps.sh
. /etc/os-release
case "$ID" in
  ubuntu | debian) apt-get install -y --no-install-recommends git xz-utils xvfb xauth dbus weston ca-certificates ;;
  fedora) dnf install -y git xz xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon weston ;;
  arch) pacman -S --needed --noconfirm git xz xorg-server-xvfb xorg-xauth dbus weston ;;
  opensuse-tumbleweed) zypper --non-interactive install git xz xorg-x11-server-Xvfb xauth dbus-1 weston tar gzip shadow util-linux ;;
esac

export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
rust=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy --default-toolchain "$rust" > /dev/null
node=$(tr -d 'v \n' < .nvmrc)
mkdir -p /opt/node
curl -sSf "https://nodejs.org/dist/v$node/node-v$node-linux-x64.tar.xz" | tar -xJ -C /opt/node --strip-components 1

id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev
chown -R dev /opt/cargo /opt/rustup "$PWD"
