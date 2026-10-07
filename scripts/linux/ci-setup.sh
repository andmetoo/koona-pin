#!/usr/bin/env bash
# Root part of a job of .github/workflows/linux.yml: the packages of deps.sh and what the jobs need
# besides them (git, X11 and Wayland servers without a display, a session bus), Rust from rust-toolchain.toml, Node
# from .nvmrc, and the user «dev» who owns the checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
# tzdata and others would ask questions; a job has no one to answer.
export DEBIAN_FRONTEND=noninteractive
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
