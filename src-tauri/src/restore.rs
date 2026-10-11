//! Restore from a JSON copy (NP-033, frame 30, Р-31). The whole file is
//! checked before anything changes; merging keeps every bookmark already in
//! the library, replacing first writes a copy of the current library. Either
//! is one transaction.

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

const SOURCES: [&str; 8] = ["app", "chrome", "edge", "firefox", "extension", "bookmarklet", "import", "mcp"];

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
        let bad_date = |value: &str| damaged(CopyItem::Bookmark, at, Damage::BadDate, value);
        b.created_at = time(&b.created_at).ok_or_else(|| bad_date(&b.created_at))?;
        b.updated_at = time(&b.updated_at).ok_or_else(|| bad_date(&b.updated_at))?;
        for optional in [&mut b.triaged_at, &mut b.deleted_at] {
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
            if !SOURCES.contains(&source.as_str()) {
                return Err(damaged(CopyItem::Bookmark, at, Damage::BadSource, source));
            }
        }
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
impl From<rusqlite::Error> for RestoreError {
    fn from(e: rusqlite::Error) -> Self {
        RestoreError::Database(e)
    }
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
        backup: backup.and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
        ..Default::default()
    };
    if mode == RestoreMode::Replace {
        tx.execute_batch("DELETE FROM bookmark_tags; DELETE FROM bookmarks; DELETE FROM tags; DELETE FROM collections;")?;
    }

    // Collections: the same uid, else the same name (case aside), else a new one with the copy's uid.
    let mut by_name: HashMap<String, i64> = tx
        .prepare("SELECT id, name FROM collections")?
        .query_map([], |r| Ok((db::fold(&r.get::<_, String>(1)?), r.get(0)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut collection_ids = HashMap::new();
    for c in &library.collections {
        let found = tx.query_row("SELECT id FROM collections WHERE uid = ?1", [&c.uid], |r| r.get::<_, i64>(0)).optional()?;
        let id = match found.or_else(|| by_name.get(&db::fold(&c.name)).copied()) {
            Some(id) => id,
            None => {
                // A replace brings the copy's sidebar order back (NP-114); a
                // merge adds the new collections after the library's own.
                let position = c.position.filter(|_| mode == RestoreMode::Replace);
                tx.execute(
                    "INSERT INTO collections (uid, name, color, icon, created_at, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![c.uid, c.name, c.color, c.icon, c.created_at, position],
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
            params![if taken { db::new_uid() } else { t.uid.clone() }, t.name, t.created_at],
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
            "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, source, created_at, updated_at, triaged_at, deleted_at, url_key, source_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                b.uid,
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

    #[test]
    fn merge_adds_what_is_missing_keeps_what_is_there_and_states_as_in_the_copy() {
        let text = copy_of(&library());
        let target = database();
        crate::import::import(&target, &crate::import::parse(r#"<DL><DT><H3>работа</H3><DL><DT><A HREF="https://github.com/">Мой GitHub</A></DL></DL>"#, Utc::now()), false, |_, _| {}).unwrap();
        let summary = restore(&target, &check(&text).unwrap(), RestoreMode::Merge, &folder()).unwrap();
        assert_eq!((summary.added, summary.existing, summary.in_inbox, summary.in_trash), (6, 1, 1, 1));
        assert_eq!(summary.collections, ["Чтение"], "«работа» is the copy's «Работа», case aside");
        assert_eq!(summary.backup, None);
        let github = db::get_bookmarks(&target, &db::BookmarkQuery { search: Some("github".into()), ..Default::default() }).unwrap();
        assert_eq!((github.items[0].title.as_str(), github.items[0].is_favorite), ("Мой GitHub", false), "left as it was");
        let tokio: (String, String) = target
            .query_row("SELECT c.name, b.created_at FROM bookmarks b JOIN collections c ON c.id = b.collection_id WHERE url = 'https://tokio.rs/'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(tokio, ("работа".to_string(), "2023-07-22T04:31:40.000Z".to_string()));
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
        let mut after = moved.clone();
        after.sort();
        assert_eq!(names(&merged), [vec!["Ящик".to_string()], after].concat());
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
            (with(&|v| v["bookmarks"][0]["source"] = "phone".into()), damaged(CopyItem::Bookmark, 1, Damage::BadSource, "phone")),
            (with(&|v| v["collections"][0]["name"] = " ".into()), damaged(CopyItem::Collection, 1, Damage::MissingName, "")),
        ];
        for (text, expected) in cases {
            assert_eq!(check(&text).unwrap_err(), expected, "{text:.80}");
        }
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
