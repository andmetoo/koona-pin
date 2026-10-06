//! NP-008 probe: what Koona Pin needs from a platform, checked at run time.
use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

fn sqlite(folder: &std::path::Path) -> Result<Value, String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let path = folder.join("probe.db");
    let conn = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
         DROP TABLE IF EXISTS words;
         CREATE VIRTUAL TABLE words USING fts5(text, content='', contentless_delete=1, tokenize='trigram');
         INSERT INTO words (rowid, text) VALUES (1, 'Архитектура тишины'), (2, 'Новогодняя Ёлка');",
    )
    .map_err(|e| e.to_string())?;
    let found: i64 = conn
        .query_row("SELECT rowid FROM words WHERE words MATCH '\"АРХИТЕКТ\"'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(json!({ "path": path, "sqlite": version, "fts5_trigram_found": found }))
}

#[tauri::command]
async fn probe(app: tauri::AppHandle) -> Value {
    let data = app.path().app_data_dir().map_err(|e| e.to_string());
    let db = match &data {
        Ok(folder) => sqlite(folder),
        Err(e) => Err(e.clone()),
    };
    let fetched = async {
        let page = reqwest::get("https://example.com/").await?.text().await?;
        let html = scraper::Html::parse_document(&page);
        let title = scraper::Selector::parse("title").unwrap();
        let text = html.select(&title).next().map(|t| t.text().collect::<String>());
        Ok::<_, reqwest::Error>(text)
    }
    .await;
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "app_data_dir": data,
        // What the desktop app uses today (db::db_path): none on mobile means a fallback is needed.
        "dirs_data_dir": dirs::data_dir(),
        "sqlite": db,
        "https_title": fetched.map_err(|e| e.to_string()),
    })
}

#[tauri::command]
fn open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![probe, open])
        .run(tauri::generate_context!())
        .expect("error while running the probe");
}
