pub mod autostart;
pub mod backup;
pub mod browsers;
pub mod capture;
pub mod capture_channel;
pub mod commands;
pub mod db;
pub mod error;
pub mod export;
pub mod import;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod metadata;
pub mod migrations;
pub mod native_host;
pub mod net_guard;
pub mod pipe_name;
#[doc(hidden)]
pub mod test_libraries;
pub mod trash;

use std::sync::{atomic::Ordering, Arc};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
        // The Save dialog of an export, called from Rust only (NP-032): no permission for the interface.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::ARG]),
        ))
        .manage(channel_state.clone())
        .manage(commands::LastExport::default())
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
            let open = MenuItem::with_id(app, "open", "Открыть Netami Pin", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Netami Pin — библиотека ссылок")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
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
            commands::delete_forever,
            commands::empty_trash,
            commands::get_collections,
            commands::create_collection,
            commands::delete_collection,
            commands::get_tags,
            commands::get_domains,
            commands::suggest_collection,
            commands::get_counts,
            commands::open_url_external,
            commands::import_html_bookmarks,
            commands::export_library,
            commands::reveal_export,
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
            commands::rebuild_search_index
        ])
        .run(tauri::generate_context!())
        .expect("error while running Netami Pin");
}
