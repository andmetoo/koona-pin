use crate::{
    browsers::CaptureStatus,
    capture::{self, CaptureRequest, ChangeKind},
    capture_channel::{self, ChannelState},
    db::{
        self, Bookmark, BookmarkPage, BookmarkQuery, Collection, DbState, DomainCount,
        LibraryCounts, Purge, Source, Suggestion, Tag,
    },
    error::{CommandError, ErrorCode},
    export, import,
    journal::{Action, Undo},
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

/// A changed bookmark and its place in the journal (NP-024).
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Changed {
    pub bookmark: Bookmark,
    /// What `undo` takes back; none when nothing changed.
    pub command: Option<i64>,
}

/// A change of one bookmark, recorded in the journal so it can be undone.
async fn journaled(
    app: &AppHandle,
    state: &State<'_, Arc<DbState>>,
    action: Action,
    id: i64,
    work: impl FnOnce(&Connection) -> rusqlite::Result<Bookmark> + Send + 'static,
) -> Result<Changed, CommandError> {
    let state = state.inner().clone();
    let changed = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        let (mut bookmarks, command) =
            journal.record(&conn, action, &[id], |conn| work(conn).map(|b| vec![b]))?;
        Ok::<_, CommandError>(Changed {
            bookmark: bookmarks.remove(0),
            command,
        })
    })
    .await
    .map_err(CommandError::internal)??;
    capture::emit(app, ChangeKind::Updated, &changed.bookmark);
    Ok(changed)
}

/// Ctrl Z (NP-024): the last command, or the one an undo notice names.
#[tauri::command]
pub async fn undo(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    command: Option<i64>,
) -> Result<Undo, CommandError> {
    let state = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        journal.undo(&conn, command).map_err(CommandError::from)
    })
    .await
    .map_err(CommandError::internal)??;
    if let Undo::Undone { bookmarks, .. } = &outcome {
        capture::emit_many(&app, bookmarks);
    }
    Ok(outcome)
}

/// What the selection bar asks for (NP-029, Р-27).
#[derive(Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
#[ts(export)]
pub enum BulkChange {
    /// Into a collection; none takes them out of any.
    Move { collection_id: Option<i64> },
    Tag { name: String },
    Favorite { favorite: bool },
    Trash,
    Restore,
    /// «Новая коллекция из выбранного»: created and filled in one go.
    NewCollection { name: String },
}

/// What a bulk action did.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct BulkChanged {
    /// Selected bookmarks the action applies to: in the library, or in the
    /// trash for «Восстановить». Those already as asked count too.
    pub count: u32,
    /// Bookmarks it actually changed.
    pub changed: u32,
    /// What `undo` takes back; none when nothing changed.
    pub command: Option<i64>,
    /// The collection «Новая коллекция из выбранного» created.
    pub collection: Option<Collection>,
}

/// One action on every selected bookmark: one transaction and one command
/// of the journal, so it is done whole or not at all and undone whole.
#[tauri::command]
pub async fn bulk_update(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    ids: Vec<i64>,
    change: BulkChange,
) -> Result<BulkChanged, CommandError> {
    // `Err` holds the name of the collection to create and fill.
    let (action, bulk) = match change {
        BulkChange::Move { collection_id } => (Action::Move, Ok(db::Bulk::Move(collection_id))),
        BulkChange::Tag { name } if name.trim().is_empty() => return Err(CommandError::invalid("Введите тег")),
        BulkChange::Tag { name } => (Action::Tag, Ok(db::Bulk::Tag(name))),
        BulkChange::Favorite { favorite } => (Action::Favorite, Ok(db::Bulk::Favorite(favorite))),
        BulkChange::Trash => (Action::Trash, Ok(db::Bulk::Trash)),
        BulkChange::Restore => (Action::Restore, Ok(db::Bulk::Restore)),
        BulkChange::NewCollection { name } if name.trim().is_empty() => {
            return Err(CommandError::invalid("Введите название коллекции"))
        }
        BulkChange::NewCollection { name } => (Action::Move, Err(name.trim().to_string())),
    };
    let state = state.inner().clone();
    let (done, changed) = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        let mut count = 0;
        let mut created = None;
        let (changed, command) = journal.record(&conn, action, &ids, |conn| match &bulk {
            Ok(bulk) => db::apply_bulk(conn, &ids, bulk).map(|(n, changed)| {
                count = n;
                changed
            }),
            Err(name) => db::bulk_into_new_collection(conn, &ids, name).map(|(collection, n, changed)| {
                count = n;
                created = Some(collection);
                changed
            }),
        })?;
        let done = BulkChanged { count: count as u32, changed: changed.len() as u32, command, collection: created };
        Ok::<_, CommandError>((done, changed))
    })
    .await
    .map_err(CommandError::internal)??;
    capture::emit_many(&app, &changed);
    Ok(done)
}

/// «Удалить навсегда…» on the selection in the trash, after the dialog:
/// how many went for good. No undo, as for one (Р-22).
#[tauri::command]
pub async fn delete_forever_many(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    ids: Vec<i64>,
) -> Result<u32, CommandError> {
    let gone = blocking(&state, move |conn| {
        db::purge_trash(conn, Purge::Some(&ids)).map_err(text)
    })
    .await?;
    capture::emit_deleted_many(&app, &gone);
    Ok(gone.len() as u32)
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
/// Every bookmark the query matches, ids only, in list order: `Ctrl A` and
/// what the selection bar counts as hidden by the search (NP-028).
#[tauri::command]
pub async fn get_bookmark_ids(
    state: State<'_, Arc<DbState>>,
    query: BookmarkQuery,
) -> Result<Vec<i64>, CommandError> {
    blocking(&state, move |conn| {
        db::get_bookmark_ids(conn, &query).map_err(text)
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
) -> Result<Changed, CommandError> {
    if patch.title.as_ref().is_some_and(|s| s.trim().is_empty()) {
        return Err(CommandError::invalid("Название не должно быть пустым"));
    }
    let plain = patch.title.is_none() && patch.notes.is_none();
    let keep = matches!(patch.collection, CollectionPatch::Keep);
    let action = match (patch.is_favorite, &patch.tags) {
        (None, None) if plain && keep => Action::Keep,
        (Some(_), None) if plain && keep => Action::Favorite,
        (None, Some(_)) if plain && keep => Action::Tag,
        (None, None) if plain && !keep => Action::Move,
        _ => Action::Edit,
    };
    let collection = match patch.collection {
        CollectionPatch::Keep => None,
        CollectionPatch::Clear => Some(None),
        CollectionPatch::Set(id) => Some(Some(id)),
    };
    journaled(&app, &state, action, id, move |conn| {
        db::update_bookmark(
            conn,
            id,
            patch.title,
            patch.notes,
            patch.is_favorite,
            collection,
            patch.tags,
        )
    })
    .await
}
/// To the trash (NP-022); the interface offers to undo it right away.
#[tauri::command]
pub async fn trash_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Changed, CommandError> {
    journaled(&app, &state, Action::Trash, id, move |conn| {
        db::trash_bookmark(conn, id)
    })
    .await
}
/// Out of the trash with everything the bookmark had, inbox flag included.
#[tauri::command]
pub async fn restore_bookmark(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Changed, CommandError> {
    journaled(&app, &state, Action::Restore, id, move |conn| {
        db::restore_bookmark(conn, id, false)
    })
    .await
}
/// «Удалить навсегда» in the trash (NP-023), after the dialog. A bookmark
/// in the library is never deleted at once.
#[tauri::command]
pub async fn delete_forever(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<(), CommandError> {
    let gone = blocking(&state, move |conn| {
        db::purge_trash(conn, Purge::One(id)).map_err(text)
    })
    .await?;
    let &(id, revision) = gone
        .first()
        .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "Этой закладки нет в корзине"))?;
    capture::emit_deleted(&app, id, revision);
    Ok(())
}
/// «Очистить корзину»: how many bookmarks went for good.
#[tauri::command]
pub async fn empty_trash(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
) -> Result<u32, CommandError> {
    let gone = blocking(&state, |conn| {
        db::purge_trash(conn, Purge::All).map_err(text)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    Ok(gone.len() as u32)
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
/// Triage: the collection the site's other bookmarks mostly lie in (NP-026).
#[tauri::command]
pub async fn suggest_collection(
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Option<Suggestion>, CommandError> {
    blocking(&state, move |conn| {
        db::suggest_collection(conn, id).map_err(text)
    })
    .await
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
/// What an export did (frame 29): nothing when the Save dialog was cancelled.
#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum ExportOutcome {
    Cancelled,
    Saved {
        file_name: String,
        count: u32,
    },
    /// Nothing was written: the old file, if any, is as it was.
    Failed {
        file_name: String,
        folder: String,
        problem: export::ExportProblem,
        detail: String,
    },
}

/// The last file an export saved: «Показать» reveals only that one.
#[derive(Default)]
pub struct LastExport(pub std::sync::Mutex<Option<std::path::PathBuf>>);

/// Menu «⋯» → Export (NP-032, Р-30): the system Save dialog, then the file
/// written next to the target and renamed over it when complete. With `ids`,
/// only the selected bookmarks (the selection bar, NP-029).
#[tauri::command]
pub async fn export_library(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    last: State<'_, LastExport>,
    format: export::ExportFormat,
    columns: Option<export::CsvColumns>,
    ids: Option<Vec<i64>>,
) -> Result<ExportOutcome, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    if format == export::ExportFormat::Csv && columns.is_none() {
        return Err(CommandError::invalid("CSV needs column titles"));
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(export::default_name(format, export::Scope::of(ids.as_deref())))
        .add_filter(format.extension().to_uppercase(), &[format.extension()]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(ExportOutcome::Cancelled);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let separator = export::list_separator();
    let (content, count) = blocking(&state, move |conn| {
        let scope = export::Scope::of(ids.as_deref());
        match format {
            export::ExportFormat::Html => export::html(conn, scope),
            export::ExportFormat::Json => export::json(conn, scope, chrono::Utc::now()),
            export::ExportFormat::Csv => export::csv(conn, scope, &columns.expect("checked above"), separator),
        }
        .map_err(text)
    })
    .await?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let folder = path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let target = path.clone();
    let written = tauri::async_runtime::spawn_blocking(move || export::write_atomically(&target, content.as_bytes()))
        .await
        .map_err(CommandError::internal)?;
    Ok(match written {
        Ok(()) => {
            *last.0.lock().map_err(CommandError::internal)? = Some(path);
            ExportOutcome::Saved { file_name, count: count as u32 }
        }
        Err(error) => ExportOutcome::Failed { file_name, folder, problem: export::problem_of(&error), detail: error.to_string() },
    })
}

/// «Показать» after an export: Explorer with the file selected.
#[tauri::command]
pub fn reveal_export(app: AppHandle, last: State<'_, LastExport>) -> Result<(), CommandError> {
    let path = last.0.lock().map_err(CommandError::internal)?.clone();
    let path = path.ok_or_else(|| CommandError::new(ErrorCode::NotFound, "Nothing was exported yet"))?;
    app.opener().reveal_item_in_dir(path).map_err(CommandError::internal)
}

/// Payload of `import-progress`: links written of all the file's links.
#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct ImportProgress {
    pub done: u32,
    pub total: u32,
}

/// A browser bookmarks file (NP-031): folders by the rule of Р-10, into the
/// library or the inbox, in one transaction off the main thread; the dialog
/// follows `import-progress` and shows the report.
#[tauri::command]
pub async fn import_html_bookmarks(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    html_content: String,
    to_inbox: Option<bool>,
) -> Result<import::ImportSummary, CommandError> {
    // Parsing needs no database, so the library stays available meanwhile.
    let parsed = tauri::async_runtime::spawn_blocking(move || {
        import::parse(&html_content, chrono::Utc::now())
    })
    .await
    .map_err(CommandError::internal)?;
    let progress = app.clone();
    let summary = blocking(&state, move |conn| {
        import::import(conn, &parsed, to_inbox.unwrap_or(false), |done, total| {
            let _ = progress.emit(
                "import-progress",
                ImportProgress {
                    done: done as u32,
                    total: total as u32,
                },
            );
        })
        .map_err(text)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    Ok(summary)
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
