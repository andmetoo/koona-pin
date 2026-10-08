#!/usr/bin/env bash
# The «webkitgtk» job of .github/workflows/linux.yml (NP-098): the interface in the distribution's own
# WebKitGTK over WebDriver (scripts/webkitgtk-check.mjs) — key screens of every language in both themes and
# cut labels (the preview in MiniBrowser), the system theme and «reduce motion» from GTK and GNOME settings
# (Koona Pin itself, the binary of the «build» job). No speed measures in the matrix: the scroll is measured
# by hand (doc/testing.md «Замер прокрутки»).
#   ci-webkitgtk.sh setup    as root: WebKitWebDriver and MiniBrowser, fonts, X11, Wayland, dconf, the
#                            settings portal, Node, user «dev»
#   ci-webkitgtk.sh          as «dev»: npm ci, then the check under X11 (Xvfb) and under Wayland (Weston)
set -euo pipefail
cd "$(dirname "$0")/../.."
. /etc/os-release
app=$PWD/dist-linux/koonapin

if [ "${1:-}" = setup ]; then
  export DEBIAN_FRONTEND=noninteractive
  printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
  apt-get update -qq
  # WebKitWebDriver: webkit2gtk-driver in Debian, webkitgtk-webdriver in Ubuntu 26.04.
  driver=webkit2gtk-driver
  apt-cache madison "$driver" | grep -q . || driver=webkitgtk-webdriver
  # Noto Sans CJK and the colour emoji: what a desktop install of Ubuntu and Debian has; the package of
  # Koona Pin only recommends the CJK font (Р-45, п. 12). dconf, gsettings and the settings portal: where
  # GNOME's dark style and «reduce animation» come from — without the portal the dark style does not reach
  # WebKitGTK, and a GNOME desktop always runs one.
  apt-get install -y -qq "$driver" libwebkit2gtk-4.1-0 libayatana-appindicator3-1 xvfb xauth dbus \
    weston fonts-noto-cjk fonts-noto-color-emoji fontconfig dconf-service libglib2.0-bin \
    gsettings-desktop-schemas xdg-desktop-portal xdg-desktop-portal-gtk curl xz-utils ca-certificates > /dev/null
  node=$(tr -d 'v \r\n' < .nvmrc)
  mkdir -p /opt/node
  curl -sSf "https://nodejs.org/dist/v$node/node-v$node-linux-x64.tar.xz" | tar -xJ -C /opt/node --strip-components 1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev
  chown -R dev "$PWD"
  exit 0
fi

export PATH=/opt/node/bin:$PATH
step() { printf '\n== %s\n' "$1"; }

step "Environment"
echo "system: $PRETTY_NAME"
echo "WebKitGTK: $(dpkg-query -W -f '${Version}' libwebkit2gtk-4.1-0)"
echo "fonts: ja $(fc-match 'sans-serif:lang=ja'), ko $(fc-match 'sans-serif:lang=ko'), zh-cn $(fc-match 'sans-serif:lang=zh-cn'), emoji $(fc-match 'emoji')"

step "npm ci"
npm ci --no-audit --no-fund

# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
status=0

# Only the socket file (`-nolisten local`): under act the jobs' containers share the host's network and
# with it the abstract X11 socket (see ci-smoke.sh). GTK settings.ini — what KDE writes for GTK programs and
# what a window manager without a settings daemon leaves — counts only without the settings portal: the
# portal's colour scheme, «no preference» here, outranks it. A session bus that starts no services.
step "X11 (Xvfb): screens, settings.ini"
bus=$XDG_RUNTIME_DIR/bus.conf
printf '%s\n' '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>' \
  '<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>' > "$bus"
Xvfb :97 -screen 0 1920x1200x24 -nolisten tcp -nolisten local > "$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done
DISPLAY=:97 GDK_BACKEND=x11 dbus-run-session --config-file="$bus" -- \
  node scripts/webkitgtk-check.mjs --only screens,media --app "$app" || status=1
kill $xvfb 2> /dev/null || true

# Under Wayland GTK 3 reads GNOME's settings from dconf and the settings portal and follows their changes;
# GNOME's dark style reaches WebKitGTK only through the portal.
step "Wayland (Weston headless): GNOME settings"
weston --backend=headless --renderer=pixman --socket=wayland-2 --width=1920 --height=1200 --idle-time=0 \
  > "$XDG_RUNTIME_DIR/weston.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-2" ] && break; sleep 0.2; done
XDG_CURRENT_DESKTOP=GNOME WAYLAND_DISPLAY=wayland-2 GDK_BACKEND=wayland dbus-run-session -- \
  node scripts/webkitgtk-check.mjs --only gnome --app "$app" || status=1
kill $weston 2> /dev/null || true
exit $status
