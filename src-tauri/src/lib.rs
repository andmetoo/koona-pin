pub mod appimage;
pub mod autostart;
pub mod backup;
pub mod billing;
pub mod commercial;
pub mod browsers;
pub mod capture;
pub mod charset;
pub mod capture_channel;
pub mod channel;
pub mod commands;
pub mod db;
pub mod dedupe;
pub mod desktop;
pub mod error;
pub mod export;
pub mod feedback;
pub mod feeds;
pub mod import;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod linkcheck;
pub mod lists;
pub mod mcp;
pub mod mcp_tools;
pub mod metadata;
pub mod migrations;
pub mod native_host;
pub mod net_guard;
pub mod offline;
pub mod open_requests;
pub mod pipe_name;
pub mod position_keys;
pub mod quick_search;
pub mod reader;
pub mod reading;
pub mod refresh;
pub mod restore;
#[cfg(target_os = "macos")]
pub mod safari_socket;
#[cfg(all(unix, not(feature = "public-release")))]
pub mod shots;
pub mod sorting;
pub mod sync_library;
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
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A `.kpin` file or a `koonapin://` link opened while the app runs (NP-139, NP-142):
            // Windows and Linux start a second copy with it, which hands its arguments over. One
            // dropped because another waits does not bring the window forward.
            let kept = open_requests::keep_args(app, &args, std::path::Path::new(&cwd));
            // The native host starts the app with --autostart to save a link;
            // an app that is already running stays where it is.
            if !args.iter().any(|arg| arg == autostart::ARG) && kept != Some(false) {
                desktop::bring_forward(app, desktop::activation_token(&args))
            }
        }))
        // Registers `koonapin://` for macOS and Windows from `plugins.deep-link` at bundle time. The
        // links themselves come as arguments or `RunEvent::Opened` and are checked by open_requests;
        // the interface has no permission for the plugin's commands.
        .plugin(tauri_plugin_deep_link::init())
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
        .manage(open_requests::PendingOpens::default())
        .manage(commands::LastExport::default())
        .manage(commands::PickedBackup::default())
        .manage(linkcheck::Checker::default())
        .manage(refresh::Refresher::default())
        .manage(Arc::new(library_state::Library::new(
            library::Paths::from_env(),
        )))
        .setup(move |app| {
            // A file or a link the app was started with waits for the interface (cold start).
            if let Some(request) = open_requests::from_args(
                std::env::args(),
                &std::env::current_dir().unwrap_or_default(),
            ) {
                let _ = app.state::<open_requests::PendingOpens>().offer(request);
            }
            // Before the library: its first daily copy goes to a Supporter's folder too, which
            // needs both states managed.
            billing::start(app.handle());
            commercial::backup_folder::start(app.handle());
            // After billing: it waits for the plan and the library, woken by their events.
            commercial::sync::start(app.handle());
            library_state::start(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || capture_channel::register_host(&handle, &channel_state));
            // The window is created hidden; a start at sign-in stays in the tray.
            if !autostart::started_by_system() {
                show_window(app.handle());
            }
            tray::build(app)?;
            updates::start(app.handle());
            // The feeds' refresh loop (NP-129): it waits for the library and the feed cache.
            feeds::schedule::start(app.handle());
            #[cfg(all(unix, not(feature = "public-release")))]
            shots::start(app.handle());
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
            commands::set_reading_progress,
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
            reader::fetch_reader_page,
            commands::import_html_bookmarks,
            commands::export_library,
            commands::reveal_export,
            commands::check_restore,
            commands::restore_library,
            commands::get_app_settings,
            commands::set_close_to_tray,
            commands::set_reading_mark_at_end,
            commands::set_reading_save_offline,
            commands::save_offline_copy,
            commands::get_offline_copy,
            commands::remove_offline_copy,
            commands::remove_all_offline_copies,
            commands::offline_stats,
            commands::reveal_offline_folder,
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
            commands::get_preview_refresh,
            commands::get_preview_counts,
            commands::start_preview_refresh,
            commands::stop_preview_refresh,
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
            commercial::backup_folder::get_backup_folder,
            commercial::backup_folder::choose_backup_folder,
            commercial::backup_folder::stop_backup_folder,
            commercial::backup_folder::open_backup_folder,
            commercial::sync::get_sync_status,
            commercial::sync::enable_sync,
            commercial::sync::disable_sync,
            commercial::sync::approve_device,
            commercial::sync::reject_device,
            commercial::sync::remove_device,
            commercial::sync::request_main,
            commercial::sync::answer_main_request,
            commercial::sync::send_start_over_code,
            commercial::sync::start_over,
            commercial::sync::join_sync_again,
            commercial::sync::dismiss_sync_notice,
            commercial::sync::get_sync_account,
            commercial::sync::rename_device,
            commercial::sync::sync_now,
            commercial::sync::copy_sync_report,
            feeds::list_feeds,
            feeds::subscribe_feed,
            feeds::update_feed,
            feeds::unsubscribe_feed,
            feeds::accept_feed_move,
            feeds::preview_link,
            feeds::preview_feed,
            feeds::list_feed_items,
            feeds::get_feed_article,
            feeds::set_feed_items_read,
            feeds::mark_feed_read,
            feeds::save_feed_item,
            feeds::refresh_feeds,
            feeds::clear_feed_cache,
            feeds::import_opml,
            feeds::export_opml,
            feeds::set_feeds_refresh_minutes,
            lists::preview_list,
            lists::import_list,
            lists::export::build_list,
            lists::export::save_list,
            tray::set_tray_labels,
            tray::get_tray_labels,
            open_requests::take_pending_opens
        ])
        .build(context)
        .expect("error while running Koona Pin")
        .run(|_app, _event| {
            // macOS hands files and links to the running app, at a cold start too, as `Opened`.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let root = std::path::Path::new("/");
                if let Some(request) = urls
                    .iter()
                    .find_map(|url| open_requests::parse(url.as_str(), root))
                {
                    if open_requests::keep(_app, request) {
                        show_window(_app);
                    }
                }
            }
        });
}
