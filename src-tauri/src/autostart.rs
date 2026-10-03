//! Start with Windows (contract Р-8): on by default, the app then starts in
//! the tray so links from the browser arrive without opening the window.

use crate::db;
use rusqlite::Connection;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// Passed by the system at sign-in; the window stays hidden.
pub const ARG: &str = "--autostart";

pub fn started_by_system() -> bool {
    std::env::args().any(|arg| arg == ARG)
}

/// The default is applied once per library. Development builds and isolated
/// test runs never write the user's Run key in the registry.
pub fn apply_default(app: &AppHandle, conn: &Connection) {
    if cfg!(debug_assertions) || std::env::var_os(db::DATA_DIR_ENV).is_some() {
        return;
    }
    if db::setting(conn, "autostart_default").is_ok() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = db::set_setting(conn, "autostart_default", "applied");
    }
}
