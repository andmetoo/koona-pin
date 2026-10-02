use crate::db::{self, Bookmark, Collection, DbState, DomainCount, Tag};
use crate::metadata;
use scraper::{Html, Selector};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn get_bookmarks(
    state: State<'_, Arc<DbState>>,
    search: Option<String>,
    collection_id: Option<i64>,
    tag: Option<String>,
    domain: Option<String>,
    only_favorites: bool,
) -> Result<Vec<Bookmark>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_bookmarks(&conn, search, collection_id, tag, domain, only_favorites)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    url: String,
    title: Option<String>,
    collection_id: Option<i64>,
    tags: Vec<String>,
) -> Result<Bookmark, String> {
    let domain = metadata::extract_domain(&url);
    let initial_title = title.clone().unwrap_or_else(|| url.clone());

    // 1. Immediately store in DB
    let initial_bookmark = {
        let conn = state.conn.lock().unwrap();
        db::insert_or_update_bookmark(
            &conn,
            &url,
            &initial_title,
            None,
            None,
            Some(&format!(
                "https://www.google.com/s2/favicons?domain={}&sz=128",
                domain
            )),
            &domain,
            collection_id,
            if tags.is_empty() { None } else { Some(&tags) },
        )
        .map_err(|e| e.to_string())?
    };

    // 2. Fetch full OpenGraph metadata in background
    let bg_url = url.clone();
    let bg_app = app.clone();
    let bg_state = state.inner().clone();
    let bg_tags = tags.clone();

    tokio::spawn(async move {
        let meta = metadata::fetch_metadata(&bg_url).await;
        let conn = bg_state.conn.lock().unwrap();
        let display_title = meta.title.as_ref().or(title.as_ref()).unwrap_or(&bg_url);
        let updated = db::insert_or_update_bookmark(
            &conn,
            &bg_url,
            display_title,
            meta.description.as_deref(),
            meta.image_url.as_deref(),
            meta.favicon_url.as_deref(),
            &meta.domain,
            collection_id,
            if bg_tags.is_empty() { None } else { Some(&bg_tags) },
        );
        drop(conn);

        if let Ok(b) = updated {
            let _ = bg_app.emit("bookmark-added", &b);
        }
    });

    Ok(initial_bookmark)
}

#[tauri::command]
pub fn update_bookmark(
    state: State<'_, Arc<DbState>>,
    id: i64,
    title: Option<String>,
    notes: Option<String>,
    is_favorite: Option<bool>,
    collection_id: Option<Option<i64>>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, String> {
    let conn = state.conn.lock().unwrap();
    db::update_bookmark(&conn, id, title, notes, is_favorite, collection_id, tags)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_bookmark(state: State<'_, Arc<DbState>>, id: i64) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    db::delete_bookmark(&conn, id)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collections(state: State<'_, Arc<DbState>>) -> Result<Vec<Collection>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_collections(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_collection(
    state: State<'_, Arc<DbState>>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<Collection, String> {
    let conn = state.conn.lock().unwrap();
    db::create_collection(&conn, &name, color.as_deref(), icon.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_collection(state: State<'_, Arc<DbState>>, id: i64) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    db::delete_collection(&conn, id)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags(state: State<'_, Arc<DbState>>) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_tags(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_domains(state: State<'_, Arc<DbState>>) -> Result<Vec<DomainCount>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_domains(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_html_bookmarks(
    state: State<'_, Arc<DbState>>,
    html_content: String,
) -> Result<usize, String> {
    let document = Html::parse_document(&html_content);
    let selector = match Selector::parse("a[href]") {
        Ok(s) => s,
        Err(e) => return Err(format!("Invalid selector: {:?}", e)),
    };

    let mut imported = 0;
    let conn = state.conn.lock().unwrap();

    for element in document.select(&selector) {
        if let Some(href) = element.value().attr("href") {
            let trimmed_href = href.trim();
            if trimmed_href.starts_with("http://") || trimmed_href.starts_with("https://") {
                let text: String = element.text().collect();
                let title = if text.trim().is_empty() {
                    trimmed_href.to_string()
                } else {
                    text.trim().to_string()
                };

                let domain = metadata::extract_domain(trimmed_href);
                let favicon = format!("https://www.google.com/s2/favicons?domain={}&sz=128", domain);

                if db::insert_or_update_bookmark(
                    &conn,
                    trimmed_href,
                    &title,
                    None,
                    None,
                    Some(&favicon),
                    &domain,
                    None,
                    None,
                )
                .is_ok()
                {
                    imported += 1;
                }
            }
        }
    }

    Ok(imported)
}
