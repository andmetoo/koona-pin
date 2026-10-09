# The .rpm of Koona Pin (NP-055). rpmbuild packs the tree scripts/build-linux-packages.mjs laid out from the
# .deb (binaries marked "rpm" for the updater, the lib64 manifest of Fedora's Firefox added): Tauri's own
# rpm writer sets no changelog and no build host, which rpmlint counts as errors. The script fills in the
# @…@ values and passes the folder of the tree as the macro "tree".
%global debug_package %{nil}
# The binaries are stripped by Cargo; the tree is installed as it is.
%global __os_install_post %{nil}

Name:           koonapin
Version:        @VERSION@
Release:        1
Summary:        Desktop bookmark library: save a link in one click
License:        AGPL-3.0-only
URL:            https://koona.app/pin/
Packager:       @PACKAGER@
BuildArch:      x86_64
# Loaded at run time, so not found among the libraries the binary links (Р-26, п. 3); Fedora names a
# library by its soname, libayatana-appindicator-gtk3 provides it.
Requires:       libayatana-appindicator3.so.1()(64bit)
# The Chinese, Japanese and Korean interface (Р-45, п. 12).
Recommends:     google-noto-sans-cjk-vf-fonts

%description
Koona Pin is a desktop bookmark library. Pages arrive from Chrome, Edge,
Chromium and Firefox with one button of the Koona Pin extension and stay on
your computer. The package brings the native messaging host and registers it
in the browsers, so saving works before the app is first started.

%install
cp -a %{tree}/. %{buildroot}/

%files
%license %{_datadir}/licenses/koonapin/LICENSE
%{_bindir}/koonapin
%{_bindir}/koonapin-host
%{_datadir}/applications/koonapin.desktop
%{_datadir}/icons/hicolor/*/apps/koonapin.png
%{_datadir}/metainfo/app.koona.pin.metainfo.xml
%{_mandir}/man1/koonapin.1*
%{_mandir}/man1/koonapin-host.1*
# The manifest of Chrome, Edge and Chromium; their folders in /etc link to it, as in the .deb: links go
# with the package and come back with a reinstall (the app's remedy, Р-53, п. 2).
%{_datadir}/koonapin
/etc/opt/chrome/native-messaging-hosts/app.koona.pin.json
/etc/opt/edge/native-messaging-hosts/app.koona.pin.json
/etc/chromium/native-messaging-hosts/app.koona.pin.json
# The browsers' folders: the package owns them with the browsers' packages, so removing it leaves no
# empty folder of its own.
%dir /etc/opt/chrome
%dir /etc/opt/chrome/native-messaging-hosts
%dir /etc/opt/edge
%dir /etc/opt/edge/native-messaging-hosts
%dir /etc/chromium
%dir /etc/chromium/native-messaging-hosts
%dir /usr/lib/mozilla
%dir /usr/lib/mozilla/native-messaging-hosts
%dir /usr/lib64/mozilla
%dir /usr/lib64/mozilla/native-messaging-hosts
/usr/lib/mozilla/native-messaging-hosts/app.koona.pin.json
/usr/lib64/mozilla/native-messaging-hosts/app.koona.pin.json

%changelog
* @CHANGELOG_DATE@ @PACKAGER@ - @VERSION@-1
- Koona Pin @VERSION@ for Linux
