#!/usr/bin/env bash
# The «distro» job of .github/workflows/linux.yml, as «dev»: the release binary of the «build» job — the
# one that ships — started on this distribution without a screen, under X11 (Xvfb) and under Wayland
# (Weston headless), each with a session bus. Checks what a container can: the process stays up, the
# library is created where the contract puts it, a second start hands over to the first (single instance
# over D-Bus) and exits; under X11 also the native host and the capture socket (test:host). Tray,
# autostart and the desktop are not here.
set -euo pipefail
cd "$(dirname "$0")/../.."
step() { printf '\n== %s\n' "$1"; }
. /etc/os-release

app=$PWD/dist-linux/koonapin

step "Environment"
echo "system: $PRETTY_NAME, glibc: $(ldd --version | head -1 | grep -oE '[0-9.]+$'), weston: $(weston --version 2>&1 | head -1)"
missing=$(ldd "$app" | grep 'not found' || true)
[ -z "$missing" ] || { echo "FAIL: libraries missing on $PRETTY_NAME:"; echo "$missing"; exit 1; }
echo "ok: every library of the binary is present"
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

# The package's manifests from this binary (NP-100, Р-53): what NP-055 puts into the .deb, the .rpm and AUR.
step "Native host manifests of the packages (--package-manifests)"
for package in deb rpm arch; do
  root=$(mktemp -d)
  "$app" --package-manifests "$package" "$root" > /dev/null
  echo "ok: $package —$(cd "$root" && find . -name app.koona.pin.json | sort | sed 's/^\./ /' | tr -d '\n')"
done

# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
unset XDG_DATA_HOME KOONAPIN_DATA_DIR WAYLAND_DISPLAY DISPLAY
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

# test:host with this binary (NP-099): the host passes messages over the socket in $XDG_RUNTIME_DIR and
# starts the closed app in a session of its own.
step "Native host, capture socket (npm run test:host)"
HOME=$(mktemp -d) DISPLAY=:99 GDK_BACKEND=x11 KOONAPIN_TEST_BINARY=$app \
  dbus-run-session -- node scripts/smoke-host.mjs
kill $xvfb 2> /dev/null || true

step "Wayland (Weston headless, no XWayland)"
weston --backend=headless --renderer=pixman --socket=wayland-1 --width=1280 --height=800 --idle-time=0 \
  > "$XDG_RUNTIME_DIR/weston.log" 2>&1 &
weston=$!
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/wayland-1" ] || { cat "$XDG_RUNTIME_DIR/weston.log"; echo "FAIL: Weston did not start"; exit 1; }
WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland check
kill $weston 2> /dev/null || true
