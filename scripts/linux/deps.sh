#!/usr/bin/env bash
# System packages for building and running Koona Pin from source on Ubuntu, Debian, Fedora, Arch and openSUSE
# (NP-093, doc/testing.md «Linux»): the Tauri 2 prerequisites (v2.tauri.app/start/prerequisites,
# checked 7 October 2026). Node.js (.nvmrc) and Rust (rustup, rust-toolchain.toml) are not here.
#   bash scripts/linux/deps.sh
set -euo pipefail
sudo=""
[ "$(id -u)" -eq 0 ] || sudo="sudo"
. /etc/os-release
case "${ID}" in
  ubuntu | debian)
    $sudo apt-get update
    $sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    ;;
  fedora)
    $sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
      libappindicator-gtk3-devel librsvg2-devel libxdo-devel
    $sudo dnf group install -y c-development
    ;;
  arch)
    $sudo pacman -Syu --needed --noconfirm webkit2gtk-4.1 base-devel curl wget file openssl \
      appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
    ;;
  opensuse-tumbleweed)
    # By pkg-config name: the package names on the Tauri page are out of date for Tumbleweed.
    $sudo zypper --non-interactive install 'pkgconfig(webkit2gtk-4.1)' 'pkgconfig(openssl)' \
      'pkgconfig(librsvg-2.0)' 'pkgconfig(ayatana-appindicator3-0.1)' xdotool-devel curl wget file
    $sudo zypper --non-interactive install -t pattern devel_basis
    ;;
  *)
    echo "deps.sh: ${PRETTY_NAME:-$ID} is not in the Linux test matrix (Ubuntu, Debian, Fedora, Arch, openSUSE Tumbleweed)" >&2
    exit 1
    ;;
esac
