pub mod capture;
pub mod commands;
pub mod db;
pub mod legacy;
pub mod metadata;
pub mod server;

use std::sync::Arc;
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
    legacy::import_webview();
    let server_state = Arc::new(server::ServerState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(server_state.clone())
        .setup(move |app| {
            let state = Arc::new(db::DbState::init());
            app.manage(state.clone());
            server::start_server(app.handle().clone(), state, server_state);
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
                let state = window.state::<Arc<db::DbState>>();
                let hide = state
                    .conn
                    .lock()
                    .ok()
                    .and_then(|c| db::setting(&c, "close_to_tray").ok())
                    .as_deref()
                    == Some("true");
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
            commands::get_server_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Netami Pin");
}
