#!/usr/bin/env bash
# The AppImage of the «build» job (NP-116), as «dev», on this distribution before any package is installed:
# Arch has no WebKitGTK 4.1 and no tray library then (only the GTK 4 WebKit of WebKitWebDriver), so what the
# image brings must be enough; on Ubuntu and Debian WebKitWebDriver has brought WebKitGTK 4.1 along, and the
# CI image of Fedora has it for the rpm stage (ci-runtime.sh): the AppImage uses its own all the same
# (AppRun). Under X11 (Xvfb) with a session bus: the first start makes the library, copies the host out of
# the image, writes the browsers' manifests in the user's folders and the autostart entry for the file; a
# second start hands over; a browser's capture through the host starts the closed app; the file moved, the
# next start follows it.
# A container has no FUSE: the image runs unpacked (APPIMAGE_EXTRACT_AND_RUN), $APPIMAGE still names the file.
set -euo pipefail
cd "$(dirname "$0")/../.."
step() { printf '\n== %s\n' "$1"; }
. /etc/os-release

image=$(ls "$PWD"/dist-linux/koonapin-*-x86_64.AppImage)
step "Environment"
echo "file: $(basename "$image"), $(du -h "$image" | cut -f1); system: $PRETTY_NAME"
# The runtime at the head of the file: the static one needs no libfuse2 (Ubuntu 22.04+ has none by default).
if ldd "$image" 2>&1 | grep -q libfuse; then
  echo "FAIL: the AppImage's runtime links libfuse2"
  exit 1
fi
echo "ok: the runtime needs no libfuse2 ($(ldd "$image" 2>&1 | head -1 | sed 's/^\s*//'))"

export APPIMAGE_EXTRACT_AND_RUN=1
# A container has no user namespaces for WebKitGTK's sandbox; a desktop system does.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
unset XDG_DATA_HOME XDG_CONFIG_HOME KOONAPIN_DATA_DIR WAYLAND_DISPLAY DISPLAY
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
# Only the socket file: see ci-smoke.sh.
Xvfb :98 -screen 0 1280x800x24 -nolisten tcp -nolisten local > "$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X98 ] && break; sleep 0.2; done
[ -S /tmp/.X11-unix/X98 ] || { cat "$XDG_RUNTIME_DIR/xvfb.log"; echo "FAIL: Xvfb did not start"; exit 1; }
export DISPLAY=:98 GDK_BACKEND=x11

step "The AppImage without a package"
HOME=$(mktemp -d) dbus-run-session -- bash -euo pipefail -c '
  mkdir -p "$HOME/Apps"
  app="$HOME/Apps/koonapin.AppImage"
  cp "$1" "$app"
  chmod +x "$app"
  library="$HOME/.local/share/Koona/Pin/koonapin.db"
  folder="$HOME/.local/share/Koona/Pin/host"
  entry="$HOME/.config/autostart/koonapin.desktop"
  # Unpacked (no FUSE), the runtime starts the app as its child and waits: ending the runtime leaves the
  # app running. Every koonapin of this user ends here.
  stop() {
    for p in /proc/[0-9]*; do
      exe=$(readlink "$p/exe" 2> /dev/null) || continue
      if [ "$(basename "$exe")" = koonapin ]; then kill "${p#/proc/}" 2> /dev/null || true; fi
    done
    for _ in $(seq 20); do
      running=0
      for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2> /dev/null) || continue
        if [ "$(basename "$exe")" = koonapin ]; then running=1; fi
      done
      if [ $running -eq 0 ]; then break; fi
      sleep 0.5
    done
    wait 2> /dev/null || true
  }
  start() {
    "$1" > "$HOME/app.log" 2>&1 &
    pid=$!
    for _ in $(seq 240); do [ -f "$library" ] && [ -x "$folder/koonapin-host" ] && [ -f "$entry" ] && break; kill -0 $pid 2> /dev/null || break; sleep 0.5; done
    if [ ! -f "$library" ] || [ ! -x "$folder/koonapin-host" ] || [ ! -f "$entry" ]; then cat "$HOME/app.log"; echo "FAIL: no library, host or autostart entry"; exit 1; fi
  }
  registered() {
    [ "$(readlink "$folder/koonapin")" = "$1" ] || { ls -l "$folder"; echo "FAIL: the link beside the host does not name $1"; exit 1; }
    for manifest in .config/google-chrome/NativeMessagingHosts .config/microsoft-edge/NativeMessagingHosts .config/chromium/NativeMessagingHosts .mozilla/native-messaging-hosts; do
      grep -q "\"path\": \"$folder/koonapin-host\"" "$HOME/$manifest/app.koona.pin.json" || { cat "$HOME/$manifest/app.koona.pin.json"; echo "FAIL: $manifest does not name the host"; exit 1; }
    done
    if ! grep -qx "Exec=$1 --autostart" "$entry" || ! grep -qx "TryExec=$1" "$entry"; then cat "$entry"; echo "FAIL: the autostart entry does not start the file"; exit 1; fi
  }
  start "$app"
  echo "ok: library at ~/.local/share/Koona/Pin/koonapin.db, the WebKitGTK and tray of the image"
  registered "$app"
  echo "ok: host copied to ~/.local/share/Koona/Pin/host, the link beside it names the file"
  echo "ok: manifests of Chrome, Edge, Chromium and Firefox in the user folders name that host"
  echo "ok: the autostart entry starts the AppImage file hidden, TryExec on it"
  sleep 3
  kill -0 $pid 2> /dev/null || { cat "$HOME/app.log"; echo "FAIL: the app exited"; exit 1; }
  status=0
  timeout 60 "$app" > "$HOME/second.log" 2>&1 || status=$?
  [ $status -eq 124 ] && { cat "$HOME/second.log"; echo "FAIL: the second start did not hand over"; exit 1; }
  kill -0 $pid 2> /dev/null || { echo "FAIL: the first instance exited"; exit 1; }
  echo "ok: a second start handed over and exited ($status)"
  stop

  # A browser starts the host by its manifest; the host starts the closed app through the link.
  bun "$2/scripts/linux/appimage-capture.mjs" "$folder/koonapin-host"
  stop

  # The file moved: the autostart entry names a file that is gone (TryExec), so the next start mends it,
  # and the link beside the host follows the file.
  mv "$app" "$HOME/Apps/Koona Pin.AppImage"
  app="$HOME/Apps/Koona Pin.AppImage"
  start "$app"
  for _ in $(seq 60); do [ "$(readlink "$folder/koonapin")" = "$app" ] && grep -qx "TryExec=$app" "$entry" && break; sleep 0.5; done
  [ "$(readlink "$folder/koonapin")" = "$app" ] || { echo "FAIL: the link did not follow the file"; exit 1; }
  grep -qx "TryExec=$app" "$entry" || { cat "$entry"; echo "FAIL: the autostart entry did not follow the file"; exit 1; }
  echo "ok: the file moved (a space in its name now), the next start follows it"
  stop
' appimage "$image" "$PWD"
kill $xvfb 2> /dev/null || true
