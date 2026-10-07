# Fedora kickstart for vm.sh: Workstation (GNOME) or KDE Plasma Desktop from the network installer,
# as the official editions install them. User «tester», key-only SSH, passwordless sudo for the
# checks, the display manager signs in by itself.
text
url --mirrorlist=https://mirrors.fedoraproject.org/mirrorlist?repo=fedora-@RELEASE@&arch=x86_64
repo --name=updates --mirrorlist=https://mirrors.fedoraproject.org/mirrorlist?repo=updates-released-f@RELEASE@&arch=x86_64
lang en_US.UTF-8
keyboard us
timezone UTC --utc
network --bootproto=dhcp --hostname=@HOSTNAME@
rootpw --lock
user --name=tester --groups=wheel --iscrypted --password=@PASSWORD_HASH@
sshkey --username=tester "@SSH_KEY@"
zerombr
clearpart --all --initlabel
autopart
bootloader
firstboot --disable
services --enabled=sshd
poweroff

%packages
@^@FEDORA_ENV@
openssh-server
%end

%post
echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester
if [ -d /etc/gdm ]; then
  printf '[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=tester\n' > /etc/gdm/custom.conf
fi
if [ -d /etc/sddm.conf.d ] || command -v sddm > /dev/null; then
  mkdir -p /etc/sddm.conf.d
  printf '[Autologin]\nUser=tester\nSession=plasma\n' > /etc/sddm.conf.d/autologin.conf
fi
systemctl set-default graphical.target
%end
