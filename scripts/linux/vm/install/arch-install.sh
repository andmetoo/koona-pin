#!/usr/bin/env bash
# Arch install for vm.sh, run by archiso from its `script=` boot parameter: base system, systemd-boot,
# GNOME or KDE Plasma with their display manager, as a clean desktop install. User «tester», key-only
# SSH, passwordless sudo for the checks, the display manager signs in by itself.
set -euxo pipefail
exec > >(tee /dev/ttyS0) 2>&1
disk=/dev/vda
case "@DESKTOP@" in
  gnome) desktop=(gnome gdm) ;;
  kde) desktop=(plasma-meta konsole dolphin sddm) ;;
esac

parted -s "$disk" mklabel gpt mkpart ESP fat32 1MiB 1025MiB set 1 esp on mkpart root ext4 1025MiB 100%
mkfs.fat -F32 "${disk}1"
mkfs.ext4 -F "${disk}2"
mount "${disk}2" /mnt
mount --mkdir "${disk}1" /mnt/boot

pacman-key --init
pacman-key --populate archlinux
pacstrap -K /mnt base linux linux-firmware sudo openssh networkmanager "${desktop[@]}"
genfstab -U /mnt >> /mnt/etc/fstab

arch-chroot /mnt /bin/bash -euxo pipefail << 'CHROOT'
echo @HOSTNAME@ > /etc/hostname
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen
locale-gen
echo 'LANG=en_US.UTF-8' > /etc/locale.conf
useradd -m -G wheel tester
usermod -p '@PASSWORD_HASH@' tester
echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester
install -d -m 700 -o tester -g tester /home/tester/.ssh
echo '@SSH_KEY@' > /home/tester/.ssh/authorized_keys
chown tester:tester /home/tester/.ssh/authorized_keys
chmod 600 /home/tester/.ssh/authorized_keys
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
bootctl install
root=$(blkid -s UUID -o value /dev/vda2)
printf 'title Arch Linux\nlinux /vmlinuz-linux\ninitrd /initramfs-linux.img\noptions root=UUID=%s rw\n' "$root" > /boot/loader/entries/arch.conf
printf 'default arch.conf\ntimeout 0\n' > /boot/loader/loader.conf
systemctl enable sshd NetworkManager
CHROOT

if [ "@DESKTOP@" = gnome ]; then
  printf '[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=tester\n' > /mnt/etc/gdm/custom.conf
  arch-chroot /mnt systemctl enable gdm
else
  mkdir -p /mnt/etc/sddm.conf.d
  printf '[Autologin]\nUser=tester\nSession=plasma\n' > /mnt/etc/sddm.conf.d/autologin.conf
  arch-chroot /mnt systemctl enable sddm
fi
umount -R /mnt
poweroff
