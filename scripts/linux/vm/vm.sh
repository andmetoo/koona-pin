#!/usr/bin/env bash
# Clean-system virtual machines of the Linux-beta matrix (NP-093, doc/testing.md «Машины Linux»).
# Runs on the Arch host as the owner's user: plain QEMU/KVM with 3D through VirGL, no window by default
# (egl-headless), nothing installed on the host. Machines, images and secrets live in $KOONA_VMS
# (~/vms). Installation is unattended: Ubuntu autoinstall, Fedora kickstart, an archiso script.
#
#   vm.sh create <machine>       download the image, install, first boot, snapshot «clean»
#   vm.sh firstboot <machine>    only the first boot and «clean», after a create that stopped there
#   vm.sh start <machine> [--view]   boot in the background; --view opens a window on the host session
#   vm.sh stop <machine>         shut down (ACPI, then hard after 60 s)
#   vm.sh restore <machine> [tag]    back to a snapshot, «clean» by default; the machine must be off
#   vm.sh snapshot <machine> <tag>   take a snapshot; the machine must be off
#   vm.sh wait <machine>         until ssh answers and the boot has finished
#   vm.sh ssh <machine> [command]    as «tester», passwordless sudo
#   vm.sh shot <machine> <file.png>  screenshot of the screen
#   vm.sh vnc <machine> click|type|key ...   input, see vnc.py
#   vm.sh list                   machines and their state
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=${KOONA_VMS:-$HOME/vms}
ovmf_code=/usr/share/edk2/x64/OVMF_CODE.4m.fd
ovmf_vars=/usr/share/edk2/x64/OVMF_VARS.4m.fd

die() { echo "vm.sh: $*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

load() {
  local line
  line=$(awk -F'\t' -v n="$1" '$1 == n' "$here/machines.tsv")
  [ -n "$line" ] || die "no machine «$1» in machines.tsv"
  IFS=$'\t' read -r name installer release desktop port <<< "$line"
  dir="$root/machines/$name"
}

running() { [ -f "$dir/qemu.pid" ] && kill -0 "$(cat "$dir/qemu.pid")" 2> /dev/null; }

qmp() {
  printf '{"execute":"qmp_capabilities"}\n%s\n' "$1" | socat -t 5 - "UNIX-CONNECT:$dir/qmp.sock" | tail -n +3
}

secrets() {
  mkdir -p "$root/secrets" && chmod 700 "$root/secrets"
  [ -f "$root/secrets/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C koona-vm -f "$root/secrets/id_ed25519"
  if [ ! -f "$root/secrets/password" ]; then
    (umask 077; openssl rand -base64 18 > "$root/secrets/password")
  fi
  ssh_key=$(cat "$root/secrets/id_ed25519.pub")
  password_hash=$(openssl passwd -6 -stdin < "$root/secrets/password")
}

# The official image and its checksum from the distribution's own server.
iso() {
  local base file sums
  case "$installer" in
    ubuntu)
      base="https://releases.ubuntu.com/$release"
      sums=$(curl -fsSL "$base/SHA256SUMS")
      file=$(grep -o "ubuntu-$release[0-9.]*-live-server-amd64.iso" <<< "$sums" | sort -V | tail -1)
      ;;
    fedora)
      # The release, else its Beta before the release date, else the nightly compose.
      local index="" mirror=https://dl.fedoraproject.org/pub/fedora/linux
      for base in "$mirror/releases/$release" "$mirror/releases/test/${release}_Beta" "$mirror/development/$release"; do
        base="$base/Everything/x86_64/iso"
        index=$(curl -fsSL "$base/" 2> /dev/null) && break
      done
      [ -n "$index" ] || die "no Fedora $release image"
      file=$(grep -o 'Fedora-Everything-netinst-x86_64-[^"]*\.iso' <<< "$index" | sort -V | tail -1)
      sums=$(curl -fsSL "$base/$(grep -o 'Fedora-Everything-[^"]*-x86_64-CHECKSUM' <<< "$index" | head -1)")
      ;;
    arch)
      base="https://geo.mirror.pkgbuild.com/iso/latest"
      file=archlinux-x86_64.iso
      sums=$(curl -fsSL "$base/sha256sums.txt")
      ;;
  esac
  [ -n "${file:-}" ] || die "no image found at $base"
  local sum
  # «hash *file» (Ubuntu), «SHA256 (file) = hash» (Fedora), «hash  file» (Arch).
  sum=$(grep -E "[ *(]${file//./\\.}([) ]|$)" <<< "$sums" | grep -oE '[0-9a-f]{64}' | head -1)
  [ -n "$sum" ] || die "no checksum for $file"
  mkdir -p "$root/iso"
  # Shared between machines by file name; a changed «latest» image fails the checksum and comes again.
  image="$root/iso/$file"
  if [ ! -f "$image" ] || ! echo "$sum  $image" | sha256sum -c --status; then
    log "downloading $file"
    curl -fL --progress-bar -o "$image.part" "$base/$file"
    echo "$sum  $image.part" | sha256sum -c --status || die "checksum of $file does not match"
    mv "$image.part" "$image"
  fi
  log "image $file, sha256 ok"
}

render() {
  sed -e "s|@HOSTNAME@|koona-$name|g" -e "s|@PASSWORD_HASH@|$password_hash|g" -e "s|@SSH_KEY@|$ssh_key|g" \
    -e "s|@DESKTOP@|$desktop|g" -e "s|@RELEASE@|$release|g" -e "s|@FEDORA_ENV@|${fedora_env:-}|g" "$1"
}

qemu_args() {
  local display="egl-headless,rendernode=/dev/dri/renderD128"
  [ "${view:-}" = 1 ] && display="gtk,gl=on"
  args=(
    -name "koona-$name" -enable-kvm -machine q35 -cpu host -smp 4 -m 4096
    -drive "if=pflash,format=raw,readonly=on,file=$ovmf_code" -drive "if=pflash,format=raw,file=$dir/vars.fd"
    -drive "if=none,id=disk,file=$dir/disk.qcow2,format=qcow2" -device virtio-blk-pci,drive=disk,bootindex=1
    -device virtio-vga-gl -display "$display" -vnc "unix:$dir/vnc.sock"
    -netdev "user,id=net,hostfwd=tcp:127.0.0.1:$port-:22" -device virtio-net-pci,netdev=net,romfile=
    -device qemu-xhci -device usb-tablet -device virtio-rng-pci
    -qmp "unix:$dir/qmp.sock,server,nowait" -serial "file:$dir/serial.log" -monitor none
  )
}

create() {
  load "$1"
  [ -f "$dir/disk.qcow2" ] && die "$name exists: $dir (remove it to start over)"
  secrets
  iso
  # Its own port, so several machines install at once.
  http_port=$((port + 6500))
  mkdir -p "$dir" "$root/serve/$name"
  qemu-img create -q -f qcow2 "$dir/disk.qcow2" 40G
  cp "$ovmf_vars" "$dir/vars.fd"

  # The installer reads its answers over HTTP from the host (10.0.2.2 inside the machine).
  local kernel initrd append files
  case "$installer" in
    ubuntu)
      render "$here/install/ubuntu-user-data" > "$root/serve/$name/user-data"
      # Invalid YAML is not an error for the installer: it silently falls back to the interactive one.
      if python3 -c 'import yaml' 2> /dev/null; then
        python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))["autoinstall"]' "$root/serve/$name/user-data" ||
          die "user-data is not valid YAML"
      fi
      # cloud-init asks for all three; a 404 on vendor-data drops the whole source.
      : > "$root/serve/$name/meta-data"
      : > "$root/serve/$name/vendor-data"
      kernel=casper/vmlinuz initrd=casper/initrd
      append="autoinstall ds=nocloud;s=http://10.0.2.2:$http_port/$name/ console=ttyS0,115200"
      ;;
    fedora)
      # The environment groups of the official editions.
      fedora_env=workstation-product-environment
      [ "$desktop" = kde ] && fedora_env=kde-desktop-environment
      render "$here/install/fedora.ks" > "$root/serve/$name/ks.cfg"
      kernel=images/pxeboot/vmlinuz initrd=images/pxeboot/initrd.img
      local label
      label=$(dd if="$image" bs=1 skip=32808 count=32 2> /dev/null | tr -d ' \0')
      append="inst.stage2=hd:LABEL=$label inst.ks=http://10.0.2.2:$http_port/$name/ks.cfg inst.text console=ttyS0,115200"
      ;;
    arch)
      render "$here/install/arch-install.sh" > "$root/serve/$name/install.sh"
      kernel=arch/boot/x86_64/vmlinuz-linux initrd=arch/boot/x86_64/initramfs-linux.img
      local uuid
      uuid=$(bsdtar -tf "$image" | sed -n 's|^boot/\(.*\)\.uuid$|\1|p' | head -1)
      append="archisobasedir=arch archisosearchuuid=$uuid script=http://10.0.2.2:$http_port/$name/install.sh console=ttyS0,115200"
      ;;
  esac
  bsdtar -xf "$image" -C "$dir" "$kernel" "$initrd"
  python3 -m http.server --bind 127.0.0.1 "$http_port" --directory "$root/serve" > "$dir/http.log" 2>&1 &
  http=$!
  trap 'kill ${http:-} 2> /dev/null || true' EXIT

  log "installing $name ($installer $release, $desktop); serial log: $dir/serial.log"
  qemu_args
  local status=0
  timeout 3h qemu-system-x86_64 "${args[@]}" -drive "file=$image,media=cdrom,readonly=on" \
    -kernel "$dir/$kernel" -initrd "$dir/$initrd" -append "$append" -no-reboot || status=$?
  # QEMU 11.1 with egl-headless may crash while quitting after the guest powered off (139): the first
  # boot below decides whether the install worked. 124 is the timeout.
  case $status in
    0) ;;
    139) log "QEMU crashed on exit after the installer; the first boot decides" ;;
    *) die "the installer did not finish, status $status (see $dir/serial.log)" ;;
  esac
  kill $http 2> /dev/null || true
  rm -rf "${dir:?}/casper" "${dir:?}/images" "${dir:?}/arch" "$root/serve/$name"
  firstboot "$name"
}

# The first boot after the install, then the «clean» snapshot; on its own it resumes a create that
# stopped after the installer.
firstboot() {
  load "$1"
  log "first boot"
  start "$name"
  wait_ssh
  # Ubuntu Desktop ships Firefox as a snap; snaps cannot be seeded from the server installer's chroot.
  [ "$installer" = ubuntu ] && ssh_vm 'sudo snap wait system seed.loaded && sudo snap install firefox'
  ssh_vm 'systemctl is-system-running --wait || systemctl --failed --no-legend; grep PRETTY_NAME /etc/os-release'
  stop "$name"
  snapshot "$name" clean
  log "$name ready: vm.sh start $name"
}

start() {
  load "$1"
  [ -f "$dir/disk.qcow2" ] || die "$name is not created: vm.sh create $name"
  running && die "$name is running"
  view=${2:+1}
  qemu_args
  qemu-system-x86_64 "${args[@]}" -daemonize -pidfile "$dir/qemu.pid" > /dev/null
  log "$name started; ssh: vm.sh ssh $name"
}

stop() {
  load "$1"
  running || { log "$name is off"; return; }
  qmp '{"execute":"system_powerdown"}' > /dev/null || true
  for _ in $(seq 60); do running || break; sleep 1; done
  running && { qmp '{"execute":"quit"}' > /dev/null || true; sleep 2; }
  rm -f "$dir/qemu.pid"
  log "$name stopped"
}

snapshot() {
  load "$1"
  running && die "stop $name first"
  qemu-img snapshot -d "$2" "$dir/disk.qcow2" 2> /dev/null || true
  qemu-img snapshot -c "$2" "$dir/disk.qcow2"
  cp "$dir/vars.fd" "$dir/vars.$2.fd"
  log "$name: snapshot $2"
}

restore() {
  load "$1"
  running && die "stop $name first"
  local tag=${2:-clean}
  qemu-img snapshot -a "$tag" "$dir/disk.qcow2"
  cp "$dir/vars.$tag.fd" "$dir/vars.fd"
  log "$name: back to $tag"
}

ssh_vm() {
  ssh -q -i "$root/secrets/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -p "$port" tester@127.0.0.1 "$@"
}

wait_ssh() {
  for _ in $(seq 120); do ssh_vm true 2> /dev/null && return; sleep 5; done
  die "$name: no ssh after 10 minutes"
}

shot() {
  load "$1"
  running || die "$name is off"
  # Not QMP screendump: with VirGL it returns the last 2D frame, the firmware screen.
  python3 "$here/vnc.py" "$dir/vnc.sock" shot "$2"
  log "$(realpath "$2")"
}

list() {
  while IFS=$'\t' read -r n _ _ _ _; do
    [[ -z "$n" || "$n" == \#* ]] && continue
    load "$n"
    local state=absent
    [ -f "$dir/disk.qcow2" ] && state=off
    running && state=running
    printf '%-16s %-8s %s %s, ssh 127.0.0.1:%s\n' "$name" "$state" "$installer $release" "$desktop" "$port"
  done < "$here/machines.tsv"
}

command=${1:-}
shift || true
case "$command" in
  create | firstboot | start | stop | restore | snapshot | shot) "$command" "$@" ;;
  ssh) load "$1"; shift; ssh_vm "$@" ;;
  wait) load "$1"; running || die "$name is off"; wait_ssh; ssh_vm "systemctl is-system-running --wait > /dev/null || true" ;;
  vnc) load "$1"; shift; running || die "$name is off"; python3 "$here/vnc.py" "$dir/vnc.sock" "$@" ;;
  list) list ;;
  *) sed -n '2,18p' "$0"; exit 1 ;;
esac
