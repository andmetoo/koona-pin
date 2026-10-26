pub mod backup;
pub mod billing;
pub mod commercial;
pub mod browsers;
pub mod capabilities;
pub mod capture;
pub mod charset;
pub mod capture_channel;
pub mod channel;
pub mod commands;
pub mod db;
pub mod dedupe;
#[cfg(desktop)]
pub mod desktop;
pub mod error;
pub mod export;
pub mod feedback;
pub mod feeds;
pub mod hash;
pub mod import;
pub mod ipc;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod lifecycle;
pub mod linkcheck;
pub mod lists;
pub mod metadata;
#[cfg(mobile)]
pub mod mobile;
pub mod migrations;
pub mod net_guard;
pub mod offline;
pub mod open_requests;
pub mod position_keys;
pub mod quick_search;
pub mod reader;
pub mod reading;
pub mod refresh;
pub mod restore;
pub mod secrets;
pub mod share_queue;
#[cfg(all(desktop, not(feature = "public-release")))]
pub mod shot_previews;
#[cfg(all(unix, desktop, not(feature = "public-release")))]
pub mod shots;
pub mod sorting;
pub mod sync_library;
#[doc(hidden)]
pub mod test_libraries;
pub mod thumbs;
pub mod trash;

// What only a desktop or only a phone has (NP-072a): both export the same functions for `run()`.
#[cfg(desktop)]
use desktop as platform;
#[cfg(mobile)]
use mobile as platform;

use std::sync::Arc;
use tauri::Manager;

#[cfg(desktop)]
pub use desktop::installer_step;

pub(crate) fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show(&window);
    }
}

pub(crate) fn show(window: &tauri::WebviewWindow) {
    // Off since desktop::hide.
    #[cfg(windows)]
    desktop::transitions(&window.as_ref().window(), true);
    let _ = window.show();
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    if platform::hand_over(&context) {
        std::process::exit(0);
    }
    let channel_state = Arc::new(capture_channel::ChannelState::default());
    platform::plugins(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        // File dialogs of export and backups, called from Rust only (NP-032, NP-034): no permission for the interface.
        .plugin(tauri_plugin_dialog::init())
        // What this build can do, read by the page before its first render (NP-072a).
        .plugin(capabilities::plugin())
        // Previews and icons from the cache beside the library (NP-146), off the main thread.
        .register_asynchronous_uri_scheme_protocol(thumbs::SCHEME, thumbs::protocol)
        .manage(channel_state.clone())
        .manage(open_requests::PendingOpens::default())
        .manage(commands::LastExport::default())
        .manage(commands::PickedBackup::default())
        .manage(commands::PickedImportFile::default())
        .manage(linkcheck::Checker::default())
        .manage(refresh::Refresher::default())
        .manage(lifecycle::Lifecycle::default())
        .setup(move |app| {
            platform::prepare(app);
            // Before anything that reads or writes beside the library.
            app.manage(Arc::new(library_state::Library::new(platform::library_paths(app)?)));
            // The iPhone's Keychain takes over the account and sync files before they are read (NP-153).
            secrets::prepare(&app.state::<Arc<library_state::Library>>().paths.folder());
            // Before the library: its first daily copy goes to a Supporter's folder too, which
            // needs both states managed.
            billing::start(app.handle());
            commercial::backup_folder::start(app.handle());
            // After billing: it waits for the plan and the library, woken by their events.
            commercial::sync::start(app.handle());
            library_state::start(app.handle().clone());
            platform::setup(app, channel_state)?;
            // The feeds' refresh loop (NP-129): it waits for the library and the feed cache.
            feeds::schedule::start(app.handle());
            Ok(())
        })
        .on_window_event(platform::on_window_event)
        .invoke_handler(ipc::handler())
        .build(context)
        .expect("error while running Koona Pin")
        .run(|app, event| platform::on_run_event(app, &event));
}
