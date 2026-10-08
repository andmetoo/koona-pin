#!/usr/bin/env bash
# A «distro» job of .github/workflows/linux.yml, as «dev», with the package installed — the distribution's own
# browsers on it (scripts/smoke-registration.mjs --installed, as the «check» job runs it for the .deb):
#   Fedora (.rpm, NP-055)          Firefox reads only /usr/lib64/mozilla (Р-53) and saves through
#                                  /usr/bin/koonapin-host before the app ever ran; Chromium finds the manifest
#                                  through the link in /etc/chromium and refuses the development extension
#   Arch (koonapin-bin, NP-101)    the same with Arch's Firefox (/usr/lib/mozilla) and Chromium, the browser of
#                                  Omarchy
set -euo pipefail
cd "$(dirname "$0")/../.."
. /etc/os-release
case "$ID" in
  fedora) chromium=/usr/bin/chromium-browser ;;
  arch) chromium=/usr/bin/chromium ;;
  *) echo "FAIL: no browsers of $PRETTY_NAME here: the «check» job covers the .deb"; exit 1 ;;
esac
export PATH=/opt/node/bin:$PATH
npm ci --no-audit --no-fund > /dev/null
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :97 -screen 0 1280x800x24 -nolisten tcp -nolisten local > /dev/null 2>&1 &
xvfb=$!
trap 'kill $xvfb 2> /dev/null || true' EXIT
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done
echo "Firefox $(firefox --version 2> /dev/null | grep -oE '[0-9.]+$'), Chromium $("$chromium" --version 2> /dev/null | grep -oE '[0-9.]+' | head -1)"
KOONAPIN_CHROMIUM=$chromium KOONAPIN_FIREFOX=/usr/bin/firefox \
  DISPLAY=:97 GDK_BACKEND=x11 dbus-run-session -- node scripts/smoke-registration.mjs --installed
