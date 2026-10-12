#!/usr/bin/env bash
# The package jobs of .github/workflows/linux.yml (deb, rpm, ubuntu, arch), as «dev»: the release binary of
# the «build» job — the one that ships, installed from its package — started on this distribution
# without a screen, under X11 (Xvfb) and under Wayland
# (Weston headless), each with a session bus. Checks what a container can: the process stays up, the
# library is created where the contract puts it, a second start hands over to the first (single instance
# over D-Bus) and exits; under X11 also the native host and the capture socket (test:host), under Wayland
# the window's app_id and the activation token a second start passes on (NP-053); the autostart entry of the
# first start and the XDG folders (NP-097); the window is drawn, not empty, under both (NP-098). Tray,
# autostart and the desktop are not here.
set -euo pipefail
cd "$(dirname "$0")/../.."
step() { printf '\n== %s\n' "$1"; }
. /etc/os-release

# The installed package where the job has one (ci-package.sh, NP-055), else the bare binary of «build».
app=/usr/bin/koonapin
[ -x "$app" ] || app=$PWD/dist-linux/bin/koonapin

step "Environment"
echo "program: $app"
echo "system: $PRETTY_NAME, glibc: $(ldd --version | head -1 | grep -oE '[0-9.]+$'), weston: $(weston --version 2>&1 | head -1)"
missing=$(ldd "$app" | grep 'not found' || true)
[ -z "$missing" ] || { echo "FAIL: libraries missing on $PRETTY_NAME:"; echo "$missing"; exit 1; }
echo "ok: every library of the binary is present"
# One start in a fresh home: library, still running, a second start hands over and exits.
check() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    library="$HOME/.local/share/Koona/Pin/koonapin.db"
    "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    if [ ! -f "$library" ]; then cat "$HOME/app.log"; echo "FAIL: no library at $library"; exit 1; fi
    echo "ok: library created at ~/.local/share/Koona/Pin/koonapin.db"
    sleep 5
    kill -0 $app 2> /dev/null || { cat "$HOME/app.log"; echo "FAIL: the app exited"; exit 1; }
    echo "ok: still running after 5 s"
    [ -f "$HOME/.config/autostart/koonapin.desktop" ] || { echo "FAIL: no autostart entry after the first start"; exit 1; }
    echo "ok: the first start turned on the start with the session (~/.config/autostart/koonapin.desktop)"
    status=0
    timeout 30 "$1" > "$HOME/second.log" 2>&1 || status=$?
    [ $status -eq 124 ] && { cat "$HOME/second.log"; echo "FAIL: the second start did not hand over"; exit 1; }
    kill -0 $app 2> /dev/null || { echo "FAIL: the first instance exited"; exit 1; }
    echo "ok: second start handed over and exited ($status), the first keeps running"
    kill $app
  ' check "$app"
}

# NP-097: with XDG_DATA_HOME and XDG_CONFIG_HOME set, the library and the autostart entry go there, and the
# entry starts this very program hidden — and only while it exists (TryExec), so a removed package leaves no
# failing start behind.
xdg() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    export XDG_DATA_HOME="$HOME/data" XDG_CONFIG_HOME="$HOME/config"
    library="$XDG_DATA_HOME/Koona/Pin/koonapin.db"
    entry="$XDG_CONFIG_HOME/autostart/koonapin.desktop"
    "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && [ -f "$entry" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    [ -f "$library" ] || { cat "$HOME/app.log"; echo "FAIL: no library under \$XDG_DATA_HOME"; exit 1; }
    [ ! -e "$HOME/.local/share/Koona" ] || { echo "FAIL: a library under ~/.local/share as well"; exit 1; }
    echo "ok: library under \$XDG_DATA_HOME/Koona/Pin"
    if ! grep -qx "Exec=$1 --autostart" "$entry" || ! grep -qx "TryExec=$1" "$entry"; then
      cat "$entry"
      echo "FAIL: the autostart entry does not start this program hidden"
      exit 1
    fi
    echo "ok: autostart entry under \$XDG_CONFIG_HOME: this program with --autostart, TryExec"
    kill $app
    wait $app || true
    # A power cut right after the first start leaves the entry empty (Debian 13, 0.3.3): the next start mends it.
    : > "$entry"
    "$1" > "$HOME/again.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do grep -qx "Exec=$1 --autostart" "$entry" && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    grep -qx "Exec=$1 --autostart" "$entry" || { cat "$HOME/again.log"; echo "FAIL: an empty autostart entry was not mended"; exit 1; }
    [ ! -e "$XDG_CONFIG_HOME/autostart/.koonapin.desktop.partial" ] || { echo "FAIL: the partial file was left behind"; exit 1; }
    echo "ok: an empty autostart entry is mended at the next start"
    kill $app
  ' xdg "$app"
}

# Wayland only (NP-053): the window's app_id is what the package's .desktop must name (StartupWMClass),
# and a second start from the app menu passes the launcher's activation token on, so the first window may
# take the focus. The protocol log (WAYLAND_DEBUG) shows both.
activation() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    library="$HOME/.local/share/Koona/Pin/koonapin.db"
    WAYLAND_DEBUG=client "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    sleep 3
    if ! grep -q "set_app_id(\"koonapin\")" "$HOME/app.log"; then
      grep -m3 set_app_id "$HOME/app.log" || echo "(no set_app_id)"
      echo "FAIL: the window app_id is not koonapin"
      exit 1
    fi
    echo "ok: app_id koonapin"
    status=0
    XDG_ACTIVATION_TOKEN=np053-token timeout 30 "$1" > "$HOME/second.log" 2>&1 || status=$?
    [ $status -eq 124 ] && { cat "$HOME/second.log"; echo "FAIL: a second start with a token did not hand over"; exit 1; }
    sleep 2
    if grep -q "xdg_activation_v1" "$HOME/app.log"; then
      grep -q "activate(\"np053-token\"" "$HOME/app.log" || { echo "FAIL: the token did not reach the first window"; exit 1; }
      echo "ok: a second start passed its activation token, the first window used it"
    else
      echo "note: this Weston offers no xdg-activation; the token is checked on a desktop (NP-104)"
    fi
    kill $app
  ' activation "$app"
}

# X11 (NP-053): the same hand-over with the launcher's startup id. GTK puts it on the first window as
# _NET_STARTUP_ID, which shows that the second start's id reached the window through D-Bus — the path the
# Wayland token takes too.
startup() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    library="$HOME/.local/share/Koona/Pin/koonapin.db"
    "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    sleep 3
    status=0
    DESKTOP_STARTUP_ID=np053-token timeout 30 "$1" > "$HOME/second.log" 2>&1 || status=$?
    [ $status -eq 124 ] && { cat "$HOME/second.log"; echo "FAIL: a second start with a startup id did not hand over"; exit 1; }
    sleep 2
    window=$(xwininfo -root -tree | grep -m1 "\"Koona Pin\"" | awk "{print \$1}")
    [ -n "$window" ] || { echo "FAIL: no window named Koona Pin"; exit 1; }
    if ! xprop -id "$window" _NET_STARTUP_ID | grep -q "np053-token"; then
      xprop -id "$window" _NET_STARTUP_ID
      echo "FAIL: the second start did not pass its startup id to the window"
      exit 1
    fi
    echo "ok: a second start passed its startup id on, the window carries it"
    kill $app
  ' startup "$app"
}

# NP-098: the window is drawn, not empty — WebKitGTK's renderer can leave it blank (DMABUF on NVIDIA). The
# whole screen in colours: before the start only the server's own background, then the interface.
drawn() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    cd "$HOME"
    shoot() { if [ -n "${WAYLAND_DISPLAY:-}" ]; then rm -f wayland-screenshot-*.png; weston-screenshooter > /dev/null; mv wayland-screenshot-*.png "$1.png"; echo "$1.png"; else xwd -root -silent > "$1.xwd"; echo "$1.xwd"; fi; }
    echo "before the start: $(bun "$2/scripts/linux/screen-colours.mjs" "$(shoot empty)" 0)"
    library="$HOME/.local/share/Koona/Pin/koonapin.db"
    "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    sleep 5
    printf "the window: "
    bun "$2/scripts/linux/screen-colours.mjs" "$(shoot window)" || { cat "$HOME/app.log"; exit 1; }
    echo "ok: the window is drawn"
    kill $app
  ' drawn "$app" "$PWD"
}

# The package's manifests from this binary (NP-100, Р-53): what NP-055 puts into the .deb, the .rpm and AUR.
step "Native host manifests of the packages (--package-manifests)"
for package in deb rpm arch; do
  root=$(mktemp -d)
  "$app" --package-manifests "$package" "$root" > /dev/null
  echo "ok: $package —$(cd "$root" && find . -name app.koona.pin.json | sort | sed 's/^\./ /' | tr -d '\n')"
done

# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
unset XDG_DATA_HOME XDG_CONFIG_HOME KOONAPIN_DATA_DIR WAYLAND_DISPLAY DISPLAY
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"

step "X11 (Xvfb)"
# Only the socket file (`-nolisten local`): act starts the jobs' containers with the host's network, and the
# abstract socket @/tmp/.X11-unix/X99 belongs to the network, not to the container. Four Xvfb :99 at once
# then share one name: the later ones exit («server already running»), and their app talks to another
# container's X server — its shared memory is out of reach there (MIT-SHM BadAccess, the app exited;
# 8 October 2026). The file /tmp/.X11-unix/X99 is each container's own. On GitHub every job has its own VM.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten local > "$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
[ -S /tmp/.X11-unix/X99 ] || { cat "$XDG_RUNTIME_DIR/xvfb.log"; echo "FAIL: Xvfb did not start"; exit 1; }
DISPLAY=:99 GDK_BACKEND=x11 check
DISPLAY=:99 GDK_BACKEND=x11 startup
DISPLAY=:99 GDK_BACKEND=x11 xdg
DISPLAY=:99 GDK_BACKEND=x11 drawn

# test:host with this binary (NP-099): the host passes messages over the socket in $XDG_RUNTIME_DIR and
# starts the closed app in a session of its own.
step "Native host, capture socket (bun run test:host)"
HOME=$(mktemp -d) DISPLAY=:99 GDK_BACKEND=x11 KOONAPIN_TEST_BINARY=$app \
  dbus-run-session -- bun scripts/smoke-host.mjs
kill $xvfb 2> /dev/null || true

step "Wayland (Weston headless, no XWayland)"
weston --backend=headless --renderer=pixman --socket=wayland-1 --width=1280 --height=800 --idle-time=0 \
  > "$XDG_RUNTIME_DIR/weston.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/wayland-1" ] || { cat "$XDG_RUNTIME_DIR/weston.log"; echo "FAIL: Weston did not start"; exit 1; }
WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland check
WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland activation
kill $weston 2> /dev/null || true

# The drawn window under Wayland: Weston's desktop shell paints a background and a panel of its own, the
# kiosk shell only black, and it shows the window over the whole screen. --debug lets the screenshooter in.
weston --backend=headless --renderer=pixman --shell=kiosk --socket=wayland-2 --width=1280 --height=800 --idle-time=0 \
  --debug > "$XDG_RUNTIME_DIR/kiosk.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-2" ] && break; sleep 0.2; done
WAYLAND_DISPLAY=wayland-2 GDK_BACKEND=wayland drawn
kill $weston 2> /dev/null || true
