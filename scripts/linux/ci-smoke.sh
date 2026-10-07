#!/usr/bin/env bash
# The «distro» job of .github/workflows/linux.yml, as «dev»: the app built against this distribution's
# libraries and started without a screen, under X11 (Xvfb) and under Wayland (Weston headless), each
# with a session bus. Checks what a container can: the process stays up, the library is created where
# the contract puts it, a second start hands over to the first (single instance over D-Bus) and exits.
# Tray, autostart and the desktop are not here.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/node/bin:$PATH
step() { printf '\n== %s\n' "$1"; }
. /etc/os-release

step "Environment"
echo "system: $PRETTY_NAME, glibc: $(ldd --version | head -1 | grep -oE '[0-9.]+$')"
echo "webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1), weston: $(weston --version 2>&1 | head -1)"

step "Build: interface embedded, as in the release"
npm ci --no-audit --no-fund
npm run build
(cd src-tauri && cargo build --features custom-protocol --locked)
app=$PWD/src-tauri/target/debug/koonapin

# One start in a fresh home: library, still running, a second start hands over and exits.
check() {
  HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
    library="$HOME/.local/share/Koona Pin/koonapin.db"
    "$1" > "$HOME/app.log" 2>&1 &
    app=$!
    for _ in $(seq 120); do [ -f "$library" ] && break; kill -0 $app 2> /dev/null || break; sleep 0.5; done
    if [ ! -f "$library" ]; then cat "$HOME/app.log"; echo "FAIL: no library at $library"; exit 1; fi
    echo "ok: library created at ~/.local/share/Koona Pin/koonapin.db"
    sleep 5
    kill -0 $app 2> /dev/null || { cat "$HOME/app.log"; echo "FAIL: the app exited"; exit 1; }
    echo "ok: still running after 5 s"
    status=0
    timeout 30 "$1" > "$HOME/second.log" 2>&1 || status=$?
    [ $status -eq 124 ] && { cat "$HOME/second.log"; echo "FAIL: the second start did not hand over"; exit 1; }
    kill -0 $app 2> /dev/null || { echo "FAIL: the first instance exited"; exit 1; }
    echo "ok: second start handed over and exited ($status), the first keeps running"
    kill $app
  ' check "$app"
}

# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
unset XDG_DATA_HOME KOONAPIN_DATA_DIR WAYLAND_DISPLAY DISPLAY
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"

step "X11 (Xvfb)"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /dev/null 2>&1 &
xvfb=$!
DISPLAY=:99 GDK_BACKEND=x11 check
kill $xvfb

step "Wayland (Weston headless, no XWayland)"
weston --backend=headless --renderer=pixman --socket=wayland-1 --width=1280 --height=800 --idle-time=0 \
  > "$XDG_RUNTIME_DIR/weston.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/wayland-1" ] || { cat "$XDG_RUNTIME_DIR/weston.log"; echo "FAIL: Weston did not start"; exit 1; }
WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland check
kill $weston
