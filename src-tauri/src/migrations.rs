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

use crate::{backup, db};
use rusqlite::{params, Connection, Transaction};
use rusqlite_migration::{HookResult, Migrations, M};
use std::path::{Path, PathBuf};

/// The newest schema this build understands. A library with a larger
/// `user_version` is not opened at all.
pub const SCHEMA_VERSION: i64 = 2;
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

/// What a new library starts with, created once: collections the user
/// deletes never come back.
fn seed(tx: &Transaction) -> HookResult {
    let now = db::now();
    for (name, color, icon) in [
        ("Разработка", "#6366f1", "code"),
        ("Дизайн & UI", "#ec4899", "palette"),
        ("Статьи / Читать", "#10b981", "book-open"),
    ] {
        tx.execute(
            "INSERT INTO collections (uid, name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![db::new_uid(), name, color, icon, now],
        )?;
    }
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
    vec![M::up_with_hook(SCHEMA_1, seed), M::up(SCHEMA_2)]
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
        let path = folder.join("netamipin.db");
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
        let paths = Paths::new(folder("new-library").join("netamipin.db"));
        let opened = library::open(&paths).unwrap();
        let conn = opened.conn;
        assert!(opened.moved_aside.is_none());
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let id: i32 = conn
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .unwrap();
        assert_eq!(id, APPLICATION_ID);
        assert_eq!(db::get_collections(&conn).unwrap().len(), 3);
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
    fn deleted_collections_do_not_come_back() {
        let paths = Paths::new(folder("collections-once").join("netamipin.db"));
        let conn = library::open(&paths).unwrap().conn;
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
        let copy = Connection::open(backups.join("netamipin.before-v2.db")).unwrap();
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
        fs::write(backups.join("netamipin.before-v1.db"), b"older").unwrap();
        migrate_with(&step3, 3, &mut conn, Some(&backups)).unwrap();
        assert!(!backups.join("netamipin.before-v1.db").exists());
        assert!(backups.join("netamipin.before-v2.db").exists());
        assert!(backups.join("netamipin.before-v3.db").exists());
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
