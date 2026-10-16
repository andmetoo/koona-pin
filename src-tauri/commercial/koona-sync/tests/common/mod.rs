//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Libraries for the tests: schema 9 as the app makes it, schemas 10, 11, 13 and 14 on top, the app's SQL
//! functions stubbed, and the writes the app makes (`db.rs`) as plain SQL, so the triggers see
//! what they see in the app.

#![allow(dead_code)]

use koona_sync::model::Vector;
use koona_sync::{Chunk, Delta};
use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub const SCHEMA_9: &str = include_str!("../schema.sql");
/// The app's columns of schema 11, before the engine's `SCHEMA_11`.
pub const APP_SCHEMA_11: &str = include_str!("../schema11.sql");
/// The app's column of schema 13, before the engine's `SCHEMA_13`.
pub const APP_SCHEMA_13: &str = include_str!("../schema13.sql");
/// The app's table of schema 14, before the engine's `SCHEMA_14`.
pub const APP_SCHEMA_14: &str = include_str!("../schema14.sql");

/// The app's hook of schema 14 (`migrations::sync_feeds`): the tombstones take kind `feed`.
fn widen_tombstones(conn: &Connection) {
    let sql: String = one(conn, "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tombstones'");
    let old = "CHECK (kind IN ('bookmark','collection','tag'))";
    assert_eq!(sql.matches(old).count(), 1, "{sql}");
    let version: i64 = conn.pragma_query_value(None, "schema_version", |r| r.get(0)).unwrap();
    conn.pragma_update(None, "writable_schema", true).unwrap();
    conn.execute(
        "UPDATE sqlite_schema SET sql = ?1 WHERE type = 'table' AND name = 'tombstones'",
        [sql.replace(old, "CHECK (kind IN ('bookmark','collection','tag','feed'))")],
    )
    .unwrap();
    conn.pragma_update(None, "schema_version", version + 1).unwrap();
    conn.pragma_update(None, "writable_schema", false).unwrap();
    let _: i64 = one(conn, "SELECT count(*) FROM tombstones");
}

/// The app's functions as far as the triggers and the engine need them.
pub fn stub_app_functions(conn: &Connection) {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("np_sort_key", 1, flags, |ctx| {
        Ok(ctx.get::<String>(0)?.to_lowercase().into_bytes())
    })
    .unwrap();
    conn.create_scalar_function("np_site_key", 1, flags, |ctx| {
        let domain = ctx.get::<String>(0)?.to_lowercase();
        Ok(domain.strip_prefix("www.").unwrap_or(&domain).as_bytes().to_vec())
    })
    .unwrap();
    conn.create_scalar_function("np_url_key", 1, flags, |ctx| {
        Ok(ctx.get::<String>(0)?.to_lowercase().trim_end_matches('/').to_string())
    })
    .unwrap();
    conn.create_scalar_function("np_domain", 1, flags, |ctx| Ok(domain(&ctx.get::<String>(0)?)))
        .unwrap();
    conn.create_scalar_function("np_contains", -1, flags, |ctx| {
        let word = ctx.get::<String>(0)?.to_lowercase();
        for i in 1..ctx.len() {
            if let Some(text) = ctx.get::<Option<String>>(i)? {
                if text.to_lowercase().contains(&word) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    })
    .unwrap();
}

pub fn domain(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#']).next().unwrap_or("").to_string()
}

/// A library at schema 14 with sync attached as `replica`, foreign keys on as in the app.
pub fn library_at(path: Option<&std::path::Path>, replica: Uuid) -> Connection {
    let conn = match path {
        Some(path) => Connection::open(path).unwrap(),
        None => Connection::open_in_memory().unwrap(),
    };
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    stub_app_functions(&conn);
    koona_sync::register(&conn).unwrap();
    conn.execute_batch(SCHEMA_9).unwrap();
    conn.execute_batch(koona_sync::SCHEMA_10).unwrap();
    conn.execute_batch(APP_SCHEMA_11).unwrap();
    conn.execute_batch(koona_sync::SCHEMA_11).unwrap();
    conn.execute_batch(APP_SCHEMA_13).unwrap();
    conn.execute_batch(koona_sync::SCHEMA_13).unwrap();
    conn.execute_batch(APP_SCHEMA_14).unwrap();
    widen_tombstones(&conn);
    conn.execute_batch(koona_sync::SCHEMA_14).unwrap();
    koona_sync::attach(&conn, replica).unwrap();
    conn
}

pub fn library(replica: Uuid) -> Connection {
    library_at(None, replica)
}

pub fn replica_id(n: u8) -> Uuid {
    Uuid::from_bytes([n; 16])
}

pub fn now(conn: &Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| r.get(0)).unwrap()
}

// The app's writes.

pub fn add_bookmark(conn: &Connection, uid: Uuid, url: &str, title: &str) -> Option<i64> {
    let exists: bool = conn
        .query_row("SELECT EXISTS (SELECT 1 FROM bookmarks WHERE url = ?1)", [url], |r| r.get(0))
        .unwrap();
    if exists {
        return None;
    }
    let now = now(conn);
    conn.execute(
        "INSERT INTO bookmarks (uid, url, title, domain, source, created_at, updated_at, url_key)
         VALUES (?1, ?2, ?3, np_domain(?2), 'app', ?4, ?4, np_url_key(?2))",
        params![uid.to_string(), url, title, now],
    )
    .unwrap();
    Some(conn.last_insert_rowid())
}

pub fn set_bookmark(conn: &Connection, id: i64, column: &str, value: rusqlite::types::Value) {
    conn.execute(
        &format!("UPDATE bookmarks SET {column} = ?1, revision = revision + 1, updated_at = ?3 WHERE id = ?2"),
        params![value, id, now(conn)],
    )
    .unwrap();
}

pub fn add_collection(conn: &Connection, uid: Uuid, name: &str) -> Option<i64> {
    let n = conn
        .execute(
            "INSERT INTO collections (uid, name, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING",
            params![uid.to_string(), name, now(conn)],
        )
        .unwrap();
    (n == 1).then(|| conn.last_insert_rowid())
}

pub fn tag(conn: &Connection, bookmark: i64, uid: Uuid, name: &str) {
    conn.execute(
        "INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING",
        params![uid.to_string(), name, now(conn)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2 ON CONFLICT DO NOTHING",
        params![bookmark, name],
    )
    .unwrap();
}

pub fn untag(conn: &Connection, bookmark: i64, tag: i64) {
    conn.execute("DELETE FROM bookmark_tags WHERE bookmark_id = ?1 AND tag_id = ?2", params![bookmark, tag])
        .unwrap();
}

/// `db::purge_trash` for one bookmark of the trash.
pub fn purge(conn: &Connection, id: i64) {
    let tx = conn.unchecked_transaction().unwrap();
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
         SELECT uid, 'bookmark', deleted_at, ?2 FROM bookmarks WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id, now(&tx)],
    )
    .unwrap();
    tx.execute("DELETE FROM bookmarks WHERE id = ?1 AND deleted_at IS NOT NULL", [id]).unwrap();
    tx.commit().unwrap();
}

/// `db::delete_collection`.
pub fn delete_collection(conn: &Connection, id: i64) {
    let tx = conn.unchecked_transaction().unwrap();
    let now = now(&tx);
    tx.execute(
        "UPDATE bookmarks SET collection_id=NULL,revision=revision+1,updated_at=?1 WHERE collection_id=?2",
        params![now, id],
    )
    .unwrap();
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
         SELECT uid, 'collection', ?1, ?1 FROM collections WHERE id = ?2",
        params![now, id],
    )
    .unwrap();
    tx.execute("DELETE FROM collections WHERE id = ?1", params![id]).unwrap();
    tx.commit().unwrap();
}

/// `feeds::subscribe`: an address already followed keeps its subscription. Returns the new id.
pub fn follow(conn: &Connection, uid: Uuid, url: &str, title: Option<&str>, destination: &str) -> Option<i64> {
    let now = now(conn);
    let n = conn
        .execute(
            "INSERT INTO feeds (uid, url, title, destination, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (url) DO NOTHING",
            params![uid.to_string(), url, title, destination, now],
        )
        .unwrap();
    (n == 1).then(|| conn.last_insert_rowid())
}

/// `feeds::update`: an unchanged value is not written.
pub fn set_feed(conn: &Connection, id: i64, column: &str, value: rusqlite::types::Value) {
    conn.execute(
        &format!("UPDATE feeds SET {column} = ?1, updated_at = ?3 WHERE id = ?2 AND {column} IS NOT ?1"),
        params![value, id, now(conn)],
    )
    .unwrap();
}

/// `feeds::unsubscribe`.
pub fn unfollow(conn: &Connection, id: i64) {
    let tx = conn.unchecked_transaction().unwrap();
    let now = now(&tx);
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
         SELECT uid, 'feed', ?1, ?1 FROM feeds WHERE id = ?2",
        params![now, id],
    )
    .unwrap();
    tx.execute("DELETE FROM feeds WHERE id = ?1", [id]).unwrap();
    tx.commit().unwrap();
}

pub fn ids(conn: &Connection, sql: &str) -> Vec<i64> {
    conn.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

pub fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

pub fn maybe<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> Option<T> {
    conn.query_row(sql, [], |r| r.get(0)).optional().unwrap()
}

// Sync.

/// What a receiver does with the chunks of one session as they arrive: applies a chunk in
/// order or again, drops one that comes too early, and merges `covers` only when every chunk
/// was applied in order and nothing was deferred.
pub struct Session {
    pub next: usize,
    pub deferred: usize,
    pub merged: bool,
}

impl Session {
    pub fn new() -> Session {
        Session { next: 0, deferred: 0, merged: false }
    }

    pub fn receive(&mut self, conn: &Connection, index: usize, chunk: &Chunk) {
        if index > self.next {
            return;
        }
        let applied = koona_sync::apply(conn, &chunk.groups).expect("apply never fails");
        if index == self.next {
            self.next += 1;
            self.deferred += applied.deferred;
            if chunk.last && self.deferred == 0 {
                koona_sync::merge_vector(conn, &chunk.covers).unwrap();
                self.merged = true;
            }
        }
    }
}

/// One clean session: every chunk once, in order. Returns whether `covers` was merged.
pub fn sync(from: &Connection, to: &Connection, max_bytes: usize) -> bool {
    let since = koona_sync::vector(to).unwrap();
    let mut delta = Delta::new(from, &since).unwrap();
    let mut session = Session::new();
    let mut index = 0;
    while let Some(chunk) = delta.next_chunk(max_bytes).unwrap() {
        session.receive(to, index, &chunk);
        index += 1;
    }
    session.merged
}

pub fn vector(conn: &Connection) -> Vector {
    koona_sync::vector(conn).unwrap()
}

/// Everything that must agree between replicas, by uid: values, the clock of each field, the
/// tags of each bookmark with their clocks, tombstones. Local ids, revisions, `updated_at` and
/// derived keys are left out.
pub fn dump(conn: &Connection) -> Vec<String> {
    let clock = |entity: i64, field: &str| {
        format!(
            "(SELECT c.hlc || '/' || o.origin || '/' || c.counter FROM sync_clock c JOIN sync_origins o ON o.id = c.origin
              WHERE c.entity = {entity} AND c.row = x.id AND c.field IN ({field}, -1) ORDER BY c.field DESC LIMIT 1)"
        )
    };
    let mut out = Vec::new();
    let mut rows = |sql: String| {
        let mut stmt = conn.prepare(&sql).unwrap();
        let n = stmt.column_count();
        let lines: Vec<String> = stmt
            .query_map([], |r| {
                Ok((0..n)
                    .map(|i| format!("{:?}", r.get::<_, rusqlite::types::Value>(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join(" | "))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out.extend(lines);
    };
    let collection_fields = ["name", "color", "icon", "position_key"];
    let cols: Vec<String> =
        collection_fields.iter().enumerate().map(|(i, c)| format!("x.{c}, {}", clock(0, &i.to_string()))).collect();
    rows(format!("SELECT 'collection', x.uid, {} FROM collections x ORDER BY x.uid", cols.join(", ")));
    rows(format!("SELECT 'tag', x.uid, x.name, {} FROM tags x ORDER BY x.uid", clock(1, "0")));
    let bookmark_fields = [
        "x.url",
        "x.title",
        "x.description",
        "x.image_url",
        "x.favicon_url",
        "x.notes",
        "x.is_favorite",
        "(SELECT uid FROM collections WHERE id = x.collection_id)",
        "x.triaged_at",
        "x.deleted_at",
        "x.source",
        "x.source_name",
        "x.created_at",
        "x.reading_at",
        "x.reading_progress",
        "x.read_at",
        "x.site_name",
    ];
    let cols: Vec<String> =
        bookmark_fields.iter().enumerate().map(|(i, c)| format!("{c}, {}", clock(2, &i.to_string()))).collect();
    rows(format!(
        "SELECT 'bookmark', x.uid, {},
            (SELECT group_concat(l, ' ') FROM (
                SELECT t.uid || '=' || EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = x.id AND bt.tag_id = t.id)
                    || '@' || c.hlc || '/' || o.origin || '/' || c.counter AS l
                FROM sync_clock c JOIN tags t ON t.id = c.field JOIN sync_origins o ON o.id = c.origin
                WHERE c.entity = 3 AND c.row = x.id ORDER BY t.uid))
         FROM bookmarks x ORDER BY x.uid",
        cols.join(", ")
    ));
    let feed_fields = ["x.url", "x.title", "x.destination"];
    let cols: Vec<String> =
        feed_fields.iter().enumerate().map(|(i, c)| format!("{c}, {}", clock(4, &i.to_string()))).collect();
    rows(format!("SELECT 'feed', x.uid, {} FROM feeds x ORDER BY x.uid", cols.join(", ")));
    rows("SELECT 'tombstone', t.uid, t.kind, t.merged_into, t.hlc, o.origin, t.counter
          FROM tombstones t LEFT JOIN sync_origins o ON o.id = t.origin ORDER BY t.uid"
        .to_string());
    out
}

/// What must hold in every library at every moment.
pub fn check_invariants(conn: &Connection) {
    let broken: Vec<i64> = ids(conn, "SELECT 1 FROM pragma_foreign_key_check");
    assert!(broken.is_empty(), "a reference to a record that is not there");
    let links: i64 = one(
        conn,
        "SELECT count(*) FROM bookmark_tags bt WHERE NOT EXISTS (SELECT 1 FROM bookmarks WHERE id = bt.bookmark_id)
            OR NOT EXISTS (SELECT 1 FROM tags WHERE id = bt.tag_id)",
    );
    assert_eq!(links, 0, "dangling bookmark_tags");
    let stale: i64 = one(
        conn,
        "SELECT count(*) FROM sync_clock c WHERE
            (c.entity = 0 AND NOT EXISTS (SELECT 1 FROM collections WHERE id = c.row))
         OR (c.entity = 1 AND NOT EXISTS (SELECT 1 FROM tags WHERE id = c.row))
         OR (c.entity = 2 AND NOT EXISTS (SELECT 1 FROM bookmarks WHERE id = c.row))
         OR (c.entity = 3 AND (NOT EXISTS (SELECT 1 FROM bookmarks WHERE id = c.row)
                               OR NOT EXISTS (SELECT 1 FROM tags WHERE id = c.field)))
         OR (c.entity = 4 AND NOT EXISTS (SELECT 1 FROM feeds WHERE id = c.row))
         OR c.entity NOT BETWEEN 0 AND 4",
    );
    assert_eq!(stale, 0, "clocks of records that are gone");
    let live_gone: i64 = one(
        conn,
        "SELECT count(*) FROM tombstones t WHERE t.merged_into IS NULL AND (
            EXISTS (SELECT 1 FROM bookmarks WHERE uid = t.uid) OR EXISTS (SELECT 1 FROM collections WHERE uid = t.uid)
            OR EXISTS (SELECT 1 FROM tags WHERE uid = t.uid) OR EXISTS (SELECT 1 FROM feeds WHERE uid = t.uid))",
    );
    assert_eq!(live_gone, 0, "a purged record is back");
}
