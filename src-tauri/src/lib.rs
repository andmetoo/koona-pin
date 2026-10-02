pub mod commands;
pub mod db;
pub mod metadata;
pub mod server;

use db::DbState;
use std::sync::Arc;

pub fn run() {
    let db_state = Arc::new(DbState::init());
    let db_for_server = db_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_state)
        .setup(move |app| {
            // Start local webhook server on 127.0.0.1:28765
            server::start_server(app.handle().clone(), db_for_server);
            Ok(())
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
            commands::open_url_external,
            commands::import_html_bookmarks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OddClicks desktop application");
}
