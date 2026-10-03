use crate::{
    capture::{self, CaptureRequest, ChangeKind},
    db::{self, Bookmark, Collection, DbState, DomainCount, LibraryCounts, Source, Tag},
    error::{CommandError, ErrorCode},
    library_state::{self, Library, LibraryStatus},
    server::{ServerState, ServerStatus},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

/// Every database command runs here, off the main thread. Sync Tauri
/// commands run on the main thread, so waiting for the database lock there
/// (during an import, a copy or a capture) would freeze the window.
async fn blocking<T: Send + 'static>(
    state: &State<'_, Arc<DbState>>,
    work: impl FnOnce(&Connection) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        work(&conn)
    })
    .await
    .map_err(CommandError::internal)?
}

fn text(e: rusqlite::Error) -> CommandError {
    e.into()
}

#[tauri::command]
pub async fn get_bookmarks(
    state: State<'_, Arc<DbState>>,
    search: Option<String>,
    collection_id: Option<i64>,
    tag: Option<String>,
    domain: Option<String>,
    only_favorites: bool,
) -> Result<Vec<Bookmark>, CommandError> {
    blocking(&state, move |conn| {
        db::get_bookmarks(conn, search, collection_id, tag, domain, only_favorites).map_err(text)
    })
    .await
}
#[tauri::command]
pub async fn add_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    url: String,
    title: Option<String>,
    collection_id: Option<i64>,
    tags: Vec<String>,
) -> Result<Bookmark, CommandError> {
    let request = CaptureRequest {
        request_id: None,
        url,
        title,
        collection_id,
        tags: Some(tags),
        source: None,
    };
    let saved = blocking(&state, move |conn| {
        capture::save(conn, &request, Source::App).map_err(CommandError::from)
    })
    .await?;
    capture::after_save(&app, state.inner().clone(), &saved);
    saved
        .bookmark
        .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "Закладка больше не существует"))
}
#[derive(Deserialize, Default, TS)]
#[serde(tag = "action", content = "id", rename_all = "lowercase")]
#[ts(export)]
pub enum CollectionPatch {
    #[default]
    Keep,
    Clear,
    Set(i64),
}
/// Only the fields present change.
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct BookmarkPatch {
    #[ts(optional)]
    pub title: Option<String>,
    #[ts(optional)]
    pub notes: Option<String>,
    #[ts(optional)]
    pub is_favorite: Option<bool>,
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
    /// The interface always sends it; a missing one keeps the collection.
    #[serde(default)]
    pub collection: CollectionPatch,
}
#[tauri::command]
pub async fn update_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
    patch: BookmarkPatch,
) -> Result<Bookmark, CommandError> {
    if patch.title.as_ref().is_some_and(|s| s.trim().is_empty()) {
        return Err(CommandError::invalid("Название не должно быть пустым"));
    }
    let collection = match patch.collection {
        CollectionPatch::Keep => None,
        CollectionPatch::Clear => Some(None),
        CollectionPatch::Set(id) => Some(Some(id)),
    };
    let b = blocking(&state, move |conn| {
        db::update_bookmark(
            conn,
            id,
            patch.title,
            patch.notes,
            patch.is_favorite,
            collection,
            patch.tags,
        )
        .map_err(text)
    })
    .await?;
    capture::emit(&app, ChangeKind::Updated, &b);
    Ok(b)
}
#[tauri::command]
pub async fn delete_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<bool, CommandError> {
    let revision = blocking(&state, move |conn| {
        let revision = db::get_bookmark_by_id(conn, id).map_err(text)?.revision + 1;
        db::delete_bookmark(conn, id).map_err(text)?;
        Ok(revision)
    })
    .await?;
    let _ = app.emit(
        "bookmark-changed",
        capture::BookmarkChange {
            kind: ChangeKind::Deleted,
            id,
            revision,
            bookmark: None,
        },
    );
    Ok(true)
}
#[tauri::command]
pub async fn get_collections(
    state: State<'_, Arc<DbState>>,
) -> Result<Vec<Collection>, CommandError> {
    blocking(&state, |conn| db::get_collections(conn).map_err(text)).await
}
#[tauri::command]
pub async fn create_collection(
    state: State<'_, Arc<DbState>>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<Collection, CommandError> {
    if name.trim().is_empty() {
        return Err(CommandError::invalid("Введите название коллекции"));
    }
    blocking(&state, move |conn| {
        db::create_collection(conn, name.trim(), color.as_deref(), icon.as_deref()).map_err(text)
    })
    .await
}
#[tauri::command]
pub async fn delete_collection(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<(), CommandError> {
    blocking(&state, move |conn| {
        db::delete_collection(conn, id).map_err(text)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    Ok(())
}
#[tauri::command]
pub async fn get_tags(state: State<'_, Arc<DbState>>) -> Result<Vec<Tag>, CommandError> {
    blocking(&state, |conn| db::get_tags(conn).map_err(text)).await
}
#[tauri::command]
pub async fn get_domains(state: State<'_, Arc<DbState>>) -> Result<Vec<DomainCount>, CommandError> {
    blocking(&state, |conn| db::get_domains(conn).map_err(text)).await
}
#[tauri::command]
pub async fn get_counts(state: State<'_, Arc<DbState>>) -> Result<LibraryCounts, CommandError> {
    blocking(&state, |conn| db::get_counts(conn).map_err(text)).await
}
#[tauri::command]
pub fn open_url_external(app: AppHandle, url: String) -> Result<(), CommandError> {
    let url = capture::validate_url(&url).map_err(CommandError::from)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(CommandError::internal)
}
#[tauri::command]
pub async fn import_html_bookmarks(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    html_content: String,
) -> Result<usize, CommandError> {
    // Parsing needs no database, so the library stays available meanwhile.
    let requests = tauri::async_runtime::spawn_blocking(move || capture::parse_html(&html_content))
        .await
        .map_err(CommandError::internal)?;
    let imported = blocking(&state, move |conn| {
        capture::import(conn, &requests).map_err(CommandError::from)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    Ok(imported)
}
#[derive(Serialize, TS)]
#[ts(export)]
pub struct AppSettings {
    pub capture_token: String,
    pub close_to_tray: bool,
}
#[tauri::command]
pub async fn get_app_settings(state: State<'_, Arc<DbState>>) -> Result<AppSettings, CommandError> {
    blocking(&state, |conn| {
        Ok(AppSettings {
            capture_token: db::setting(conn, "capture_token").map_err(text)?,
            close_to_tray: db::setting(conn, "close_to_tray").map_err(text)? == "true",
        })
    })
    .await
}
#[tauri::command]
pub async fn set_close_to_tray(
    state: State<'_, Arc<DbState>>,
    enabled: bool,
) -> Result<(), CommandError> {
    blocking(&state, move |conn| {
        db::set_setting(
            conn,
            "close_to_tray",
            if enabled { "true" } else { "false" },
        )
        .map_err(text)
    })
    .await?;
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
pub fn get_server_status(state: State<'_, Arc<ServerState>>) -> Result<ServerStatus, CommandError> {
    Ok(state.0.lock().map_err(CommandError::internal)?.clone())
}

#[tauri::command]
pub fn get_library_status(library: State<'_, Arc<Library>>) -> LibraryStatus {
    library.status()
}
/// Only a failed opening is repeated; a second click while opening does nothing.
#[tauri::command]
pub fn retry_library(app: AppHandle, library: State<'_, Arc<Library>>) {
    if library.begin_retry() {
        library_state::start(app);
    }
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "LibraryPlace")]
pub enum Place {
    /// The folder with the library.
    Data,
    /// The folder with backup copies.
    Backups,
    /// The copy made before a failed migration, selected in Explorer.
    Backup,
}
/// Paths come from the app, never from the page.
#[tauri::command]
pub fn reveal_library_place(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    place: Place,
) -> Result<(), CommandError> {
    let opener = app.opener();
    let paths = &library.paths;
    let shown = match place {
        Place::Data => opener.open_path(paths.folder().to_string_lossy(), None::<&str>),
        Place::Backups => {
            std::fs::create_dir_all(&paths.backups).map_err(CommandError::internal)?;
            opener.open_path(paths.backups.to_string_lossy(), None::<&str>)
        }
        Place::Backup => match library.status() {
            LibraryStatus::Failed(failure) if failure.backup.is_some() => {
                opener.reveal_item_in_dir(failure.backup.unwrap_or_default())
            }
            _ => opener.open_path(paths.backups.to_string_lossy(), None::<&str>),
        },
    };
    shown.map_err(CommandError::internal)
}
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
