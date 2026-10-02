use crate::{
    capture::{self, CaptureRequest},
    db::{self, Bookmark, Collection, DbState, DomainCount, LibraryCounts, Tag},
    server::{ServerState, ServerStatus},
};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
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
    db::get_bookmarks(
        &*state.conn.lock().map_err(|e| e.to_string())?,
        search,
        collection_id,
        tag,
        domain,
        only_favorites,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn add_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    url: String,
    title: Option<String>,
    collection_id: Option<i64>,
    tags: Vec<String>,
) -> Result<Bookmark, String> {
    let request = CaptureRequest {
        request_id: None,
        url,
        title,
        collection_id,
        tags: Some(tags),
    };
    let saved = capture::save(&*state.conn.lock().map_err(|e| e.to_string())?, &request)
        .map_err(|e| e.message)?;
    capture::after_save(&app, state.inner().clone(), &saved);
    saved
        .bookmark
        .ok_or_else(|| "Закладка больше не существует".into())
}
#[derive(Deserialize, Default)]
#[serde(tag = "action", content = "id", rename_all = "lowercase")]
pub enum CollectionPatch {
    #[default]
    Keep,
    Clear,
    Set(i64),
}
#[derive(Deserialize)]
pub struct BookmarkPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub is_favorite: Option<bool>,
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub collection: CollectionPatch,
}
#[tauri::command]
pub fn update_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
    patch: BookmarkPatch,
) -> Result<Bookmark, String> {
    if patch.title.as_ref().is_some_and(|s| s.trim().is_empty()) {
        return Err("Название не должно быть пустым".into());
    }
    let collection = match patch.collection {
        CollectionPatch::Keep => None,
        CollectionPatch::Clear => Some(None),
        CollectionPatch::Set(id) => Some(Some(id)),
    };
    let b = db::update_bookmark(
        &*state.conn.lock().map_err(|e| e.to_string())?,
        id,
        patch.title,
        patch.notes,
        patch.is_favorite,
        collection,
        patch.tags,
    )
    .map_err(|e| e.to_string())?;
    capture::emit(&app, "updated", &b);
    Ok(b)
}
#[tauri::command]
pub fn delete_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<bool, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let revision = db::get_bookmark_by_id(&conn, id)
        .map_err(|e| e.to_string())?
        .revision
        + 1;
    db::delete_bookmark(&conn, id).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "bookmark-changed",
        capture::BookmarkChange {
            kind: "deleted",
            id,
            revision,
            bookmark: None,
        },
    );
    Ok(true)
}
#[tauri::command]
pub fn get_collections(state: State<'_, Arc<DbState>>) -> Result<Vec<Collection>, String> {
    db::get_collections(&*state.conn.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn create_collection(
    state: State<'_, Arc<DbState>>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<Collection, String> {
    if name.trim().is_empty() {
        return Err("Введите название коллекции".into());
    }
    db::create_collection(
        &*state.conn.lock().map_err(|e| e.to_string())?,
        name.trim(),
        color.as_deref(),
        icon.as_deref(),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn delete_collection(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE bookmarks SET collection_id=NULL,revision=revision+1 WHERE collection_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    db::delete_collection(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = app.emit("library-invalidated", ());
    Ok(())
}
#[tauri::command]
pub fn get_tags(state: State<'_, Arc<DbState>>) -> Result<Vec<Tag>, String> {
    db::get_tags(&*state.conn.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_domains(state: State<'_, Arc<DbState>>) -> Result<Vec<DomainCount>, String> {
    db::get_domains(&*state.conn.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_counts(state: State<'_, Arc<DbState>>) -> Result<LibraryCounts, String> {
    db::get_counts(&*state.conn.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_url_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = capture::validate_url(&url).map_err(|e| e.message)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn import_html_bookmarks(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    html_content: String,
) -> Result<usize, String> {
    let document = Html::parse_document(&html_content);
    let selector = Selector::parse("a[href]").map_err(|e| e.to_string())?;
    let mut imported = 0;
    for element in document.select(&selector) {
        let Some(href) = element.value().attr("href") else {
            continue;
        };
        if capture::validate_url(href).is_err() {
            continue;
        }
        let request = CaptureRequest {
            request_id: None,
            url: href.into(),
            title: Some(element.text().collect::<String>().trim().into()),
            collection_id: None,
            tags: None,
        };
        let result = capture::save(&*state.conn.lock().map_err(|e| e.to_string())?, &request)
            .map_err(|e| e.message)?;
        if result.newly_created {
            imported += 1;
        }
        // HTML import remains bounded and does not launch an unbounded scraping burst.
    }
    let _ = app.emit("library-invalidated", ());
    Ok(imported)
}
#[derive(Serialize)]
pub struct AppSettings {
    pub capture_token: String,
    pub close_to_tray: bool,
}
#[tauri::command]
pub fn get_app_settings(state: State<'_, Arc<DbState>>) -> Result<AppSettings, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(AppSettings {
        capture_token: db::setting(&conn, "capture_token").map_err(|e| e.to_string())?,
        close_to_tray: db::setting(&conn, "close_to_tray").map_err(|e| e.to_string())? == "true",
    })
}
#[tauri::command]
pub fn set_close_to_tray(state: State<'_, Arc<DbState>>, enabled: bool) -> Result<(), String> {
    db::set_setting(
        &*state.conn.lock().map_err(|e| e.to_string())?,
        "close_to_tray",
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_server_status(state: State<'_, Arc<ServerState>>) -> Result<ServerStatus, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}
