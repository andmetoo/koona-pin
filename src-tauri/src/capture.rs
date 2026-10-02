use crate::db::{self, Bookmark, DbState};
use crate::metadata;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use url::Url;

#[derive(Debug, Deserialize)]
pub struct CaptureRequest {
    pub request_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub collection_id: Option<i64>,
    pub tags: Option<Vec<String>>,
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
#[derive(Debug, Serialize)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip)]
    pub status: u16,
}
impl CaptureError {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
            status: 400,
        }
    }
    fn database(e: rusqlite::Error) -> Self {
        Self {
            code: "database_error",
            message: e.to_string(),
            status: 500,
        }
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
pub fn save(conn: &Connection, request: &CaptureRequest) -> Result<CaptureResult, CaptureError> {
    let url = validate_url(&request.url)?;
    if request
        .request_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err(CaptureError::invalid("Некорректный request_id"));
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(CaptureError::database)?;
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
                });
            }
            let bookmark = db::get_bookmark_by_id(&tx, bookmark_id)
                .optional()
                .map_err(CaptureError::database)?;
            tx.commit().map_err(CaptureError::database)?;
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
        &tx,
        &url,
        title,
        None,
        None,
        None,
        &metadata::extract_domain(&url),
        request.collection_id,
        request.tags.as_deref(),
    )
    .map_err(CaptureError::database)?;
    let outcome = if newly_created { "created" } else { "existing" }.to_owned();
    if let Some(id) = &request.request_id {
        tx.execute("INSERT INTO capture_receipts (request_id,url,bookmark_id,outcome) VALUES (?1,?2,?3,?4)",params![id,url,bookmark.id,outcome]).map_err(CaptureError::database)?;
    }
    tx.commit().map_err(CaptureError::database)?;
    Ok(CaptureResult {
        bookmark_id: bookmark.id,
        outcome,
        bookmark: Some(bookmark),
        newly_created,
    })
}
#[derive(Debug, Clone, Serialize)]
pub struct BookmarkChange {
    pub kind: &'static str,
    pub id: i64,
    pub revision: i64,
    pub bookmark: Option<Bookmark>,
}
pub fn emit(app: &AppHandle, kind: &'static str, bookmark: &Bookmark) {
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
    emit(app, "created", &bookmark);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let meta = metadata::fetch_metadata(&bookmark.url).await;
        let updated = state.conn.lock().map_err(|_| ()).and_then(|conn| {
            db::enrich_bookmark(&conn, bookmark.id, bookmark.revision, &meta).map_err(|_| ())
        });
        if let Ok(Some(updated)) = updated {
            emit(&app, "updated", &updated);
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        db::create_tables(&c).unwrap();
        db::migrate(&c, None).unwrap();
        c
    }
    fn request(id: &str) -> CaptureRequest {
        CaptureRequest {
            request_id: Some(id.into()),
            url: "https://example.com/".into(),
            title: Some("Original".into()),
            collection_id: None,
            tags: Some(vec!["one".into()]),
        }
    }
    #[test]
    fn replay_after_deletion_does_not_recreate() {
        let c = database();
        let req = request("one");
        let saved = save(&c, &req).unwrap();
        db::delete_bookmark(&c, saved.bookmark_id).unwrap();
        let replay = save(&c, &req).unwrap();
        assert_eq!(replay.bookmark_id, saved.bookmark_id);
        assert!(replay.bookmark.is_none());
        assert!(!replay.newly_created);
        assert_eq!(db::get_counts(&c).unwrap().total, 0);
    }
    #[test]
    fn duplicate_preserves_user_fields() {
        let c = database();
        let first = save(&c, &request("one")).unwrap();
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
        let duplicate = save(&c, &request("two")).unwrap();
        let b = duplicate.bookmark.unwrap();
        assert_eq!(duplicate.outcome, "existing");
        assert_eq!(b.title, "Edited");
        assert_eq!(b.tags.unwrap(), vec!["user"]);
        assert!(b.is_favorite);
    }
    #[test]
    fn stale_metadata_and_deleted_records_are_safe() {
        let c = database();
        let saved = save(&c, &request("one")).unwrap().bookmark.unwrap();
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
        assert_eq!(save(&c, &req).unwrap_err().status, 500);
        assert_eq!(db::get_counts(&c).unwrap().total, 0);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM capture_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        req.collection_id = None;
        req.url = "chrome://settings".into();
        assert_eq!(save(&c, &req).unwrap_err().status, 400);
    }
    #[test]
    fn request_id_cannot_be_reused_for_another_url() {
        let c = database();
        let mut req = request("one");
        save(&c, &req).unwrap();
        req.url = "https://other.example/".into();
        assert_eq!(save(&c, &req).unwrap_err().status, 409);
    }
}
