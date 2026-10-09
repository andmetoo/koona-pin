//! Start with Windows (contract Р-8): on by default, the app then starts in
//! the tray so links from the browser arrive without opening the window.
//!
//! The installer owns the default (NP-037): its checkbox writes the same `Run`
//! value as `tauri-plugin-autostart`, and an update leaves it as it is. The app
//! only changes it from the settings.
//!
//! Linux (Р-45, п. 10; NP-097) has no installer step that may write into the
//! home folder: the app turns it on at its first start and writes the XDG
//! autostart entry itself — see `linux`.

/// Passed by the system at sign-in; the window stays hidden.
pub const ARG: &str = "--autostart";

pub fn started_by_system() -> bool {
    std::env::args().any(|arg| arg == ARG)
}

/// The XDG autostart entry, written by the app rather than by
/// `tauri-plugin-autostart`: the plugin's entry ignores `XDG_CONFIG_HOME`, and
/// without `TryExec` an entry left behind by a removed package would start a
/// program that is gone at every sign-in. GNOME, KDE and uwsm (Hyprland in
/// Omarchy) read `~/.config/autostart`; with `TryExec` they skip the entry once
/// the program is gone.
pub mod xdg {
    use std::path::{Path, PathBuf};

    pub const FILE: &str = "koonapin.desktop";

    /// The text of the entry for this program.
    pub fn entry(program: &Path) -> String {
        let program = program.to_string_lossy();
        [
            "[Desktop Entry]".to_string(),
            "Type=Application".into(),
            "Name=Koona Pin".into(),
            "Comment=Starts Koona Pin in the background so links from the browser arrive right away".into(),
            format!("Exec={} {}", exec_argument(&program), super::ARG),
            format!("TryExec={}", escape(&program)),
            "Terminal=false".into(),
            "NoDisplay=true".into(),
            "StartupNotify=false".into(),
            "X-GNOME-Autostart-enabled=true".into(),
            String::new(),
        ]
        .join("\n")
    }

    /// One argument of `Exec`: quoted when it has a reserved character, then
    /// escaped as a string value (the Desktop Entry Specification).
    fn exec_argument(argument: &str) -> String {
        let reserved = |c: char| " \t\n\"'\\><~|&;$*?#()`".contains(c);
        let argument = argument.replace('%', "%%");
        if !argument.contains(reserved) {
            return escape(&argument);
        }
        let mut quoted = String::from("\"");
        for c in argument.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
        escape(&quoted)
    }

    /// A string value: `\` is written `\\`.
    fn escape(value: &str) -> String {
        value.replace('\\', "\\\\")
    }

    /// Off when the entry is gone or the desktop's own settings turned it off
    /// (`Hidden=true`, `X-GNOME-Autostart-enabled=false`), and when it is no
    /// entry at all: an empty file is what a power cut leaves of a fresh write,
    /// and the session skips it.
    pub fn enabled_in(text: &str) -> bool {
        let mut in_entry = false;
        let mut found = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
                found |= in_entry;
            } else if in_entry && (line == "Hidden=true" || line == "X-GNOME-Autostart-enabled=false") {
                return false;
            }
        }
        found
    }

    /// The file is there but the session cannot start it: empty or without an
    /// entry (a write cut short), or its `TryExec` program is gone. A file the
    /// desktop turned off is a choice, not damage.
    pub fn broken(text: &str, exists: impl Fn(&Path) -> bool) -> bool {
        let turned_off = text.lines().map(str::trim).any(|l| l == "Hidden=true" || l == "X-GNOME-Autostart-enabled=false");
        if turned_off {
            return false;
        }
        if !enabled_in(text) {
            return true;
        }
        match text.lines().map(str::trim).find_map(|l| l.strip_prefix("TryExec=")) {
            Some(program) => !exists(Path::new(&program.replace("\\\\", "\\"))),
            None => false,
        }
    }

    /// `$XDG_CONFIG_HOME/autostart/koonapin.desktop`, by default under `~/.config`.
    pub fn path() -> Option<PathBuf> {
        Some(dirs::config_dir()?.join("autostart").join(FILE))
    }

    pub fn is_enabled() -> bool {
        path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|text| enabled_in(&text))
    }

    /// Written beside and renamed over, after `fsync`: a power cut leaves the
    /// old entry or the new one, never an empty file (ext4 keeps a fresh file's
    /// name before its contents).
    pub fn enable() -> std::io::Result<()> {
        use std::io::Write;
        let path = path().ok_or_else(|| std::io::Error::other("no configuration folder"))?;
        let program = std::env::current_exe()?;
        // Right after a package update the running binary is the replaced one.
        if program.to_string_lossy().ends_with(" (deleted)") {
            return Err(std::io::Error::other("the running program was replaced"));
        }
        let folder = path.parent().ok_or_else(|| std::io::Error::other("no autostart folder"))?;
        std::fs::create_dir_all(folder)?;
        let partial = folder.join(format!(".{FILE}.partial"));
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(entry(&program).as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&partial, &path)?;
        std::fs::File::open(folder)?.sync_all()
    }

    pub fn disable() -> std::io::Result<()> {
        match path().map(std::fs::remove_file) {
            Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    /// At the first start with a library the entry is written (on by default,
    /// the contract); later starts leave the person's choice alone, but mend an
    /// entry that is there and cannot start (`broken`) — turning it off removes
    /// the file, so a damaged one was meant to be on.
    /// Not in a debug build: a developer's session would start `target/debug`.
    pub fn apply_default(conn: &rusqlite::Connection) {
        const DONE: &str = "autostart_default";
        if cfg!(debug_assertions) {
            return;
        }
        if crate::db::setting(conn, DONE).is_ok() {
            let damaged = path()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .is_some_and(|text| broken(&text, Path::exists));
            if damaged {
                if let Err(error) = enable() {
                    eprintln!("Mending the start with the session failed: {error}");
                }
            }
            return;
        }
        match enable() {
            Ok(()) => {
                let _ = crate::db::set_setting(conn, DONE, "linux");
            }
            Err(error) => eprintln!("Turning on the start with the session failed, will try again: {error}"),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_entry_starts_the_program_hidden_and_only_while_it_exists() {
            let text = entry(Path::new("/usr/bin/koonapin"));
            assert!(text.contains("\nExec=/usr/bin/koonapin --autostart\n"), "{text}");
            assert!(text.contains("\nTryExec=/usr/bin/koonapin\n"), "{text}");
            assert!(text.starts_with("[Desktop Entry]\nType=Application\n"));
            assert!(enabled_in(&text));
        }

        #[test]
        fn a_path_with_spaces_or_signs_is_quoted() {
            let text = entry(Path::new("/home/anna/Koona Pin/100%/koon$pin"));
            assert!(text.contains("\nExec=\"/home/anna/Koona Pin/100%%/koon\\\\$pin\" --autostart\n"), "{text}");
            assert!(text.contains("\nTryExec=/home/anna/Koona Pin/100%/koon$pin\n"), "{text}");
        }

        #[test]
        fn the_desktop_can_turn_it_off() {
            assert!(!enabled_in("[Desktop Entry]\nExec=koonapin\nHidden=true\n"));
            assert!(!enabled_in("[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n"));
            assert!(enabled_in("[Desktop Entry]\nX-GNOME-Autostart-enabled=true\n[Other]\nHidden=true\n"));
        }

        #[test]
        fn an_empty_or_cut_entry_is_off_and_mended() {
            // A power cut right after the first start left an empty file (Debian 13, 0.3.3).
            assert!(!enabled_in(""));
            assert!(!enabled_in("Exec=/usr/bin/koonapin --autostart\n"));
            let everywhere = |_: &Path| true;
            assert!(broken("", everywhere));
            assert!(broken("[Desktop", everywhere));
            assert!(!broken(&entry(Path::new("/usr/bin/koonapin")), everywhere));
        }

        #[test]
        fn an_entry_of_a_gone_program_is_mended_and_a_turned_off_one_kept() {
            let only_usr_bin = |p: &Path| p == Path::new("/usr/bin/koonapin");
            assert!(!broken(&entry(Path::new("/usr/bin/koonapin")), only_usr_bin));
            assert!(broken(&entry(Path::new("/opt/old/koonapin")), only_usr_bin));
            assert!(!broken("[Desktop Entry]\nTryExec=/opt/old/koonapin\nHidden=true\n", only_usr_bin));
            assert!(!broken("[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n", only_usr_bin));
        }
    }
}
