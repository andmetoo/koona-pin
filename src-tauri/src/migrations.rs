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
use rusqlite::{params, Connection, Transaction};
use rusqlite_migration::{HookResult, Migrations, M};
use std::path::{Path, PathBuf};

/// The newest schema this build understands. A library with a larger
/// `user_version` is not opened at all.
pub const SCHEMA_VERSION: i64 = 7;
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
