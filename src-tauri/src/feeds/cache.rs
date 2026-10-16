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

use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

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
    Ok(())
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
}

/// What [`store_fetch`] did: the ids of posts new to the cache, newest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stored {
    pub new_ids: Vec<i64>,
}

/// Stores a fetched document (NP-129 calls it, NP-131 fills it): the feed's
/// own title, site, icon and description into `feed_state`, and its posts
/// into `feed_items` by `(feed_uid, key)`, keeping read marks and saves,
/// skipping keys in `feed_seen`, with the first-load rule (plan §3.2). The
/// fetch state columns (validators, times, failures) are the fetch's own to
/// write. Until NP-131: stores nothing.
pub fn store_fetch(
    _conn: &Connection,
    _feed_uid: &str,
    _feed: &super::parse::ParsedFeed,
    _now: &str,
) -> rusqlite::Result<Stored> {
    Ok(Stored::default())
}
