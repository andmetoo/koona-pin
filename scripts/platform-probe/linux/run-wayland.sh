#!/usr/bin/env bash
# NP-008: the same binary under Wayland (Weston, headless) instead of X11, with
# GDK forced to Wayland so XWayland cannot hide a problem. Mounted as run.sh.
set -uo pipefail
name="$1"
out="/out/$name"
mkdir -p "$out"
exec > >(tee "$out/run.log") 2>&1
. /etc/os-release
echo "distro: $PRETTY_NAME"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-common \
  weston dbus dbus-x11 fonts-dejavu-core >/dev/null
echo "weston: $(weston --version)"

export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
# --debug lets the screenshooter capture the headless output.
weston --backend=headless --renderer=pixman --width=1440 --height=900 --socket=wayland-1 --debug >"$out/weston.log" 2>&1 &
sleep 2
export WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland
unset DISPLAY
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
eval "$(dbus-launch --sh-syntax)"

cp /bin-in/koonapin /tmp/koonapin && chmod +x /tmp/koonapin
/tmp/koonapin > "$out/app.log" 2>&1 &
pid=$!
sleep 12
echo "app alive: $(kill -0 $pid 2>/dev/null && echo yes || echo no)"
echo "library: $(ls -1 "$HOME/.local/share/Koona Pin" 2>&1 | tr '\n' ' ')"
cd "$out" && weston-screenshooter >/dev/null 2>&1; cd - >/dev/null
echo "screenshot: $(ls "$out"/wayland-screenshot-*.png 2>/dev/null | head -1)"
timeout 20 /tmp/koonapin > "$out/second.log" 2>&1
echo "second start: exit $?; first alive: $(kill -0 $pid 2>/dev/null && echo yes || echo no)"
kill "$pid" 2>/dev/null
echo "app log:"
cat "$out/app.log"
