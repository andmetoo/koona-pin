use crate::db::{self, Bookmark, DbState, Source};
use crate::error::{CommandError, ErrorCode};
use crate::metadata;
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
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
    /// Browser named by the extension: `chrome`, `edge` or `firefox` (NP-016).
    #[serde(default)]
    pub source: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct CaptureResult {
    pub bookmark_id: i64,
    pub outcome: String,
    #[serde(skip)]
    pub bookmark: Option<Bookmark>,
    #[serde(skip)]
    pub newly_created: bool,
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
}
impl CaptureError {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
            status: 400,
            ipc: ErrorCode::InvalidRequest,
        }
    }
    fn database(e: rusqlite::Error) -> Self {
        Self {
            code: "database_error",
            message: e.to_string(),
            status: 500,
            ipc: crate::error::code_of(&e),
        }
    }
}
impl From<CaptureError> for CommandError {
    fn from(error: CaptureError) -> Self {
        CommandError::new(error.ipc, error.message)
    }
}
pub fn validate_url(raw: &str) -> Result<String, CaptureError> {
    let raw = raw.trim();
    let parsed = Url::parse(raw).map_err(|_| CaptureError::invalid("Некорректная ссылка"))?;
    if raw.len() > 8192
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
    {
        return Err(CaptureError::invalid(
            "Поддерживаются только ссылки HTTP/HTTPS",
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
        return Err(CaptureError::invalid("Некорректный request_id"));
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
                    message: "Этот request_id уже использован для другой ссылки".into(),
                    status: 409,
                    ipc: ErrorCode::Conflict,
                });
            }
            let bookmark = db::get_bookmark_by_id(tx, bookmark_id)
                .optional()
                .map_err(CaptureError::database)?;
            return Ok(CaptureResult {
                bookmark_id,
                outcome,
                bookmark,
                newly_created: false,
            });
        }
    }
    let existing = tx
        .query_row("SELECT id FROM bookmarks WHERE url=?1", [&url], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(CaptureError::database)?;
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
    let outcome = if newly_created { "created" } else { "existing" }.to_owned();
    if let Some(id) = &request.request_id {
        tx.execute("INSERT INTO capture_receipts (request_id,url,bookmark_id,outcome) VALUES (?1,?2,?3,?4)",params![id,url,bookmark.id,outcome]).map_err(CaptureError::database)?;
    }
    Ok(CaptureResult {
        bookmark_id: bookmark.id,
        outcome,
        bookmark: Some(bookmark),
        newly_created,
    })
}

/// Links of a browser bookmarks file; addresses that are not HTTP/HTTPS are skipped.
pub fn parse_html(html: &str) -> Vec<CaptureRequest> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href]").expect("valid selector");
    document
        .select(&selector)
        .filter_map(|element| {
            let href = element.value().attr("href")?;
            validate_url(href).ok()?;
            Some(CaptureRequest {
                request_id: None,
                url: href.into(),
                title: Some(element.text().collect::<String>().trim().into()),
                collection_id: None,
                tags: None,
                source: None,
            })
        })
        .collect()
}

/// One transaction for the whole file: an import is saved entirely or not at
/// all, and thousands of links cost one sync to disk instead of thousands.
/// Metadata is not fetched, so an import does not start a burst of requests.
pub fn import(conn: &Connection, requests: &[CaptureRequest]) -> Result<usize, CaptureError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(CaptureError::database)?;
    let mut imported = 0;
    for request in requests {
        if save_in(&tx, request, Source::Import)?.newly_created {
            imported += 1;
        }
    }
    tx.commit().map_err(CaptureError::database)?;
    Ok(imported)
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
pub fn after_save(app: &AppHandle, state: Arc<DbState>, result: &CaptureResult) {
    if !result.newly_created {
        return;
    }
    let Some(bookmark) = result.bookmark.clone() else {
        return;
    };
    emit(app, ChangeKind::Created, &bookmark);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let meta = metadata::fetch_metadata(&bookmark.url).await;
        let updated = state.conn.lock().map_err(|_| ()).and_then(|conn| {
            db::enrich_bookmark(&conn, bookmark.id, bookmark.revision, &meta).map_err(|_| ())
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
            source: None,
        }
    }
    #[test]
    fn replay_after_deletion_does_not_recreate() {
        let c = database();
        let req = request("one");
        let saved = save(&c, &req, Source::Extension).unwrap();
        db::delete_bookmark(&c, saved.bookmark_id).unwrap();
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
            db::enrich_bookmark(&c, saved.id, saved.revision, &meta)
                .unwrap()
                .unwrap()
                .title,
            "User title"
        );
        db::delete_bookmark(&c, saved.id).unwrap();
        assert!(db::enrich_bookmark(&c, saved.id, saved.revision, &meta)
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
        let mut req = request("one");
        req.source = Some("firefox".into());
        save(&c, &req, Source::from_extension(req.source.as_deref())).unwrap();
        let mut unknown = request("two");
        unknown.url = "https://example.com/unknown".into();
        unknown.source = Some("netscape".into());
        save(
            &c,
            &unknown,
            Source::from_extension(unknown.source.as_deref()),
        )
        .unwrap();
        import(
            &c,
            &parse_html(r#"<a href="https://example.com/imported">I</a>"#),
        )
        .unwrap();
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

    #[test]
    fn import_of_ten_thousand_links_is_one_transaction() {
        let c = database();
        let mut html = String::from("<DL>");
        for i in 0..10_000 {
            html.push_str(&format!(
                r#"<DT><A HREF="https://example.com/{i}">Link {i}</A>"#
            ));
        }
        html.push_str(r#"<DT><A HREF="javascript:alert(1)">Skipped</A><DT><A HREF="https://example.com/1">Duplicate</A></DL>"#);
        let requests = parse_html(&html);
        assert_eq!(requests.len(), 10_001);
        let started = std::time::Instant::now();
        assert_eq!(import(&c, &requests).unwrap(), 10_000);
        println!("import of 10 000 links: {:?}", started.elapsed());
        assert_eq!(db::get_counts(&c).unwrap().total, 10_000);

        // A failure in the middle keeps nothing from the file.
        let mut broken = parse_html(
            r#"<a href="https://example.org/a">A</a><a href="https://example.org/b">B</a>"#,
        );
        broken[1].collection_id = Some(99_999);
        assert_eq!(import(&c, &broken).unwrap_err().status, 500);
        assert_eq!(db::get_counts(&c).unwrap().total, 10_000);
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
