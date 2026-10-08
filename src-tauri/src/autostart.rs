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
    /// (`Hidden=true`, `X-GNOME-Autostart-enabled=false`).
    pub fn enabled_in(text: &str) -> bool {
        let mut in_entry = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
            } else if in_entry && (line == "Hidden=true" || line == "X-GNOME-Autostart-enabled=false") {
                return false;
            }
        }
        true
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

    pub fn enable() -> std::io::Result<()> {
        let path = path().ok_or_else(|| std::io::Error::other("no configuration folder"))?;
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        std::fs::write(path, entry(&std::env::current_exe()?))
    }

    pub fn disable() -> std::io::Result<()> {
        match path().map(std::fs::remove_file) {
            Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    /// At the first start with a library the entry is written (on by default,
    /// the contract); later starts leave the person's choice alone.
    /// Not in a debug build: a developer's session would start `target/debug`.
    pub fn apply_default(conn: &rusqlite::Connection) {
        const DONE: &str = "autostart_default";
        if cfg!(debug_assertions) || crate::db::setting(conn, DONE).is_ok() {
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
    }
}
