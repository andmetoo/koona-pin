//! Start with Windows (contract Р-8): on by default, the app then starts in
//! the tray so links from the browser arrive without opening the window.
//!
//! The installer owns the default (NP-037): its checkbox writes the same `Run`
//! value as `tauri-plugin-autostart`, and an update leaves it as it is. The app
//! only changes it from the settings.

/// Passed by the system at sign-in; the window stays hidden.
pub const ARG: &str = "--autostart";

pub fn started_by_system() -> bool {
    std::env::args().any(|arg| arg == ARG)
}
