#!/usr/bin/env bash
# NP-008: runs the binary built on Ubuntu 22.04 in another distribution under
# Xvfb. Mounted: /bin-in (koonapin), /out/<name> (results).
# What it checks: missing libraries, WebKitGTK version, the window appears and
# draws the interface, the window has no frame, where the library is created,
# a second start hands over to the first (single instance).
set -uo pipefail
name="$1"
out="/out/$name"
mkdir -p "$out"
exec > >(tee "$out/run.log") 2>&1

. /etc/os-release
echo "distro: $PRETTY_NAME"
case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    # NO_TRAY_LIB=1: a system without the tray library (minimal installs).
    tray=libayatana-appindicator3-1
    [ "${NO_TRAY_LIB:-}" = 1 ] && tray=""
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      libwebkit2gtk-4.1-0 $tray librsvg2-common \
      xvfb xauth dbus-x11 xdotool x11-utils imagemagick fonts-dejavu-core >/dev/null
    webkit=$(dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0)
    ;;
  fedora)
    dnf install -y -q webkit2gtk4.1 libayatana-appindicator-gtk3 librsvg2 \
      xorg-x11-server-Xvfb xorg-x11-xauth dbus-x11 xdotool xprop ImageMagick dejavu-sans-fonts >/dev/null
    webkit=$(rpm -q --qf '%{VERSION}' webkit2gtk4.1)
    ;;
esac
echo "glibc: $(ldd --version | head -1)"
echo "webkit2gtk-4.1: $webkit"

app=/tmp/koonapin
cp /bin-in/koonapin "$app"
chmod +x "$app"
missing=$(ldd "$app" | grep "not found" || true)
echo "missing libraries: ${missing:-none}"

export HOME=/tmp/home
mkdir -p "$HOME"
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
# WebKitGTK's sandbox needs user namespaces, which a container does not give.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
eval "$(dbus-launch --sh-syntax)"

started=$(date +%s%N)
"$app" > "$out/app.log" 2>&1 &
pid=$!
window=""
for _ in $(seq 1 60); do
  window=$(xdotool search --name "Koona Pin" 2>/dev/null | head -1)
  [ -n "$window" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$window" ]; then
  echo "window: none; app exited: $(kill -0 $pid 2>/dev/null && echo no || echo yes)"
  tail -n 20 "$out/app.log"
  exit 1
fi
echo "window after ms: $(( ($(date +%s%N) - started) / 1000000 ))"
echo "geometry: $(xdotool getwindowgeometry "$window" | tr '\n' ' ')"
# Decorations off: _MOTIF_WM_HINTS carries decorations = 0.
echo "motif hints: $(xprop -id "$window" _MOTIF_WM_HINTS 2>&1)"
sleep 8
import -window root "$out/window.png"

echo "library: $(ls -1 "$HOME/.local/share/Koona/Pin" 2>&1 | tr '\n' ' ')"
second=$(date +%s%N)
timeout 20 "$app" > "$out/second.log" 2>&1
code=$?
echo "second start: exit $code after ms $(( ($(date +%s%N) - second) / 1000000 )); first alive: $(kill -0 $pid 2>/dev/null && echo yes || echo no)"
echo "windows named Koona Pin: $(xdotool search --name "Koona Pin" | wc -l)"
kill "$pid" 2>/dev/null
sleep 1
echo "app log:"
cat "$out/app.log"
