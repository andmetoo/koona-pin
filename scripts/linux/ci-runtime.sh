#!/usr/bin/env bash
# Root part of a «distro» job of .github/workflows/linux.yml: X11 and Wayland servers without a display,
# xprop and xwininfo to read the window (NP-053), WebKitWebDriver for tests/webkit (NP-095), and a session bus. WebKitGTK and the tray library come with
# the package (ci-package.sh): the .deb on Ubuntu and Debian, the .rpm on Fedora (NP-055), koonapin-bin from
# the AUR's PKGBUILD on Arch (NP-101). No compilers but Arch's base-devel for makepkg. Node for
# scripts/build-aur.mjs and the artifact action under act (GitHub brings its own), and the user «dev».
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID" in
  ubuntu | debian)
    printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
    apt-get update -qq
    # webkitgtk-webdriver: WebKitWebDriver of the same WebKitGTK 4.1 as the package (NP-095).
    apt-get install -y -qq xvfb xauth x11-utils dbus weston curl xz-utils ca-certificates webkitgtk-webdriver > /dev/null
    ;;
  fedora)
    # libatomic: Node needs it (the artifact action under act); WebKitGTK used to bring it. Fedora's Chromium
    # and Firefox check the installed .rpm (ci-browsers.sh, NP-055). WebKitWebDriver ships only with the GTK 4
    # build, webkitgtk6.0, of the same WebKit release as the app's webkit2gtk4.1 (NP-095).
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xprop xwininfo dbus-daemon weston xz libatomic \
      chromium firefox webkitgtk6.0
    ;;
  arch)
    # base-devel and namcap build and check koonapin-bin, whose depends bring WebKitGTK and the tray
    # (ci-package.sh, NP-101); Arch's Chromium and Firefox check the installed package (ci-browsers.sh).
    # WebKitWebDriver, as on Fedora, from the GTK 4 build webkitgtk-6.0 (NP-095).
    pacman -Syu --needed --noconfirm base-devel namcap chromium firefox webkitgtk-6.0 \
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
