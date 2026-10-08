#!/usr/bin/env bash
# The native tests on WebKitGTK (NP-095, Р-57) in a «distro» job of .github/workflows/linux.yml, as «dev»:
# tests/webkit through tauri-driver and WebKitWebDriver against the installed package, under X11 (Xvfb) and
# under Wayland (Weston headless), each with a session bus of its own. tauri-driver comes from the «build»
# job (dist-tools/), WebKitWebDriver from the distribution (ci-runtime.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
step() { printf '\n== %s\n' "$1"; }

export KOONAPIN_TAURI_DRIVER=${KOONAPIN_TAURI_DRIVER:-$PWD/dist-tools/tauri-driver}
# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
unset XDG_DATA_HOME XDG_CONFIG_HOME KOONAPIN_DATA_DIR WAYLAND_DISPLAY DISPLAY
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
echo "tauri-driver: $KOONAPIN_TAURI_DRIVER, WebKitWebDriver: $(command -v WebKitWebDriver)"

# A fresh home for each display server: the autostart entry and settings of one run stay out of the other.
# The drivers' and the app's output (driver.log) and the last window (last.png) stay in the run's library
# folder under .test-data; the log is shown when a test fails.
tests() {
  HOME=$(mktemp -d) dbus-run-session -- bun test --timeout 600000 tests/webkit/ || {
    log=$(ls -t .test-data/webkit-*/driver.log | head -1)
    echo "--- $log, without GTK's warnings"
    grep -v -e '-CRITICAL \*\*' -e '-WARNING \*\*' -e '^$' "$log" | tail -n 60
    exit 1
  }
}

step "X11 (Xvfb)"
# Only the socket file, as in ci-smoke.sh: act's containers share the host's abstract sockets.
Xvfb :98 -screen 0 1280x800x24 -nolisten tcp -nolisten local > "$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X98 ] && break; sleep 0.2; done
[ -S /tmp/.X11-unix/X98 ] || { cat "$XDG_RUNTIME_DIR/xvfb.log"; echo "FAIL: Xvfb did not start"; exit 1; }
DISPLAY=:98 GDK_BACKEND=x11 tests
kill $xvfb 2> /dev/null || true

step "Wayland (Weston headless, no XWayland)"
weston --backend=headless --renderer=pixman --socket=wayland-2 --width=1280 --height=800 --idle-time=0 \
  > "$XDG_RUNTIME_DIR/weston.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-2" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/wayland-2" ] || { cat "$XDG_RUNTIME_DIR/weston.log"; echo "FAIL: Weston did not start"; exit 1; }
WAYLAND_DISPLAY=wayland-2 GDK_BACKEND=wayland tests
kill $weston 2> /dev/null || true
