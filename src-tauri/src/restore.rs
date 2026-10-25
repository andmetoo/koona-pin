//! Restore from a JSON copy (NP-033, frame 30, Р-31). The whole file is
//! checked before anything changes; merging keeps every bookmark already in
//! the library, replacing first writes a copy of the current library. Either
//! is one transaction. Collections nest (2.19.0): a copy names each one's
//! parent; an unknown parent or a loop is damage, a tree deeper than the
//! limit is kept, a copy without parents is a flat library.

use crate::capture::validate_url;
use crate::db;
use crate::export::{JsonLibrary, JSON_FORMAT, JSON_VERSION};
use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RestoreMode {
    /// Add what the library does not have; what it has stays as it is.
    Merge,
    /// The library becomes the copy, after a backup of the current one.
    Replace,
}

/// Which part of the copy is damaged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CopyItem {
    File,
    Collection,
    Tag,
    Bookmark,
}

/// What is wrong with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Damage {
    /// A field is missing or of the wrong kind.
    Structure,
    /// Not an HTTP or HTTPS address.
    BadAddress,
    RepeatedAddress,
    RepeatedUid,
    BadDate,
    UnknownCollection,
    BadSource,
    MissingName,
    RepeatedName,
    /// A collection sits in one the copy doesn't have (2.19.0).
    UnknownParent,
    /// A collection is inside itself, directly or through others (2.19.0).
    Loop,
}

/// Why a copy cannot be restored (frame 30); nothing was changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "problem", rename_all = "snake_case")]
#[ts(export)]
pub enum RestoreProblem {
    NotJson,
    /// JSON, but not a copy made by Koona Pin.
    NotOurs,
    /// Made by a newer Koona Pin: its format is not known here.
    Newer { version: u32 },
    /// `index` counts from 1 within its kind; 0 for the whole file.
    Damaged { item: CopyItem, index: u32, damage: Damage, detail: String },
}

/// What the copy holds, shown before the restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct RestorePreview {
    pub bookmarks: u32,
    pub collections: u32,
    pub tags: u32,
    pub exported_at: String,
    /// Bookmarks in the library now, the trash included: what «Заменить» removes.
    pub current: u32,
}

/// What a restore did: the report of frame 30.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct RestoreSummary {
    pub added: u32,
    /// Of the added, waiting in the inbox.
    pub in_inbox: u32,
    /// Of the added, in the trash.
    pub in_trash: u32,
    /// Merge: in the library already, left as they were.
    pub existing: u32,
    /// Collections the restore created (for a merge: those the library lacked).
    pub collections: Vec<String>,
    pub tags: u32,
    /// Replace: the file name of the copy written before.
    pub backup: Option<String>,
}

fn damaged(item: CopyItem, index: usize, damage: Damage, detail: impl Into<String>) -> RestoreProblem {
    RestoreProblem::Damaged { item, index: index as u32, damage, detail: detail.into() }
}

/// A time of the copy in the library's format.
fn time(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|t| db::stamp(t.into()))
}

/// A source the copy may carry. Any short name passes, not only the ones this
/// version knows: a newer app, or another device through sync (schema 10,
/// Р-68), may have saved from a place this one has no name for, and the
/// interface shows an unknown source as it is.
const MAX_SOURCE: usize = 64;

/// Reads and checks the whole copy; nothing in the library is touched. Times
/// come back in the library's format.
pub fn check(text: &str) -> Result<JsonLibrary, RestoreProblem> {
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| RestoreProblem::NotJson)?;
    if value.get("format").and_then(|f| f.as_str()) != Some(JSON_FORMAT) {
        return Err(RestoreProblem::NotOurs);
    }
    let version = value.get("version").and_then(|v| v.as_u64()).ok_or(RestoreProblem::NotOurs)?;
    if version > u64::from(JSON_VERSION) {
        return Err(RestoreProblem::Newer { version: version as u32 });
    }
    let mut library: JsonLibrary =
        serde_json::from_value(value).map_err(|e| damaged(CopyItem::File, 0, Damage::Structure, e.to_string()))?;

    let mut uids = HashSet::new();
    let mut names = HashSet::new();
    for (i, c) in library.collections.iter_mut().enumerate() {
        let at = i + 1;
        c.name = c.name.trim().to_owned();
        if c.uid.trim().is_empty() || !uids.insert(c.uid.clone()) {
            return Err(damaged(CopyItem::Collection, at, Damage::RepeatedUid, &c.uid));
        }
        if c.name.is_empty() {
            return Err(damaged(CopyItem::Collection, at, Damage::MissingName, ""));
        }
        if !names.insert(c.name.clone()) {
            return Err(damaged(CopyItem::Collection, at, Damage::RepeatedName, &c.name));
        }
        c.created_at = time(&c.created_at).ok_or_else(|| damaged(CopyItem::Collection, at, Damage::BadDate, &c.created_at))?;
    }
    let collections: HashSet<String> = library.collections.iter().map(|c| c.uid.clone()).collect();
    // The tree (2.19.0): every parent is in the copy and nothing is inside
    // itself. A copy from before nesting has no parents. How deep it goes is
    // not checked: sync can make a tree deeper than the limit too.
    for (i, c) in library.collections.iter().enumerate() {
        if let Some(parent) = &c.parent {
            if !collections.contains(parent) {
                return Err(damaged(CopyItem::Collection, i + 1, Damage::UnknownParent, parent));
            }
        }
    }
    let parents: HashMap<&str, &str> = library.collections.iter().filter_map(|c| c.parent.as_deref().map(|p| (c.uid.as_str(), p))).collect();
    for (i, c) in library.collections.iter().enumerate() {
        let mut at = parents.get(c.uid.as_str());
        for _ in 0..library.collections.len() {
            match at {
                Some(&up) if up == c.uid => return Err(damaged(CopyItem::Collection, i + 1, Damage::Loop, &c.uid)),
                Some(&up) => at = parents.get(up),
                None => break,
            }
        }
    }

    let mut tag_names = HashSet::new();
    for (i, t) in library.tags.iter_mut().enumerate() {
        let at = i + 1;
        t.name = t.name.trim().to_lowercase();
        if t.name.is_empty() {
            return Err(damaged(CopyItem::Tag, at, Damage::MissingName, ""));
        }
        if !tag_names.insert(t.name.clone()) {
            return Err(damaged(CopyItem::Tag, at, Damage::RepeatedName, &t.name));
        }
        t.created_at = time(&t.created_at).ok_or_else(|| damaged(CopyItem::Tag, at, Damage::BadDate, &t.created_at))?;
    }

    let mut uids = HashSet::new();
    let mut urls = HashSet::new();
    for (i, b) in library.bookmarks.iter_mut().enumerate() {
        let at = i + 1;
        if b.uid.trim().is_empty() || !uids.insert(b.uid.clone()) {
            return Err(damaged(CopyItem::Bookmark, at, Damage::RepeatedUid, &b.uid));
        }
        b.url = validate_url(&b.url).map_err(|_| damaged(CopyItem::Bookmark, at, Damage::BadAddress, &b.url))?;
        if !urls.insert(b.url.clone()) {
            return Err(damaged(CopyItem::Bookmark, at, Damage::RepeatedAddress, &b.url));
        }
        if b.domain.trim().is_empty() {
            b.domain = crate::metadata::extract_domain(&b.url);
        }
        // The WebView loads pictures itself (NP-019): a copy must not point it
        // at the user's computer or network. Only the picture goes.
        for picture in [&mut b.image_url, &mut b.favicon_url] {
            if picture.as_deref().is_some_and(|raw| !crate::net_guard::public_url(raw)) {
                *picture = None;
            }
        }
        b.site_name = b.site_name.as_deref().and_then(crate::metadata::tidy_site_name);
        let bad_date = |value: &str| damaged(CopyItem::Bookmark, at, Damage::BadDate, value);
        b.created_at = time(&b.created_at).ok_or_else(|| bad_date(&b.created_at))?;
        b.updated_at = time(&b.updated_at).ok_or_else(|| bad_date(&b.updated_at))?;
        for optional in [&mut b.triaged_at, &mut b.deleted_at, &mut b.reading_at, &mut b.read_at] {
            if let Some(value) = optional.as_mut() {
                *value = time(value).ok_or_else(|| bad_date(value))?;
            }
        }
        if let Some(uid) = &b.collection {
            if !collections.contains(uid) {
                return Err(damaged(CopyItem::Bookmark, at, Damage::UnknownCollection, uid));
            }
        }
        if let Some(source) = &b.source {
            if source.trim().is_empty() || source.chars().count() > MAX_SOURCE {
                return Err(damaged(CopyItem::Bookmark, at, Damage::BadSource, source));
            }
        }
        // A progress out of 0–1 is a hand-edited copy: the nearest end.
        b.reading_progress = b.reading_progress.clamp(0.0, 1.0);
        let mut seen = HashSet::new();
        b.tags = b.tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty() && seen.insert(t.clone())).collect();
    }
    Ok(library)
}

pub fn preview(conn: &Connection, library: &JsonLibrary) -> rusqlite::Result<RestorePreview> {
    let current: i64 = conn.query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))?;
    Ok(RestorePreview {
        bookmarks: library.bookmarks.len() as u32,
        collections: library.collections.len() as u32,
        tags: library.tags.len() as u32,
        exported_at: library.exported_at.clone(),
        current: current as u32,
    })
}

#[derive(Debug)]
pub enum RestoreError {
    /// The copy before a replace could not be written: nothing was changed.
    Backup(String),
    Database(rusqlite::Error),
}
fn sync_error(error: koona_sync::Error) -> RestoreError {
    match error {
        koona_sync::Error::Sql(e) => RestoreError::Database(e),
        other => RestoreError::Database(rusqlite::Error::UserFunctionError(other.to_string().into())),
    }
}

impl From<rusqlite::Error> for RestoreError {
    fn from(e: rusqlite::Error) -> Self {
        RestoreError::Database(e)
    }
}

/// The copy's uid for a record it brings, or a new one when that uid was
/// deleted for good here: a purge is final for its uid. Its tombstone stays,
/// so the other devices keep it purged; under a new uid the record is a new
/// one everywhere and reaches them too.
fn fresh_uid(conn: &Connection, uid: &str) -> rusqlite::Result<String> {
    Ok(if db::is_purged(conn, uid)? { db::new_uid() } else { uid.to_owned() })
}

/// Restores a checked copy. A replace writes the backup first and gives up if
/// it fails; then everything happens in one transaction.
pub fn restore(conn: &Connection, library: &JsonLibrary, mode: RestoreMode, backups: &Path) -> Result<RestoreSummary, RestoreError> {
    let backup = match mode {
        RestoreMode::Replace => {
            let path = crate::backup::before_restore_path(backups);
            crate::backup::write_copy(conn, &path).map_err(RestoreError::Backup)?;
            crate::backup::prune_before_restore(backups);
            Some(path)
        }
        RestoreMode::Merge => None,
    };
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let mut summary = RestoreSummary {
        backup: backup.as_ref().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
        ..Default::default()
    };
    // With sync on, a replace removes nothing on the other devices (Р-68):
    // its writes are recorded by `sync_library::after_restore`, not as purges.
    let kept = match mode {
        RestoreMode::Replace => crate::sync_library::keep(&tx)?,
        RestoreMode::Merge => None,
    };
    let applying = match kept {
        Some(_) => Some(koona_sync::Applying::new(&tx).map_err(sync_error)?),
        None => None,
    };
    if mode == RestoreMode::Replace {
        tx.execute_batch("DELETE FROM bookmark_tags; DELETE FROM bookmarks; DELETE FROM tags; DELETE FROM collections;")?;
    }
    // A replace brings the copy's sidebar order back (NP-114): its places
    // become keys in the same order (schema 10), among the siblings of each
    // parent since schema 15. A merge adds the new collections after the
    // library's own, by name.
    let mut placed: HashMap<Option<&str>, Vec<(i64, usize)>> = HashMap::new();
    for (i, c) in library.collections.iter().enumerate() {
        if let Some(p) = c.position.filter(|_| mode == RestoreMode::Replace) {
            placed.entry(c.parent.as_deref()).or_default().push((p, i));
        }
    }
    let mut position_keys: HashMap<usize, String> = HashMap::new();
    for siblings in placed.values_mut() {
        siblings.sort();
        position_keys.extend(siblings.iter().map(|(_, i)| *i).zip(crate::position_keys::spread(None, None, siblings.len())));
    }

    // Collections. A merge: the same uid, else the same name (case aside),
    // else a new one with the copy's uid. A replace starts from none and
    // makes each of the copy's, «Work» and «work» each its own. A uid
    // deleted for good here gets a new one (`fresh_uid`). A new collection
    // sits in the one its parent became, found or new (2.19.0); an existing
    // one stays where the library has it. Parents are written first.
    let mut by_name: HashMap<String, i64> = tx
        .prepare("SELECT id, name FROM collections")?
        .query_map([], |r| Ok((db::fold(&r.get::<_, String>(1)?), r.get(0)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut collection_ids = HashMap::new();
    let index_of: HashMap<&str, usize> = library.collections.iter().enumerate().map(|(i, c)| (c.uid.as_str(), i)).collect();
    let mut queued = vec![false; library.collections.len()];
    let mut order = Vec::with_capacity(queued.len());
    for start in 0..queued.len() {
        let mut chain = Vec::new();
        let mut at = Some(start);
        while let Some(i) = at.filter(|&i| !queued[i]) {
            queued[i] = true;
            chain.push(i);
            at = library.collections[i].parent.as_deref().and_then(|p| index_of.get(p).copied());
        }
        order.extend(chain.into_iter().rev());
    }
    for index in order {
        let c = &library.collections[index];
        let found = match mode {
            RestoreMode::Merge => tx
                .query_row("SELECT id FROM collections WHERE uid = ?1", [&c.uid], |r| r.get::<_, i64>(0))
                .optional()?
                .or_else(|| by_name.get(&db::fold(&c.name)).copied()),
            RestoreMode::Replace => None,
        };
        let id = match found {
            Some(id) => id,
            None => {
                let parent = c.parent.as_ref().and_then(|uid| collection_ids.get(uid)).copied();
                tx.execute(
                    "INSERT INTO collections (uid, name, color, icon, created_at, position_key, parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![fresh_uid(&tx, &c.uid)?, c.name, c.color, c.icon, c.created_at, position_keys.remove(&index), parent],
                )?;
                summary.collections.push(c.name.clone());
                let id = tx.last_insert_rowid();
                by_name.insert(db::fold(&c.name), id);
                id
            }
        };
        collection_ids.insert(c.uid.clone(), id);
    }

    // Tags: by name; a new one keeps the copy's uid unless another tag has it.
    let tags_before: i64 = tx.query_row("SELECT count(*) FROM tags", [], |r| r.get(0))?;
    for t in &library.tags {
        let taken = tx.query_row("SELECT 1 FROM tags WHERE uid = ?1", [&t.uid], |_| Ok(())).optional()?.is_some();
        tx.execute(
            "INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING",
            params![if taken { db::new_uid() } else { fresh_uid(&tx, &t.uid)? }, t.name, t.created_at],
        )?;
    }

    for b in &library.bookmarks {
        let present = tx
            .query_row("SELECT 1 FROM bookmarks WHERE uid = ?1 OR url = ?2", params![b.uid, b.url], |_| Ok(()))
            .optional()?
            .is_some();
        if present {
            summary.existing += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, source, created_at, updated_at, triaged_at, deleted_at, url_key, source_name,
                 reading_at, reading_progress, read_at, site_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                fresh_uid(&tx, &b.uid)?,
                b.url,
                b.title,
                b.description,
                b.image_url,
                b.favicon_url,
                b.domain,
                b.notes,
                b.is_favorite,
                b.collection.as_ref().and_then(|uid| collection_ids.get(uid)),
                b.source,
                b.created_at,
                b.updated_at,
                b.triaged_at,
                b.deleted_at,
                crate::dedupe::url_key(&b.url),
                b.source_name,
                b.reading_at,
                b.reading_progress,
                b.read_at,
                b.site_name,
            ],
        )?;
        if !b.tags.is_empty() {
            db::link_tags(&tx, tx.last_insert_rowid(), &b.tags, &now)?;
        }
        summary.added += 1;
        if b.deleted_at.is_some() {
            summary.in_trash += 1;
        } else if b.triaged_at.is_none() {
            summary.in_inbox += 1;
        }
    }
    let tags_after: i64 = tx.query_row("SELECT count(*) FROM tags", [], |r| r.get(0))?;
    summary.tags = u32::try_from(tags_after - if mode == RestoreMode::Replace { 0 } else { tags_before }).unwrap_or(0);
    drop(applying);
    if let (Some(kept), Some(previous)) = (kept, &backup) {
        crate::sync_library::after_restore(&tx, kept, previous).map_err(sync_error)?;
    }
    tx.commit()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export;
    use chrono::{TimeZone, Utc};

    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        db::register_functions(&c).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    /// The Chrome file imported with edits: a star and notes, one in the trash, one in the inbox.
    fn library() -> Connection {
        let c = database();
        let now = Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap();
        crate::import::import(&c, &crate::import::parse(include_str!("../../tests/fixtures/bookmarks/chrome.html"), now), false, |_, _| {}).unwrap();
        let id = |url: &str| c.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get::<_, i64>(0)).unwrap();
        db::update_bookmark(&c, id("https://github.com/"), None, Some("заметка".into()), Some(true), None, None).unwrap();
        // The file's folders are collections, not tags: Tokio gets its tags by hand.
        db::update_bookmark(&c, id("https://tokio.rs/"), None, None, None, None, Some(vec!["rust".into(), "async".into()])).unwrap();
        db::trash_bookmark(&c, id("https://habr.com/ru/articles/")).unwrap();
        c.execute("UPDATE bookmarks SET triaged_at = NULL WHERE url = 'https://m.example.com/'", []).unwrap();
        c
    }
    fn copy_of(c: &Connection) -> String {
        export::json(c, export::Scope::Library, Utc.with_ymd_and_hms(2026, 10, 4, 18, 20, 0).unwrap()).unwrap().0
    }
    fn folder() -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("koonapin-restore-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }
    fn everything(c: &Connection) -> String {
        copy_of(c)
    }

    #[test]
    fn export_then_restore_into_an_empty_library_gives_the_same_library() {
        let source = library();
        let text = copy_of(&source);
        let target = database();
        // The seeded collections of a new library go; the library becomes the copy.
        let summary = restore(&target, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        assert_eq!((summary.added, summary.in_inbox, summary.in_trash, summary.existing), (7, 1, 1, 0));
        assert_eq!(everything(&target), text, "the same copy again: identical data, uids and times");
        // Search finds restored bookmarks by their tags.
        let found = db::get_bookmarks(&target, &db::BookmarkQuery { search: Some("async".into()), ..Default::default() }).unwrap();
        assert_eq!(found.items[0].url, "https://tokio.rs/");
    }

    /// Reading (NP-121): what is in the list, how far each was read and
    /// whether it was come back from a copy, in the list's order.
    #[test]
    fn reading_progress_and_read_state_survive_export_and_import() {
        let source = library();
        let id = |url: &str| source.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get::<_, i64>(0)).unwrap();
        let (tokio, github) = (id("https://tokio.rs/"), id("https://github.com/"));
        db::apply_bulk(&source, &[tokio, github], &db::Bulk::Reading(true)).unwrap();
        crate::reading::set_progress(&source, tokio, 0.35).unwrap();
        crate::reading::set_progress(&source, github, 1.0).unwrap();
        // Read once, out of Reading since: the state stays with the bookmark.
        let out = id("https://m.example.com/");
        db::apply_bulk(&source, &[out], &db::Bulk::Read(true)).unwrap();
        let reading = |c: &Connection| {
            db::get_bookmarks(c, &db::BookmarkQuery { only_reading: true, ..Default::default() })
                .unwrap()
                .items
                .into_iter()
                .map(|b| (b.url, b.reading_at, b.reading_progress, b.read_at))
                .collect::<Vec<_>>()
        };
        let before = reading(&source);
        assert_eq!(before.iter().map(|r| (r.0.as_str(), r.2, r.3.is_some())).collect::<Vec<_>>(), [("https://tokio.rs/", 0.35, false), ("https://github.com/", 1.0, true)]);
        let text = copy_of(&source);
        let target = database();
        restore(&target, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        assert_eq!(reading(&target), before);
        assert_eq!(crate::reading::counts(&target).unwrap(), (2, 1));
        let kept = db::get_bookmarks(&target, &db::BookmarkQuery { search: Some("m.example.com".into()), ..Default::default() }).unwrap().items.remove(0);
        assert_eq!((kept.reading_at, kept.reading_progress, kept.read_at.is_some()), (None, 1.0, true));
        assert_eq!(everything(&target), text, "the same copy again");
        // A copy without Reading (made before it) reads as out of Reading and unread.
        let plain = copy_of(&library());
        assert!(!plain.contains("reading"), "no Reading fields when nothing is in Reading");
        let mut edited: serde_json::Value = serde_json::from_str(&text).unwrap();
        edited["bookmarks"][0]["reading_progress"] = serde_json::json!(4);
        assert_eq!(check(&edited.to_string()).unwrap().bookmarks[0].reading_progress, 1.0);
    }

    /// The site's name survives a copy; a copy from before site names reads
    /// as none, and a name in a copy is tidied like one read from a page.
    #[test]
    fn the_site_name_survives_export_and_import() {
        let source = library();
        source.execute("UPDATE bookmarks SET site_name = 'Tokio' WHERE url = 'https://tokio.rs/'", []).unwrap();
        let text = copy_of(&source);
        assert_eq!(text.matches("\"site_name\"").count(), 1, "left out where there is none");
        let target = database();
        restore(&target, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        let name = |c: &Connection| c.query_row("SELECT site_name FROM bookmarks WHERE url = 'https://tokio.rs/'", [], |r| r.get::<_, Option<String>>(0)).unwrap();
        assert_eq!(name(&target).as_deref(), Some("Tokio"));
        assert_eq!(everything(&target), text, "the same copy again");
        assert!(!copy_of(&library()).contains("site_name"), "a copy without names reads as before");
        let mut edited: serde_json::Value = serde_json::from_str(&text).unwrap();
        let tokio = edited["bookmarks"].as_array().unwrap().iter().position(|b| b["url"] == "https://tokio.rs/").unwrap();
        edited["bookmarks"][0]["site_name"] = serde_json::json!("   ");
        edited["bookmarks"][tokio]["site_name"] = serde_json::json!("  Tokio\n Docs ");
        let checked = check(&edited.to_string()).unwrap();
        assert_eq!(checked.bookmarks[tokio].site_name.as_deref(), Some("Tokio Docs"));
        if tokio != 0 {
            assert_eq!(checked.bookmarks[0].site_name, None);
        }
    }

    #[test]
    fn merge_adds_what_is_missing_keeps_what_is_there_and_states_as_in_the_copy() {
        let text = copy_of(&library());
        let target = database();
        crate::import::import(&target, &crate::import::parse(r#"<DL><DT><H3>работа</H3><DL><DT><A HREF="https://github.com/">Мой GitHub</A></DL></DL>"#, Utc::now()), false, |_, _| {}).unwrap();
        let summary = restore(&target, &check(&text).unwrap(), RestoreMode::Merge, &folder()).unwrap();
        assert_eq!((summary.added, summary.existing, summary.in_inbox, summary.in_trash), (6, 1, 1, 1));
        assert_eq!(summary.collections, ["Rust", "Async", "Чтение"], "«работа» is the copy's «Работа», case aside; its children come in under it");
        assert_eq!(summary.backup, None);
        let github = db::get_bookmarks(&target, &db::BookmarkQuery { search: Some("github".into()), ..Default::default() }).unwrap();
        assert_eq!((github.items[0].title.as_str(), github.items[0].is_favorite), ("Мой GitHub", false), "left as it was");
        let tokio: (String, String) = target
            .query_row("SELECT c.name, b.created_at FROM bookmarks b JOIN collections c ON c.id = b.collection_id WHERE url = 'https://tokio.rs/'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(tokio, ("Async".to_string(), "2023-07-22T04:31:40.000Z".to_string()));
        // The parents go through the same mapping: the library's «работа» is the one «Rust» sits in.
        let async_id: i64 = target.query_row("SELECT id FROM collections WHERE name = 'Async'", [], |r| r.get(0)).unwrap();
        assert_eq!(db::collection_path(&target, async_id).unwrap(), ["работа", "Rust", "Async"]);
        let counts = db::get_counts(&target).unwrap();
        assert_eq!((counts.total, counts.inbox, counts.trash), (6, 1, 1));
        // Again: nothing more.
        let again = restore(&target, &check(&text).unwrap(), RestoreMode::Merge, &folder()).unwrap();
        assert_eq!((again.added, again.existing, again.collections.len(), again.tags), (0, 7, 0, 0));
    }

    /// NP-114: the copy carries the sidebar's order; a replace brings it back,
    /// a merge keeps the library's own and adds the copy's collections after it.
    #[test]
    fn the_sidebar_order_comes_back_with_a_replace_and_follows_in_a_merge() {
        let names = |c: &Connection| db::get_collections(c).unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>();
        let source = library();
        let mut ids: Vec<i64> = db::get_collections(&source).unwrap().iter().map(|c| c.id).collect();
        ids.reverse();
        db::reorder_collections(&source, &ids).unwrap();
        let moved = names(&source);
        assert_ne!(moved, { let mut by_name = moved.clone(); by_name.sort(); by_name }, "the test needs an order that is not by name");
        let text = copy_of(&source);

        let replaced = database();
        restore(&replaced, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        assert_eq!(names(&replaced), moved);

        let merged = database();
        let own = db::create_collection(&merged, "Ящик", None, None).unwrap();
        db::reorder_collections(&merged, &[own.id]).unwrap();
        restore(&merged, &check(&text).unwrap(), RestoreMode::Merge, &folder()).unwrap();
        // Its own first; the copy's top-level ones after it by name, each followed by what is inside it.
        assert_eq!(names(&merged), ["Ящик", "Работа", "Rust", "Async", "Чтение"]);
    }

    /// The tree comes back with a replace: parents and the order among the
    /// siblings of each; one deeper than the limit (sync can make it) stays.
    #[test]
    fn the_tree_comes_back_with_a_replace_and_is_kept_deeper_than_the_limit() {
        let source = database();
        let make = |name: &str, parent: Option<i64>| db::create_collection_under(&source, name, parent, None, None).unwrap().id;
        let top = make("Top", None);
        let (b, a) = (make("B", Some(top)), make("A", Some(top)));
        make("C", Some(a));
        let mid = make("Mid", Some(b));
        make("D", Some(mid));
        make("E", None);
        db::move_collection(&source, a, Some(top), Some(b)).unwrap();
        let text = copy_of(&source);
        let target = database();
        restore(&target, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        let tree = |conn: &Connection| {
            db::get_collections(conn)
                .unwrap()
                .into_iter()
                .map(|col| db::collection_path(conn, col.id).unwrap().join("/"))
                .collect::<Vec<_>>()
        };
        // A before B though «B» comes first by name; D is four levels down and stays.
        assert_eq!(tree(&source), ["E", "Top", "Top/A", "Top/A/C", "Top/B", "Top/B/Mid", "Top/B/Mid/D"]);
        assert_eq!(tree(&target), tree(&source));
        assert_eq!(copy_of(&target), text, "the same copy again, parents and places included");
    }

    /// Copies made before collections nested have no `parent`: they restore
    /// as the flat library they were.
    #[test]
    fn a_copy_without_parents_restores_flat() {
        let mut copy: serde_json::Value = serde_json::from_str(&copy_of(&library())).unwrap();
        for collection in copy["collections"].as_array_mut().unwrap() {
            collection.as_object_mut().unwrap().remove("parent");
        }
        let target = database();
        let checked = check(&copy.to_string()).unwrap();
        assert!(checked.collections.iter().all(|c| c.parent.is_none()));
        restore(&target, &checked, RestoreMode::Replace, &folder()).unwrap();
        let nested: i64 = target.query_row("SELECT count(*) FROM collections WHERE parent_id IS NOT NULL", [], |r| r.get(0)).unwrap();
        let all: i64 = target.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        assert_eq!((nested, all), (0, 4));
    }

    /// A purge is final for its uid: a record the copy brings back whose uid
    /// was deleted for good here comes under a new uid, the tombstone stays,
    /// and its collection and tags follow it. A merge and a replace alike.
    #[test]
    fn records_deleted_for_good_come_back_under_new_uids() {
        let text = copy_of(&library());
        let uid_in_copy = |kind: &str, field: &str, value: &str| -> String {
            let copy: serde_json::Value = serde_json::from_str(&text).unwrap();
            copy[kind].as_array().unwrap().iter().find(|r| r[field] == value).unwrap()["uid"].as_str().unwrap().to_owned()
        };
        let (tokio, work, tag) =
            (uid_in_copy("bookmarks", "url", "https://tokio.rs/"), uid_in_copy("collections", "name", "Работа"), uid_in_copy("tags", "name", "async"));
        for mode in [RestoreMode::Merge, RestoreMode::Replace] {
            let c = database();
            restore(&c, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
            // Deleted for good: the bookmark purged, its collection deleted, its tag gone.
            let id: i64 = c.query_row("SELECT id FROM bookmarks WHERE uid = ?1", [&tokio], |r| r.get(0)).unwrap();
            db::trash_bookmark(&c, id).unwrap();
            db::purge_trash(&c, db::Purge::One(id)).unwrap();
            let work_id: i64 = c.query_row("SELECT id FROM collections WHERE uid = ?1", [&work], |r| r.get(0)).unwrap();
            db::delete_collection(&c, work_id).unwrap();
            c.execute("DELETE FROM tags WHERE uid = ?1", [&tag]).unwrap();
            c.execute("INSERT INTO tombstones (uid, kind, deleted_at, purged_at) VALUES (?1, 'tag', 'x', 'x')", [&tag]).unwrap();
            let gone = [&tokio, &work, &tag];
            assert_eq!(gone.iter().filter(|uid| db::is_purged(&c, uid).unwrap()).count(), 3);

            restore(&c, &check(&text).unwrap(), mode, &folder()).unwrap();
            assert!(gone.iter().all(|uid| db::is_purged(&c, uid).unwrap()), "{mode:?}: the tombstones stay");
            for (table, uid) in [("bookmarks", &tokio), ("collections", &work), ("tags", &tag)] {
                let live: i64 = c.query_row(&format!("SELECT count(*) FROM {table} WHERE uid = ?1"), [uid], |r| r.get(0)).unwrap();
                assert_eq!(live, 0, "{mode:?}: no {table} row under the purged uid");
            }
            let back = db::get_bookmarks(&c, &db::BookmarkQuery { search: Some("tokio.rs".into()), ..Default::default() }).unwrap().items.remove(0);
            let collection: String = c.query_row("SELECT name FROM collections WHERE id = ?1", [back.collection_id.unwrap()], |r| r.get(0)).unwrap();
            // Tokio sits in «Async», below the deleted «Работа»: that one comes back too, under a new uid.
            assert_eq!(collection, "Async", "{mode:?}");
            let work_back: i64 = c.query_row("SELECT count(*) FROM collections WHERE name = 'Работа'", [], |r| r.get(0)).unwrap();
            assert_eq!(work_back, 1, "{mode:?}");
            assert!(back.tags.unwrap().contains(&"async".to_string()), "{mode:?}");
        }
    }

    /// A replace keeps collections whose names differ only in case apart,
    /// each with its own uid, colour, icon, place and bookmarks.
    #[test]
    fn a_replace_keeps_collections_that_differ_only_in_case() {
        let source = database();
        let upper = db::create_collection(&source, "Work", Some("#ff0000"), Some("briefcase")).unwrap();
        let lower = db::create_collection(&source, "work", Some("#00ff00"), Some("star")).unwrap();
        let ids: Vec<i64> = db::get_collections(&source).unwrap().iter().map(|c| c.id).collect();
        let mut order: Vec<i64> = ids.iter().copied().filter(|id| ![upper.id, lower.id].contains(id)).collect();
        order.splice(0..0, [lower.id, upper.id]);
        db::reorder_collections(&source, &order).unwrap();
        crate::import::import(&source, &crate::import::parse(r#"<a href="https://a.example/">A</a><a href="https://b.example/">B</a>"#, Utc::now()), false, |_, _| {}).unwrap();
        let id = |url: &str| source.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get::<_, i64>(0)).unwrap();
        db::update_bookmark(&source, id("https://a.example/"), None, None, None, Some(Some(upper.id)), None).unwrap();
        db::update_bookmark(&source, id("https://b.example/"), None, None, None, Some(Some(lower.id)), None).unwrap();
        let text = copy_of(&source);

        let target = database();
        let summary = restore(&target, &check(&text).unwrap(), RestoreMode::Replace, &folder()).unwrap();
        assert!(summary.collections.contains(&"Work".to_string()) && summary.collections.contains(&"work".to_string()));
        let shape = |c: &Connection| {
            db::get_collections(c)
                .unwrap()
                .into_iter()
                .map(|col| {
                    let uid: String = c.query_row("SELECT uid FROM collections WHERE id = ?1", [col.id], |r| r.get(0)).unwrap();
                    let urls: Vec<String> = c
                        .prepare("SELECT url FROM bookmarks WHERE collection_id = ?1 ORDER BY url")
                        .unwrap()
                        .query_map([col.id], |r| r.get(0))
                        .unwrap()
                        .map(Result::unwrap)
                        .collect();
                    (uid, col.name, col.color, col.icon, urls)
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(shape(&target), shape(&source));
    }

    #[test]
    fn replace_writes_a_copy_of_the_library_first() {
        let current = library();
        let backups = folder();
        let other = database();
        crate::import::import(&other, &crate::import::parse(r#"<a href="https://only.example/">Only</a>"#, Utc::now()), false, |_, _| {}).unwrap();
        let summary = restore(&current, &check(&copy_of(&other)).unwrap(), RestoreMode::Replace, &backups).unwrap();
        assert_eq!((summary.added, db::get_counts(&current).unwrap().total), (1, 1));
        let name = summary.backup.unwrap();
        assert!(name.starts_with("koonapin.before-restore-") && name.ends_with(".db"));
        let saved = Connection::open(backups.join(&name)).unwrap();
        let before: i64 = saved.query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0)).unwrap();
        assert_eq!(before, 7, "the copy holds the library as it was");
        drop(saved);

        // Only the two newest copies before a replace stay.
        for old in ["koonapin.before-restore-20200101-000000.db", "koonapin.before-restore-20210101-000000.db"] {
            std::fs::write(backups.join(old), "old").unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let again = restore(&current, &check(&copy_of(&other)).unwrap(), RestoreMode::Replace, &backups).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [name, again.backup.unwrap()]);
    }

    #[test]
    fn a_damaged_foreign_or_newer_file_is_refused_and_changes_nothing() {
        let c = library();
        let before = everything(&c);
        let good: serde_json::Value = serde_json::from_str(&copy_of(&c)).unwrap();
        let with = |edit: &dyn Fn(&mut serde_json::Value)| {
            let mut v = good.clone();
            edit(&mut v);
            v.to_string()
        };
        let cases: Vec<(String, RestoreProblem)> = vec![
            ("not json at all".into(), RestoreProblem::NotJson),
            (r#"{"bookmarks": []}"#.into(), RestoreProblem::NotOurs),
            (with(&|v| v["version"] = 2.into()), RestoreProblem::Newer { version: 2 }),
            (with(&|v| v["bookmarks"][2]["url"] = "javascript:alert(1)".into()), damaged(CopyItem::Bookmark, 3, Damage::BadAddress, "javascript:alert(1)")),
            (with(&|v| v["bookmarks"][3]["url"] = v["bookmarks"][0]["url"].clone()), damaged(CopyItem::Bookmark, 4, Damage::RepeatedAddress, good["bookmarks"][0]["url"].as_str().unwrap())),
            (with(&|v| v["bookmarks"][1]["created_at"] = "вчера".into()), damaged(CopyItem::Bookmark, 2, Damage::BadDate, "вчера")),
            (with(&|v| v["bookmarks"][0]["collection"] = "nowhere".into()), damaged(CopyItem::Bookmark, 1, Damage::UnknownCollection, "nowhere")),
            (with(&|v| v["bookmarks"][1]["uid"] = v["bookmarks"][0]["uid"].clone()), damaged(CopyItem::Bookmark, 2, Damage::RepeatedUid, good["bookmarks"][0]["uid"].as_str().unwrap())),
            (with(&|v| v["bookmarks"][0]["source"] = " ".into()), damaged(CopyItem::Bookmark, 1, Damage::BadSource, " ")),
            (with(&|v| v["bookmarks"][0]["source"] = "x".repeat(65).into()), damaged(CopyItem::Bookmark, 1, Damage::BadSource, &"x".repeat(65))),
            (with(&|v| v["collections"][0]["name"] = " ".into()), damaged(CopyItem::Collection, 1, Damage::MissingName, "")),
        ];
        for (text, expected) in cases {
            assert_eq!(check(&text).unwrap_err(), expected, "{text:.80}");
        }
        // The tree (2.19.0): a parent the copy doesn't have, a collection inside itself, a ring through others.
        let at = |name: &str| good["collections"].as_array().unwrap().iter().position(|c| c["name"] == name).unwrap();
        let uid = |name: &str| good["collections"][at(name)]["uid"].as_str().unwrap().to_owned();
        let unknown = with(&|v| v["collections"][at("Async")]["parent"] = "nowhere".into());
        assert_eq!(check(&unknown).unwrap_err(), damaged(CopyItem::Collection, at("Async") + 1, Damage::UnknownParent, "nowhere"));
        let itself = with(&|v| v["collections"][at("Чтение")]["parent"] = uid("Чтение").into());
        assert_eq!(check(&itself).unwrap_err(), damaged(CopyItem::Collection, at("Чтение") + 1, Damage::Loop, uid("Чтение")));
        // Async is in Rust, in Работа: Работа in Async closes the ring, reported at its first member in the file.
        let ring = with(&|v| v["collections"][at("Работа")]["parent"] = uid("Async").into());
        assert_eq!(check(&ring).unwrap_err(), damaged(CopyItem::Collection, at("Async") + 1, Damage::Loop, uid("Async")));
        // A source this version doesn't know, from a newer app or another device, is kept.
        let phone = check(&with(&|v| v["bookmarks"][0]["source"] = "phone".into())).unwrap();
        assert_eq!(phone.bookmarks[0].source.as_deref(), Some("phone"));
        // Missing fields are a damaged structure, with serde's account of where.
        let broken = with(&|v| {
            v["bookmarks"][0].as_object_mut().unwrap().remove("title");
        });
        assert!(matches!(check(&broken), Err(RestoreProblem::Damaged { item: CopyItem::File, damage: Damage::Structure, .. })));
        assert_eq!(everything(&c), before);
    }

    #[test]
    fn pictures_at_local_addresses_are_dropped_and_the_bookmarks_stay() {
        let mut copy: serde_json::Value = serde_json::from_str(&copy_of(&library())).unwrap();
        copy["bookmarks"][0]["image_url"] = "http://192.168.1.1/cgi-bin/reboot".into();
        copy["bookmarks"][0]["favicon_url"] = "https://example.com/favicon.ico".into();
        copy["bookmarks"][1]["favicon_url"] = "http://localhost:8080/admin".into();
        copy["bookmarks"][2]["image_url"] = "file:///C:/Windows/win.ini".into();
        let checked = check(&copy.to_string()).unwrap();
        let pictures = |i: usize| (checked.bookmarks[i].image_url.as_deref(), checked.bookmarks[i].favicon_url.as_deref());
        assert_eq!(pictures(0), (None, Some("https://example.com/favicon.ico")));
        assert_eq!(pictures(1).1, None);
        assert_eq!(pictures(2).0, None);
        assert_eq!(checked.bookmarks.len(), 7);
    }

    #[test]
    fn a_failure_in_the_middle_leaves_the_library_as_it_was() {
        let c = library();
        let before = everything(&c);
        let copy = check(&copy_of(&library())).unwrap();
        c.execute_batch("CREATE TEMP TRIGGER fail BEFORE INSERT ON bookmarks WHEN NEW.url = 'https://tokio.rs/' BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        assert!(restore(&c, &copy, RestoreMode::Replace, &folder()).is_err());
        assert_eq!(everything(&c), before, "the replace rolled back: the old library is whole");
        // A backup that cannot be written stops a replace before any change.
        let file_not_folder = folder().join("blocked");
        std::fs::write(&file_not_folder, "x").unwrap();
        assert!(matches!(restore(&c, &copy, RestoreMode::Replace, &file_not_folder), Err(RestoreError::Backup(_))));
        assert_eq!(everything(&c), before);
    }
}
