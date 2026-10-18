use crate::db::{self, Bookmark, DbState, Source};
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use crate::metadata;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use ts_rs::TS;
use url::Url;

#[derive(Debug, Deserialize)]
pub struct CaptureRequest {
    pub request_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub collection_id: Option<i64>,
    pub tags: Option<Vec<String>>,
    /// «Save to Reading» in the extension (NP-125): the link also goes to
    /// Reading. Inbox rules do not change: a new link waits there as well.
    #[serde(default)]
    pub reading: bool,
}
#[derive(Debug, Serialize)]
pub struct CaptureResult {
    pub bookmark_id: i64,
    pub outcome: String,
    #[serde(skip)]
    pub bookmark: Option<Bookmark>,
    #[serde(skip)]
    pub newly_created: bool,
    /// The link was in the trash and came back to the inbox (Р-10, point 2).
    /// The wire says `outcome: "created"` with `restored: true`: extensions
    /// 0.3 and older know only `created` and `existing`.
    #[serde(skip)]
    pub restored: bool,
    /// Asked for Reading and in Reading now (NP-125), as the reply says.
    #[serde(skip)]
    pub reading: bool,
    /// This save put an existing link in Reading: the interface hears of it.
    #[serde(skip)]
    pub reading_changed: bool,
}
/// `code` and `status` are the HTTP v1 contract and do not change; IPC gets
/// the finer `ipc` code (NP-007).
#[derive(Debug, Serialize)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip)]
    pub status: u16,
    #[serde(skip)]
    pub ipc: ErrorCode,
    /// What the interface says about it; the extension has its own words.
    #[serde(skip)]
    pub detail: Option<ErrorDetail>,
}
impl CaptureError {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
            status: 400,
            ipc: ErrorCode::InvalidRequest,
            detail: None,
        }
    }
    fn invalid_url(detail: ErrorDetail, message: &str) -> Self {
        Self {
            detail: Some(detail),
            ..Self::invalid(message)
        }
    }
    fn database(e: rusqlite::Error) -> Self {
        Self {
            code: "database_error",
            message: e.to_string(),
            status: 500,
            ipc: crate::error::code_of(&e),
            detail: None,
        }
    }
}
impl From<CaptureError> for CommandError {
    fn from(error: CaptureError) -> Self {
        CommandError {
            detail: error.detail,
            ..CommandError::new(error.ipc, error.message)
        }
    }
}
pub fn validate_url(raw: &str) -> Result<String, CaptureError> {
    let raw = raw.trim();
    let parsed = Url::parse(raw).map_err(|_| CaptureError::invalid_url(ErrorDetail::InvalidUrl, "Not a valid link"))?;
    if raw.len() > 8192
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
    {
        return Err(CaptureError::invalid_url(
            ErrorDetail::UnsupportedUrl,
            "Only HTTP and HTTPS links are supported",
        ));
    }
    Ok(raw.to_owned())
}
pub fn save(
    conn: &Connection,
    request: &CaptureRequest,
    source: Source,
) -> Result<CaptureResult, CaptureError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(CaptureError::database)?;
    let result = save_in(&tx, request, source)?;
    tx.commit().map_err(CaptureError::database)?;
    Ok(result)
}

/// A link an AI assistant saves over MCP (NP-091): to the inbox like a
/// capture, from `mcp`, with the assistant's name in the same transaction.
/// A link already there keeps its own source.
pub fn save_by_assistant(
    conn: &Connection,
    url: &str,
    title: Option<String>,
    assistant: &str,
) -> Result<CaptureResult, CaptureError> {
    let request = CaptureRequest {
        request_id: None,
        url: url.into(),
        title,
        collection_id: None,
        tags: None,
        reading: false,
    };
    let tx = conn
        .unchecked_transaction()
        .map_err(CaptureError::database)?;
    let mut result = save_in(&tx, &request, Source::Mcp)?;
    if result.newly_created {
        db::set_source_name(&tx, result.bookmark_id, assistant).map_err(CaptureError::database)?;
        result.bookmark = Some(db::get_bookmark_by_id(&tx, result.bookmark_id).map_err(CaptureError::database)?);
    }
    tx.commit().map_err(CaptureError::database)?;
    Ok(result)
}

/// The caller owns the transaction; nothing is confirmed before its commit.
fn save_in(
    tx: &Connection,
    request: &CaptureRequest,
    source: Source,
) -> Result<CaptureResult, CaptureError> {
    let url = validate_url(&request.url)?;
    if request
        .request_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err(CaptureError::invalid("Invalid request_id"));
    }
    if let Some(id) = &request.request_id {
        let receipt = tx
            .query_row(
                "SELECT url,bookmark_id,outcome FROM capture_receipts WHERE request_id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(CaptureError::database)?;
        if let Some((saved_url, bookmark_id, outcome)) = receipt {
            if saved_url != url {
                return Err(CaptureError {
                    code: "request_id_conflict",
                    message: "This request_id was already used for another link".into(),
                    status: 409,
                    ipc: ErrorCode::Conflict,
                    detail: None,
                });
            }
            // The same request again (a reply lost on the way): answered from
            // the receipt, Reading as it is now. A link taken out of Reading
            // since is not put back.
            let bookmark = db::get_bookmark_by_id(tx, bookmark_id)
                .optional()
                .map_err(CaptureError::database)?;
            let reading = request.reading && bookmark.as_ref().is_some_and(|b| b.reading_at.is_some());
            return Ok(CaptureResult {
                bookmark_id,
                outcome,
                bookmark,
                newly_created: false,
                restored: false,
                reading,
                reading_changed: false,
            });
        }
    }
    let existing = tx
        .query_row(
            "SELECT id, deleted_at IS NOT NULL FROM bookmarks WHERE url=?1",
            [&url],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(CaptureError::database)?;
    if let Some((id, true)) = existing {
        // An import never comes here: it leaves the trash alone (`import.rs`).
        // Saved again: back from the trash with its fields, waiting in the inbox.
        let bookmark = db::restore_bookmark(tx, id, true).map_err(CaptureError::database)?;
        let (bookmark, reading_changed) = to_reading(tx, request, bookmark)?;
        if let Some(request_id) = &request.request_id {
            tx.execute(
                "INSERT INTO capture_receipts (request_id,url,bookmark_id,outcome) VALUES (?1,?2,?3,'created')",
                params![request_id, url, id],
            )
            .map_err(CaptureError::database)?;
        }
        return Ok(CaptureResult {
            bookmark_id: id,
            outcome: "created".into(),
            reading: request.reading && bookmark.reading_at.is_some(),
            bookmark: Some(bookmark),
            newly_created: false,
            restored: true,
            reading_changed,
        });
    }
    let newly_created = existing.is_none();
    let title = request
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&url);
    let bookmark = db::insert_or_update_bookmark(
        tx,
        &url,
        title,
        None,
        None,
        None,
        &metadata::extract_domain(&url),
        request.collection_id,
        request.tags.as_deref(),
        source,
    )
    .map_err(CaptureError::database)?;
    let (bookmark, reading_changed) = to_reading(tx, request, bookmark)?;
    let outcome = if newly_created { "created" } else { "existing" }.to_owned();
    if let Some(id) = &request.request_id {
        tx.execute("INSERT INTO capture_receipts (request_id,url,bookmark_id,outcome) VALUES (?1,?2,?3,?4)",params![id,url,bookmark.id,outcome]).map_err(CaptureError::database)?;
    }
    Ok(CaptureResult {
        bookmark_id: bookmark.id,
        outcome,
        reading: request.reading && bookmark.reading_at.is_some(),
        bookmark: Some(bookmark),
        newly_created,
        restored: false,
        reading_changed,
    })
}

/// «Save to Reading» (NP-125): as «Send to Reading» in the app
/// (`Bulk::Reading`), inside the capture's transaction and without the undo
/// journal, as a capture has none. A link already in Reading keeps its place
/// and its progress. Returns the bookmark as it is now, and whether it changed.
fn to_reading(tx: &Connection, request: &CaptureRequest, bookmark: Bookmark) -> Result<(Bookmark, bool), CaptureError> {
    if !request.reading {
        return Ok((bookmark, false));
    }
    let (_, mut changed) = db::bulk_in(tx, &[bookmark.id], &db::Bulk::Reading(true)).map_err(CaptureError::database)?;
    Ok(match changed.pop() {
        Some(sent) => (sent, true),
        None => (bookmark, false),
    })
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
}
/// Payload of the `bookmark-changed` event; `bookmark` is empty for a deletion.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BookmarkChange {
    pub kind: ChangeKind,
    pub id: i64,
    pub revision: i64,
    pub bookmark: Option<Bookmark>,
}
pub fn emit(app: &AppHandle, kind: ChangeKind, bookmark: &Bookmark) {
    let _ = app.emit(
        "bookmark-changed",
        BookmarkChange {
            kind,
            id: bookmark.id,
            revision: bookmark.revision,
            bookmark: Some(bookmark.clone()),
        },
    );
}
/// The batch event of a bulk action or an undo of many (NP-029): every
/// change at once, so the interface merges them in one pass instead of
/// reading the list again. One bookmark still goes as `bookmark-changed`.
pub fn emit_many(app: &AppHandle, bookmarks: &[Bookmark]) {
    match bookmarks {
        [] => {}
        [one] => emit(app, ChangeKind::Updated, one),
        _ => {
            let changes: Vec<BookmarkChange> = bookmarks
                .iter()
                .map(|b| BookmarkChange {
                    kind: ChangeKind::Updated,
                    id: b.id,
                    revision: b.revision,
                    bookmark: Some(b.clone()),
                })
                .collect();
            let _ = app.emit("bookmarks-changed", changes);
        }
    }
}
/// Bookmarks deleted for good, in one event.
pub fn emit_deleted_many(app: &AppHandle, gone: &[(i64, i64)]) {
    let changes: Vec<BookmarkChange> = gone
        .iter()
        .map(|&(id, revision)| BookmarkChange { kind: ChangeKind::Deleted, id, revision: revision + 1, bookmark: None })
        .collect();
    let _ = app.emit("bookmarks-changed", changes);
}
/// A bookmark deleted for good: no bookmark, the next revision.
pub fn emit_deleted(app: &AppHandle, id: i64, revision: i64) {
    let _ = app.emit(
        "bookmark-changed",
        BookmarkChange {
            kind: ChangeKind::Deleted,
            id,
            revision: revision + 1,
            bookmark: None,
        },
    );
}
pub fn after_save(app: &AppHandle, state: Arc<DbState>, result: &CaptureResult) {
    let Some(bookmark) = result.bookmark.clone() else {
        return;
    };
    // A link back from the trash arrives like a new one; its metadata is there.
    if result.restored {
        emit(app, ChangeKind::Created, &bookmark);
        return;
    }
    if !result.newly_created {
        // Saved again to Reading (NP-125): the list and its number move.
        if result.reading_changed {
            emit(app, ChangeKind::Updated, &bookmark);
        }
        return;
    }
    emit(app, ChangeKind::Created, &bookmark);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // A link previewed in «New link» in the last 10 minutes is not read again (NP-129).
        let meta = crate::feeds::discover::metadata_for_save(&bookmark.url).await;
        let updated = state.conn.lock().map_err(|_| ()).and_then(|conn| {
            db::enrich_bookmark(&conn, bookmark.id, &bookmark.url, bookmark.revision, &meta).map_err(|_| ())
        });
        if let Ok(Some(updated)) = updated {
            emit(&app, ChangeKind::Updated, &updated);
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        // The SQL functions the triggers call, as every connection of the app has.
        crate::db::register_functions(&c).unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    fn request(id: &str) -> CaptureRequest {
        CaptureRequest {
            request_id: Some(id.into()),
            url: "https://example.com/".into(),
            title: Some("Original".into()),
            collection_id: None,
            tags: Some(vec!["one".into()]),
            reading: false,
        }
    }
    #[test]
    fn replay_after_deletion_does_not_recreate() {
        let c = database();
        let req = request("one");
        let saved = save(&c, &req, Source::Extension).unwrap();
        db::trash_bookmark(&c, saved.bookmark_id).unwrap();
        db::purge_trash(&c, db::Purge::One(saved.bookmark_id)).unwrap();
        let replay = save(&c, &req, Source::Extension).unwrap();
        assert_eq!(replay.bookmark_id, saved.bookmark_id);
        assert!(replay.bookmark.is_none());
        assert!(!replay.newly_created);
        assert_eq!(db::get_counts(&c).unwrap().total, 0);
    }
    #[test]
    fn duplicate_preserves_user_fields() {
        let c = database();
        let first = save(&c, &request("one"), Source::Extension).unwrap();
        db::update_bookmark(
            &c,
            first.bookmark_id,
            Some("Edited".into()),
            Some("Notes".into()),
            Some(true),
            None,
            Some(vec!["user".into()]),
        )
        .unwrap();
        let duplicate = save(&c, &request("two"), Source::Extension).unwrap();
        let b = duplicate.bookmark.unwrap();
        assert_eq!(duplicate.outcome, "existing");
        assert_eq!(b.title, "Edited");
        assert_eq!(b.tags.unwrap(), vec!["user"]);
        assert!(b.is_favorite);
    }
    #[test]
    fn stale_metadata_and_deleted_records_are_safe() {
        let c = database();
        let saved = save(&c, &request("one"), Source::Extension)
            .unwrap()
            .bookmark
            .unwrap();
        db::update_bookmark(
            &c,
            saved.id,
            Some("User title".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let meta = metadata::PageMetadata {
            title: Some("Scraped".into()),
            description: Some("Description".into()),
            ..Default::default()
        };
        assert_eq!(
            db::enrich_bookmark(&c, saved.id, &saved.url, saved.revision, &meta)
                .unwrap()
                .unwrap()
                .title,
            "User title"
        );
        db::trash_bookmark(&c, saved.id).unwrap();
        db::purge_trash(&c, db::Purge::One(saved.id)).unwrap();
        assert!(db::enrich_bookmark(&c, saved.id, &saved.url, saved.revision, &meta)
            .unwrap()
            .is_none());
    }
    #[test]
    fn failures_are_not_acknowledged_and_transaction_rolls_back() {
        let c = database();
        let mut req = request("one");
        req.collection_id = Some(99999);
        assert_eq!(save(&c, &req, Source::Extension).unwrap_err().status, 500);
        assert_eq!(db::get_counts(&c).unwrap().total, 0);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM capture_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        req.collection_id = None;
        req.url = "chrome://settings".into();
        assert_eq!(save(&c, &req, Source::Extension).unwrap_err().status, 400);
    }
    #[test]
    fn source_and_inbox_follow_the_channel() {
        let c = database();
        save(&c, &request("one"), Source::Firefox).unwrap();
        let mut unknown = request("two");
        unknown.url = "https://example.com/unknown".into();
        save(&c, &unknown, Source::Extension).unwrap();
        imported(&c, r#"<a href="https://example.com/imported">I</a>"#);
        let rows: Vec<(String, Option<String>, Option<String>)> = c
            .prepare("SELECT url, source, triaged_at FROM bookmarks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows[0].1.as_deref(), Some("firefox"));
        assert_eq!(rows[0].2, None, "a capture waits in the inbox");
        assert_eq!(rows[1].1.as_deref(), Some("extension"));
        assert_eq!(rows[2].1.as_deref(), Some("import"));
        assert!(rows[2].2.is_some(), "an import goes to the library");
    }

    /// An import of `html` into the library (`import.rs`).
    fn imported(c: &Connection, html: &str) -> crate::import::ImportSummary {
        crate::import::import(c, &crate::import::parse(html, chrono::Utc::now()), false, |_, _| {}).unwrap()
    }

    #[test]
    fn a_link_in_the_trash_comes_back_when_saved_but_not_by_an_import() {
        let c = database();
        db::create_starter_collections(&c, &["Development".into()]).unwrap();
        let first = save(&c, &request("one"), Source::Chrome).unwrap();
        let id = first.bookmark_id;
        db::update_bookmark(
            &c,
            id,
            None,
            Some("Заметка".into()),
            Some(true),
            Some(Some(1)),
            Some(vec!["тег".into()]),
        )
        .unwrap();
        db::trash_bookmark(&c, id).unwrap();

        // An import leaves it in the trash and says so.
        let summary = imported(&c, r#"<a href="https://example.com/">Again</a>"#);
        assert_eq!((summary.added, summary.in_trash), (0, 1));
        assert_eq!(db::get_counts(&c).unwrap().trash, 1);

        // A capture brings it back with its fields, waiting in the inbox again.
        let again = save(&c, &request("two"), Source::Edge).unwrap();
        assert_eq!((again.outcome.as_str(), again.restored), ("created", true));
        assert!(!again.newly_created, "no new record, no metadata request");
        let b = again.bookmark.unwrap();
        assert_eq!((b.id, b.deleted_at, b.triaged_at), (id, None, None));
        assert_eq!(
            (b.notes.as_deref(), b.is_favorite, b.collection_id),
            (Some("Заметка"), true, Some(1))
        );
        assert_eq!(b.tags.unwrap(), ["тег"]);

        // The receipt of the first delivery replays without touching the trash.
        db::trash_bookmark(&c, id).unwrap();
        let replay = save(&c, &request("one"), Source::Chrome).unwrap();
        assert!(!replay.restored);
        assert!(db::get_bookmark_by_id(&c, id).unwrap().deleted_at.is_some());
        // Its own receipt replays as `created` and restores nothing either.
        let replay = save(&c, &request("two"), Source::Edge).unwrap();
        assert_eq!(
            (replay.outcome.as_str(), replay.restored),
            ("created", false)
        );
        assert!(db::get_bookmark_by_id(&c, id).unwrap().deleted_at.is_some());

        // Added by hand: back too.
        let mut by_hand = request("three");
        by_hand.request_id = None;
        assert!(save(&c, &by_hand, Source::App).unwrap().restored);
        assert_eq!(db::get_counts(&c).unwrap().trash, 0);
    }

    #[test]
    fn request_id_cannot_be_reused_for_another_url() {
        let c = database();
        let mut req = request("one");
        save(&c, &req, Source::Extension).unwrap();
        req.url = "https://other.example/".into();
        assert_eq!(save(&c, &req, Source::Extension).unwrap_err().status, 409);
    }
}
