#!/usr/bin/env bash
# The Fedora «distro» job of .github/workflows/linux.yml, as «dev», with the .rpm installed (NP-055): Fedora's
# own Firefox reads only /usr/lib64/mozilla (Р-53) and saves through /usr/bin/koonapin-host before the app ever
# ran; Fedora's Chromium finds the manifest through the link in /etc/chromium and refuses the development
# extension (the package lets in only the store ones). scripts/smoke-registration.mjs --installed, as the
# «check» job runs it for the .deb.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH=/opt/node/bin:$PATH
npm ci --no-audit --no-fund > /dev/null
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :97 -screen 0 1280x800x24 -nolisten tcp -nolisten local > /dev/null 2>&1 &
xvfb=$!
trap 'kill $xvfb 2> /dev/null || true' EXIT
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done
echo "Firefox $(firefox --version 2> /dev/null | grep -oE '[0-9.]+$'), Chromium $(chromium-browser --version 2> /dev/null | grep -oE '[0-9.]+' | head -1)"
KOONAPIN_CHROMIUM=/usr/bin/chromium-browser KOONAPIN_FIREFOX=/usr/bin/firefox \
  DISPLAY=:97 GDK_BACKEND=x11 dbus-run-session -- node scripts/smoke-registration.mjs --installed
