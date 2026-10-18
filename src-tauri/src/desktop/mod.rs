//! What only a desktop has (NP-151, NP-072a): the window and the tray, the start at sign-in, the
//! updater, the AppImage, the browser host and its pipe, the MCP server's side, the file manager
//! and quitting. `run()` reaches this module as `platform` on a desktop build; `crate::mobile`
//! exports the same functions for phones. A phone never compiles any of it.
//!
//! The binaries `koonapin-host` and `koonapin-mcp` include `pipe_name.rs`, `channel_client.rs` and
//! `mcp_tools.rs` from here by path; those files stay free of `crate::` paths of the app.

pub mod appimage;
pub mod autostart;
pub mod capture_server;
pub mod commands;
pub mod mcp;
pub mod mcp_tools;
pub mod native_host;
pub mod pipe_name;
#[cfg(target_os = "macos")]
pub mod safari_socket;
pub mod tray;
pub mod updates;
pub mod window;

#[cfg(target_os = "linux")]
pub use window::linux;
#[cfg(windows)]
pub use window::transitions;
pub use window::{activation_token, bring_forward, hide, tray_shown};

use crate::{capture_channel::ChannelState, db, library, open_requests};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// The window was closed without a tray for the first time: the page explains
/// that the app keeps running (frame «40 · Без трея»).
pub const BACKGROUND_EVENT: &str = "close-to-background";

/// A step the installer or the uninstaller runs (NP-037), or the Linux package
/// build (NP-100): the app does it and exits with 0 or 1, without a window, the
/// tray or the library.
pub fn installer_step() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ok = match args.first()?.as_str() {
        native_host::REGISTER_ARG => native_host::register_on_request().is_ok(),
        native_host::UNREGISTER_ARG => native_host::unregister().is_ok(),
        #[cfg(target_os = "linux")]
        native_host::linux::PACKAGE_ARG => return Some(native_host::linux::package_step(&args[1..])),
        _ => return None,
    };
    Some(if ok { 0 } else { 1 })
}

/// Before the app is built: true when this start only handed itself over to the copy already
/// running. A second start from the app menu brings its activation token along, or Wayland would
/// not let the window take the focus (NP-053).
pub fn hand_over(context: &tauri::Context<tauri::Wry>) -> bool {
    #[cfg(target_os = "linux")]
    return linux::hand_over(&context.config().identifier);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = context;
        false
    }
}

/// The desktop's plugins, registered before the shared ones: the single instance must come first.
pub fn plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A `.kpin` file or a `koonapin://` link opened while the app runs (NP-139, NP-142):
            // Windows and Linux start a second copy with it, which hands its arguments over. One
            // dropped because another waits, or refused because a list dialog is open, does not
            // bring the window forward.
            let kept = open_requests::keep_args(app, &args, std::path::Path::new(&cwd));
            // The native host starts the app with --autostart to save a link;
            // an app that is already running stays where it is.
            if !args.iter().any(|arg| arg == autostart::ARG) && kept != Some(false) {
                bring_forward(app, activation_token(&args))
            }
        }))
        // Registers `koonapin://` for macOS and Windows from `plugins.deep-link` at bundle time. The
        // links themselves come as arguments or `RunEvent::Opened` and are checked by open_requests;
        // the interface has no permission for the plugin's commands.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::ARG]),
        ))
        // Called from Rust only (updates.rs, NP-038): no permission for the interface.
        .plugin(tauri_plugin_updater::Builder::new().build())
}

/// Where the library lives: the brand folder it always had (`db::db_path`).
pub fn library_paths(_app: &tauri::App) -> tauri::Result<library::Paths> {
    Ok(library::Paths::from_env())
}

/// Before the shared starts: a file or a link the app was started with waits for the interface
/// (cold start).
pub fn prepare(app: &tauri::App) {
    if let Some(request) = open_requests::from_args(std::env::args(), &std::env::current_dir().unwrap_or_default()) {
        let _ = app.state::<open_requests::PendingOpens>().offer(request);
    }
}

/// After the shared starts: the browsers pointed at the host, the window, the tray and the updater.
pub fn setup(app: &tauri::App, channel_state: Arc<ChannelState>) -> tauri::Result<()> {
    let handle = app.handle().clone();
    std::thread::spawn(move || capture_server::register_host(&handle, &channel_state));
    // The window is created hidden; a start at sign-in stays in the tray.
    if !autostart::started_by_system() {
        crate::show_window(app.handle());
    }
    tray::build(app)?;
    updates::start(app.handle());
    // Screenshots for the site and the stores, from a test build only.
    #[cfg(all(unix, not(feature = "public-release")))]
    crate::shots::start(app.handle());
    Ok(())
}

/// Closing the window keeps the app in the tray when the person chose so.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    // Without an open library there is nothing to keep in the tray.
    let Some(state) = window.try_state::<Arc<db::DbState>>() else {
        return;
    };
    if !state.close_to_tray.load(Ordering::Relaxed) {
        return;
    }
    api.prevent_close();
    // No tray (NP-096): the first time the window says that the app
    // keeps running, and hides only on «Hide window».
    if !state.background_explained.load(Ordering::Relaxed) && !tray_shown() {
        let _ = window.emit(BACKGROUND_EVENT, ());
    } else {
        let _ = hide(window);
    }
}

/// macOS hands files and links to the running app, at a cold start too, as `Opened`.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        let root = std::path::Path::new("/");
        if let Some(request) = urls.iter().find_map(|url| open_requests::parse(url.as_str(), root)) {
            if open_requests::keep(app, request) {
                crate::show_window(app);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}
