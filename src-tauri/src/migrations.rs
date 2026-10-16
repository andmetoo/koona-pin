//! Schema migrations through `rusqlite_migration` (Р-3, Р-11).
//!
//! `user_version` is the schema number. Pending steps run in one transaction
//! together with the new `user_version`, so a failure leaves the library as
//! it was and the next start tries again. Before migrating an existing
//! library a copy `before-vN` is made. The checks before any write (foreign
//! file, newer schema, damage) live in `library.rs`.
//!
//! A future step that rebuilds a table must handle foreign keys itself:
//! `PRAGMA foreign_keys` cannot change inside the migration transaction, and
//! dropping a parent table with them on deletes the children.

use crate::backup;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use rusqlite_migration::{HookResult, Migrations, M};
use std::path::{Path, PathBuf};

/// The newest schema this build understands. A library with a larger
/// `user_version` is not opened at all.
pub const SCHEMA_VERSION: i64 = 14;
/// "NPIN" in the database header; a file without it is not a library of
/// this schema line (Р-10, point 11).
pub const APPLICATION_ID: i32 = 0x4E50_494E;

/// Schema 1 (Р-10, Р-11): `uid` for future sync, the source of a bookmark,
/// inbox and trash fields, tombstones, times in UTC with milliseconds.
const SCHEMA_1: &str = "
CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    icon TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    favicon_url TEXT,
    domain TEXT NOT NULL,
    notes TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    source TEXT CHECK (source IN ('app','chrome','edge','firefox','extension','bookmarklet','import')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    triaged_at TEXT,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE bookmark_tags (
    bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
);
CREATE INDEX idx_bookmarks_domain ON bookmarks(domain);
CREATE INDEX idx_bookmarks_fav ON bookmarks(is_favorite);
CREATE INDEX idx_bookmarks_collection ON bookmarks(collection_id);
CREATE INDEX idx_bookmarks_created ON bookmarks(created_at DESC);

-- No foreign key on purpose: a receipt outlives its bookmark, so a repeated
-- delivery after deletion does not save the link again.
CREATE TABLE capture_receipts (
    request_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    bookmark_id INTEGER NOT NULL,
    outcome TEXT NOT NULL
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tombstones (
    uid TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bookmark','collection','tag')),
    deleted_at TEXT NOT NULL,
    purged_at TEXT NOT NULL
);
";

/// Schema 2 (NP-011): the search index. FTS5 `trigram` finds a substring of
/// three or more characters in any field and folds case, Cyrillic included.
/// It keeps no copy of the text (`content=''`); `contentless_delete` lets a
/// row be removed by id. «ё» is written as «е» on the way in, the query is
/// folded the same way in `db::fold`. Triggers keep the index in the same
/// transaction as every write; `db::rebuild_search` rebuilds it from
/// `bookmarks_search_source`.
const SCHEMA_2: &str = "
CREATE VIRTUAL TABLE bookmarks_search USING fts5(
    title, url, domain, description, notes, tags,
    content='', contentless_delete=1, tokenize='trigram'
);
CREATE VIEW bookmarks_search_source AS
SELECT b.id,
    replace(replace(b.title, 'ё', 'е'), 'Ё', 'Е') AS title,
    replace(replace(b.url, 'ё', 'е'), 'Ё', 'Е') AS url,
    replace(replace(b.domain, 'ё', 'е'), 'Ё', 'Е') AS domain,
    replace(replace(COALESCE(b.description, ''), 'ё', 'е'), 'Ё', 'Е') AS description,
    replace(replace(COALESCE(b.notes, ''), 'ё', 'е'), 'Ё', 'Е') AS notes,
    replace(replace(COALESCE((SELECT group_concat(t.name, ' ') FROM bookmark_tags bt
        JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), ''), 'ё', 'е'), 'Ё', 'Е') AS tags
FROM bookmarks b;

CREATE TRIGGER bookmarks_search_insert AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_search_update
AFTER UPDATE OF title, url, domain, description, notes ON bookmarks BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_search_delete AFTER DELETE ON bookmarks BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
END;
CREATE TRIGGER bookmarks_search_tag_link AFTER INSERT ON bookmark_tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid = new.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.bookmark_id;
END;
-- Also runs for links removed by a cascade; a deleted bookmark has no source row.
CREATE TRIGGER bookmarks_search_tag_unlink AFTER DELETE ON bookmark_tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = old.bookmark_id;
END;
CREATE TRIGGER bookmarks_search_tag_rename AFTER UPDATE OF name ON tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid IN
        (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = new.id);
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id IN
        (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = new.id);
END;

INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
SELECT * FROM bookmarks_search_source;

-- Pages are read by (created_at, id); equal times need no extra sort.
DROP INDEX idx_bookmarks_created;
CREATE INDEX idx_bookmarks_order ON bookmarks(created_at, id);
";

/// Schema 3 (NP-021): the inbox section. In a large sorted library the few
/// bookmarks waiting are found without reading the whole list: a page of the
/// inbox took 250 ms on 100 000 bookmarks, with the index under 1 ms.
const SCHEMA_3: &str = "
CREATE INDEX idx_bookmarks_inbox ON bookmarks(created_at, id) WHERE triaged_at IS NULL;
";

/// Schema 4 (NP-022): the trash. Every count leaves the trash out, so the
/// site and collection indexes carry `deleted_at`: on 100 000 bookmarks the
/// sites took 115 ms and the collections 46 ms without it, 2–5 ms with it.
/// The trash itself is read by deletion time, also by its cleanup (NP-023).
const SCHEMA_4: &str = "
DROP INDEX idx_bookmarks_domain;
CREATE INDEX idx_bookmarks_domain ON bookmarks(domain, deleted_at);
DROP INDEX idx_bookmarks_collection;
CREATE INDEX idx_bookmarks_collection ON bookmarks(collection_id, deleted_at);
CREATE INDEX idx_bookmarks_trash ON bookmarks(deleted_at, id) WHERE deleted_at IS NOT NULL;
";

/// Schema 5 (NP-035, Р-35): duplicates. The address key (`dedupe::url_key`,
/// registered as `np_url_key`) is stored so groups are found by an index
/// instead of parsing every address; rows written without it get it from
/// `dedupe::fill_keys`. The hook fills the keys of existing bookmarks. «Не дубликаты» remembers the bookmarks (by `uid`)
/// of a group that are different pages.
const SCHEMA_5: &str = "
ALTER TABLE bookmarks ADD COLUMN url_key TEXT;
CREATE INDEX idx_bookmarks_url_key ON bookmarks(url_key) WHERE deleted_at IS NULL;
CREATE TABLE duplicates_dismissed (
    url_key TEXT NOT NULL,
    uid TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (url_key, uid)
) WITHOUT ROWID;
";

/// Schema 6 (NP-036, Р-38): link check results. One row per bookmark, for the
/// address it was made for (`url`): a bookmark whose address changes is
/// unchecked again. Results are not exported: they say what a site answered
/// on a day, not what the person saved.
const SCHEMA_6: &str = "
CREATE TABLE link_checks (
    bookmark_id INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','gone','moved','failed','local')),
    status INTEGER,
    reason TEXT,
    target TEXT
);
CREATE INDEX idx_link_checks_outcome ON link_checks(outcome) WHERE outcome IN ('gone','moved','failed');
";

/// Schema 7 (NP-114, Р-59): the order of the list and of the collections.
/// A collection gets the place the person gave it in the sidebar; none until
/// the first move. A bookmark gets the sort keys of its title and of its site
/// in the interface's language: the triggers write them with `np_sort_key`
/// and `np_site_key` (`sorting.rs`) on every write, the keys of the bookmarks
/// already there are written when the interface first tells its language
/// (`sorting::set_language`); in a new library there are none to write.
/// «Title A–Z» and «Site A–Z» read pages by their indexes; equal keys go
/// newest first.
///
/// The query check of NP-114 (example `query_plans`, 100 000 bookmarks,
/// release) rebuilt the other indexes of the list on the way. Each leaves the
/// trash out or names it, and carries the columns its queries read, so a page
/// is a seek and a total is read from the index alone: `Ctrl A` 300 → 3 ms,
/// the inbox 18 → 0.4 ms, favorites 28 → 0.8 ms, a collection 34 → 1.6 ms,
/// a site 25 → 0.9 ms, the sidebar counts 25 → 0.7 ms. A tag filter starts
/// from the tag (`idx_bookmark_tags_tag`): a rare tag took 520 ms a page,
/// now 0.06 ms. The keys and indexes add about a quarter to the file.
const SCHEMA_7: &str = "
ALTER TABLE collections ADD COLUMN position INTEGER;
ALTER TABLE bookmarks ADD COLUMN title_key BLOB;
ALTER TABLE bookmarks ADD COLUMN site_key BLOB;
-- The list's indexes leave the trash out and still carry `deleted_at` (always
-- NULL in them): SQLite reads an index alone only when it has every column the
-- query names, the condition of a partial index included.
CREATE INDEX idx_bookmarks_title ON bookmarks(title_key, created_at DESC, id DESC, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookmarks_site ON bookmarks(site_key, created_at DESC, id DESC, deleted_at) WHERE deleted_at IS NULL;
CREATE TRIGGER bookmarks_sort_insert AFTER INSERT ON bookmarks BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_sort_update AFTER UPDATE OF title, domain ON bookmarks BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;

DROP INDEX idx_bookmarks_order;
CREATE INDEX idx_bookmarks_order ON bookmarks(created_at, id, deleted_at) WHERE deleted_at IS NULL;
DROP INDEX idx_bookmarks_inbox;
CREATE INDEX idx_bookmarks_inbox ON bookmarks(created_at, id, triaged_at, deleted_at, source)
    WHERE triaged_at IS NULL AND deleted_at IS NULL;
DROP INDEX idx_bookmarks_fav;
CREATE INDEX idx_bookmarks_favorites ON bookmarks(created_at, id, is_favorite, deleted_at)
    WHERE is_favorite = 1 AND deleted_at IS NULL;
DROP INDEX idx_bookmarks_collection;
CREATE INDEX idx_bookmarks_collection ON bookmarks(collection_id, deleted_at, created_at, id);
DROP INDEX idx_bookmarks_domain;
CREATE INDEX idx_bookmarks_domain ON bookmarks(domain, deleted_at, created_at, id);
CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags(tag_id, bookmark_id);
";

/// Schema 8 (NP-091, Р-67): links an AI assistant saves over MCP. They come
/// from `source = 'mcp'`, which the check of schema 1 does not allow:
/// [`allow_mcp`] widens it. `source_name` is the assistant that saved one, as
/// triage names it («saved … from Claude Code»).
const SCHEMA_8: &str = "
ALTER TABLE bookmarks ADD COLUMN source_name TEXT;
";

/// The check on `bookmarks.source` gets `'mcp'`. SQLite cannot change a check
/// in place; rebuilding the table would copy every bookmark and rebuild its
/// triggers and indexes. A wider check holds for every stored row, so it is
/// written into the schema text, the way the SQLite manual describes changes
/// that leave the stored data valid (ALTER TABLE, «other kinds of schema
/// changes»): `writable_schema`, the new text, `schema_version` + 1, all in
/// the migration's transaction. A schema text other than schema 1's is
/// refused, and the migration rolls back.
fn allow_mcp(tx: &Transaction) -> HookResult {
    widen_sources(
        tx,
        "'extension','bookmarklet','import'))",
        "'extension','bookmarklet','import','mcp'))",
        "the bookmarks table is not the one schema 1 made",
    )
}

/// Schema 9 (NP-119): links the Safari extension saves come from
/// `source = 'safari'`; the check of schema 8 gets it the way [`allow_mcp`]
/// added `'mcp'`. Nothing else changes.
const SCHEMA_9: &str = "";

fn allow_safari(tx: &Transaction) -> HookResult {
    widen_sources(
        tx,
        "'extension','bookmarklet','import','mcp'))",
        "'extension','bookmarklet','import','mcp','safari'))",
        "the bookmarks table is not the one schema 8 made",
    )
}

/// Schema 10 (Р-68): sync. The engine's tables and triggers come from
/// `koona_sync::SCHEMA_10` (commercial); sync stays off in every library
/// until the person turns it on, and nothing is recorded until then. The
/// step also:
///
/// - gives the collections ordered by hand a fractional key of their place
///   (`position_key`, [`position_keys`]), in the order the sidebar shows;
///   a library never ordered keeps none and goes on by name;
/// - lets `bookmarks.source` hold any text ([`any_source`]);
/// - makes the search and sort triggers of schemas 2 and 7 wait while a
///   connection defers them (`np_index_now`, `db::IndexDeferred`): a batch
///   from another device writes each search row once, not once per tag.
///
/// [`position_keys`]: crate::position_keys
const SCHEMA_10_INDEX: &str = "
DROP TRIGGER bookmarks_search_insert;
CREATE TRIGGER bookmarks_search_insert AFTER INSERT ON bookmarks WHEN np_index_now(new.id) BEGIN
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
DROP TRIGGER bookmarks_search_update;
CREATE TRIGGER bookmarks_search_update
AFTER UPDATE OF title, url, domain, description, notes ON bookmarks WHEN np_index_now(new.id) BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
DROP TRIGGER bookmarks_search_delete;
CREATE TRIGGER bookmarks_search_delete AFTER DELETE ON bookmarks WHEN np_index_now(old.id) BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
END;
DROP TRIGGER bookmarks_search_tag_link;
CREATE TRIGGER bookmarks_search_tag_link AFTER INSERT ON bookmark_tags WHEN np_index_now(new.bookmark_id) BEGIN
    DELETE FROM bookmarks_search WHERE rowid = new.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.bookmark_id;
END;
-- Also runs for links removed by a cascade; a deleted bookmark has no source row.
DROP TRIGGER bookmarks_search_tag_unlink;
CREATE TRIGGER bookmarks_search_tag_unlink AFTER DELETE ON bookmark_tags WHEN np_index_now(old.bookmark_id) BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = old.bookmark_id;
END;
DROP TRIGGER bookmarks_sort_insert;
CREATE TRIGGER bookmarks_sort_insert AFTER INSERT ON bookmarks WHEN np_index_now(new.id) BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;
DROP TRIGGER bookmarks_sort_update;
CREATE TRIGGER bookmarks_sort_update AFTER UPDATE OF title, domain ON bookmarks WHEN np_index_now(new.id) BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;
";

/// See [`SCHEMA_10_INDEX`]. The keys are written between the engine's tables
/// and its triggers, so writing them records nothing and needs none of the
/// engine's functions (`validate()` runs without them).
fn sync_schema(tx: &Transaction) -> HookResult {
    let (tables, triggers) = koona_sync::schema_10_parts();
    // First: the statements after it make SQLite read the edited schema
    // text. Done last, a library in memory had no `bookmarks` table for its
    // next statement.
    any_source(tx)?;
    tx.execute_batch(tables)?;
    position_keys(tx)?;
    tx.execute_batch(triggers)?;
    tx.execute_batch(SCHEMA_10_INDEX)?;
    Ok(())
}

/// Schema 11 (NP-121, Р-69): the Reading list. A bookmark is in Reading
/// since `reading_at` (none: not in it); `reading_progress` is how far it was
/// read, 0 to 1; `read_at` is when it was read (none: unread). Progress and
/// read state belong to the bookmark, not to the list: the reader keeps them
/// for an article opened from any section. The partial index holds only the
/// few bookmarks in Reading, for its page and its count of unread ones.
/// The hook gives the sync capture trigger the three fields
/// (`koona_sync::SCHEMA_11`, commercial).
pub(crate) const SCHEMA_11: &str = "ALTER TABLE bookmarks ADD COLUMN reading_at TEXT;
ALTER TABLE bookmarks ADD COLUMN reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress BETWEEN 0 AND 1);
ALTER TABLE bookmarks ADD COLUMN read_at TEXT;
CREATE INDEX idx_bookmarks_reading ON bookmarks(reading_at, read_at, id, deleted_at)
    WHERE reading_at IS NOT NULL AND deleted_at IS NULL;
";

/// Schema 12 (NP-126): offline copies of articles. The copy itself is a
/// folder beside the library (`offline.rs`); the row says that it is there
/// and what it holds, so the list shows it and Settings sums it without
/// reading the disk. Copies never leave the computer: the table has no
/// sync triggers, no export reads it, and the journal does not record it.
/// A hard delete of the bookmark takes the row with it.
const SCHEMA_12: &str = "
CREATE TABLE offline_copies (
    bookmark_id INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    saved_at TEXT NOT NULL,
    url TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    images INTEGER NOT NULL,
    words INTEGER NOT NULL
);
";

fn sync_reading(tx: &Transaction) -> HookResult {
    tx.execute_batch(koona_sync::SCHEMA_11)?;
    Ok(())
}

/// Schema 13: the site's own name (`og:site_name` and its kin, `metadata.rs`)
/// for the card's cover; none until a save or «Refresh preview» reads it. The
/// hook gives the sync capture trigger the field (`koona_sync::SCHEMA_13`,
/// commercial).
pub(crate) const SCHEMA_13: &str = "ALTER TABLE bookmarks ADD COLUMN site_name TEXT;
";

fn sync_site_name(tx: &Transaction) -> HookResult {
    tx.execute_batch(koona_sync::SCHEMA_13)?;
    Ok(())
}

/// Schema 14 (NP-128, Р-71): the feeds a person follows. Only the
/// subscription lives in the library, so it is backed up, exported and
/// synced; the feed's own title, icon, posts and fetch state live in the
/// cache file beside it (`feeds/cache.rs`), so a fetch never writes the
/// library. `url` is the feed document's address, `title` the person's own
/// name for it (none: the feed's). `destination` takes any text for the
/// reason `bookmarks.source` does ([`any_source`]): a newer device may sync
/// a place this one does not know, and the app reads it as `feeds`.
/// `created_at` is not a synced field: the engine fills it, as for collections.
pub(crate) const SCHEMA_14: &str = "
CREATE TABLE feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    destination TEXT NOT NULL DEFAULT 'feeds' CHECK (typeof(destination) = 'text'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// See [`SCHEMA_14`]. An unsubscribe leaves a tombstone of kind `feed`,
/// which the check of schema 1 refuses: it is widened the way [`allow_mcp`]
/// widened the sources. Then the capture triggers of the feeds
/// (`koona_sync::SCHEMA_14`, commercial).
fn sync_feeds(tx: &Transaction) -> HookResult {
    widen_check(
        tx,
        "tombstones",
        "CHECK (kind IN ('bookmark','collection','tag'))",
        "CHECK (kind IN ('bookmark','collection','tag','feed'))",
        "the tombstones table is not the one schema 10 left",
    )?;
    // A statement after the edit makes SQLite read the new schema text inside
    // the transaction; left last, a library in memory lost its tables (see
    // [`sync_schema`]), and `koona_sync::SCHEMA_14` is empty until NP-130.
    tx.query_row("SELECT count(*) FROM tombstones", [], |r| r.get::<_, i64>(0))?;
    tx.execute_batch(koona_sync::SCHEMA_14)?;
    Ok(())
}

/// The places of schema 7 as keys, in the sidebar's order: by place, then
/// the collections never moved by name in the language of the sort keys.
/// When none was ever moved, none gets a key: they keep following the
/// interface's language.
fn position_keys(tx: &Transaction) -> HookResult {
    let mut collections: Vec<(i64, Option<i64>, String)> = tx
        .prepare("SELECT id, position, name FROM collections")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if collections.iter().all(|(_, position, _)| position.is_none()) {
        return Ok(());
    }
    let language: Option<String> = tx
        .query_row("SELECT value FROM app_settings WHERE key = 'sort_language'", [], |r| r.get(0))
        .optional()?;
    let collator = crate::sorting::collator(language.as_deref().unwrap_or(crate::sorting::DEFAULT_LANGUAGE));
    collections.sort_by_cached_key(|(id, position, name)| {
        (position.is_none(), *position, crate::sorting::key(&collator, name), *id)
    });
    let keys = crate::position_keys::spread(None, None, collections.len());
    let mut write = tx.prepare("UPDATE collections SET position_key = ?1 WHERE id = ?2")?;
    for ((id, _, _), key) in collections.iter().zip(keys) {
        write.execute(params![key, id])?;
    }
    Ok(())
}

/// The check on `bookmarks.source` takes any text: a device of a newer
/// version may save from a place this one does not know, and sync passes it
/// on as it is (Р-68). Refused, the value would fail every batch that brings
/// it. The app itself still writes only its own sources (`db::Source`); the
/// interface shows an unknown one as no place in particular.
fn any_source(tx: &Transaction) -> HookResult {
    widen_sources(
        tx,
        "CHECK (source IN ('app','chrome','edge','firefox','extension','bookmarklet','import','mcp','safari'))",
        "CHECK (typeof(source) IN ('text','null'))",
        "the bookmarks table is not the one schema 9 made",
    )
}

/// Replaces `old`, which must occur once, with `new` in the schema text of
/// `bookmarks`: see [`allow_mcp`] for why this is safe.
fn widen_sources(tx: &Transaction, old: &str, new: &str, refused: &str) -> HookResult {
    widen_check(tx, "bookmarks", old, new, refused)
}

/// [`widen_sources`] for any table: `old` must occur once in its schema text.
fn widen_check(tx: &Transaction, table: &str, old: &str, new: &str, refused: &str) -> HookResult {
    let sql: String = tx.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?1",
        [table],
        |r| r.get(0),
    )?;
    if sql.matches(old).count() != 1 {
        return Err(rusqlite_migration::HookError::Hook(refused.into()));
    }
    let version: i64 = tx.pragma_query_value(None, "schema_version", |r| r.get(0))?;
    tx.pragma_update(None, "writable_schema", true)?;
    tx.execute(
        "UPDATE sqlite_schema SET sql=?1 WHERE type='table' AND name=?2",
        rusqlite::params![sql.replace(old, new), table],
    )?;
    tx.pragma_update(None, "schema_version", version + 1)?;
    tx.pragma_update(None, "writable_schema", false)?;
    Ok(())
}

/// Keys of the existing bookmarks, computed in Rust: the step must not need
/// the SQL functions of `library::configure` (`validate()` runs without them).
fn url_keys(tx: &Transaction) -> HookResult {
    let rows: Vec<(i64, String)> = tx
        .prepare("SELECT id, url FROM bookmarks")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut update = tx.prepare("UPDATE bookmarks SET url_key = ?1 WHERE id = ?2")?;
    for (id, url) in rows {
        update.execute(params![crate::dedupe::url_key(&url), id])?;
    }
    Ok(())
}

/// What a new library starts with, created once. Its first collections wait
/// for the interface to name them in its language (`starter_collections`,
/// NP-085); libraries seeded before keep the ones they got.
fn seed(tx: &Transaction) -> HookResult {
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES ('starter_collections', 'pending')",
        [],
    )?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES ('capture_token', ?1), ('close_to_tray', 'true')",
        [token],
    )?;
    tx.pragma_update(None, "application_id", APPLICATION_ID)?;
    Ok(())
}

/// One step per schema version, in order; never edit a released step.
pub fn steps() -> Vec<M<'static>> {
    vec![
        M::up_with_hook(SCHEMA_1, seed),
        M::up(SCHEMA_2),
        M::up(SCHEMA_3),
        M::up(SCHEMA_4),
        M::up_with_hook(SCHEMA_5, url_keys),
        M::up(SCHEMA_6),
        M::up(SCHEMA_7),
        M::up_with_hook(SCHEMA_8, allow_mcp),
        M::up_with_hook(SCHEMA_9, allow_safari),
        M::up_with_hook("", sync_schema),
        M::up_with_hook(SCHEMA_11, sync_reading),
        M::up(SCHEMA_12),
        M::up_with_hook(SCHEMA_13, sync_site_name),
        M::up_with_hook(SCHEMA_14, sync_feeds),
    ]
}

pub fn migrations() -> Migrations<'static> {
    Migrations::new(steps())
}

#[derive(Debug)]
pub enum MigrationError {
    /// The copy before migrating to `version` failed; the library is untouched.
    Backup { version: i64, error: String },
    /// Migration to `version` was rolled back; the library is as it was.
    Failed {
        version: i64,
        error: String,
        backup: Option<PathBuf>,
    },
}

pub fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
}

pub fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}

pub fn migrate(conn: &mut Connection, backups: Option<&Path>) -> Result<(), MigrationError> {
    migrate_with(&migrations(), SCHEMA_VERSION, conn, backups)
}

/// `migrations` must have exactly `target` steps; tests pass extra ones.
pub fn migrate_with(
    migrations: &Migrations,
    target: i64,
    conn: &mut Connection,
    backups: Option<&Path>,
) -> Result<(), MigrationError> {
    let failed = |error: String, backup: Option<PathBuf>| MigrationError::Failed {
        version: target,
        error,
        backup,
    };
    let current = user_version(conn).map_err(|e| failed(e.to_string(), None))?;
    if current >= target {
        return Ok(());
    }
    // A new file (version 0) has nothing to save.
    let backup = match backups {
        Some(folder) if current > 0 => Some(
            backup::before_migration(conn, folder, target).map_err(|error| {
                MigrationError::Backup {
                    version: target,
                    error,
                }
            })?,
        ),
        _ => None,
    };
    migrations
        .to_latest(conn)
        .map_err(|e| failed(e.to_string(), backup.clone()))?;
    if let Some(folder) = backups {
        backup::prune_before_migration(folder, target);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db,
        library::{self, Paths},
        test_libraries as fixtures,
    };
    use rusqlite::types::ValueRef;
    use std::fs;

    fn folder(name: &str) -> PathBuf {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn rows(conn: &Connection, sql: &str) -> Vec<String> {
        let mut statement = conn.prepare(sql).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |r| {
                Ok((0..columns)
                    .map(|i| match r.get_ref(i).unwrap() {
                        ValueRef::Text(t) => format!("{:?}", String::from_utf8_lossy(t)),
                        other => format!("{other:?}"),
                    })
                    .collect::<Vec<_>>()
                    .join(" | "))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// The whole file as stored: schema, every row, the version.
    fn everything(conn: &Connection) -> Vec<String> {
        let tables = rows(
            conn,
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        );
        let mut data = rows(
            conn,
            "SELECT type, name, sql FROM sqlite_master ORDER BY name",
        );
        for table in tables {
            let table = table.trim_matches('"');
            data.extend(rows(
                conn,
                &format!("SELECT * FROM \"{table}\" ORDER BY rowid"),
            ));
        }
        data.push(format!("user_version {}", user_version(conn).unwrap()));
        data
    }

    /// A v1 library with data, plus the next migrations to try on it.
    fn library_v1(name: &str, rows: usize) -> (PathBuf, Connection) {
        let folder = folder(name);
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 1);
        fixtures::generated(&conn, rows, 7);
        fixtures::finish(conn);
        let conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        (folder, conn)
    }

    fn with_step(step: &'static str) -> Migrations<'static> {
        Migrations::new(vec![steps().remove(0), M::up(step)])
    }

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
    }

    #[test]
    fn new_library_gets_the_clean_schema_once() {
        let paths = Paths::new(folder("new-library").join("koonapin.db"));
        let opened = library::open(&paths).unwrap();
        let conn = opened.conn;
        assert!(opened.moved_aside.is_none());
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let id: i32 = conn
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .unwrap();
        assert_eq!(id, APPLICATION_ID);
        // No collection in any language until the interface names them (NP-085).
        assert!(db::get_collections(&conn).unwrap().is_empty());
        assert_eq!(db::setting(&conn, "starter_collections").unwrap(), "pending");
        assert_eq!(db::setting(&conn, "capture_token").unwrap().len(), 64);
        assert!(
            !paths.backups.exists(),
            "nothing to back up in a new library"
        );
        let synchronous: i64 = conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .unwrap();
        assert_eq!(synchronous, 2, "FULL");
    }

    /// Schema 8 (NP-091): a library of schema 7 with data takes links from
    /// `mcp` after the migration and nothing else; every row, index and
    /// trigger stays as it was, and the file passes the integrity check.
    #[test]
    fn schema_8_lets_the_assistants_save_and_keeps_everything_else() {
        let folder = folder("schema-8");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 7);
        fixtures::generated(&conn, 300, 8);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let insert = |conn: &Connection, source: &str| {
            conn.execute(
                "INSERT INTO bookmarks (uid, url, title, domain, source, created_at, updated_at) VALUES (?1, ?1, 't', 'd', ?2, 'x', 'x')",
                rusqlite::params![format!("https://example.com/{source}"), source],
            )
        };
        assert!(insert(&conn, "mcp").is_err(), "schema 7 refuses mcp");
        let rows_before = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        let objects = |conn: &Connection| rows(conn, "SELECT type, name FROM sqlite_schema WHERE name <> 'bookmarks' ORDER BY name");
        let objects_before = objects(&conn);
        let to_8 = Migrations::new(steps().into_iter().take(8).collect());
        migrate_with(&to_8, 8, &mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 8);
        assert_eq!(objects(&conn), objects_before, "no trigger, index or view lost");
        let rows_after = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        assert_eq!(rows_after.len(), rows_before.len());
        assert!(rows_after.iter().zip(&rows_before).all(|(after, before)| after.starts_with(before.as_str()) && after.ends_with("| Null")), "the rows, and a new empty column");
        insert(&conn, "mcp").unwrap();
        assert!(insert(&conn, "phone").is_err(), "the check still holds");
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        // A new connection reads the new schema text.
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        conn.execute(
            "INSERT INTO bookmarks (uid, url, title, domain, source, created_at, updated_at) VALUES ('u2', 'https://example.com/again', 't', 'd', 'mcp', 'x', 'x')",
            [],
        )
        .unwrap();
    }

    /// Schema 9 (NP-119): a library of schema 8 with data takes links from
    /// `safari` after the migration, keeps taking `mcp` and nothing else;
    /// rows, indexes and triggers stay exactly as they were.
    #[test]
    fn schema_9_lets_safari_save_and_keeps_everything_else() {
        let folder = folder("schema-9");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 8);
        fixtures::generated(&conn, 300, 9);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let insert = |conn: &Connection, source: &str| {
            conn.execute(
                "INSERT INTO bookmarks (uid, url, title, domain, source, created_at, updated_at) VALUES (?1, ?1, 't', 'd', ?2, 'x', 'x')",
                rusqlite::params![format!("https://example.com/{source}"), source],
            )
        };
        assert!(insert(&conn, "safari").is_err(), "schema 8 refuses safari");
        let rows_before = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        let objects = |conn: &Connection| rows(conn, "SELECT type, name, sql FROM sqlite_schema WHERE name <> 'bookmarks' ORDER BY name");
        let objects_before = objects(&conn);
        let to_9 = Migrations::new(steps().into_iter().take(9).collect());
        migrate_with(&to_9, 9, &mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 9);
        assert!(folder.join("backups/koonapin.before-v9.db").exists());
        assert_eq!(objects(&conn), objects_before, "no trigger, index or view changed");
        assert_eq!(rows(&conn, "SELECT * FROM bookmarks ORDER BY id"), rows_before);
        insert(&conn, "safari").unwrap();
        insert(&conn, "mcp").unwrap();
        assert!(insert(&conn, "phone").is_err(), "the check still holds");
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        // A new connection reads the new schema text.
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        conn.execute(
            "INSERT INTO bookmarks (uid, url, title, domain, source, created_at, updated_at) VALUES ('u2', 'https://example.com/again', 't', 'd', 'safari', 'x', 'x')",
            [],
        )
        .unwrap();
    }

    /// A library of schema 9 as the release left it, filled by `fill`, then
    /// migrated to 10: every row, index and trigger of 9 stays (but the
    /// search and sort triggers, which only gain a WHEN), sync is off and
    /// records nothing, the copy before-v10 is there.
    fn schema_10_on(name: &str, fill: impl FnOnce(&Connection)) -> Connection {
        let folder = folder(name);
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 9);
        fill(&conn);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let data = |conn: &Connection| {
            ["bookmarks", "tags", "bookmark_tags", "app_settings", "link_checks"]
                .iter()
                .flat_map(|t| rows(conn, &format!("SELECT * FROM {t} ORDER BY rowid")))
                .collect::<Vec<_>>()
        };
        // Two tables gain columns at the end.
        let collections = |conn: &Connection| {
            [rows(conn, "SELECT * FROM collections ORDER BY id"), rows(conn, "SELECT * FROM tombstones ORDER BY rowid")].concat()
        };
        // The sidebar's order as schema 9 read it, and as it is read now.
        let order_9 = |conn: &Connection| rows(conn, "SELECT name FROM collections ORDER BY position IS NULL, position, np_sort_key(name), id");
        let order = |conn: &Connection| db::get_collections(conn).unwrap().into_iter().map(|c| format!("{:?}", c.name)).collect::<Vec<_>>();
        let objects = |conn: &Connection| {
            let changed = "name IN ('bookmarks', 'collections', 'tombstones') OR (type = 'trigger' AND name LIKE 'bookmarks_%')";
            [
                rows(conn, &format!("SELECT type, name, sql FROM sqlite_schema WHERE NOT ({changed}) ORDER BY name")),
                rows(conn, &format!("SELECT type, name FROM sqlite_schema WHERE {changed} ORDER BY name")),
            ]
            .concat()
        };
        // The search as `db` makes it; `db` itself reads the columns of schema 11.
        let found = |conn: &Connection| rows(conn, "SELECT count(*) FROM bookmarks b WHERE b.deleted_at IS NULL AND b.id IN (SELECT rowid FROM bookmarks_search WHERE bookmarks_search MATCH '\"заметка\"')");
        let (data_before, collections_before, order_before, objects_before, found_before) =
            (data(&conn), collections(&conn), order_9(&conn), objects(&conn), found(&conn));

        let started = std::time::Instant::now();
        let to_10 = Migrations::new(steps().into_iter().take(10).collect());
        migrate_with(&to_10, 10, &mut conn, Some(&folder.join("backups"))).unwrap();
        println!("{name}: copied and migrated in {:?}", started.elapsed());
        assert_eq!(user_version(&conn).unwrap(), 10);
        assert!(folder.join("backups/koonapin.before-v10.db").exists());
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert!(rows(&conn, "PRAGMA foreign_key_check").is_empty());
        assert_eq!(data(&conn), data_before, "every row as it was");
        let after = collections(&conn);
        assert_eq!(after.len(), collections_before.len());
        assert!(after.iter().zip(&collections_before).all(|(a, b)| a.starts_with(b.as_str())), "the collections and tombstones, and their new columns");
        assert_eq!(order(&conn), order_before, "the sidebar's order");
        let objects_after = objects(&conn);
        assert!(objects_before.iter().all(|o| objects_after.contains(o)), "no index, view or table of schema 9 lost");
        assert_eq!(found(&conn), found_before, "the search finds what it found");
        // Sync is off: nothing is recorded, nothing stamped.
        assert!(!crate::sync_library::is_on(&conn));
        for table in ["sync_meta", "sync_origins", "sync_vector", "sync_clock"] {
            assert_eq!(rows(&conn, &format!("SELECT count(*) FROM {table}")), ["Integer(0)"], "{table}");
        }
        // On to the newest schema, for what follows and for the callers.
        migrate(&mut conn, Some(&folder.join("backups"))).unwrap();
        db::insert_or_update_bookmark(&conn, "https://example.com/after-10", "After", None, None, None, "example.com", None, Some(&["new".into()]), db::Source::App).unwrap();
        assert_eq!(rows(&conn, "SELECT count(*) FROM sync_clock"), ["Integer(0)"]);
        assert_eq!(rows(&conn, "SELECT count(*) FROM tombstones WHERE hlc IS NOT NULL"), ["Integer(0)"]);
        conn
    }

    #[test]
    fn schema_10_adds_sync_to_a_new_library() {
        let conn = schema_10_on("schema-10-fresh", |_| {});
        // Never ordered by hand: no keys, the collections go by name.
        assert_eq!(rows(&conn, "SELECT count(*) FROM collections WHERE position_key IS NOT NULL"), ["Integer(0)"]);
    }

    #[test]
    fn schema_10_keeps_the_sample_rows_and_the_order_given() {
        let conn = schema_10_on("schema-10-sample", |conn| {
            fixtures::sample_rows(conn);
            conn.execute("INSERT INTO tombstones (uid, kind, deleted_at, purged_at) VALUES ('gone', 'bookmark', 'x', 'x')", []).unwrap();
            // One collection moved to the top; the others follow by name.
            conn.execute("UPDATE collections SET position = 0 WHERE name = 'Development'", []).unwrap();
        });
        let names = db::get_collections(&conn).unwrap().into_iter().map(|c| (c.name, c.position)).collect::<Vec<_>>();
        assert_eq!(
            names,
            [("Development".to_string(), Some(0)), ("Articles / To read".into(), Some(1)), ("Design & UI".into(), Some(2))]
        );
        // A new one goes last, a move writes one key.
        let new = db::create_collection(&conn, "Aardvark", None, None).unwrap();
        assert_eq!(new.position, Some(3));
        let ids: Vec<i64> = db::get_collections(&conn).unwrap().iter().map(|c| c.id).collect();
        let keys = |conn: &Connection| rows(conn, "SELECT position_key FROM collections ORDER BY id");
        let before = keys(&conn);
        db::reorder_collections(&conn, &[ids[3], ids[0], ids[1], ids[2]]).unwrap();
        let after = keys(&conn);
        assert_eq!(before.iter().zip(&after).filter(|(a, b)| a != b).count(), 1);
        assert_eq!(db::get_collections(&conn).unwrap()[0].name, "Aardvark");
        // A source this build does not know, from a newer device.
        conn.execute("UPDATE bookmarks SET source = 'watch' WHERE id = 1", []).unwrap();
        assert_eq!(db::get_bookmark_by_id(&conn, 1).unwrap().source.as_deref(), Some("watch"));
    }

    #[test]
    fn schema_10_keeps_a_generated_library() {
        schema_10_on("schema-10-generated", |conn| fixtures::generated(conn, 2_000, 10));
    }

    /// The same on 100 000 bookmarks: `cargo test --release schema_10_on_a_hundred -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn schema_10_on_a_hundred_thousand_bookmarks() {
        let started = std::time::Instant::now();
        schema_10_on("schema-10-100k", |conn| fixtures::generated(conn, 100_000, 10));
        println!("built, migrated and checked in {:?}", started.elapsed());
    }

    /// Schema 11 (NP-121): a library of schema 10 with data keeps every row
    /// and object (but the capture trigger, which gains the Reading fields);
    /// nothing is in Reading, nothing read; the copy before-v11 is there; with
    /// sync on, sending to Reading, progress and reading are recorded field by
    /// field, and the list reads its index.
    #[test]
    fn schema_11_adds_reading_and_keeps_everything_else() {
        let folder = folder("schema-11");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 10);
        fixtures::generated(&conn, 2_000, 11);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let objects = |conn: &Connection| rows(conn, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT IN ('bookmarks', 'sync_bookmarks_update') ORDER BY name");
        let other = |conn: &Connection| {
            ["collections", "tags", "bookmark_tags", "app_settings", "tombstones"]
                .iter()
                .flat_map(|t| rows(conn, &format!("SELECT * FROM {t} ORDER BY rowid")))
                .collect::<Vec<_>>()
        };
        let bookmarks_before = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        let (objects_before, other_before) = (objects(&conn), other(&conn));

        let to_11 = Migrations::new(steps().into_iter().take(11).collect());
        migrate_with(&to_11, 11, &mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 11);
        assert!(folder.join("backups/koonapin.before-v11.db").exists());
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        let mut objects_after = objects(&conn);
        objects_after.retain(|o| !o.contains("idx_bookmarks_reading"));
        assert_eq!(objects_after, objects_before, "no other index, view, table or trigger changed");
        assert_eq!(other(&conn), other_before);
        let bookmarks_after = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        assert_eq!(bookmarks_after.len(), bookmarks_before.len());
        assert!(
            bookmarks_after.iter().zip(&bookmarks_before).all(|(a, b)| *a == format!("{b} | Null | Real(0.0) | Null")),
            "every row, out of Reading and unread: {}",
            bookmarks_after[0]
        );
        assert!(conn.execute("UPDATE bookmarks SET reading_progress = 1.5 WHERE id = 1", []).is_err(), "progress is 0 to 1");

        // Sync on: each Reading field is a change of its own.
        koona_sync::attach(&conn, uuid::Uuid::new_v4()).unwrap();
        let clocks = |conn: &Connection| rows(conn, "SELECT field FROM sync_clock WHERE entity = 2 AND row = 1 ORDER BY field");
        conn.execute("UPDATE bookmarks SET reading_at = '2026-10-14T10:00:00.000Z' WHERE id = 1", []).unwrap();
        assert_eq!(clocks(&conn), ["Integer(13)"]);
        conn.execute("UPDATE bookmarks SET reading_progress = 1, read_at = '2026-10-14T11:00:00.000Z' WHERE id = 1", []).unwrap();
        assert_eq!(clocks(&conn), ["Integer(13)", "Integer(14)", "Integer(15)"]);

        // The page of Reading as `db` reads it: the few rows from the index, then sorted.
        let page = format!(
            "SELECT b.id FROM bookmarks b WHERE b.deleted_at IS NULL AND b.reading_at IS NOT NULL ORDER BY {} DESC, b.id DESC LIMIT 101",
            "CASE WHEN b.read_at IS NULL THEN '1' || b.reading_at ELSE '0' || b.read_at END"
        );
        let plan = rows(&conn, &format!("EXPLAIN QUERY PLAN {page}"));
        assert!(plan.iter().any(|step| step.contains("idx_bookmarks_reading")), "{plan:?}");
        let plan = rows(&conn, "EXPLAIN QUERY PLAN SELECT count(*) FROM bookmarks b WHERE b.deleted_at IS NULL AND b.reading_at IS NOT NULL AND b.read_at IS NULL");
        assert!(plan.iter().any(|step| step.contains("COVERING INDEX idx_bookmarks_reading")), "{plan:?}");
    }

    /// Schema 12 (NP-126): a library of schema 11 with data keeps every row
    /// and object and gains the empty table of offline copies; the copy
    /// before-v12 is there; with sync on, a copy records nothing; a hard
    /// delete of the bookmark takes its row, a move to the trash does not.
    #[test]
    fn schema_12_adds_offline_copies_and_keeps_everything_else() {
        let folder = folder("schema-12");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 11);
        fixtures::generated(&conn, 2_000, 12);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let objects = |conn: &Connection| rows(conn, "SELECT type, name, sql FROM sqlite_schema WHERE name <> 'offline_copies' ORDER BY name");
        let data = |conn: &Connection| {
            ["bookmarks", "collections", "tags", "bookmark_tags", "app_settings", "tombstones"]
                .iter()
                .flat_map(|t| rows(conn, &format!("SELECT * FROM {t} ORDER BY rowid")))
                .collect::<Vec<_>>()
        };
        let (objects_before, data_before) = (objects(&conn), data(&conn));

        let to_12 = Migrations::new(steps().into_iter().take(12).collect());
        migrate_with(&to_12, 12, &mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 12);
        assert!(folder.join("backups/koonapin.before-v12.db").exists());
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert_eq!(objects(&conn), objects_before, "no other index, view, table or trigger changed");
        assert_eq!(data(&conn), data_before, "every row as it was");
        assert_eq!(rows(&conn, "SELECT count(*) FROM offline_copies"), ["Integer(0)"]);

        // Sync on: a copy is not a change to send.
        koona_sync::attach(&conn, uuid::Uuid::new_v4()).unwrap();
        let clocks = |conn: &Connection| rows(conn, "SELECT count(*) FROM sync_clock");
        let before = clocks(&conn);
        conn.execute(
            "INSERT INTO offline_copies (bookmark_id, saved_at, url, bytes, images, words)
             VALUES (1, '2026-10-16T10:00:00.000Z', 'https://example.com/', 10, 0, 2), (2, '2026-10-16T10:00:00.000Z', 'https://example.com/', 10, 0, 2)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE offline_copies SET bytes = 20 WHERE bookmark_id = 1", []).unwrap();
        assert_eq!(clocks(&conn), before);
        assert!(conn.execute("INSERT INTO offline_copies VALUES (999999, 'x', 'x', 0, 0, 0)", []).is_err(), "only of a bookmark");
        // The app's own calls read the newest schema (the site name of schema 13).
        migrate(&mut conn, Some(&folder.join("backups"))).unwrap();
        db::trash_bookmark(&conn, 1).unwrap();
        db::trash_bookmark(&conn, 2).unwrap();
        db::purge_trash(&conn, db::Purge::One(2)).unwrap();
        assert_eq!(rows(&conn, "SELECT bookmark_id FROM offline_copies"), ["Integer(1)"]);
    }

    /// Schema 13: a library of schema 12 with data keeps every row and object
    /// (but the capture trigger, which gains the field); no bookmark has a
    /// site name yet; the copy before-v13 is there; with sync on, a name read
    /// later is a change of its own (field 16).
    #[test]
    fn schema_13_adds_the_site_name_and_keeps_everything_else() {
        let folder = folder("schema-13");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 12);
        fixtures::generated(&conn, 2_000, 13);
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let objects = |conn: &Connection| rows(conn, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT IN ('bookmarks', 'sync_bookmarks_update') ORDER BY name");
        let other = |conn: &Connection| {
            ["collections", "tags", "bookmark_tags", "app_settings", "tombstones", "offline_copies"]
                .iter()
                .flat_map(|t| rows(conn, &format!("SELECT * FROM {t} ORDER BY rowid")))
                .collect::<Vec<_>>()
        };
        let bookmarks_before = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        let (objects_before, other_before) = (objects(&conn), other(&conn));

        let to_13 = Migrations::new(steps().into_iter().take(13).collect());
        migrate_with(&to_13, 13, &mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 13);
        assert!(folder.join("backups/koonapin.before-v13.db").exists());
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert_eq!(objects(&conn), objects_before, "no index, view, table or other trigger changed");
        assert_eq!(other(&conn), other_before);
        let bookmarks_after = rows(&conn, "SELECT * FROM bookmarks ORDER BY id");
        assert_eq!(bookmarks_after.len(), bookmarks_before.len());
        assert!(
            bookmarks_after.iter().zip(&bookmarks_before).all(|(a, b)| *a == format!("{b} | Null")),
            "every row, without a site name: {}",
            bookmarks_after[0]
        );

        koona_sync::attach(&conn, uuid::Uuid::new_v4()).unwrap();
        let clocks = |conn: &Connection| rows(conn, "SELECT field FROM sync_clock WHERE entity = 2 AND row = 1 ORDER BY field");
        conn.execute("UPDATE bookmarks SET site_name = 'Serious Eats' WHERE id = 1", []).unwrap();
        assert_eq!(clocks(&conn), ["Integer(16)"]);
    }

    /// Schema 14 (NP-128): a library of schema 13 with data keeps every row
    /// and object (but the tombstones' check, which takes `feed`) and gains
    /// the empty table of feeds, in one step with the copy before-v14. A
    /// subscription takes any destination text but no other type; an
    /// unsubscribe leaves a `feed` tombstone, and the check still holds.
    #[test]
    fn schema_14_adds_feeds_and_keeps_everything_else() {
        let folder = folder("schema-14");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 13);
        fixtures::generated(&conn, 2_000, 14);
        conn.execute("INSERT INTO tombstones (uid, kind, deleted_at, purged_at) VALUES ('gone', 'bookmark', 'x', 'x')", []).unwrap();
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let tombstone = |conn: &Connection, kind: &str| {
            conn.execute(
                "INSERT INTO tombstones (uid, kind, deleted_at, purged_at) VALUES (?1, ?2, 'x', 'x')",
                rusqlite::params![format!("uid-{kind}"), kind],
            )
        };
        assert!(tombstone(&conn, "feed").is_err(), "schema 13 refuses feed");
        let objects = |conn: &Connection| rows(conn, "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name NOT IN ('tombstones', 'feeds') AND name <> 'sqlite_sequence' ORDER BY name");
        let data = |conn: &Connection| {
            ["bookmarks", "collections", "tags", "bookmark_tags", "app_settings", "tombstones", "offline_copies"]
                .iter()
                .flat_map(|t| rows(conn, &format!("SELECT * FROM {t} ORDER BY rowid")))
                .collect::<Vec<_>>()
        };
        let (objects_before, data_before) = (objects(&conn), data(&conn));

        migrate(&mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 14);
        assert!(folder.join("backups/koonapin.before-v14.db").exists());
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert_eq!(objects(&conn), objects_before, "no other index, view, table or trigger changed");
        assert_eq!(data(&conn), data_before, "every row as it was");
        assert_eq!(rows(&conn, "SELECT count(*) FROM feeds"), ["Integer(0)"]);

        tombstone(&conn, "feed").unwrap();
        assert!(tombstone(&conn, "post").is_err(), "the check still holds");
        let subscribe = |conn: &Connection, url: &str, destination: rusqlite::types::Value| {
            conn.execute(
                "INSERT INTO feeds (uid, url, destination, created_at, updated_at) VALUES (?1, ?1, ?2, 'x', 'x')",
                rusqlite::params![url, destination],
            )
        };
        subscribe(&conn, "https://example.com/feed", "watch-only".to_string().into()).unwrap();
        assert!(subscribe(&conn, "https://example.com/other", vec![1u8].into()).is_err(), "destination is text, not a blob");
        assert!(subscribe(&conn, "https://example.com/feed", "feeds".to_string().into()).is_err(), "one subscription per address");
        conn.execute("INSERT INTO feeds (uid, url, created_at, updated_at) VALUES ('d', 'https://example.org/rss', 'x', 'x')", []).unwrap();
        assert_eq!(rows(&conn, "SELECT destination FROM feeds WHERE uid = 'd'"), [r#""feeds""#]);
        // A new connection reads the new schema text.
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        conn.execute("INSERT INTO tombstones (uid, kind, deleted_at, purged_at) VALUES ('again', 'feed', 'x', 'x')", []).unwrap();
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
    }

    /// A tombstones table other than the one schema 10 left is refused, and
    /// the step rolls back whole.
    #[test]
    fn schema_14_refuses_a_foreign_tombstones_table() {
        let folder = folder("schema-14-foreign");
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 13);
        conn.execute_batch(
            "PRAGMA writable_schema = ON;
             UPDATE sqlite_schema SET sql = replace(sql, '''tag''))', '''tag'',''note''))') WHERE name = 'tombstones';
             PRAGMA writable_schema = OFF;",
        )
        .unwrap();
        fixtures::finish(conn);
        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        match migrate(&mut conn, Some(&folder.join("backups"))) {
            Err(MigrationError::Failed { version: 14, error, .. }) => assert!(error.contains("tombstones"), "{error}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(user_version(&conn).unwrap(), 13);
        assert!(!table_exists(&conn, "feeds").unwrap());
    }

    /// The column of schema 13 the engine's tests add (`koona-sync/tests/schema13.sql`)
    /// is the one this step adds.
    #[test]
    fn the_engine_tests_schema_13_as_the_app_makes_it() {
        let file = include_str!("../commercial/koona-sync/tests/schema13.sql");
        let columns: String = file.lines().skip_while(|l| l.starts_with("--")).map(|l| format!("{l}\n")).collect();
        assert_eq!(columns, SCHEMA_13);
    }

    /// The columns of schema 11 the engine's tests add (`koona-sync/tests/schema11.sql`)
    /// are the ones this step adds.
    #[test]
    fn the_engine_tests_schema_11_as_the_app_makes_it() {
        let file = include_str!("../commercial/koona-sync/tests/schema11.sql");
        let columns: String = file.lines().skip_while(|l| l.starts_with("--")).map(|l| format!("{l}\n")).collect();
        assert_eq!(columns, SCHEMA_11);
    }

    /// The schema 9 the engine's tests build on (`koona-sync/tests/schema.sql`)
    /// is the one these steps make.
    #[test]
    fn the_engine_tests_schema_9_as_the_app_makes_it() {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrations::new(steps().into_iter().take(9).collect()).to_latest(&mut conn).unwrap();
        let made: String = conn
            .prepare(
                "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name <> 'sqlite_sequence'
                     AND name NOT IN ('bookmarks_search_data', 'bookmarks_search_idx', 'bookmarks_search_docsize', 'bookmarks_search_config')
                 ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|sql| format!("{};\n", sql.unwrap()))
            .collect();
        let file = include_str!("../commercial/koona-sync/tests/schema.sql");
        let schema: String = file.lines().skip_while(|l| l.starts_with("--")).map(|l| format!("{l}\n")).collect();
        assert_eq!(made, schema);
    }

    #[test]
    fn starter_collections_are_named_by_the_interface_once() {
        let paths = Paths::new(folder("starters").join("koonapin.db"));
        let conn = library::open(&paths).unwrap().conn;
        let names = ["Development", "Design & UI", "Articles / To read"].map(String::from);
        let made = db::create_starter_collections(&conn, &names).unwrap();
        assert_eq!(made.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), names);
        assert_eq!(made[0].icon.as_deref(), Some("code"));
        // A second call, another language or another start: nothing more.
        let again = ["Разработка", "Дизайн", "Статьи"].map(String::from);
        assert!(db::create_starter_collections(&conn, &again).unwrap().is_empty());
        drop(conn);
        let conn = library::open(&paths).unwrap().conn;
        assert!(db::create_starter_collections(&conn, &again).unwrap().is_empty());
        assert_eq!(db::get_collections(&conn).unwrap().len(), 3);
    }

    #[test]
    fn a_library_seeded_before_gets_no_starters() {
        let (_folder, conn) = library_v1("old-starters", 0);
        assert!(db::setting(&conn, "starter_collections").is_err());
        let names = ["One", "Two", "Three"].map(String::from);
        assert!(db::create_starter_collections(&conn, &names).unwrap().is_empty());
    }

    #[test]
    fn deleted_collections_do_not_come_back() {
        let paths = Paths::new(folder("collections-once").join("koonapin.db"));
        let conn = library::open(&paths).unwrap().conn;
        let names = ["Development", "Design & UI", "Articles / To read"].map(String::from);
        db::create_starter_collections(&conn, &names).unwrap();
        for c in db::get_collections(&conn).unwrap() {
            db::delete_collection(&conn, c.id).unwrap();
        }
        drop(conn);
        for _ in 0..2 {
            let conn = library::open(&paths).unwrap().conn;
            assert!(db::get_collections(&conn).unwrap().is_empty());
            assert_eq!(
                rows(&conn, "SELECT kind, count(*) FROM tombstones"),
                [r#""collection" | Integer(3)"#]
            );
        }
    }

    #[test]
    fn next_migration_is_backed_up_applied_once_and_pruned() {
        let (folder, mut conn) = library_v1("migrate-next", 500);
        let before = everything(&conn);
        let backups = folder.join("backups");
        let step2 =
            with_step("ALTER TABLE bookmarks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
        migrate_with(&step2, 2, &mut conn, Some(&backups)).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 2);
        let copy = Connection::open(backups.join("koonapin.before-v2.db")).unwrap();
        assert_eq!(
            everything(&copy),
            before,
            "the copy holds the library as it was"
        );

        let migrated = everything(&conn);
        migrate_with(&step2, 2, &mut conn, Some(&backups)).unwrap();
        assert_eq!(
            everything(&conn),
            migrated,
            "a repeated start changes nothing"
        );

        // Copies before the last two migrations are kept.
        let step3 = Migrations::new(vec![
            steps().remove(0),
            M::up("ALTER TABLE bookmarks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;"),
            M::up("CREATE TABLE notes (text TEXT);"),
        ]);
        fs::write(backups.join("koonapin.before-v1.db"), b"older").unwrap();
        migrate_with(&step3, 3, &mut conn, Some(&backups)).unwrap();
        assert!(!backups.join("koonapin.before-v1.db").exists());
        assert!(backups.join("koonapin.before-v2.db").exists());
        assert!(backups.join("koonapin.before-v3.db").exists());
    }

    /// Schemas 3 and 4 add indexes only: a library of schema 2 gets them with
    /// one copy, every bookmark keeps its state, the queries use them.
    #[test]
    fn schemas_3_and_4_index_an_existing_library() {
        let paths = Paths::new(folder("migrate-indexes").join("koonapin.db"));
        let conn = fixtures::fresh_at(&paths.database, 2);
        fixtures::generated(&conn, 2_000, 5);
        conn.execute(
            "UPDATE bookmarks SET deleted_at = updated_at WHERE id % 10 = 0",
            [],
        )
        .unwrap();
        let counts = db::get_counts(&conn).unwrap();
        fixtures::finish(conn);

        let conn = library::open(&paths).unwrap().conn;
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let copy = format!("koonapin.before-v{SCHEMA_VERSION}.db");
        assert!(paths.backups.join(copy).exists());
        assert!(counts.inbox > 0 && counts.trash > 0);
        let after = db::get_counts(&conn).unwrap();
        assert_eq!(
            (after.total, after.inbox, after.trash),
            (counts.total, counts.inbox, counts.trash),
            "no bookmark changes its state"
        );
        for (query, index) in [
            (
                "SELECT b.id FROM bookmarks b WHERE b.deleted_at IS NULL AND b.triaged_at IS NULL
                 ORDER BY b.created_at DESC, b.id DESC LIMIT 101",
                "idx_bookmarks_inbox",
            ),
            (
                "SELECT b.id FROM bookmarks b WHERE b.deleted_at IS NOT NULL
                 ORDER BY b.deleted_at DESC, b.id DESC LIMIT 101",
                "idx_bookmarks_trash",
            ),
            (
                "SELECT domain, COUNT(id) FROM bookmarks WHERE deleted_at IS NULL GROUP BY domain",
                "COVERING INDEX idx_bookmarks_domain",
            ),
            (
                "SELECT c.id, COUNT(b.id) FROM collections c
                 LEFT JOIN bookmarks b ON c.id = b.collection_id AND b.deleted_at IS NULL GROUP BY c.id",
                "COVERING INDEX idx_bookmarks_collection",
            ),
        ] {
            let plan = rows(&conn, &format!("EXPLAIN QUERY PLAN {query}"));
            assert!(plan.iter().any(|step| step.contains(index)), "{index}: {plan:?}");
        }
    }

    /// Schema 5 keys every existing address: the near duplicates of the test
    /// libraries become one group; «?ref=» stays another page.
    #[test]
    fn schema_5_keys_the_addresses_of_an_existing_library() {
        let paths = Paths::new(folder("migrate-duplicates").join("koonapin.db"));
        let conn = fixtures::fresh_at(&paths.database, 4);
        fixtures::near_duplicates(&conn);
        fixtures::finish(conn);
        let conn = library::open(&paths).unwrap().conn;
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let missing: i64 = conn.query_row("SELECT count(*) FROM bookmarks WHERE url_key IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(missing, 0);
        let groups = crate::dedupe::groups(&conn).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].bookmarks.len(), 7);
        assert_eq!(groups[0].bookmarks[0].url, "https://example.com/page", "the plain and oldest one");
        let plan = rows(&conn, "EXPLAIN QUERY PLAN SELECT url_key FROM bookmarks WHERE deleted_at IS NULL AND url_key IS NOT NULL GROUP BY url_key");
        assert!(plan.iter().any(|step| step.contains("idx_bookmarks_url_key")), "{plan:?}");
    }

    /// Schema 7 (NP-114): the bookmarks already there wait for the interface's
    /// language for their sort keys, the first order by title writes them
    /// (English) if the interface has not; the collections have no places yet.
    /// Each order reads its index, the totals and `Ctrl A` read an index alone.
    #[test]
    fn schema_7_sorts_an_existing_library_by_its_indexes() {
        use crate::db::{BookmarkQuery, BookmarkSort};
        let paths = Paths::new(folder("migrate-sort").join("koonapin.db"));
        let conn = fixtures::fresh_at(&paths.database, 6);
        fixtures::generated(&conn, 2_000, 9);
        fixtures::finish(conn);
        let conn = library::open(&paths).unwrap().conn;
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        assert_eq!(crate::sorting::stored_language(&conn), None);
        let missing = |conn: &Connection| -> i64 {
            conn.query_row("SELECT count(*) FROM bookmarks WHERE title_key IS NULL OR site_key IS NULL", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(missing(&conn), 2_000);
        let by_title = BookmarkQuery { sort: Some(BookmarkSort::Title), ..Default::default() };
        assert_eq!(db::get_bookmarks(&conn, &by_title).unwrap().total, Some(db::get_counts(&conn).unwrap().total));
        assert_eq!((missing(&conn), crate::sorting::stored_language(&conn).as_deref()), (0, Some("en")));
        assert!(crate::sorting::set_language(&conn, "ru").unwrap());
        assert_eq!(rows(&conn, "SELECT count(*) FROM collections WHERE position IS NOT NULL"), ["Integer(0)"]);

        let live = "WHERE b.deleted_at IS NULL";
        for (query, index) in [
            (format!("SELECT b.id FROM bookmarks b {live} ORDER BY b.title_key, b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_title"),
            (format!("SELECT b.id FROM bookmarks b {live} AND b.title_key >= x'01' AND (b.title_key > x'01' OR (b.created_at, b.id) < ('2026', 1)) ORDER BY b.title_key, b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_title (title_key>?)"),
            (format!("SELECT b.id FROM bookmarks b {live} ORDER BY b.site_key, b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_site"),
            (format!("SELECT b.id FROM bookmarks b {live} ORDER BY b.created_at, b.id LIMIT 101"), "idx_bookmarks_order"),
            (format!("SELECT b.id FROM bookmarks b {live} ORDER BY b.created_at DESC, b.id DESC"), "COVERING INDEX idx_bookmarks_order"),
            // Any index of the list answers a total alone.
            (format!("SELECT count(*), sum(b.created_at >= '2026') FROM bookmarks b {live}"), "USING COVERING INDEX"),
            (format!("SELECT count(*) FROM bookmarks b {live} AND b.triaged_at IS NULL AND b.source = 'import'"), "COVERING INDEX idx_bookmarks_inbox"),
            (format!("SELECT b.id FROM bookmarks b {live} AND b.is_favorite = 1 ORDER BY b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_favorites"),
            (format!("SELECT b.id FROM bookmarks b {live} AND b.collection_id = 2 ORDER BY b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_collection"),
            (format!("SELECT b.id FROM bookmarks b {live} AND b.domain = 'github.com' ORDER BY b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_domain"),
            // The links in the trash of `db::get_tags`: from the trash, not from every link.
            (
                "SELECT bt.tag_id, count(*) FROM bookmarks b CROSS JOIN bookmark_tags bt ON bt.bookmark_id = b.id WHERE b.deleted_at IS NOT NULL GROUP BY bt.tag_id".into(),
                "idx_bookmarks_trash",
            ),
            (format!("SELECT b.id FROM bookmarks b {live} AND b.triaged_at IS NULL ORDER BY b.created_at DESC, b.id DESC LIMIT 101"), "idx_bookmarks_inbox"),
            (
                format!("SELECT b.id FROM bookmarks b {live} AND b.id IN (SELECT bt.bookmark_id FROM bookmark_tags bt WHERE bt.tag_id = (SELECT id FROM tags WHERE name = 'rust')) ORDER BY b.created_at DESC, b.id DESC LIMIT 101"),
                "idx_bookmark_tags_tag",
            ),
        ] {
            let plan = rows(&conn, &format!("EXPLAIN QUERY PLAN {query}"));
            assert!(plan.iter().any(|step| step.contains(index)), "{index}: {plan:?}");
            assert!(!plan.iter().any(|step| step.contains("TEMP B-TREE FOR ORDER BY") && !query.contains("tag_id")), "{query}: {plan:?}");
        }
    }

    #[test]
    fn failed_migration_rolls_back_and_names_the_copy() {
        let (folder, mut conn) = library_v1("migrate-failed", 500);
        let before = everything(&conn);
        let backups = folder.join("backups");
        // The first statement succeeds, the second fails: both must disappear.
        let broken = with_step(
            "CREATE TABLE half_done (x); INSERT INTO bookmarks (url) VALUES ('https://example.com/no-title');",
        );
        match migrate_with(&broken, 2, &mut conn, Some(&backups)) {
            Err(MigrationError::Failed {
                version: 2,
                backup: Some(copy),
                error,
            }) => {
                assert!(copy.exists(), "{error}");
            }
            other => panic!("expected a failed migration, got {other:?}"),
        }
        assert_eq!(everything(&conn), before, "the library stays v1 as it was");
    }

    #[test]
    fn write_failure_in_the_middle_rolls_back() {
        let (folder, mut conn) = library_v1("migrate-disk-full", 3_000);
        let before = everything(&conn);
        // A full disk: the copy succeeds, the migration cannot grow the file.
        let pages: i64 = conn
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .unwrap();
        conn.pragma_update(None, "max_page_count", pages + 5)
            .unwrap();
        let copying = with_step("CREATE TABLE bookmarks_copy AS SELECT * FROM bookmarks;");
        match migrate_with(&copying, 2, &mut conn, Some(&folder.join("backups"))) {
            Err(MigrationError::Failed {
                error,
                backup: Some(_),
                ..
            }) => {
                assert!(error.contains("full"), "{error}");
            }
            other => panic!("expected a failed migration, got {other:?}"),
        }
        assert_eq!(everything(&conn), before);
        conn.pragma_update(None, "max_page_count", 1_073_741_823)
            .unwrap();
        migrate_with(&copying, 2, &mut conn, None).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 2);
    }
}
