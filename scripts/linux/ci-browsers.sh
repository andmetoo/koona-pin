#!/usr/bin/env bash
# A package job of .github/workflows/linux.yml, as «dev», with the package installed — the distribution's own
# browsers on it (scripts/smoke-registration.mjs --installed):
#   Debian (.deb, NP-055, NP-100)  first the development registration: the app's own --register-host in a
#                                  temporary home, Debian's Chromium and Firefox capture through the host —
#                                  the debug binaries of the «debug-build» job in src-tauri/target/debug; then the
#                                  package: Chromium, Google Chrome and Microsoft Edge find its manifests
#                                  through the links in /etc and refuse the development extension (they let in
#                                  only the store ones), Firefox saves through /usr/bin/koonapin-host before
#                                  the app ever ran; then the extension's flows in Chrome for Testing as on
#                                  Windows (NP-054), with the debug host
#   Fedora (.rpm, NP-055)          Firefox reads only /usr/lib64/mozilla (Р-53) and saves through
#                                  /usr/bin/koonapin-host before the app ever ran; Chromium finds the manifest
#                                  through the link in /etc/chromium and refuses the development extension
#   Arch (koonapin-bin, NP-101)    the same with Arch's Firefox (/usr/lib/mozilla) and Chromium, the browser of
#                                  Omarchy
set -euo pipefail
cd "$(dirname "$0")/../.."
. /etc/os-release
step() { printf '\n== %s\n' "$1"; }
firefox=/usr/bin/firefox
case "$ID" in
  debian) chromium=/usr/bin/chromium firefox=/usr/bin/firefox-esr ;;
  fedora) chromium=/usr/bin/chromium-browser ;;
  arch) chromium=/usr/bin/chromium ;;
  *) echo "FAIL: no browser checks for $PRETTY_NAME"; exit 1 ;;
esac
bun install --frozen-lockfile > /dev/null
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :97 -screen 0 1280x800x24 -nolisten tcp -nolisten local > /dev/null 2>&1 &
xvfb=$!
trap 'kill $xvfb 2> /dev/null || true' EXIT
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done
export DISPLAY=:97 GDK_BACKEND=x11
echo "Firefox $("$firefox" --version 2> /dev/null | grep -oE '[0-9.]+(esr)?$'), Chromium $("$chromium" --version 2> /dev/null | grep -oE '[0-9.]+' | head -1)"

# The browsers read the user's folder first, so the package installed meanwhile does not disturb it.
if [ "$ID" = debian ]; then
  step "Development registration with Chromium and Firefox of Debian"
  KOONAPIN_CHROMIUM=$chromium KOONAPIN_FIREFOX=$firefox dbus-run-session -- bun scripts/smoke-registration.mjs
  chromium=$chromium:/usr/bin/google-chrome-stable:/usr/bin/microsoft-edge-stable
fi

step "The installed package with the distribution's browsers"
KOONAPIN_CHROMIUM=$chromium KOONAPIN_FIREFOX=$firefox dbus-run-session -- bun scripts/smoke-registration.mjs --installed

# Capture, closed app, queue, browser restart, duplicate, host not registered — calm on Linux —, foreign
# id, quick search. The test host lives in the run's own browser profile.
if [ "$ID" = debian ]; then
  step "Extension smoke with Chrome for Testing"
  bunx --bun playwright install chromium
  dbus-run-session -- bun scripts/smoke-extension.mjs
fi
