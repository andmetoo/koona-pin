#!/usr/bin/env bash
# What a test job of .github/workflows/linux.yml finds ready on Ubuntu, Debian, Fedora and Arch, installed as
# root when the CI image is built (scripts/linux/images/<role>.Dockerfile, scripts/linux/images.mjs), never in a
# job: X11 and Wayland servers without a display, xprop and xwininfo to read the window (NP-053),
# WebKitWebDriver for tests/webkit (NP-095), xwd to take the screen (NP-098), a session bus, git for
# actions/checkout, Bun (bun.sh) and the user «dev». WebKitGTK and the tray library come with the package
# (ci-package.sh): the .deb on Ubuntu and Debian, the .rpm on Fedora (NP-055), koonapin-bin from the AUR's
# PKGBUILD on Arch (NP-101). No compilers but Arch's base-devel for makepkg: the binaries are the «build»
# job's (Void). Besides, what each image's packaging stage and checks need:
#   Debian   the deb stage of build-linux-packages.mjs (dpkg-shlibdeps with WebKitGTK and the tray library
#            present), lintian, desktop-file-validate, appstreamcli; Chromium, Firefox ESR, Google Chrome and
#            Microsoft Edge for the registration checks, Chrome for Testing's system libraries (needs
#            PLAYWRIGHT_VERSION, the Dockerfile's, equal to bun.lock's: images.mjs checks)
#   Fedora   the rpm stage (rpmbuild, dpkg to read Tauri's .deb), rpmlint
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID" in
  ubuntu | debian)
    # Docker without an IPv6 route: apt picks the IPv6 addresses of the mirror and fails to connect.
    # Recommended packages are hundreds of megabytes no job needs.
    printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' > /etc/apt/apt.conf.d/99koona-ci
    apt-get update -qq
    # webkitgtk-webdriver: WebKitWebDriver of the same WebKitGTK 4.1 as the package (NP-095).
    apt-get install -y -qq xvfb xauth x11-utils x11-apps dbus weston curl unzip xz-utils git ca-certificates \
      webkitgtk-webdriver > /dev/null
    ;;
  fedora)
    # Fedora's Chromium and Firefox check the installed .rpm (ci-browsers.sh, NP-055). WebKitWebDriver ships
    # only with the GTK 4 build, webkitgtk6.0, of the same WebKit release as the app's webkit2gtk4.1 (NP-095).
    # No webkit2gtk4.1: the .rpm must bring it (ci-package.sh), and the AppImage runs without it. The rpm
    # stage reads the manifests compile wrote and unpacks the raw .deb with ar (binutils).
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xprop xwininfo xwd dbus-daemon weston unzip xz git \
      chromium firefox webkitgtk6.0 rpm-build rpmlint binutils
    dnf clean all > /dev/null
    ;;
  arch)
    # base-devel and namcap build and check koonapin-bin, whose depends bring WebKitGTK and the tray
    # (ci-package.sh, NP-101); Arch's Chromium and Firefox check the installed package (ci-browsers.sh).
    # WebKitWebDriver, as on Fedora, from the GTK 4 build webkitgtk-6.0 (NP-095).
    pacman -Syu --needed --noconfirm base-devel namcap chromium firefox webkitgtk-6.0 git curl unzip xz \
      xorg-server-xvfb xorg-xauth xorg-xprop xorg-xwininfo xorg-xwd dbus weston > /dev/null
    pacman -Scc --noconfirm > /dev/null
    ;;
  *)
    echo "ci-runtime.sh: $PRETTY_NAME is not in the matrix" >&2
    exit 1
    ;;
esac

if [ "$ID" = debian ]; then
  # The deb stage and Debian's checks of what a package may contain (bun run build:linux, NP-055).
  # libwebkit2gtk-4.1-0 and libayatana-appindicator3-1: dpkg-shlibdeps resolves the binaries' libraries.
  apt-get install -y -qq dpkg-dev lintian desktop-file-utils appstream file binutils \
    libwebkit2gtk-4.1-0 libayatana-appindicator3-1 > /dev/null
  # The development registration and the installed package are checked with Debian's browsers (NP-100,
  # smoke-registration.mjs).
  apt-get install -y -qq chromium firefox-esr gpg > /dev/null
  # Google Chrome and Microsoft Edge from their makers' repositories: they find the package's manifests
  # through the links in /etc/opt/chrome and /etc/opt/edge (NP-055).
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main" \
    > /etc/apt/sources.list.d/microsoft-edge.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable microsoft-edge-stable > /dev/null
fi

bash scripts/linux/bun.sh

# The extension smoke's Chrome for Testing (smoke-extension.mjs): its system libraries, root only, for the
# Playwright of bun.lock. The browser itself is downloaded by the job, as «dev», into its own cache.
if [ "$ID" = debian ]; then
  bunx --bun "playwright@${PLAYWRIGHT_VERSION:?the Dockerfile sets PLAYWRIGHT_VERSION}" install-deps chromium > /dev/null
fi
if [ "$ID" = ubuntu ] || [ "$ID" = debian ]; then rm -rf /var/lib/apt/lists/*; fi

id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev
