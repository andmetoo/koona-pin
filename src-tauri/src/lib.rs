pub mod autostart;
pub mod backup;
pub mod capture;
pub mod commands;
pub mod db;
pub mod error;
pub mod library;
pub mod library_state;
pub mod metadata;
pub mod migrations;
pub mod server;
#[doc(hidden)]
pub mod test_libraries;

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
    let server_state = Arc::new(server::ServerState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::ARG]),
        ))
        .manage(server_state)
        .manage(Arc::new(library_state::Library::new(
            library::Paths::from_env(),
        )))
        .setup(move |app| {
            library_state::start(app.handle().clone());
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
            commands::add_bookmark,
            commands::update_bookmark,
            commands::delete_bookmark,
            commands::get_collections,
            commands::create_collection,
            commands::delete_collection,
            commands::get_tags,
            commands::get_domains,
            commands::get_counts,
            commands::open_url_external,
            commands::import_html_bookmarks,
            commands::get_app_settings,
            commands::set_close_to_tray,
            commands::get_server_status,
            commands::get_library_status,
            commands::retry_library,
            commands::reveal_library_place,
            commands::quit_app,
            commands::get_autostart,
            commands::set_autostart,
            commands::get_data_summary,
            commands::back_up_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running Netami Pin");
}
