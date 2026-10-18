use crate::{
    browsers::CaptureStatus,
    capture::{self, CaptureRequest, ChangeKind},
    capture_channel::{self, ChannelState},
    db::{
        self, Bookmark, BookmarkPage, BookmarkQuery, Collection, DbState, DomainCount,
        LibraryCounts, Purge, Source, Suggestion, Tag,
    },
    error::{CommandError, ErrorCode, ErrorDetail},
    backup, dedupe, export, feedback, import, linkcheck, mcp, metadata, offline, refresh, restore,
    journal::{Action, Undo},
    library_state::{self, Library, LibraryStatus},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

/// Every database command runs here, off the main thread. Sync Tauri
/// commands run on the main thread, so waiting for the database lock there
/// (during an import, a copy or a capture) would freeze the window.
pub(crate) async fn blocking<T: Send + 'static>(
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
    /// Into Reading, or out of it (NP-121).
    Reading { reading: bool },
    /// Marked read, or unread.
    Read { read: bool },
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
        BulkChange::Tag { name } if name.trim().is_empty() => return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyTag, "Enter a tag")),
        BulkChange::Tag { name } => (Action::Tag, Ok(db::Bulk::Tag(name))),
        BulkChange::Favorite { favorite } => (Action::Favorite, Ok(db::Bulk::Favorite(favorite))),
        BulkChange::Trash => (Action::Trash, Ok(db::Bulk::Trash)),
        BulkChange::Restore => (Action::Restore, Ok(db::Bulk::Restore)),
        BulkChange::Reading { reading: true } => (Action::ToReading, Ok(db::Bulk::Reading(true))),
        BulkChange::Reading { reading: false } => (Action::FromReading, Ok(db::Bulk::Reading(false))),
        BulkChange::Read { read: true } => (Action::Read, Ok(db::Bulk::Read(true))),
        BulkChange::Read { read: false } => (Action::Unread, Ok(db::Bulk::Read(false))),
        BulkChange::NewCollection { name } if name.trim().is_empty() => {
            return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyCollectionName, "Enter a collection name"))
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

/// How far an article was read, 0 to 1, from the reader (NP-122): at 1 it is
/// read. Not a command of the journal: reading is no change to undo.
#[tauri::command]
pub async fn set_reading_progress(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
    progress: f64,
) -> Result<Bookmark, CommandError> {
    let bookmark = blocking(&state, move |conn| crate::reading::set_progress(conn, id, progress).map_err(text)).await?;
    capture::emit(&app, ChangeKind::Updated, &bookmark);
    Ok(bookmark)
}

/// Whether every selected bookmark has a star: «В избранное» or «Из избранного».
#[tauri::command]
pub async fn all_favorite(state: State<'_, Arc<DbState>>, ids: Vec<i64>) -> Result<bool, CommandError> {
    blocking(&state, move |conn| db::all_favorite(conn, &ids).map_err(text)).await
}

/// The id, and so the colour, «Новая коллекция из выбранного» will get.
#[tauri::command]
pub async fn next_collection_id(state: State<'_, Arc<DbState>>) -> Result<i64, CommandError> {
    blocking(&state, |conn| db::next_collection_id(conn).map_err(text)).await
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
/// The link added by hand, and whether it came back from the trash or was
/// in the library already. Either way the bookmark keeps its own fields:
/// adding never overwrites what the person set.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct AddedLink {
    pub bookmark: Bookmark,
    pub restored: bool,
    pub existing: bool,
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
        reading: false,
    };
    let saved = blocking(&state, move |conn| {
        capture::save(conn, &request, Source::App).map_err(CommandError::from)
    })
    .await?;
    capture::after_save(&app, state.inner().clone(), &saved);
    let (restored, existing) = (saved.restored, saved.outcome == "existing");
    saved
        .bookmark
        .map(|bookmark| AddedLink { bookmark, restored, existing })
        .ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::BookmarkGone, "The bookmark no longer exists"))
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
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyTitle, "The title must not be empty"));
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
        .ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::NotInTrash, "This bookmark is not in the trash"))?;
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
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyCollectionName, "Enter a collection name"));
    }
    blocking(&state, move |conn| {
        db::create_collection(conn, name.trim(), color.as_deref(), icon.as_deref()).map_err(text)
    })
    .await
}
/// «Обновить превью» in the bookmark's menu (NP-087): the page is read again
/// with the rules of a capture (NP-019) — an imported link gets its picture,
/// a page that gained one shows it.
#[tauri::command]
pub async fn refresh_preview(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    id: i64,
) -> Result<Bookmark, CommandError> {
    let url = blocking(&state, move |conn| db::get_bookmark_by_id(conn, id).map(|b| b.url).map_err(text)).await?;
    let meta = metadata::fetch_metadata(&url).await;
    let bookmark = blocking(&state, move |conn| db::refresh_preview(conn, id, &url, &meta).map_err(text)).await?;
    capture::emit(&app, ChangeKind::Updated, &bookmark);
    crate::thumbs::warm(&app, &bookmark);
    Ok(bookmark)
}
/// The sidebar's order after a drag or `Alt ↑` / `Alt ↓` (NP-114): every
/// collection's id from first to last.
#[tauri::command]
pub async fn reorder_collections(
    state: State<'_, Arc<DbState>>,
    ids: Vec<i64>,
) -> Result<(), CommandError> {
    blocking(&state, move |conn| db::reorder_collections(conn, &ids).map_err(text)).await
}
/// The interface's language (NP-114): «Title A–Z» and «Site A–Z» compare as
/// it does. On start and on every change of language; the first call after
/// an update to schema 7, or a call with another language, writes every sort
/// key anew (about a second for 100 000 bookmarks). Returns whether it did.
#[tauri::command]
pub async fn set_sort_language(
    state: State<'_, Arc<DbState>>,
    language: String,
) -> Result<bool, CommandError> {
    blocking(&state, move |conn| crate::sorting::set_language(conn, &language).map_err(text)).await
}
/// A new library's first collections, named by the interface in its language
/// (NP-085). Made once: a library that already had them gets nothing.
#[tauri::command]
pub async fn create_starter_collections(
    state: State<'_, Arc<DbState>>,
    names: Vec<String>,
) -> Result<Vec<Collection>, CommandError> {
    blocking(&state, move |conn| db::create_starter_collections(conn, &names).map_err(text)).await
}
/// A new library's first collections and starter links (NP-117), in the
/// interface's language, made once like [`create_starter_collections`]. Then
/// the links' pages are read for their pictures and icons, one after another
/// in the background, the way «Обновить превью» does: the set's titles and
/// descriptions stay. Without a network the covers stay drawn from the address.
#[tauri::command]
pub async fn create_starter_library(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    names: Vec<String>,
    links: Vec<db::StarterLink>,
) -> Result<db::StarterLibrary, CommandError> {
    let made = blocking(&state, move |conn| db::create_starter_library(conn, &names, &links).map_err(text)).await?;
    if made.links.is_empty() {
        return Ok(made);
    }
    let _ = app.emit("library-invalidated", ());
    let pages: Vec<(i64, String)> = made.links.iter().map(|b| (b.id, b.url.clone())).collect();
    let db = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        for (id, url) in pages {
            let meta = metadata::fetch_metadata(&url).await;
            let updated = db
                .conn
                .lock()
                .map_err(|_| ())
                .and_then(|conn| db::refresh_preview(&conn, id, &url, &meta).map_err(|_| ()));
            if let Ok(bookmark) = updated {
                capture::emit(&app, ChangeKind::Updated, &bookmark);
            }
        }
    });
    Ok(made)
}
/// The starter links still in the library: triage names them (NP-117).
#[tauri::command]
pub async fn get_starter_links(state: State<'_, Arc<DbState>>) -> Result<Vec<i64>, CommandError> {
    blocking(&state, |conn| db::starter_link_ids(conn).map_err(text)).await
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
    blocking(&state, |conn| {
        let mut counts = db::get_counts(conn).map_err(text)?;
        counts.duplicates = dedupe::count(conn).map_err(text)?;
        counts.links = linkcheck::count(conn).map_err(text)?;
        (counts.reading, counts.reading_unread) = crate::reading::counts(conn).map_err(text)?;
        counts.offline = offline::count(conn).map_err(text)?;
        Ok(counts)
    })
    .await
}

/// The section «Дубликаты» (NP-035, sheet 34). Keys missing from rows an
/// older build or another program wrote are filled first; a read-only
/// (damaged) library shows the groups it already knows.
#[tauri::command]
pub async fn get_duplicates(state: State<'_, Arc<DbState>>) -> Result<Vec<dedupe::DuplicateGroup>, CommandError> {
    blocking(&state, |conn| {
        let _ = dedupe::fill_keys(conn);
        dedupe::groups(conn).map_err(text)
    })
    .await
}

/// What «Объединить» did.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Merged {
    pub groups: u32,
    /// Bookmarks moved to the trash.
    pub trashed: u32,
    /// The bookmark kept, when one group was merged: the notice names it.
    pub title: Option<String>,
    pub command: Option<i64>,
}

/// «Объединить» and «Объединить все»: one transaction and one command of the
/// journal, so `Ctrl Z` takes the whole merge back.
#[tauri::command]
pub async fn merge_duplicates(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    groups: Vec<dedupe::MergeGroup>,
) -> Result<Merged, CommandError> {
    let state = state.inner().clone();
    let (merged, changed) = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        let ids: Vec<i64> = groups.iter().flat_map(|g| std::iter::once(g.main).chain(g.others.iter().copied())).collect();
        let (changed, command) = journal.record(&conn, Action::Merge, &ids, |conn| dedupe::merge(conn, &groups))?;
        let title = match groups.as_slice() {
            [one] => changed.iter().find(|b| b.id == one.main).map(|b| b.title.clone()),
            _ => None,
        };
        let merged = Merged {
            groups: groups.iter().filter(|g| !g.others.is_empty()).count() as u32,
            trashed: changed.iter().filter(|b| b.deleted_at.is_some()).count() as u32,
            title,
            command,
        };
        Ok::<_, CommandError>((merged, changed))
    })
    .await
    .map_err(CommandError::internal)??;
    capture::emit_many(&app, &changed);
    Ok(merged)
}

/// «Не дубликаты»: the group is hidden until another twin arrives. No
/// bookmark changes: `duplicates-changed` tells the count and the section.
#[tauri::command]
pub async fn dismiss_duplicates(app: AppHandle, state: State<'_, Arc<DbState>>, key: String, ids: Vec<i64>) -> Result<u32, CommandError> {
    let hidden = blocking(&state, move |conn| dedupe::dismiss(conn, &key, &ids).map(|n| n as u32).map_err(text)).await?;
    let _ = app.emit("duplicates-changed", ());
    Ok(hidden)
}

/// «Отменить» after «Не дубликаты»: the group is shown again.
#[tauri::command]
pub async fn undismiss_duplicates(app: AppHandle, state: State<'_, Arc<DbState>>, key: String, ids: Vec<i64>) -> Result<u32, CommandError> {
    let shown = blocking(&state, move |conn| dedupe::undismiss(conn, &key, &ids).map(|n| n as u32).map_err(text)).await?;
    let _ = app.emit("duplicates-changed", ());
    Ok(shown)
}
/// The section «Проверка ссылок» (NP-036, sheet 35).
#[tauri::command]
pub async fn get_link_check(app: AppHandle, state: State<'_, Arc<DbState>>) -> Result<linkcheck::LinkCheckReport, CommandError> {
    blocking(&state, move |conn| app.state::<linkcheck::Checker>().report(conn).map_err(text)).await
}

/// «Проверить 1 248 ссылок», «Проверить снова», «Продолжить», «Повторить»:
/// the check runs in the background and reports through `link-check`. With
/// `ids`, only those bookmarks; `resume` goes on with the check stopped.
#[tauri::command]
pub async fn start_link_check(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    ids: Option<Vec<i64>>,
    resume: bool,
) -> Result<(), CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || linkcheck::start(app, state, ids, resume))
        .await
        .map_err(CommandError::internal)?
        .map_err(|e| CommandError::new(ErrorCode::DatabaseError, e))
}

/// «Остановить»: at once; what was found stays.
#[tauri::command]
pub fn stop_link_check(checker: State<'_, linkcheck::Checker>) {
    checker.stop();
}

/// «Обновить превью» for many bookmarks: the run of this session, so the
/// interface picks it up after a reload.
#[tauri::command]
pub fn get_preview_refresh(refresher: State<'_, refresh::Refresher>) -> refresh::PreviewRefresh {
    refresher.state()
}

/// The counts of the choice in Settings: without a picture or site name, and all.
#[tauri::command]
pub async fn get_preview_counts(state: State<'_, Arc<DbState>>) -> Result<refresh::Counts, CommandError> {
    blocking(&state, |conn| refresh::counts(conn).map_err(text)).await
}

/// Reads the pages of `scope`, or of the bookmarks `ids`, again in the
/// background and reports through `preview-refresh`. While a run is under
/// way, returns its state and starts nothing.
#[tauri::command]
pub async fn start_preview_refresh(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    scope: Option<refresh::Scope>,
    ids: Option<Vec<i64>>,
) -> Result<refresh::PreviewRefresh, CommandError> {
    let target = match (ids, scope) {
        (Some(ids), _) => refresh::Target::Ids(ids),
        (None, Some(scope)) => refresh::Target::Scope(scope),
        (None, None) => return Err(CommandError::new(ErrorCode::InvalidRequest, "Choose the bookmarks to refresh")),
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || refresh::start(app, state, target, false))
        .await
        .map_err(CommandError::internal)?
        .map_err(|e| CommandError::new(ErrorCode::DatabaseError, e))
}

/// «Остановить»: the pages under way finish, no other starts.
#[tauri::command]
pub fn stop_preview_refresh(refresher: State<'_, refresh::Refresher>) {
    refresher.stop();
}

/// What «Заменить адрес» and «Заменить все» did.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Replaced {
    pub replaced: u32,
    /// Not replaced: the new address is already saved, or the result no longer holds.
    pub skipped: u32,
    /// The new address, when one bookmark changed: the notice names its site.
    pub address: Option<String>,
    pub command: Option<i64>,
}

/// Each moved bookmark takes the address its page moved to: one transaction
/// and one command of the journal, so `Ctrl Z` takes it all back.
#[tauri::command]
pub async fn replace_addresses(app: AppHandle, state: State<'_, Arc<DbState>>, ids: Vec<i64>) -> Result<Replaced, CommandError> {
    let state = state.inner().clone();
    let (replaced, changed) = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        let mut skipped = 0;
        let (changed, command) = journal.record(&conn, Action::Replace, &ids, |conn| {
            linkcheck::replace(conn, &ids).map(|(changed, s)| {
                skipped = s;
                changed
            })
        })?;
        let address = match changed.as_slice() {
            [one] => Some(one.url.clone()),
            _ => None,
        };
        let replaced = Replaced { replaced: changed.len() as u32, skipped: skipped as u32, address, command };
        Ok::<_, CommandError>((replaced, changed))
    })
    .await
    .map_err(CommandError::internal)??;
    capture::emit_many(&app, &changed);
    Ok(replaced)
}

/// The report «Показать отчёт» shows and «Приложить отчёт» attaches (NP-088).
/// Off the main thread: it reads the registry and waits for the capture state,
/// which the capture thread holds while it writes to the library.
#[tauri::command]
pub async fn feedback_report(app: AppHandle, channel: State<'_, Arc<ChannelState>>, language: String) -> Result<String, CommandError> {
    let channel = channel.inner().clone();
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned());
        feedback::report(&channel.status(chrono::Utc::now()), &version, &feedback::system_lines(), &language, home.as_deref())
    })
    .await
    .map_err(CommandError::internal)
}

/// «Отправить»: the one request to the feedback service (NP-088, Р-9).
#[tauri::command]
pub async fn send_feedback(app: AppHandle, feedback: feedback::Feedback) -> Result<(), CommandError> {
    let payload = feedback::payload(feedback, &app.package_info().version.to_string(), &feedback::os_name())?;
    let Some(endpoint) = feedback::ENDPOINT else {
        return Err(CommandError::detailed(
            ErrorCode::Network,
            ErrorDetail::ServiceFailed,
            "This build has no feedback address (KOONAPIN_FEEDBACK_URL)",
        ));
    };
    feedback::send(endpoint, &payload, feedback::LIMITS).await
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
    let path = path.ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::NothingExported, "Nothing was exported yet"))?;
    app.opener().reveal_item_in_dir(path).map_err(CommandError::internal)
}

/// The check of a JSON copy before the restore (frame 30).
#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum RestoreCheck {
    Ready { preview: restore::RestorePreview },
    Rejected { problem: restore::RestoreProblem },
}

/// What a restore did; on `rejected` and `backup_failed` nothing was changed.
#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum RestoreOutcome {
    Restored { summary: restore::RestoreSummary },
    Rejected { problem: restore::RestoreProblem },
    BackupFailed { detail: String },
}

/// Menu «⋯» → «Резервная копия Koona Pin (JSON)»: reads and checks the
/// whole copy, changes nothing (NP-033).
#[tauri::command]
pub async fn check_restore(state: State<'_, Arc<DbState>>, content: String) -> Result<RestoreCheck, CommandError> {
    blocking(&state, move |conn| match restore::check(&content) {
        Ok(library) => Ok(RestoreCheck::Ready { preview: restore::preview(conn, &library).map_err(text)? }),
        Err(problem) => Ok(RestoreCheck::Rejected { problem }),
    })
    .await
}

/// Merges the copy into the library or replaces the library with it, after
/// checking it again (Р-31). A replace writes a backup first and empties the
/// undo journal: its commands point at bookmarks that are gone.
#[tauri::command]
pub async fn restore_library(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    library: State<'_, Arc<Library>>,
    content: String,
    mode: restore::RestoreMode,
) -> Result<RestoreOutcome, CommandError> {
    let backups = library.paths.backups.clone();
    let state = state.inner().clone();
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let copy = match restore::check(&content) {
            Ok(copy) => copy,
            Err(problem) => return Ok(RestoreOutcome::Rejected { problem }),
        };
        let conn = state.conn.lock().map_err(CommandError::internal)?;
        let mut journal = state.journal.lock().map_err(CommandError::internal)?;
        match restore::restore(&conn, &copy, mode, &backups) {
            Ok(summary) => {
                if mode == restore::RestoreMode::Replace {
                    journal.clear();
                    // Still under the lock: a link check or a refresh of previews writes nothing into the new library.
                    handle.state::<linkcheck::Checker>().abandon();
                    handle.state::<refresh::Refresher>().abandon();
                    // The replaced bookmarks' copies.
                    let _ = offline::sweep(&conn);
                }
                Ok(RestoreOutcome::Restored { summary })
            }
            Err(restore::RestoreError::Backup(detail)) => Ok(RestoreOutcome::BackupFailed { detail }),
            Err(restore::RestoreError::Database(e)) => Err(CommandError::from(e)),
        }
    })
    .await
    .map_err(CommandError::internal)??;
    if matches!(outcome, RestoreOutcome::Restored { .. }) {
        let _ = app.emit("library-invalidated", ());
    }
    Ok(outcome)
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
    // The new bookmarks have only their addresses: their pages are read for
    // pictures, icons and site names in the background, joining a run under way.
    if !summary.created.is_empty() {
        let (state, ids) = (state.inner().clone(), summary.created.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || refresh::start(app, state, refresh::Target::Ids(ids), true)).await;
    }
    Ok(summary)
}
#[derive(Serialize, TS)]
#[ts(export)]
pub struct AppSettings {
    pub close_to_tray: bool,
    /// «Mark as read at the end» of Settings → Reading (NP-124); on by default.
    pub reading_mark_at_end: bool,
    /// «Save articles I open in Reading» (NP-126); off by default.
    pub reading_save_offline: bool,
    /// «Check for new posts» of Settings → Feeds (NP-128), in minutes; 60 by
    /// default, 0 only when the person refreshes.
    pub feeds_refresh_minutes: u32,
}
#[tauri::command]
pub async fn get_app_settings(state: State<'_, Arc<DbState>>) -> Result<AppSettings, CommandError> {
    blocking(&state, |conn| {
        Ok(AppSettings {
            close_to_tray: db::setting(conn, "close_to_tray").map_err(text)? == "true",
            reading_mark_at_end: crate::reading::mark_at_end(conn),
            reading_save_offline: offline::save_on_open(conn),
            feeds_refresh_minutes: crate::feeds::refresh_minutes(conn),
        })
    })
    .await
}
/// «Save articles I open in Reading» (NP-126): the reader saves a copy of
/// what it opened from Reading.
#[tauri::command]
pub async fn set_reading_save_offline(state: State<'_, Arc<DbState>>, enabled: bool) -> Result<(), CommandError> {
    blocking(&state, move |conn| {
        db::set_setting(conn, offline::SAVE_SETTING, if enabled { "true" } else { "false" }).map_err(text)
    })
    .await
}

/// Saves the article the reader extracted as the bookmark's offline copy
/// (NP-126), replacing the one it had. Pictures are fetched without the
/// library lock; the list hears of the copy as of any other change.
#[tauri::command]
pub async fn save_offline_copy(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    bookmark_id: i64,
    article: offline::OfflineArticle,
) -> Result<offline::OfflineCopy, CommandError> {
    let root = blocking(&state, move |conn| offline::start(conn, bookmark_id)).await?;
    let staged = offline::stage(&root, bookmark_id, &article, &offline::LIMITS, &offline::CAPS).await?;
    let (copy, bookmark) = blocking(&state, move |conn| offline::finish(conn, &root, bookmark_id, &article, staged)).await?;
    capture::emit(&app, ChangeKind::Updated, &bookmark);
    Ok(copy)
}
/// The bookmark's copy to read, pictures inline; none without one.
#[tauri::command]
pub async fn get_offline_copy(
    state: State<'_, Arc<DbState>>,
    bookmark_id: i64,
) -> Result<Option<offline::OfflineCopyContent>, CommandError> {
    let files = blocking(&state, move |conn| match offline::root(conn) {
        Some(root) => offline::read(conn, &root, bookmark_id).map_err(text),
        None => Ok(None),
    })
    .await?;
    // Encoding the pictures needs no lock.
    Ok(files.and_then(offline::content))
}
#[tauri::command]
pub async fn remove_offline_copy(app: AppHandle, state: State<'_, Arc<DbState>>, bookmark_id: i64) -> Result<(), CommandError> {
    let bookmark = blocking(&state, move |conn| {
        let root = offline::root(conn).ok_or_else(|| CommandError::internal("the library has no folder"))?;
        offline::remove(conn, &root, bookmark_id).map_err(text)?;
        Ok(db::get_bookmark_by_id(conn, bookmark_id).ok())
    })
    .await?;
    if let Some(bookmark) = bookmark {
        capture::emit(&app, ChangeKind::Updated, &bookmark);
    }
    Ok(())
}
/// «Remove all copies» of Settings → Reading: how many there were.
#[tauri::command]
pub async fn remove_all_offline_copies(app: AppHandle, state: State<'_, Arc<DbState>>) -> Result<u32, CommandError> {
    let removed = blocking(&state, |conn| {
        let root = offline::root(conn).ok_or_else(|| CommandError::internal("the library has no folder"))?;
        offline::remove_all(conn, &root).map_err(text)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    Ok(removed as u32)
}
#[tauri::command]
pub async fn offline_stats(state: State<'_, Arc<DbState>>) -> Result<offline::OfflineStats, CommandError> {
    blocking(&state, |conn| offline::stats(conn).map_err(text)).await
}
/// «Show folder»: the folder of copies, made if there is none yet.
#[tauri::command]
pub async fn reveal_offline_folder(app: AppHandle, state: State<'_, Arc<DbState>>) -> Result<(), CommandError> {
    let root = blocking(&state, |conn| offline::root(conn).ok_or_else(|| CommandError::internal("the library has no folder"))).await?;
    std::fs::create_dir_all(&root).map_err(CommandError::internal)?;
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(CommandError::internal)
}
/// «Mark as read at the end» (NP-124): whether the reader's end of an article marks it read.
#[tauri::command]
pub async fn set_reading_mark_at_end(state: State<'_, Arc<DbState>>, enabled: bool) -> Result<(), CommandError> {
    blocking(&state, move |conn| {
        db::set_setting(conn, crate::reading::MARK_AT_END_SETTING, if enabled { "true" } else { "false" }).map_err(text)
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
/// «Hide window» in the dialog of the first close without a tray (NP-096):
/// from then on closing just hides the window.
#[tauri::command]
pub async fn hide_to_background(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
) -> Result<(), CommandError> {
    blocking(&state, |conn| {
        db::set_setting(conn, "background_explained", "true").map_err(text)
    })
    .await?;
    state.background_explained.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        crate::desktop::hide(&window.as_ref().window()).map_err(CommandError::internal)?;
    }
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

/// Linux keeps its own XDG autostart entry (`autostart::xdg`, NP-097).
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, CommandError> {
    #[cfg(target_os = "linux")]
    return {
        let _ = app;
        Ok(crate::autostart::xdg::is_enabled())
    };
    #[cfg(not(target_os = "linux"))]
    app.autolaunch()
        .is_enabled()
        .map_err(CommandError::internal)
}
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    #[cfg(target_os = "linux")]
    return {
        let _ = app;
        if enabled {
            crate::autostart::xdg::enable()
        } else {
            crate::autostart::xdg::disable()
        }
        .map_err(CommandError::internal)
    };
    #[cfg(not(target_os = "linux"))]
    {
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(CommandError::internal)
    }
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
pub async fn back_up_now(app: AppHandle, library: State<'_, Arc<Library>>) -> Result<DataSummary, CommandError> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let copy = crate::library::back_up_now(&library.paths, chrono::Utc::now())
            .map_err(|error| CommandError::new(ErrorCode::DatabaseError, error))?;
        // A Supporter's chosen folder gets this copy too (commercial/backup_folder.rs), without
        // holding the button: a cloud or network folder can be slow, its row says how it went.
        std::thread::spawn(move || crate::commercial::backup_folder::mirror(&app, &copy));
        Ok(data_summary(&library))
    })
    .await
    .map_err(CommandError::internal)?
}

/// What «Save a copy…» did: nothing when the Save dialog was cancelled.
#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum SaveCopyOutcome {
    Cancelled,
    Saved { file_name: String },
    /// Nothing was written: the old file, if any, is as it was.
    Failed { file_name: String, detail: String },
}

/// «Save a copy…» (sheet 33): the system Save dialog, then the same checked
/// copy as «Back up now», written next to the target and renamed over it.
/// «Show» reveals it like an export.
#[tauri::command]
pub async fn save_backup_copy(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    last: State<'_, LastExport>,
) -> Result<SaveCopyOutcome, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let name = format!("koona-pin-backup-{}.db", chrono::Local::now().format("%Y-%m-%d"));
    let mut dialog = app.dialog().file().set_file_name(name).add_filter("Koona Pin", &["db"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(SaveCopyOutcome::Cancelled);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (library, target) = (library.inner().clone(), path.clone());
    let written = tauri::async_runtime::spawn_blocking(move || crate::library::save_copy(&library.paths, &target))
        .await
        .map_err(CommandError::internal)?;
    Ok(match written {
        Ok(()) => {
            *last.0.lock().map_err(CommandError::internal)? = Some(path);
            SaveCopyOutcome::Saved { file_name }
        }
        Err(detail) => SaveCopyOutcome::Failed { file_name, detail },
    })
}

/// The copies the restore dialog lists, newest first.
#[tauri::command]
pub async fn list_backups(library: State<'_, Arc<Library>>) -> Result<Vec<backup::BackupCopy>, CommandError> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup::list(&library.paths.backups))
        .await
        .map_err(CommandError::internal)
}

/// The file «Choose a file…» picked and checked; a restore from it reads only this path.
#[derive(Default)]
pub struct PickedBackup(pub std::sync::Mutex<Option<std::path::PathBuf>>);

#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum PickedCopy {
    Cancelled,
    Ready { copy: backup::BackupCopy },
    Rejected { file_name: String, problem: crate::library::CopyProblem },
}

/// «Choose a file…»: the system Open dialog in the backups folder, then the
/// file is checked in full; nothing is changed.
#[tauri::command]
pub async fn pick_backup(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    picked: State<'_, PickedBackup>,
) -> Result<PickedCopy, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Koona Pin", &["db"])
        .set_directory(&library.paths.backups);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let chosen = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(chosen) = chosen else {
        return Ok(PickedCopy::Cancelled);
    };
    let path = chosen.into_path().map_err(CommandError::internal)?;
    let checked = path.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let file_name = checked.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match crate::library::check_copy(&checked) {
            Ok(bookmarks) => match backup::describe(&checked) {
                Some(copy) => PickedCopy::Ready { copy: backup::BackupCopy { bookmarks: Some(bookmarks), ..copy } },
                None => PickedCopy::Rejected { file_name, problem: crate::library::CopyProblem::Unreadable { detail: String::new() } },
            },
            Err(problem) => PickedCopy::Rejected { file_name, problem },
        }
    })
    .await
    .map_err(CommandError::internal)?;
    *picked.0.lock().map_err(CommandError::internal)? = matches!(outcome, PickedCopy::Ready { .. }).then_some(path);
    Ok(outcome)
}

/// The largest file «Import a file…» reads: a full copy's cap, the biggest of the kinds it takes
/// (share-bundle.md, «"Import a file…" and the sniffer»). The page checks each kind's own cap
/// once it knows the kind.
pub const IMPORT_FILE_CAP: u64 = 256 * 1024 * 1024;

#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum PickedImport {
    Cancelled,
    /// The file's name, size and text, to be sniffed by the page as a dropped file is.
    Picked { name: String, bytes: u32, text: String },
    /// Over `IMPORT_FILE_CAP`: not read.
    TooBig { name: String },
}

/// The text of a file of at most `cap` bytes, or `None` when it is bigger. The read itself stops
/// past the cap, so a file that grows after its size was taken is not read whole either. Not
/// UTF-8 is replaced, as the webview's `File.text()` does for a dropped file.
pub fn read_capped(path: &std::path::Path, cap: u64) -> std::io::Result<Option<(u32, String)>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size > cap {
        return Ok(None);
    }
    // Sized once from the metadata (still within the cap); one more byte tells a file that grew.
    let mut bytes = Vec::with_capacity(size as usize + 1);
    file.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Ok(None);
    }
    // The cap is far under 4 GB, so the size fits.
    let read = bytes.len() as u32;
    // Valid UTF-8 becomes the String without a copy; only a file that is not pays for one.
    let text = String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    Ok(Some((read, text)))
}

/// «Import a file…» in the ⋯ menu: the system Open dialog for any file, read up to the largest
/// cap; what it is is the page's sniffer's call, as for a drop. Nothing is imported here.
#[tauri::command]
pub async fn pick_import_file(app: AppHandle) -> Result<PickedImport, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let chosen = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(chosen) = chosen else {
        return Ok(PickedImport::Cancelled);
    };
    let path = chosen.into_path().map_err(CommandError::internal)?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(match read_capped(&path, IMPORT_FILE_CAP).map_err(CommandError::internal)? {
            Some((bytes, text)) => PickedImport::Picked { name, bytes, text },
            None => PickedImport::TooBig { name },
        })
    })
    .await
    .map_err(CommandError::internal)?
}

/// Where a restore takes its copy.
#[derive(Deserialize, TS)]
#[serde(tag = "from", rename_all = "snake_case")]
#[ts(export)]
pub enum BackupSource {
    Listed { file_name: String },
    /// The file «Choose a file…» checked last.
    Picked,
}

/// What a restore did; on anything but `restored` nothing was changed.
#[derive(Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum BackupRestoreOutcome {
    Restored {
        bookmarks: u32,
        /// The copy of the library as it was, in the backups folder.
        previous: String,
    },
    Rejected { problem: crate::library::CopyProblem },
    BackupFailed { detail: String },
    Failed { detail: String },
}

/// Restores a backup (NP-034, sheet 33). Into the open library in place: the
/// undo journal is cleared, the damage flag goes, the window reloads. When the
/// library did not open (frame 12), its files are replaced and it opens again.
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    picked: State<'_, PickedBackup>,
    source: BackupSource,
) -> Result<BackupRestoreOutcome, CommandError> {
    let library = library.inner().clone();
    let path = match source {
        BackupSource::Listed { file_name } => backup::listed(&library.paths.backups, &file_name),
        BackupSource::Picked => picked.0.lock().map_err(CommandError::internal)?.clone(),
    }
    .ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::CopyGone, "The copy is gone"))?;
    let db = app.try_state::<Arc<DbState>>().map(|state| state.inner().clone());
    let closed = matches!(library.status(), LibraryStatus::Failed(_));
    if db.is_none() && !closed {
        return Err(CommandError::detailed(ErrorCode::DatabaseBusy, ErrorDetail::LibraryOpening, "The library is still opening"));
    }
    let paths = library.paths.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match db {
        Some(db) => {
            let mut conn = db.conn.lock().map_err(CommandError::internal)?;
            let mut journal = db.journal.lock().map_err(CommandError::internal)?;
            let result = crate::library::restore_into(&mut conn, &paths, &path);
            if result.is_ok() {
                // Its commands point at bookmarks of the replaced library.
                journal.clear();
                // Still under the lock: a link check or a refresh of previews writes nothing into the new library.
                handle.state::<linkcheck::Checker>().abandon();
                handle.state::<refresh::Refresher>().abandon();
                db.reload_settings(&conn);
                // Copies the restored library has no rows for, and rows of copies since removed.
                let _ = offline::sweep(&conn);
            }
            Ok::<_, CommandError>(result)
        }
        None => Ok(crate::library::restore_closed(&paths, &path)),
    })
    .await
    .map_err(CommandError::internal)??;
    Ok(match result {
        Ok(restored) => {
            if closed {
                if library.begin_retry() {
                    library_state::start(app);
                }
            } else {
                library.restored(&app);
                let _ = app.emit("library-invalidated", ());
            }
            BackupRestoreOutcome::Restored {
                bookmarks: restored.bookmarks,
                previous: restored.previous.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            }
        }
        Err(crate::library::RestoreFailure::Rejected(problem)) => BackupRestoreOutcome::Rejected { problem },
        Err(crate::library::RestoreFailure::Backup(detail)) => BackupRestoreOutcome::BackupFailed { detail },
        Err(crate::library::RestoreFailure::Failed(detail)) => BackupRestoreOutcome::Failed { detail },
    })
}

/// «Show» after a restore: Explorer with the copy of the replaced library selected.
#[tauri::command]
pub fn reveal_backup(app: AppHandle, library: State<'_, Arc<Library>>, file_name: String) -> Result<(), CommandError> {
    let path = backup::listed(&library.paths.backups, &file_name)
        .ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::CopyGone, "The copy is gone"))?;
    app.opener().reveal_item_in_dir(path).map_err(CommandError::internal)
}

/// Settings → AI assistants (NP-091): access and the last request.
#[tauri::command]
pub async fn get_mcp_status(state: State<'_, Arc<DbState>>) -> Result<mcp::McpStatus, CommandError> {
    blocking(&state, |conn| Ok(mcp::status(conn))).await
}

/// Off, read only, or read and add; the settings and every open window hear of it.
#[tauri::command]
pub async fn set_mcp_access(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    access: crate::mcp_tools::Access,
) -> Result<mcp::McpStatus, CommandError> {
    let status = blocking(&state, move |conn| {
        mcp::set_access(conn, access)?;
        Ok(mcp::status(conn))
    })
    .await?;
    let _ = app.emit("mcp-status", status.clone());
    Ok(status)
}

/// «How to connect…»: the commands and JSON with this computer's path.
#[tauri::command]
pub fn get_mcp_setup() -> Result<mcp::McpSetup, CommandError> {
    mcp::server_path().map(|server| mcp::setup(&server)).map_err(CommandError::internal)
}

/// «Save for Claude Desktop…»: `koona-pin.mcpb` where the person saves it,
/// Downloads by default, then shown in the file manager. Opening the file
/// from the app failed: on Windows Claude Desktop does not always take the
/// file type, and a package in the temporary folder could not be found to
/// open by hand. The dialog says how to install it. None when cancelled.
#[tauri::command]
pub async fn save_mcpb(app: AppHandle) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let server = mcp::server_path().map_err(CommandError::internal)?;
    if !server.is_file() {
        return Err(CommandError::detailed(ErrorCode::NotFound, ErrorDetail::ServerMissing, "koonapin-mcp is not next to the app"));
    }
    let mut dialog = app.dialog().file().set_file_name("koona-pin.mcpb").add_filter("Claude Desktop", &["mcpb"]);
    if let Some(downloads) = dirs::download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || mcp::write_bundle(&server, &target))
        .await
        .map_err(CommandError::internal)?
        .map_err(CommandError::internal)?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(Some(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_capped_reads_up_to_the_cap_and_refuses_past_it() {
        let dir = std::env::temp_dir().join(format!("koonapin-read-capped-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bookmarks.html");
        std::fs::write(&path, b"<DL>\xff</DL>").unwrap();
        // At the cap the file is read, with bytes that are not UTF-8 replaced.
        assert_eq!(read_capped(&path, 10).unwrap(), Some((10, "<DL>\u{fffd}</DL>".to_string())));
        // One byte over: not read.
        assert_eq!(read_capped(&path, 9).unwrap(), None);
        // Valid UTF-8 comes back as it is.
        std::fs::write(&path, "<DL>Ёлка</DL>").unwrap();
        assert_eq!(read_capped(&path, 64).unwrap(), Some((17, "<DL>Ёлка</DL>".to_string())));
        assert!(read_capped(&dir.join("missing"), IMPORT_FILE_CAP).is_err());
        assert_eq!(IMPORT_FILE_CAP, 256 * 1024 * 1024);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}