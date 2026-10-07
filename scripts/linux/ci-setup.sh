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
# Ubuntu: archive.ubuntu.com gave the owner's network 0.7 MB/s (20 minutes of packages), a nearby mirror
# 26 MB/s. fast-apt-mirror.sh measures the mirrors of the country and picks the fastest; no mirror is
# written in the repository, so every CI and every machine picks its own. It needs curl, which the base
# image lacks (one slow `apt-get update`), so the choice is kept for a day in /var/cache/koona-ci when a
# volume is mounted there (act does, .actrc). APT_MIRROR sets a mirror by hand. The script is pinned to a
# commit and its hash.
if [ "$(. /etc/os-release; echo "$ID")" = ubuntu ]; then
  cache=/var/cache/koona-ci/apt-mirror-ubuntu
  mirror=${APT_MIRROR:-}
  if [ -z "$mirror" ] && [ -n "$(find "$cache" -mmin -1440 2> /dev/null)" ]; then
    mirror=$(cat "$cache")
  fi
  if [ -n "$mirror" ]; then
    echo "apt mirror: $mirror"
    sed -i -E "s#http://(archive|security)\.ubuntu\.com/ubuntu/?#${mirror%/}/#" /etc/apt/sources.list.d/ubuntu.sources
  else
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates > /dev/null
    fam=/usr/local/bin/fast-apt-mirror.sh
    curl -fsSL -o "$fam" \
      https://raw.githubusercontent.com/vegardit/fast-apt-mirror.sh/806c59276adfff2df420124ad5e4587f018c358a/fast-apt-mirror.sh
    echo "c1e1b20304e2f2ecd4056deac352cd9fef237e530c2adc7d0ee2f7afbe06b12d  $fam" | sha256sum -c --quiet
    chmod 755 "$fam"
    if mirror=$("$fam" find --apply | tail -1) && [[ $mirror == http* ]]; then
      [ -d "${cache%/*}" ] && echo "$mirror" > "$cache"
    else
      echo "fast-apt-mirror.sh found nothing; the default mirror stays"
    fi
  fi
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
