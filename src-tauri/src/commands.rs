use crate::{
    browsers::CaptureStatus,
    capture::{self, CaptureRequest, ChangeKind},
    capture_channel::{self, ChannelState},
    db::{
        self, Bookmark, BookmarkPage, BookmarkQuery, Collection, DbState, DomainCount,
        LibraryCounts, Source, Tag,
    },
    error::{CommandError, ErrorCode},
    library_state::{self, Library, LibraryStatus},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
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
    query: BookmarkQuery,
) -> Result<BookmarkPage, CommandError> {
    blocking(&state, move |conn| {
        db::get_bookmarks(conn, &query).map_err(text)
    })
    .await
}
/// Settings → Data: rebuilds the search index if it has drifted from the library.
#[tauri::command]
pub async fn rebuild_search_index(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
) -> Result<i64, CommandError> {
    let count = blocking(&state, |conn| db::rebuild_search(conn).map_err(text)).await?;
    // An open search may now find more.
    let _ = app.emit("library-invalidated", ());
    Ok(count)
}
/// The link added by hand, and whether it came back from the trash.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct AddedLink {
    pub bookmark: Bookmark,
    pub restored: bool,
}
#[tauri::command]
pub async fn add_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    url: String,
    title: Option<String>,
    collection_id: Option<i64>,
    tags: Vec<String>,
) -> Result<AddedLink, CommandError> {
    let request = CaptureRequest {
        request_id: None,
        url,
        title,
        collection_id,
        tags: Some(tags),
    };
    let saved = blocking(&state, move |conn| {
        capture::save(conn, &request, Source::App).map_err(CommandError::from)
    })
    .await?;
    capture::after_save(&app, state.inner().clone(), &saved);
    let restored = saved.restored;
    saved
        .bookmark
        .map(|bookmark| AddedLink { bookmark, restored })
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
/// To the trash (NP-022); the interface offers to undo it right away.
#[tauri::command]
pub async fn trash_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Bookmark, CommandError> {
    let b = blocking(&state, move |conn| {
        db::trash_bookmark(conn, id).map_err(text)
    })
    .await?;
    capture::emit(&app, ChangeKind::Updated, &b);
    Ok(b)
}
/// Out of the trash with everything the bookmark had, inbox flag included.
#[tauri::command]
pub async fn restore_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Bookmark, CommandError> {
    let b = blocking(&state, move |conn| {
        db::restore_bookmark(conn, id, false).map_err(text)
    })
    .await?;
    capture::emit(&app, ChangeKind::Updated, &b);
    Ok(b)
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
) -> Result<capture::ImportSummary, CommandError> {
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
    pub close_to_tray: bool,
}
#[tauri::command]
pub async fn get_app_settings(state: State<'_, Arc<DbState>>) -> Result<AppSettings, CommandError> {
    blocking(&state, |conn| {
        Ok(AppSettings {
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
/// Which browsers are connected; the sidebar and Settings → Browser (NP-016).
#[tauri::command]
pub fn get_capture_status(state: State<'_, Arc<ChannelState>>) -> CaptureStatus {
    state.status(chrono::Utc::now())
}

/// «Повторить» when capture cannot work: registers the host again and reopens
/// the pipe if it failed.
#[tauri::command]
pub async fn repair_capture(
    app: AppHandle,
    state: State<'_, Arc<ChannelState>>,
) -> Result<CaptureStatus, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        capture_channel::register_host(&app, &state);
        if state.channel_failed() {
            if let Some(db) = app.try_state::<Arc<DbState>>() {
                capture_channel::start(app.clone(), db.inner().clone(), state.clone());
            }
        }
        state.status(chrono::Utc::now())
    })
    .await
    .map_err(CommandError::internal)
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

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, CommandError> {
    app.autolaunch()
        .is_enabled()
        .map_err(CommandError::internal)
}
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(CommandError::internal)
}

/// The «Data» block of the settings.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct DataSummary {
    pub library_folder: String,
    pub backups_folder: String,
    /// Copies in the backups folder, before-migration ones included.
    pub copies: u32,
    pub bytes: u64,
    /// The newest automatic copy, UTC.
    pub last_copy: Option<String>,
}
fn data_summary(library: &Library) -> DataSummary {
    let (copies, bytes, last) = crate::backup::summary(&library.paths.backups);
    DataSummary {
        library_folder: library.paths.folder().to_string_lossy().into_owned(),
        backups_folder: library.paths.backups.to_string_lossy().into_owned(),
        copies: copies as u32,
        bytes,
        last_copy: last.map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
    }
}
#[tauri::command]
pub fn get_data_summary(library: State<'_, Arc<Library>>) -> DataSummary {
    data_summary(&library)
}
/// A copy can take seconds on a large library, so it runs off the main thread.
#[tauri::command]
pub async fn back_up_now(library: State<'_, Arc<Library>>) -> Result<DataSummary, CommandError> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::back_up_now(&library.paths, chrono::Utc::now())
            .map_err(|error| CommandError::new(ErrorCode::DatabaseError, error))?;
        Ok(data_summary(&library))
    })
    .await
    .map_err(CommandError::internal)?
}
