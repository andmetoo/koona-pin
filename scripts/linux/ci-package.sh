#!/usr/bin/env bash
# Root part of a «distro» job of .github/workflows/linux.yml (NP-055): the package of the «build» job, as
# people get it.
#   ci-package.sh install   apt or dnf installs it from dist-linux/ with its dependencies — the job did not
#                           install WebKitGTK or the tray library — and the files are where Р-53 puts them
#   ci-package.sh remove    a second install over it, then removal: the program, the host, the manifests and
#                           the menu entry go, the library in the home folder stays (Р-45, п. 9)
# Arch gets koonapin-bin as an AUR helper builds it (NP-101): PKGBUILD and .SRCINFO from scripts/build-aur.mjs
# for the .deb of «build», its dependencies by pacman, makepkg as «dev», namcap, pacman -U.
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
step() { printf '\n== %s\n' "$1"; }

deb=$(ls "$PWD"/dist-linux/koonapin_*_amd64.deb 2> /dev/null | head -1)
rpm=$(ls "$PWD"/dist-linux/koonapin-*.x86_64.rpm 2> /dev/null | head -1)
# Not under .test-data: made by root, that folder would keep «dev» from the tests' own.
aur=/tmp/koonapin-aur
case "$ID" in
  ubuntu | debian) package=$deb ;;
  fedora) package=$rpm ;;
  arch) package=$(ls "$aur"/koonapin-bin-*.pkg.tar.zst 2> /dev/null | head -1 || true) ;;
  *) echo "FAIL: $PRETTY_NAME is not in the matrix"; exit 1 ;;
esac
[ -n "$package" ] || [ "$ID" = arch ] || { echo "FAIL: no package for $PRETTY_NAME in dist-linux/"; ls dist-linux; exit 1; }

manifests=(/etc/opt/chrome /etc/opt/edge /etc/chromium /usr/lib/mozilla)
[ "$ID" = fedora ] && manifests+=(/usr/lib64/mozilla)
# On disk. The Ubuntu image leaves out /usr/share/man and /usr/share/doc when dpkg unpacks
# (/etc/dpkg/dpkg.cfg.d/excludes): the manual pages are looked for in the package itself.
installed=(/usr/bin/koonapin /usr/bin/koonapin-host /usr/share/applications/koonapin.desktop
  /usr/share/metainfo/app.koona.pin.metainfo.xml /usr/share/icons/hicolor/512x512/apps/koonapin.png)
for folder in "${manifests[@]}"; do installed+=("$folder/native-messaging-hosts/app.koona.pin.json"); done
library="/home/dev/.local/share/Koona/Pin/koonapin.db"

[ "$ID" = arch ] && installed+=(/usr/share/koonapin/channel)

install() {
  case "$ID" in
    ubuntu | debian) apt-get install -y -qq "$@" "$package" > /dev/null ;;
    fedora) dnf install -y -q "$@" "$package" ;;
    arch) pacman -U --noconfirm "$package" > /dev/null ;;
  esac
}

# The AUR package from the .deb of «build», as yay or paru build it: the .deb lies next to the PKGBUILD,
# so makepkg takes it instead of the release on GitHub and checks its sha256.
build_aur() {
  step "Build koonapin-bin (PKGBUILD of scripts/build-aur.mjs, makepkg, namcap)"
  rm -rf "$aur"
  node scripts/build-aur.mjs --deb "$deb" --out "$aur"
  cp "$deb" "$aur/"
  chown -R dev "$aur"
  # What an AUR helper installs before makepkg: the depends of .SRCINFO.
  mapfile -t depends < <(sed -n 's/^\tdepends = //p' "$aur/.SRCINFO")
  pacman -S --needed --noconfirm "${depends[@]}" > /dev/null
  su dev -s /bin/bash -c "cd '$aur' && makepkg --printsrcinfo | diff -u .SRCINFO - && makepkg --noconfirm > makepkg.log 2>&1 || { cat makepkg.log; exit 1; }"
  echo "ok: .SRCINFO is what makepkg --printsrcinfo writes; makepkg built $(cd "$aur" && ls koonapin-bin-*.pkg.tar.zst)"
  package=$(ls "$aur"/koonapin-bin-*.pkg.tar.zst | head -1)
  # Errors fail the job; the warnings that stay are explained in Р-55.
  for target in "$aur/PKGBUILD" "$package"; do
    report=$(namcap "$target")
    [ -z "$report" ] || echo "$report"
    ! grep -q ' E: ' <<< "$report" || { echo "FAIL: namcap reports errors for $(basename "$target")"; exit 1; }
  done
  echo "ok: namcap without errors"
}

case "${1:-}" in
  install)
    [ "$ID" = arch ] && build_aur
    step "Install $(basename "$package") on $PRETTY_NAME"
    install
    for file in "${installed[@]}"; do [ -e "$file" ] || { echo "FAIL: $file is missing"; exit 1; }; done
    case "$ID" in
      ubuntu | debian) contents=$(dpkg-deb --contents "$package") ;;
      fedora) contents=$(rpm -qlp "$package") ;;
      arch) contents=$(pacman -Qlp "$package") ;;
    esac
    for page in koonapin.1.gz koonapin-host.1.gz; do
      grep -q "/usr/share/man/man1/$page" <<< "$contents" || { echo "FAIL: the package has no $page"; exit 1; }
    done
    echo "ok: program, host, menu entry, AppStream, icons and ${#manifests[@]} manifest folders installed, manual pages in the package"
    # The package is the release build: the store extensions only, never the development id (NP-100).
    for file in "${installed[@]}"; do
      [[ $file == *.json ]] || continue
      grep -q '"path": "/usr/bin/koonapin-host"' "$file" || { cat "$file"; echo "FAIL: $file does not name the host"; exit 1; }
      ! grep -q iibgiagcbediajombmkohanobgicbepn "$file" || { echo "FAIL: $file lets the development extension in"; exit 1; }
    done
    echo "ok: the manifests name /usr/bin/koonapin-host and only the store extensions"
    missing=$(ldd /usr/bin/koonapin | grep 'not found' || true)
    [ -z "$missing" ] || { echo "FAIL: the package's dependencies leave libraries out:"; echo "$missing"; exit 1; }
    echo "ok: the package's dependencies bring every library of the program"
    case "$ID" in
      ubuntu | debian) dpkg -s koonapin | grep -E '^(Version|Depends|Recommends):' ;;
      fedora)
        rpm -q --requires koonapin | grep -v '^rpmlib' | tr '\n' ' '
        echo
        # Fedora's own rpmlint and configuration (Debian's rpmlint checks as openSUSE does); what stays is
        # explained in src-tauri/linux/rpmlint.toml.
        dnf install -y -q rpmlint > /dev/null
        rpmlint -c src-tauri/linux/rpmlint.toml "$package"
        ;;
      arch)
        pacman -Qi koonapin-bin | grep -E '^(Version|Depends On|Optional Deps) '
        # pacman updates it: the app keeps its built-in updater off (src-tauri/src/channel.rs).
        [ "$(cat /usr/share/koonapin/channel)" = aur ] || { echo "FAIL: no channel mark of the AUR package"; exit 1; }
        echo "ok: the AUR package marks its channel, the built-in updater stays off"
        ;;
    esac
    ;;
  remove)
    step "Install again over it"
    case "$ID" in
      ubuntu | debian) install --reinstall ;;
      fedora) dnf reinstall -y -q "$package" ;;
      arch) install ;;
    esac
    echo "ok: the second install went through"
    step "Remove"
    # The library of a person who used the app: the package does not own it.
    su dev -s /bin/bash -c "mkdir -p \"$(dirname "$library")\" && echo library > \"$library\""
    case "$ID" in
      ubuntu | debian) apt-get purge -y -qq koonapin > /dev/null ;;
      fedora) dnf remove -y -q koonapin ;;
      arch) pacman -R --noconfirm koonapin-bin > /dev/null ;;
    esac
    for file in "${installed[@]}"; do [ ! -e "$file" ] || { echo "FAIL: $file stays after the removal"; exit 1; }; done
    echo "ok: program, host, menu entry and manifests are gone"
    [ -f "$library" ] || { echo "FAIL: the removal took the library in the home folder"; exit 1; }
    echo "ok: the library in the home folder stays"
    ;;
  *)
    echo "usage: ci-package.sh install|remove" >&2
    exit 2
    ;;
esac
