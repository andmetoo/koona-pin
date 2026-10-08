//! How this copy gets new versions (Р-45, п. 8; Р-55): the built-in updater for the Windows installer and
//! the .deb and .rpm (NP-102), pacman for the AUR package. The AUR package carries the same binary as the
//! .deb — Tauri marks it «deb» — so it says so with a file of its own, and the updater stays off: an app
//! from AUR never tries to install a .deb through dpkg.

use std::path::Path;

/// Written by the AUR package (`src-tauri/linux/aur/PKGBUILD`), word `aur`.
pub const MARKER: &str = "/usr/share/koonapin/channel";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// The installer, the .deb or the .rpm: the app updates itself.
    BuiltIn,
    /// The AUR package: pacman and the AUR helper update it.
    Pacman,
}

impl Channel {
    pub fn current() -> Self {
        Self::from_marker(Path::new(MARKER))
    }

    fn from_marker(marker: &Path) -> Self {
        match std::fs::read_to_string(marker) {
            Ok(text) if text.trim() == "aur" => Channel::Pacman,
            _ => Channel::BuiltIn,
        }
    }

    /// Whether the built-in updater may look for, offer and install a version.
    pub fn updater(self) -> bool {
        self == Channel::BuiltIn
    }

    /// The line of the feedback report.
    pub fn describe(self) -> &'static str {
        match self {
            Channel::BuiltIn => "built-in updater",
            Channel::Pacman => "pacman (AUR), the built-in updater is off",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_aur_package_turns_the_updater_off() {
        let dir = std::env::temp_dir().join(format!("koonapin-channel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("channel");
        // No file: the installer, the .deb, the .rpm or a development build.
        assert_eq!(Channel::from_marker(&marker), Channel::BuiltIn);
        assert!(Channel::from_marker(&marker).updater());
        std::fs::write(&marker, "aur\n").unwrap();
        assert_eq!(Channel::from_marker(&marker), Channel::Pacman);
        assert!(!Channel::from_marker(&marker).updater());
        // Anything else is not a channel this build knows: it keeps its own updater.
        std::fs::write(&marker, "flatpak").unwrap();
        assert_eq!(Channel::from_marker(&marker), Channel::BuiltIn);
        std::fs::remove_dir_all(&dir).unwrap();
        // The PKGBUILD writes exactly this file and word.
        let pkgbuild = include_str!("../linux/aur/PKGBUILD");
        assert!(pkgbuild.contains(&format!("\"$pkgdir{MARKER}\"")), "the PKGBUILD must write {MARKER}");
        assert!(pkgbuild.contains("<<< aur"));
    }
}
