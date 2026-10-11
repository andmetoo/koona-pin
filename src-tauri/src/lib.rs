pub mod appimage;
pub mod autostart;
pub mod backup;
pub mod billing;
pub mod browsers;
pub mod capture;
pub mod capture_channel;
pub mod channel;
pub mod commands;
pub mod db;
pub mod dedupe;
pub mod desktop;
pub mod error;
pub mod export;
pub mod feedback;
pub mod import;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod linkcheck;
pub mod mcp;
pub mod mcp_tools;
pub mod metadata;
pub mod migrations;
pub mod native_host;
pub mod net_guard;
pub mod pipe_name;
pub mod quick_search;
pub mod restore;
pub mod sorting;
#[doc(hidden)]
pub mod test_libraries;
pub mod trash;
pub mod tray;
pub mod updates;

use std::sync::{atomic::Ordering, Arc};
use tauri::{Emitter, Manager};

/// The window was closed without a tray for the first time: the page explains
/// that the app keeps running (frame «40 · Без трея»).
pub const BACKGROUND_EVENT: &str = "close-to-background";

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
    let _ = window.unminimize();
    let _ = window.set_focus();
}

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

pub fn run() {
    let context = tauri::generate_context!();
    // A second start from the app menu brings its activation token along, or
    // Wayland would not let the window take the focus (NP-053).
    #[cfg(target_os = "linux")]
    if desktop::linux::hand_over(&context.config().identifier) {
        std::process::exit(0);
    }
    let channel_state = Arc::new(capture_channel::ChannelState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            // The native host starts the app with --autostart to save a link;
            // an app that is already running stays where it is.
            if !args.iter().any(|arg| arg == autostart::ARG) {
                desktop::bring_forward(app, desktop::activation_token(&args))
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // File dialogs of export and backups, called from Rust only (NP-032, NP-034): no permission for the interface.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::ARG]),
        ))
        // Called from Rust only (updates.rs, NP-038): no permission for the interface.
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            updates::start(app.handle());
            billing::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
                if !state.background_explained.load(Ordering::Relaxed) && !desktop::tray_shown() {
                    let _ = window.emit(BACKGROUND_EVENT, ());
                } else {
                    let _ = desktop::hide(window);
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
            commands::create_starter_library,
            commands::get_starter_links,
            commands::reorder_collections,
            commands::set_sort_language,
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
            commands::hide_to_background,
            commands::get_mcp_status,
            commands::set_mcp_access,
            commands::get_mcp_setup,
            commands::save_mcpb,
            desktop::get_desktop,
            updates::get_update_status,
            updates::check_for_updates,
            updates::install_update,
            updates::cancel_update,
            billing::get_supporter_status,
            billing::get_supporter_prices,
            billing::start_checkout,
            billing::poll_checkout,
            billing::open_checkout,
            billing::refresh_supporter,
            billing::open_supporter_portal,
            billing::send_sign_in_code,
            billing::verify_sign_in_code,
            billing::sign_out_supporter,
            tray::set_tray_labels,
            tray::get_tray_labels
        ])
        .run(context)
        .expect("error while running Koona Pin");
}
