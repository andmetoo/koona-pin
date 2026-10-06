pub mod autostart;
pub mod backup;
pub mod browsers;
pub mod capture;
pub mod capture_channel;
pub mod commands;
pub mod db;
pub mod dedupe;
pub mod error;
pub mod export;
pub mod feedback;
pub mod import;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod linkcheck;
pub mod metadata;
pub mod migrations;
pub mod native_host;
pub mod net_guard;
pub mod pipe_name;
pub mod quick_search;
pub mod restore;
#[doc(hidden)]
pub mod test_libraries;
pub mod trash;
pub mod tray;

use std::sync::{atomic::Ordering, Arc};
use tauri::Manager;

pub(crate) fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A step the installer or the uninstaller runs (NP-037): the app does it and
/// exits with 0 or 1, without a window, the tray or the library.
pub fn installer_step() -> Option<i32> {
    let ok = match std::env::args().nth(1)?.as_str() {
        native_host::REGISTER_ARG => native_host::register().is_ok(),
        native_host::UNREGISTER_ARG => native_host::unregister().is_ok(),
        _ => return None,
    };
    Some(if ok { 0 } else { 1 })
}

pub fn run() {
    let channel_state = Arc::new(capture_channel::ChannelState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            // The native host starts the app with --autostart to save a link;
            // an app that is already running stays where it is.
            if !args.iter().any(|arg| arg == autostart::ARG) {
                show_window(app)
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // File dialogs of export and backups, called from Rust only (NP-032, NP-034): no permission for the interface.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::ARG]),
        ))
        .manage(channel_state.clone())
        .manage(commands::LastExport::default())
        .manage(commands::PickedBackup::default())
        .manage(linkcheck::Checker::default())
        .manage(Arc::new(library_state::Library::new(
            library::Paths::from_env(),
        )))
        .setup(move |app| {
            library_state::start(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || capture_channel::register_host(&handle, &channel_state));
            // The window is created hidden; a start at sign-in stays in the tray.
            if !autostart::started_by_system() {
                show_window(app.handle());
            }
            tray::build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Without an open library there is nothing to keep in the tray.
                let hide = window
                    .try_state::<Arc<db::DbState>>()
                    .is_some_and(|state| state.close_to_tray.load(Ordering::Relaxed));
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bookmarks,
            commands::get_bookmark_ids,
            commands::add_bookmark,
            commands::update_bookmark,
            commands::trash_bookmark,
            commands::restore_bookmark,
            commands::undo,
            commands::bulk_update,
            commands::all_favorite,
            commands::next_collection_id,
            commands::delete_forever,
            commands::delete_forever_many,
            commands::empty_trash,
            commands::get_collections,
            commands::create_collection,
            commands::create_starter_collections,
            commands::refresh_preview,
            commands::delete_collection,
            commands::get_tags,
            commands::get_domains,
            commands::suggest_collection,
            commands::get_counts,
            commands::open_url_external,
            commands::import_html_bookmarks,
            commands::export_library,
            commands::reveal_export,
            commands::check_restore,
            commands::restore_library,
            commands::get_app_settings,
            commands::set_close_to_tray,
            commands::get_capture_status,
            commands::repair_capture,
            commands::get_library_status,
            commands::retry_library,
            commands::reveal_library_place,
            commands::quit_app,
            commands::get_autostart,
            commands::set_autostart,
            commands::get_data_summary,
            commands::back_up_now,
            commands::save_backup_copy,
            commands::list_backups,
            commands::pick_backup,
            commands::restore_backup,
            commands::reveal_backup,
            commands::get_duplicates,
            commands::merge_duplicates,
            commands::dismiss_duplicates,
            commands::undismiss_duplicates,
            commands::get_link_check,
            commands::start_link_check,
            commands::stop_link_check,
            commands::replace_addresses,
            commands::rebuild_search_index,
            commands::feedback_report,
            commands::send_feedback,
            tray::set_tray_labels,
            tray::get_tray_labels
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koona Pin");
}
