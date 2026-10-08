#!/usr/bin/env bash
# Root part of a «distro» job of .github/workflows/linux.yml: X11 and Wayland servers without a display,
# xprop and xwininfo to read the window (NP-053), and a session bus. WebKitGTK and the tray library come with
# the package on Ubuntu, Debian and Fedora (ci-package.sh, NP-055); Arch, which runs the bare binary, gets
# them here. No compilers. Node only for the artifact action under act (GitHub brings its own), and the user
# «dev».
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID" in
  ubuntu | debian)
    printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
    apt-get update -qq
    apt-get install -y -qq xvfb xauth x11-utils dbus weston curl xz-utils ca-certificates > /dev/null
    ;;
  fedora)
    # libatomic: Node needs it (the artifact action under act); WebKitGTK used to bring it. Fedora's Chromium
    # and Firefox check the installed .rpm (ci-browsers.sh, NP-055).
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xprop xwininfo dbus-daemon weston xz libatomic \
      chromium firefox
    ;;
  arch)
    pacman -Sy --needed --noconfirm webkit2gtk-4.1 libayatana-appindicator \
      xorg-server-xvfb xorg-xauth xorg-xprop xorg-xwininfo dbus weston xz > /dev/null
    ;;
esac
# \r: a Windows checkout under act.
node=$(tr -d 'v \r\n' < .nvmrc)
mkdir -p /opt/node
curl -sSf "https://nodejs.org/dist/v$node/node-v$node-linux-x64.tar.xz" | tar -xJ -C /opt/node --strip-components 1
ln -sf /opt/node/bin/node /usr/local/bin/node
id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev
chown -R dev "$PWD"
