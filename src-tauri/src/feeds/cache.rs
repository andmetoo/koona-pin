//! The feed cache `feeds.db` beside the library (NP-128, plan §3.2): posts,
//! read marks and fetch state. A second file, not tables in the library:
//! about 150 MB for 50 busy feeds would ride along in every backup, a restore
//! would roll read marks back, and a refresh would queue behind every library
//! write on its one lock. Nothing here is backed up, exported or synced.
//!
//! The cache is disposable: a missing file is made, a damaged or foreign one
//! is moved aside and made again, and everything is fetched anew. Nothing is
//! lost but read marks. Rows are keyed by the subscription's `uid`, so a feed
//! that comes back by sync, OPML or a restore finds its posts.
//!
//! Lock order, always: the library (`DbState::conn`), then this connection.
//! The sweep, queries and writes of posts are NP-131's.

use super::{Feed, FeedArticle, FeedHealth, FeedItem, FeedItemQuery};
use crate::{
    db::{self, DbState},
    error::CommandError,
};
use chrono::{DateTime, Duration as Span, Utc};
use rusqlite::{params, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

/// Beside `koonapin.db`.
pub const FILE: &str = "feeds.db";
/// Where a damaged or foreign cache is moved: one, the newest, is kept for a look.
pub const DAMAGED_FILE: &str = "feeds.damaged.db";
/// "NPFC" in the header: a feed cache of this app.
pub const APPLICATION_ID: i32 = 0x4E50_4643;

/// One step per cache version, applied in order; `user_version` is the version.
/// Unlike the library's, a released step may be dropped for a fresh start: a
/// new first step and a higher version make every cache again (NP-128).
const STEPS: &[&str] = &[
    // v1: fetch state per feed, posts, and the keys of expired posts.
    "
CREATE TABLE feed_state (
    feed_uid TEXT PRIMARY KEY,
    title TEXT, site_url TEXT, icon_url TEXT, description TEXT,
    etag TEXT, last_modified TEXT,
    fetched_at TEXT, succeeded_at TEXT, next_fetch_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0, failing_since TEXT, last_error TEXT,
    moved_to TEXT
);
CREATE TABLE feed_items (
    id INTEGER PRIMARY KEY,
    feed_uid TEXT NOT NULL,
    key TEXT NOT NULL,
    url TEXT, title TEXT, author TEXT,
    excerpt TEXT,
    content_html TEXT,
    full INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT,
    published_at TEXT, fetched_at TEXT NOT NULL,
    read_at TEXT,
    bookmark_uid TEXT,
    UNIQUE (feed_uid, key)
);
CREATE INDEX feed_items_list ON feed_items (feed_uid, published_at DESC, id DESC);
CREATE INDEX feed_items_unread ON feed_items (feed_uid) WHERE read_at IS NULL;
CREATE TABLE feed_seen (
    feed_uid TEXT NOT NULL, key TEXT NOT NULL, until TEXT NOT NULL,
    PRIMARY KEY (feed_uid, key)
) WITHOUT ROWID;
",
];

/// The newest cache version this build makes.
pub const VERSION: i64 = STEPS.len() as i64;

/// Managed once the library is open. The connection is its own: a refresh
/// never waits for the library's lock, nor the library for it.
pub struct FeedCache {
    pub conn: Mutex<Connection>,
    pub path: PathBuf,
}

/// The cache, ready to use, and where a damaged one went.
pub struct Opened {
    pub conn: Connection,
    pub moved_aside: Option<PathBuf>,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // A cache: losing the last write on a power cut costs a refetch, not data.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    register_functions(conn)
}

/// Opens the cache as it is, or says why it cannot be used.
fn open_as_is(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
        .map_err(|e| e.to_string())?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("damaged: {check}"));
    }
    let id: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0)).map_err(|e| e.to_string())?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(|e| e.to_string())?;
    let empty: bool = conn
        .query_row("SELECT NOT EXISTS (SELECT 1 FROM sqlite_schema)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !(id == APPLICATION_ID || (id == 0 && version == 0 && empty)) {
        return Err(format!("not a feed cache (application id {id:#x})"));
    }
    // A newer build's cache: this one cannot read it, and it is only a cache.
    if version > VERSION {
        return Err(format!("cache version {version} is newer than {VERSION}"));
    }
    configure(&conn).map_err(|e| e.to_string())?;
    migrate(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// The steps after the cache's version, each with its version in one transaction.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (index, step) in STEPS.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(step)?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// Moves the cache and its journal files out of the way; the newest damaged
/// copy replaces an older one.
fn move_aside(path: &Path) -> Option<PathBuf> {
    let aside = path.with_file_name(DAMAGED_FILE);
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", aside.display()));
    }
    let moved = std::fs::rename(path, &aside).is_ok();
    for suffix in ["-wal", "-shm"] {
        let from = format!("{}{suffix}", path.display());
        if moved {
            let _ = std::fs::rename(&from, format!("{}{suffix}", aside.display()));
        } else {
            let _ = std::fs::remove_file(&from);
        }
    }
    if !moved {
        let _ = std::fs::remove_file(path);
    }
    moved.then_some(aside)
}

/// The cache in `folder`, made when missing; damaged, foreign or from a newer
/// build, it is moved aside and made again.
pub fn open(folder: &Path) -> rusqlite::Result<Opened> {
    let path = folder.join(FILE);
    match open_as_is(&path) {
        Ok(conn) => Ok(Opened { conn, moved_aside: None }),
        Err(problem) => {
            eprintln!("The feed cache cannot be used ({problem}); making it again");
            let moved_aside = move_aside(&path);
            let conn = Connection::open(&path)?;
            configure(&conn)?;
            migrate(&conn)?;
            Ok(Opened { conn, moved_aside })
        }
    }
}

/// A cache that lives as long as the run: when the file cannot be made at
/// all, feeds still work, and are fetched again on the next start.
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    register_functions(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Opens the cache beside the library and manages it. Called once, after
/// the library opened.
pub fn start(app: &AppHandle, folder: &Path) {
    let path = folder.join(FILE);
    let conn = match open(folder) {
        Ok(opened) => opened.conn,
        Err(error) => {
            eprintln!("The feed cache cannot be made ({error}); keeping it in memory for this run");
            match open_in_memory() {
                Ok(conn) => conn,
                Err(_) => return,
            }
        }
    };
    // The start's sweep (NP-131): the library is managed by now; it is read
    // and let go before the cache is written, as the lock order asks.
    if let Some(db) = app.try_state::<Arc<DbState>>() {
        let known = db.conn.lock().map_err(|e| e.to_string()).and_then(|library| known_uids(&library).map_err(|e| e.to_string()));
        match known.and_then(|known| sweep(&conn, &known, Utc::now()).map_err(|e| e.to_string())) {
            Ok(_) => {}
            Err(error) => eprintln!("Sweeping the feed cache failed: {error}"),
        }
    }
    app.manage(Arc::new(FeedCache { conn: Mutex::new(conn), path }));
}

/// Every row of a feed: after an unsubscribe.
pub fn forget(conn: &Connection, feed_uid: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for table in ["feed_items", "feed_seen", "feed_state"] {
        tx.execute(&format!("DELETE FROM {table} WHERE feed_uid = ?1"), [feed_uid])?;
    }
    tx.commit()
}

/// [`forget`] through the managed cache; without one there is nothing to forget.
pub fn forget_feed(app: &AppHandle, feed_uid: &str) {
    let Some(cache) = app.try_state::<Arc<FeedCache>>() else {
        return;
    };
    let Ok(conn) = cache.conn.lock() else {
        return;
    };
    if let Err(error) = forget(&conn, feed_uid) {
        // The start's sweep of unknown uids takes them later (NP-131).
        eprintln!("Forgetting the posts of a feed failed: {error}");
    }
}

/// How long an unsaved post stays, by when it was first fetched (plan §11.8).
pub const KEEP_DAYS: i64 = 30;
/// How long the key of an expired post keeps it from coming back as new.
pub const SEEN_DAYS: i64 = 90;
/// Posts kept per feed, the newest.
pub const PER_FEED: i64 = 500;
/// The first load of a subscription keeps this many…
pub const FIRST_LOAD: usize = 20;
/// …and marks those published longer ago than this read.
pub const FIRST_LOAD_UNREAD_DAYS: i64 = 7;
/// A feed failing this long shows as failing.
pub const FAILING_DAYS: i64 = 7;
/// `VACUUM` once more than this share of the file is free pages.
const VACUUM_FREE_SHARE: f64 = 0.25;

/// A post's place in the list: its date, else when it was fetched (a post
/// without a date is as new as its fetch). The cursor is this, `|`, the id.
const SORT_AT: &str = "COALESCE(published_at, fetched_at)";

/// `np_feed_match(word, field…)`: the folded word is in one of the fields,
/// folded as the library folds (`db::fold`): case-insensitive for Cyrillic
/// too, which `LIKE` is not (NP-131).
fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::ValueRef;
    conn.create_scalar_function(
        "np_feed_match",
        -1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let word = ctx.get_or_create_aux(0, |word| -> rusqlite::Result<String> { Ok(db::fold(word.as_str()?)) })?;
            for i in 1..ctx.len() {
                if let ValueRef::Text(bytes) = ctx.get_raw(i) {
                    if db::fold(&String::from_utf8_lossy(bytes)).contains(word.as_str()) {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        },
    )
}

fn stamp_of(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

/// The cache's connection off the main thread, as `commands::blocking` does
/// for the library. Never call it holding the library's lock (lock order).
pub(crate) async fn blocking<T: Send + 'static>(
    cache: &State<'_, Arc<FeedCache>>,
    work: impl FnOnce(&Connection) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = cache.conn.lock().map_err(CommandError::internal)?;
        work(&conn)
    })
    .await
    .map_err(CommandError::internal)?
}

/// What [`store_fetch`] did: the ids of posts new to the cache, newest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stored {
    pub new_ids: Vec<i64>,
}

/// Stores a fetched document (NP-129 calls it): the feed's own title, site,
/// icon and description into `feed_state`, and its posts into `feed_items` by
/// `(feed_uid, key)`, keeping read marks and saves, skipping keys in
/// `feed_seen`, with the first-load rule (plan §3.2). The fetch state columns
/// (validators, times, failures) are the fetch's own to write.
pub fn store_fetch(
    conn: &Connection,
    feed_uid: &str,
    feed: &super::parse::ParsedFeed,
    now: &str,
) -> rusqlite::Result<Stored> {
    let at = stamp_of(now).unwrap_or_else(Utc::now);
    let seen_until = db::stamp(at + Span::days(SEEN_DAYS));
    let old = db::stamp(at - Span::days(FIRST_LOAD_UNREAD_DAYS));
    let tx = conn.unchecked_transaction()?;
    // What the feed says of itself; a field it stopped sending keeps the last one.
    tx.execute(
        "INSERT INTO feed_state (feed_uid, title, site_url, icon_url, description) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (feed_uid) DO UPDATE SET title = COALESCE(excluded.title, title),
            site_url = COALESCE(excluded.site_url, site_url), icon_url = COALESCE(excluded.icon_url, icon_url),
            description = COALESCE(excluded.description, description)",
        params![feed_uid, feed.title, feed.site_url, feed.icon_url, feed.description],
    )?;
    let first = !tx.query_row("SELECT EXISTS (SELECT 1 FROM feed_items WHERE feed_uid = ?1)", [feed_uid], |r| r.get::<_, bool>(0))?;

    // Newest first; a post without a date keeps its place in the document after the dated ones.
    let mut items: Vec<&super::parse::ParsedItem> = feed.items.iter().collect();
    items.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    let mut seen = tx.prepare("INSERT INTO feed_seen (feed_uid, key, until) VALUES (?1, ?2, ?3)
        ON CONFLICT (feed_uid, key) DO UPDATE SET until = excluded.until")?;
    if first && items.len() > FIRST_LOAD {
        // A new subscription doesn't arrive with «200 new»: the rest are seen, so
        // the next fetch does not bring them as new either.
        for item in items.split_off(FIRST_LOAD) {
            seen.execute(params![feed_uid, item.key, seen_until])?;
        }
    }
    let mut new_ids = Vec::new();
    for item in items {
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM feed_items WHERE feed_uid = ?1 AND key = ?2", params![feed_uid, item.key], |r| r.get(0))
            .optional()?;
        if let Some(id) = existing {
            // Edited at the source: the text follows, the read mark and the save stay.
            tx.execute(
                "UPDATE feed_items SET url = ?2, title = ?3, author = ?4, excerpt = ?5, content_html = ?6, full = ?7,
                    thumbnail_url = ?8, published_at = COALESCE(?9, published_at) WHERE id = ?1",
                params![id, item.url, item.title, item.author, item.excerpt, item.content_html, item.full, item.thumbnail_url, item.published_at],
            )?;
            continue;
        }
        let expired: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM feed_seen WHERE feed_uid = ?1 AND key = ?2)",
            params![feed_uid, item.key],
            |r| r.get(0),
        )?;
        if expired {
            // Still in the document: still seen, for as long as it stays there.
            seen.execute(params![feed_uid, item.key, seen_until])?;
            continue;
        }
        let read_at = (first && item.published_at.as_deref().is_some_and(|p| p < old.as_str())).then_some(now);
        tx.execute(
            "INSERT INTO feed_items (feed_uid, key, url, title, author, excerpt, content_html, full, thumbnail_url, published_at, fetched_at, read_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![feed_uid, item.key, item.url, item.title, item.author, item.excerpt, item.content_html, item.full, item.thumbnail_url, item.published_at, now, read_at],
        )?;
        new_ids.push(tx.last_insert_rowid());
    }
    drop(seen);
    tx.commit()?;
    Ok(Stored { new_ids })
}

/// What a [`sweep`] took.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Swept {
    /// Posts past [`KEEP_DAYS`], saved or not.
    pub expired: usize,
    /// Posts over [`PER_FEED`].
    pub capped: usize,
    /// Rows of feeds no longer followed.
    pub unknown: usize,
    pub vacuumed: bool,
}

/// The subscriptions' uids, to sweep the cache by.
pub fn known_uids(library: &Connection) -> rusqlite::Result<Vec<String>> {
    library.prepare("SELECT uid FROM feeds")?.query_map([], |r| r.get(0))?.collect()
}

/// The start-up and daily sweep (plan §3.2): posts first fetched more than
/// 30 days ago go, saved or not (a saved one lives on as its bookmark), with
/// their keys kept in `feed_seen` for 90 days so they do not come back as
/// new; at most 500 posts per feed; rows of uids not in `known` go; and
/// `VACUUM` when over a quarter of the file is free.
pub fn sweep(conn: &Connection, known: &[String], now: DateTime<Utc>) -> rusqlite::Result<Swept> {
    let stamp = db::stamp(now);
    let until = db::stamp(now + Span::days(SEEN_DAYS));
    let cutoff = db::stamp(now - Span::days(KEEP_DAYS));
    let known = serde_json::to_string(known).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM feed_seen WHERE until < ?1", [&stamp])?;
    let mut unknown = 0;
    for table in ["feed_items", "feed_seen", "feed_state"] {
        unknown += tx.execute(
            &format!("DELETE FROM {table} WHERE feed_uid NOT IN (SELECT value FROM json_each(?1))"),
            [&known],
        )?;
    }
    tx.execute(
        "INSERT INTO feed_seen (feed_uid, key, until) SELECT feed_uid, key, ?2 FROM feed_items WHERE fetched_at < ?1
         ON CONFLICT (feed_uid, key) DO UPDATE SET until = excluded.until",
        params![cutoff, until],
    )?;
    let expired = tx.execute("DELETE FROM feed_items WHERE fetched_at < ?1", [&cutoff])?;
    let over = format!(
        "SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY feed_uid ORDER BY {SORT_AT} DESC, id DESC) AS n
         FROM feed_items) WHERE n > ?1"
    );
    tx.execute(
        &format!(
            "INSERT INTO feed_seen (feed_uid, key, until) SELECT feed_uid, key, ?2 FROM feed_items WHERE id IN ({over})
             ON CONFLICT (feed_uid, key) DO UPDATE SET until = excluded.until"
        ),
        params![PER_FEED, until],
    )?;
    let capped = tx.execute(&format!("DELETE FROM feed_items WHERE id IN ({over})"), [PER_FEED])?;
    tx.commit()?;
    let pages: i64 = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let free: i64 = conn.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
    let vacuumed = pages > 0 && free as f64 / pages as f64 > VACUUM_FREE_SHARE;
    if vacuumed {
        conn.execute_batch("VACUUM")?;
    }
    Ok(Swept { expired, capped, unknown, vacuumed })
}

/// How fetching goes, from the fetch state NP-129 writes: gone and moved
/// first, then a blocked feed (at once: waiting will not help), offline, and
/// a feed failing for [`FAILING_DAYS`].
pub fn health(
    last_error: Option<&str>,
    moved_to: Option<&str>,
    failures: i64,
    failing_since: Option<&str>,
    fetched_at: Option<&str>,
    now: DateTime<Utc>,
) -> FeedHealth {
    let since = || failing_since.or(fetched_at).unwrap_or_default().to_string();
    match last_error {
        Some("gone") | Some("status:410") => return FeedHealth::Gone,
        _ if moved_to.is_some() => return FeedHealth::Moved { to: moved_to.unwrap_or_default().into() },
        Some("blocked") => return FeedHealth::Failing { since: since(), reason: "blocked".into() },
        Some("offline") => return FeedHealth::Offline,
        _ => {}
    }
    let long = failing_since
        .and_then(stamp_of)
        .is_some_and(|since| now - since >= Span::days(FAILING_DAYS));
    match last_error {
        Some(reason) if failures > 0 && long => FeedHealth::Failing { since: since(), reason: reason.into() },
        _ => FeedHealth::Ok,
    }
}

/// What the cache knows of each subscription, into `feeds`: title, site,
/// icon, counts, the last fetch and health.
pub fn merge_state(conn: &Connection, feeds: &mut [Feed], now: DateTime<Utc>) -> rusqlite::Result<()> {
    let mut counts: HashMap<String, (u32, u32)> = conn
        .prepare("SELECT feed_uid, count(*), count(*) FILTER (WHERE read_at IS NULL) FROM feed_items GROUP BY feed_uid")?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let mut state = conn.prepare(
        "SELECT title, site_url, icon_url, fetched_at, last_error, moved_to, failures, failing_since
         FROM feed_state WHERE feed_uid = ?1",
    )?;
    for feed in feeds.iter_mut() {
        let (total, unread) = counts.remove(&feed.uid).unwrap_or_default();
        (feed.total, feed.unread) = (total, unread);
        let row = state
            .query_row([&feed.uid], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            })
            .optional()?;
        if let Some((title, site, icon, fetched, error, moved, failures, since)) = row {
            feed.health = health(error.as_deref(), moved.as_deref(), failures, since.as_deref(), fetched.as_deref(), now);
            (feed.feed_title, feed.site_url, feed.icon_url, feed.fetched_at) = (title, site, icon, fetched);
        }
    }
    Ok(())
}

/// The feed's own title from its last fetch.
pub fn feed_title(conn: &Connection, feed_uid: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row("SELECT title FROM feed_state WHERE feed_uid = ?1", [feed_uid], |r| r.get(0))
        .optional()?
        .flatten())
}

const ITEM_COLUMNS: &str = "id, feed_uid, url, title, author, excerpt, thumbnail_url, published_at, fetched_at,
    read_at IS NOT NULL, full, bookmark_uid, COALESCE(published_at, fetched_at)";

/// A post of the list and its bookmark's uid; `bookmark_id` is the library's
/// to fill (`save::saved_ids`).
fn item_of(row: &rusqlite::Row) -> rusqlite::Result<(FeedItem, Option<String>, String)> {
    Ok((
        FeedItem {
            id: row.get(0)?,
            feed_uid: row.get(1)?,
            url: row.get(2)?,
            title: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            author: row.get(4)?,
            excerpt: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            thumbnail_url: row.get(6)?,
            published_at: row.get(7)?,
            fetched_at: row.get(8)?,
            read: row.get(9)?,
            bookmark_id: None,
            full: row.get(10)?,
        },
        row.get(11)?,
        row.get(12)?,
    ))
}

/// A page of the list, newest first: the posts with their bookmarks' uids,
/// and the cursor of the next page.
pub type ItemsPage = (Vec<(FeedItem, Option<String>)>, Option<String>);

/// A page of posts, newest first, after the cursor `published_at|id`.
pub fn list_items(conn: &Connection, query: &FeedItemQuery) -> rusqlite::Result<ItemsPage> {
    let limit = match query.limit {
        0 => 50,
        n => n.min(500),
    } as usize;
    let mut filter = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(uid) = &query.feed_uid {
        filter.push("feed_uid = ?".to_string());
        values.push(uid.clone().into());
    }
    if query.unread_only {
        filter.push("read_at IS NULL".into());
    }
    for word in query.search.as_deref().unwrap_or_default().split_whitespace() {
        filter.push("np_feed_match(?, title, excerpt)".into());
        values.push(word.to_string().into());
    }
    if let Some((at, id)) = query.after.as_deref().and_then(|cursor| cursor.rsplit_once('|')) {
        let id: i64 = id.parse().map_err(|_| rusqlite::Error::InvalidParameterName("after".into()))?;
        filter.push(format!("({SORT_AT} < ? OR ({SORT_AT} = ? AND id < ?))"));
        values.extend([at.to_string().into(), at.to_string().into(), id.into()]);
    }
    let filter = if filter.is_empty() { String::new() } else { format!(" WHERE {}", filter.join(" AND ")) };
    values.push((limit as i64 + 1).into());
    let mut rows = conn
        .prepare(&format!("SELECT {ITEM_COLUMNS} FROM feed_items{filter} ORDER BY {SORT_AT} DESC, id DESC LIMIT ?"))?
        .query_map(params_from_iter(values), item_of)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = (rows.len() > limit).then(|| {
        rows.truncate(limit);
        rows.last().map(|(item, _, at)| format!("{at}|{}", item.id))
    });
    Ok((rows.into_iter().map(|(item, uid, _)| (item, uid)).collect(), next.flatten()))
}

/// One post to read; a post without content reads as its excerpt.
pub fn article(conn: &Connection, id: i64) -> rusqlite::Result<FeedArticle> {
    conn.query_row(
        "SELECT id, url, title, author, published_at, content_html, excerpt, full FROM feed_items WHERE id = ?1",
        [id],
        |r| {
            let html: Option<String> = r.get(5)?;
            let excerpt: Option<String> = r.get(6)?;
            Ok(FeedArticle {
                id: r.get(0)?,
                url: r.get(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                author: r.get(3)?,
                published_at: r.get(4)?,
                html: html
                    .filter(|h| !h.trim().is_empty())
                    .unwrap_or_else(|| format!("<p>{}</p>", escape(&excerpt.unwrap_or_default()))),
                full: r.get(7)?,
            })
        },
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Marks posts read (at `now`; a post already read keeps its time) or unread.
pub fn set_read(conn: &Connection, ids: &[i64], read: bool, now: &str) -> rusqlite::Result<usize> {
    let ids = serde_json::to_string(ids).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    if read {
        conn.execute(
            "UPDATE feed_items SET read_at = ?2 WHERE read_at IS NULL AND id IN (SELECT value FROM json_each(?1))",
            params![ids, now],
        )
    } else {
        conn.execute(
            "UPDATE feed_items SET read_at = NULL WHERE read_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))",
            [ids],
        )
    }
}

/// «Mark all read» of one feed or all, of posts fetched up to `up_to`: a post
/// that arrived since the person looked stays new. How many were marked.
pub fn mark_all_read(conn: &Connection, feed_uid: Option<&str>, up_to: Option<&str>, now: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE feed_items SET read_at = ?3 WHERE read_at IS NULL
            AND (?1 IS NULL OR feed_uid = ?1) AND (?2 IS NULL OR fetched_at <= ?2)",
        params![feed_uid, up_to, now],
    )
}

/// What saving needs of a post.
#[derive(Debug, Clone)]
pub struct PostToSave {
    pub id: i64,
    pub feed_uid: String,
    pub url: Option<String>,
    pub title: String,
    pub excerpt: String,
    pub thumbnail_url: Option<String>,
    pub bookmark_uid: Option<String>,
}

/// Those of `ids` still in the cache, in the order of `ids`.
pub fn posts(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<PostToSave>> {
    let mut stmt = conn.prepare(
        "SELECT id, feed_uid, url, title, excerpt, thumbnail_url, bookmark_uid FROM feed_items WHERE id = ?1",
    )?;
    let mut found = Vec::new();
    for id in ids {
        let post = stmt
            .query_row([id], |r| {
                Ok(PostToSave {
                    id: r.get(0)?,
                    feed_uid: r.get(1)?,
                    url: r.get(2)?,
                    title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    excerpt: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    thumbnail_url: r.get(5)?,
                    bookmark_uid: r.get(6)?,
                })
            })
            .optional()?;
        found.extend(post);
    }
    Ok(found)
}

/// The post was saved as the bookmark `bookmark_uid`: shown «saved», and read.
pub fn mark_saved(conn: &Connection, id: i64, bookmark_uid: &str, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE feed_items SET bookmark_uid = ?2, read_at = COALESCE(read_at, ?3) WHERE id = ?1",
        params![id, bookmark_uid, now],
    )?;
    Ok(())
}

/// «Clear feed cache»: posts, read marks, seen keys and fetch state go; with no
/// fetch state every feed is due, so the loop fetches each again.
pub fn clear(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for table in ["feed_items", "feed_seen", "feed_state"] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.commit()?;
    conn.execute_batch("VACUUM")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folder(name: &str) -> PathBuf {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn tables(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn post(conn: &Connection, feed: &str, key: &str) {
        conn.execute(
            "INSERT INTO feed_items (feed_uid, key, title, fetched_at) VALUES (?1, ?2, 'A post', '2026-10-16T10:00:00.000Z')",
            [feed, key],
        )
        .unwrap();
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM feed_items", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_missing_cache_is_made_with_schema_1_and_kept() {
        let folder = folder("feed-cache-new");
        let opened = open(&folder).unwrap();
        assert!(opened.moved_aside.is_none());
        let conn = opened.conn;
        assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.pragma_query_value(None, "application_id", |r| r.get::<_, i32>(0)).unwrap(), APPLICATION_ID);
        assert_eq!(
            tables(&conn),
            ["feed_items", "feed_items_list", "feed_items_unread", "feed_seen", "feed_state"]
        );
        post(&conn, "f", "1");
        drop(conn);
        let again = open(&folder).unwrap();
        assert!(again.moved_aside.is_none());
        assert_eq!(count(&again.conn), 1, "a second start keeps the posts");
    }

    #[test]
    fn a_damaged_cache_is_moved_aside_and_made_again() {
        let folder = folder("feed-cache-damaged");
        fs::write(folder.join(FILE), b"not a database, only noise of a broken disk ......").unwrap();
        let opened = open(&folder).unwrap();
        assert_eq!(opened.moved_aside.as_deref(), Some(folder.join(DAMAGED_FILE).as_path()));
        assert!(folder.join(DAMAGED_FILE).exists());
        assert_eq!(count(&opened.conn), 0);
        post(&opened.conn, "f", "1");
    }

    #[test]
    fn a_foreign_or_newer_file_is_not_used() {
        let folder = folder("feed-cache-foreign");
        let foreign = Connection::open(folder.join(FILE)).unwrap();
        foreign.execute_batch("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('mine');").unwrap();
        drop(foreign);
        let opened = open(&folder).unwrap();
        assert!(opened.moved_aside.is_some());
        assert!(tables(&opened.conn).contains(&"feed_items".to_string()));
        opened.conn.pragma_update(None, "user_version", VERSION + 1).unwrap();
        drop(opened);
        let opened = open(&folder).unwrap();
        assert!(opened.moved_aside.is_some(), "a newer build's cache");
        assert_eq!(opened.conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    }

    #[test]
    fn a_post_is_one_per_key_and_forget_takes_a_feed() {
        let conn = open_in_memory().unwrap();
        post(&conn, "a", "1");
        post(&conn, "b", "1");
        let again = conn.execute(
            "INSERT INTO feed_items (feed_uid, key, fetched_at) VALUES ('a', '1', 'x')",
            [],
        );
        assert!(again.is_err(), "one row per feed and key");
        conn.execute("INSERT INTO feed_state (feed_uid) VALUES ('a')", []).unwrap();
        conn.execute("INSERT INTO feed_seen VALUES ('a', 'old', 'x')", []).unwrap();
        forget(&conn, "a").unwrap();
        assert_eq!(count(&conn), 1);
        let left: i64 = conn
            .query_row("SELECT (SELECT count(*) FROM feed_state) + (SELECT count(*) FROM feed_seen)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    // The rules of NP-131 below.

    use super::super::{
        parse::{ParsedFeed, ParsedItem},
        FeedDestination,
    };

    const NOW: &str = "2026-10-16T10:00:00.000Z";

    fn at(text: &str) -> DateTime<Utc> {
        stamp_of(text).unwrap()
    }

    fn days_ago(days: i64) -> String {
        db::stamp(at(NOW) - Span::days(days))
    }

    fn item(key: &str, published: Option<String>) -> ParsedItem {
        ParsedItem {
            key: key.into(),
            url: Some(format!("https://example.com/{key}")),
            title: format!("Post {key}"),
            excerpt: format!("About {key}"),
            content_html: Some(format!("<p>All of {key}</p>")),
            published_at: published,
            ..Default::default()
        }
    }

    fn document(items: Vec<ParsedItem>) -> ParsedFeed {
        ParsedFeed { title: Some("Example".into()), site_url: Some("https://example.com/".into()), items, ..Default::default() }
    }

    fn keys(conn: &Connection, feed: &str) -> Vec<String> {
        conn.prepare("SELECT key FROM feed_items WHERE feed_uid = ?1 ORDER BY key")
            .unwrap()
            .query_map([feed], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn unread(conn: &Connection, feed: &str) -> i64 {
        conn.query_row("SELECT count(*) FROM feed_items WHERE feed_uid = ?1 AND read_at IS NULL", [feed], |r| r.get(0))
            .unwrap()
    }

    fn query(feed: Option<&str>, limit: u32) -> FeedItemQuery {
        FeedItemQuery { feed_uid: feed.map(str::to_string), limit, ..Default::default() }
    }

    fn subscription(uid: &str) -> Feed {
        Feed {
            uid: uid.into(),
            url: format!("https://{uid}.example.com/feed"),
            title: None,
            feed_title: None,
            site_url: None,
            icon_url: None,
            destination: FeedDestination::Feeds,
            unread: 0,
            total: 0,
            fetched_at: None,
            health: FeedHealth::Ok,
        }
    }

    #[test]
    fn an_upsert_keeps_read_marks_and_saves_and_returns_new_posts_newest_first() {
        let conn = open_in_memory().unwrap();
        // The fetch's own columns, written before by NP-129, stay as they are.
        conn.execute("INSERT INTO feed_state (feed_uid, etag, failures) VALUES ('f', 'v1', 2)", []).unwrap();
        let first = store_fetch(&conn, "f", &document(vec![item("a", Some(days_ago(1)))]), NOW).unwrap();
        assert_eq!(first.new_ids.len(), 1);
        conn.execute("UPDATE feed_items SET read_at = ?1, bookmark_uid = 'b-1' WHERE key = 'a'", [NOW]).unwrap();

        let mut edited = item("a", Some(days_ago(1)));
        edited.title = "Post a, edited".into();
        let later = "2026-10-16T11:00:00.000Z";
        let doc = document(vec![item("c", Some(days_ago(0))), edited, item("b", Some(days_ago(2))), item("d", None)]);
        let second = store_fetch(&conn, "f", &doc, later).unwrap();
        let id_of = |key: &str| -> i64 { conn.query_row("SELECT id FROM feed_items WHERE key = ?1", [key], |r| r.get(0)).unwrap() };
        assert_eq!(second.new_ids, vec![id_of("c"), id_of("b"), id_of("d")], "new only, newest first, undated last");
        let (title, read, saved, fetched): (String, Option<String>, Option<String>, String) = conn
            .query_row("SELECT title, read_at, bookmark_uid, fetched_at FROM feed_items WHERE key = 'a'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!((title.as_str(), read.as_deref(), saved.as_deref(), fetched.as_str()), ("Post a, edited", Some(NOW), Some("b-1"), NOW));
        // Not a first load: nothing new is marked read, however old.
        assert_eq!(unread(&conn, "f"), 3);
        let (title, etag, failures): (String, String, i64) = conn
            .query_row("SELECT title, etag, failures FROM feed_state WHERE feed_uid = 'f'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((title.as_str(), etag.as_str(), failures), ("Example", "v1", 2));
    }

    #[test]
    fn a_first_load_keeps_twenty_and_marks_the_older_than_a_week_read() {
        let conn = open_in_memory().unwrap();
        // 30 posts, one a day: the 20 newest are kept, days 8–19 of them read.
        let items: Vec<ParsedItem> = (0..30).map(|day| item(&format!("{day:02}"), Some(days_ago(day)))).collect();
        let stored = store_fetch(&conn, "f", &document(items.clone()), NOW).unwrap();
        assert_eq!(stored.new_ids.len(), 20);
        assert_eq!(keys(&conn, "f").last().map(String::as_str), Some("19"));
        assert_eq!(unread(&conn, "f"), 8, "days 0 to 7");
        // The ten left out do not come back as new with the next fetch.
        let again = store_fetch(&conn, "f", &document(items), NOW).unwrap();
        assert!(again.new_ids.is_empty());
        assert_eq!(keys(&conn, "f").len(), 20);
        // Another feed's first load is its own.
        assert_eq!(store_fetch(&conn, "g", &document(vec![item("x", None)]), NOW).unwrap().new_ids.len(), 1);
    }

    #[test]
    fn after_thirty_days_a_post_is_gone_and_does_not_come_back() {
        let conn = open_in_memory().unwrap();
        store_fetch(&conn, "f", &document(vec![item("old", None), item("saved", None)]), &days_ago(31)).unwrap();
        conn.execute("UPDATE feed_items SET bookmark_uid = 'b' WHERE key = 'saved'", []).unwrap();
        store_fetch(&conn, "f", &document(vec![item("new", None)]), &days_ago(1)).unwrap();
        let swept = sweep(&conn, &["f".to_string()], at(NOW)).unwrap();
        assert_eq!(swept.expired, 2, "saved or not: a saved one lives on as its bookmark");
        assert_eq!(keys(&conn, "f"), ["new"]);
        let until: String = conn.query_row("SELECT until FROM feed_seen WHERE key = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(until, db::stamp(at(NOW) + Span::days(SEEN_DAYS)));
        // Still in the feed's document: skipped, and seen for longer.
        let later = db::stamp(at(NOW) + Span::days(1));
        let stored = store_fetch(&conn, "f", &document(vec![item("old", None), item("saved", None), item("new", None)]), &later).unwrap();
        assert!(stored.new_ids.is_empty());
        let until: String = conn.query_row("SELECT until FROM feed_seen WHERE key = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(until, db::stamp(at(&later) + Span::days(SEEN_DAYS)));
        // A seen key itself expires after 90 days.
        sweep(&conn, &["f".to_string()], at(NOW) + Span::days(SEEN_DAYS + 2)).unwrap();
        let seen: Vec<String> = conn
            .prepare("SELECT key FROM feed_seen")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(seen, ["new"], "only the post that expired just now");
    }

    #[test]
    fn a_feed_keeps_at_most_five_hundred_posts_the_newest() {
        let conn = open_in_memory().unwrap();
        store_fetch(&conn, "f", &document(vec![item("first", Some(days_ago(3)))]), NOW).unwrap();
        let items: Vec<ParsedItem> = (0..PER_FEED + 10)
            .map(|n| item(&format!("{n:04}"), Some(db::stamp(at(NOW) - Span::minutes(n)))))
            .collect();
        store_fetch(&conn, "f", &document(items), NOW).unwrap();
        let swept = sweep(&conn, &["f".to_string()], at(NOW)).unwrap();
        assert_eq!(swept.capped, 11);
        let all = keys(&conn, "f");
        assert_eq!(all.len() as i64, PER_FEED);
        assert!(!all.contains(&"first".to_string()), "the oldest go first");
        assert_eq!(all.last().map(String::as_str), Some("0499"));
        let seen: i64 = conn.query_row("SELECT count(*) FROM feed_seen", [], |r| r.get(0)).unwrap();
        assert_eq!(seen, 11, "capped posts do not come back as new either");
    }

    #[test]
    fn the_sweep_takes_unknown_feeds_and_vacuums_a_mostly_empty_file() {
        let conn = open_in_memory().unwrap();
        let mut big = item("big", None);
        big.content_html = Some("x".repeat(400_000));
        store_fetch(&conn, "gone", &document(vec![big, item("a", None)]), NOW).unwrap();
        store_fetch(&conn, "kept", &document(vec![item("a", None)]), NOW).unwrap();
        conn.execute("INSERT INTO feed_seen VALUES ('gone', 'k', ?1)", [NOW]).unwrap();
        let swept = sweep(&conn, &["kept".to_string()], at(NOW)).unwrap();
        assert_eq!(swept.unknown, 4, "two posts, a seen key and the state");
        assert!(swept.vacuumed);
        assert_eq!(keys(&conn, "kept"), ["a"]);
        assert!(!sweep(&conn, &["kept".to_string()], at(NOW)).unwrap().vacuumed);
        // No subscriptions at all: nothing stays.
        sweep(&conn, &[], at(NOW)).unwrap();
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn pages_follow_the_cursor_and_filter_unread_and_search() {
        let conn = open_in_memory().unwrap();
        let mut items: Vec<ParsedItem> = (0..5).map(|n| item(&format!("a{n}"), Some(days_ago(n)))).collect();
        items[1].title = "Ёжик в ТУМАНЕ".into();
        items[3].excerpt = "a quiet Fog".into();
        store_fetch(&conn, "a", &document(items), NOW).unwrap();
        store_fetch(&conn, "b", &document(vec![item("b0", Some(days_ago(2))), item("b1", None)]), NOW).unwrap();

        let mut seen = Vec::new();
        let mut q = query(None, 3);
        loop {
            let (page, next) = list_items(&conn, &q).unwrap();
            seen.extend(page.into_iter().map(|(item, _)| item.title));
            match next {
                Some(next) => q.after = Some(next),
                None => break,
            }
        }
        // b1 has no date: as new as its fetch, so first.
        assert_eq!(seen, ["Post b1", "Post a0", "Ёжик в ТУМАНЕ", "Post b0", "Post a2", "Post a3", "Post a4"]);

        let (page, next) = list_items(&conn, &query(Some("b"), 10)).unwrap();
        assert_eq!((page.len(), next), (2, None));

        let ids: Vec<i64> = list_items(&conn, &query(Some("a"), 2)).unwrap().0.iter().map(|(i, _)| i.id).collect();
        assert_eq!(set_read(&conn, &ids, true, NOW).unwrap(), 2);
        let unread_only = FeedItemQuery { unread_only: true, ..query(Some("a"), 10) };
        assert_eq!(list_items(&conn, &unread_only).unwrap().0.len(), 3);
        assert_eq!(set_read(&conn, &ids[..1], false, NOW).unwrap(), 1);
        assert_eq!(list_items(&conn, &unread_only).unwrap().0.len(), 4);

        let search = |words: &str| -> Vec<String> {
            let q = FeedItemQuery { search: Some(words.into()), ..query(None, 10) };
            list_items(&conn, &q).unwrap().0.into_iter().map(|(i, _)| i.title).collect()
        };
        assert_eq!(search("ежик туман"), ["Ёжик в ТУМАНЕ"], "Cyrillic, case and ё folded");
        assert_eq!(search("FOG"), ["Post a3"], "the excerpt too");
        assert!(search("nothing").is_empty());
    }

    #[test]
    fn mark_all_read_stops_at_what_the_person_saw() {
        let conn = open_in_memory().unwrap();
        store_fetch(&conn, "a", &document(vec![item("1", None)]), NOW).unwrap();
        store_fetch(&conn, "b", &document(vec![item("1", None)]), NOW).unwrap();
        store_fetch(&conn, "a", &document(vec![item("2", None)]), "2026-10-16T12:00:00.000Z").unwrap();
        assert_eq!(mark_all_read(&conn, Some("a"), Some(NOW), NOW).unwrap(), 1, "the post fetched since stays new");
        assert_eq!(unread(&conn, "b"), 1);
        assert_eq!(mark_all_read(&conn, None, None, NOW).unwrap(), 2);
    }

    #[test]
    fn an_article_reads_its_content_else_its_excerpt() {
        let conn = open_in_memory().unwrap();
        let mut bare = item("bare", None);
        bare.content_html = None;
        bare.excerpt = "Fish & <chips>".into();
        store_fetch(&conn, "f", &document(vec![item("full", None), bare]), NOW).unwrap();
        let id = |key: &str| -> i64 { conn.query_row("SELECT id FROM feed_items WHERE key = ?1", [key], |r| r.get(0)).unwrap() };
        assert_eq!(article(&conn, id("full")).unwrap().html, "<p>All of full</p>");
        assert_eq!(article(&conn, id("bare")).unwrap().html, "<p>Fish &amp; &lt;chips&gt;</p>");
        assert!(matches!(article(&conn, 9999), Err(rusqlite::Error::QueryReturnedNoRows)));
    }

    #[test]
    fn feeds_get_their_titles_counts_and_health() {
        let conn = open_in_memory().unwrap();
        store_fetch(&conn, "a", &document(vec![item("1", None), item("2", None)]), NOW).unwrap();
        conn.execute("UPDATE feed_items SET read_at = ?1 WHERE key = '1'", [NOW]).unwrap();
        conn.execute("UPDATE feed_state SET fetched_at = ?1, icon_url = 'https://example.com/i.png'", [NOW]).unwrap();
        let mut list = vec![subscription("a"), subscription("new")];
        merge_state(&conn, &mut list, at(NOW)).unwrap();
        let a = &list[0];
        assert_eq!((a.feed_title.as_deref(), a.site_url.as_deref(), a.icon_url.as_deref()), (Some("Example"), Some("https://example.com/"), Some("https://example.com/i.png")));
        assert_eq!((a.total, a.unread, a.fetched_at.as_deref(), &a.health), (2, 1, Some(NOW), &FeedHealth::Ok));
        assert_eq!((list[1].total, list[1].feed_title.clone(), &list[1].health), (0, None, &FeedHealth::Ok));

        let now = at(NOW);
        let week = days_ago(7);
        let day = days_ago(1);
        assert_eq!(health(Some("timeout"), None, 5, Some(&day), Some(NOW), now), FeedHealth::Ok, "not a week yet");
        assert_eq!(
            health(Some("status:404"), None, 9, Some(&week), Some(NOW), now),
            FeedHealth::Failing { since: week.clone(), reason: "status:404".into() }
        );
        assert_eq!(
            health(Some("blocked"), None, 1, Some(&day), Some(NOW), now),
            FeedHealth::Failing { since: day.clone(), reason: "blocked".into() },
            "blocked at once"
        );
        assert_eq!(health(Some("offline"), None, 0, None, Some(NOW), now), FeedHealth::Offline);
        assert_eq!(health(Some("gone"), None, 1, Some(&week), Some(NOW), now), FeedHealth::Gone);
        assert_eq!(
            health(None, Some("https://new.example.com/feed"), 0, None, Some(NOW), now),
            FeedHealth::Moved { to: "https://new.example.com/feed".into() }
        );
    }

    #[test]
    fn clearing_the_cache_leaves_nothing_to_remember() {
        let conn = open_in_memory().unwrap();
        store_fetch(&conn, "a", &document(vec![item("1", None)]), NOW).unwrap();
        conn.execute("INSERT INTO feed_seen VALUES ('a', 'k', ?1)", [NOW]).unwrap();
        clear(&conn).unwrap();
        let left: i64 = conn
            .query_row("SELECT (SELECT count(*) FROM feed_items) + (SELECT count(*) FROM feed_state) + (SELECT count(*) FROM feed_seen)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        // A first load again.
        let items: Vec<ParsedItem> = (0..25).map(|n| item(&n.to_string(), None)).collect();
        assert_eq!(store_fetch(&conn, "a", &document(items), NOW).unwrap().new_ids.len(), 20);
    }
}
