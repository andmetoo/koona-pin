#!/usr/bin/env bash
# What a Linux test machine is (NP-093, doc/testing.md «Машины Linux»): run it in the desktop session
# of the VM or computer and paste the output into the protocol. Reads only, needs no root.
#   bash scripts/linux/system-info.sh
. /etc/os-release
pkg() {
  if command -v dpkg-query > /dev/null; then dpkg-query -W -f '${Version}' "$1" 2> /dev/null
  elif command -v rpm > /dev/null; then rpm -q --qf '%{VERSION}-%{RELEASE}' "$1" 2> /dev/null
  elif command -v pacman > /dev/null; then pacman -Q "$1" 2> /dev/null | cut -d' ' -f2
  fi
}
first() { for name in "$@"; do v=$(pkg "$name") && [ -n "$v" ] && { echo "$name $v"; return; }; done; echo "not installed"; }
echo "system: ${PRETTY_NAME}, $(uname -m)"
echo "kernel: $(uname -r)"
echo "session: ${XDG_SESSION_TYPE:-?}, desktop ${XDG_CURRENT_DESKTOP:-?}"
for shell in gnome-shell plasmashell Hyprland; do
  command -v "$shell" > /dev/null && echo "shell: $("$shell" --version 2> /dev/null | head -1)"
done
echo "webkit2gtk-4.1: $(first libwebkit2gtk-4.1-0 webkit2gtk4.1 webkit2gtk-4.1)"
echo "mesa: $(first libgl1-mesa-dri mesa-dri-drivers mesa)"
echo "tray library: $(first libayatana-appindicator3-1 libayatana-appindicator-gtk3 libayatana-appindicator libappindicator-gtk3)"
if command -v lspci > /dev/null; then
  lspci -k 2> /dev/null | grep -A2 -E 'VGA|3D|Display' | grep -E 'VGA|3D|Display|driver in use' | sed 's/^\s*/gpu: /'
fi
renderer=$(grep -h -m1 -E 'OpenGL renderer|GL_RENDERER' <(glxinfo -B 2> /dev/null) <(eglinfo -B 2> /dev/null) 2> /dev/null)
echo "renderer: ${renderer:-unknown (glxinfo or eglinfo not installed)}"
