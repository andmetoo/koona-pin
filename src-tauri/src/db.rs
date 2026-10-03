use rusqlite::{params, Connection, DatabaseName, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub domain: String,
    pub notes: Option<String>,
    pub is_favorite: bool,
    pub collection_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Option<Vec<String>>,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCount {
    pub domain: String,
    pub count: i64,
}

pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    pub fn init() -> Self {
        let db_path = get_db_path();
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let imported = crate::legacy::legacy_database().filter(|legacy| {
            crate::legacy::import_database(legacy, &db_path)
                .expect("Failed to import the OddClicks library; original data preserved")
        });

        let conn = Connection::open(&db_path).expect("Failed to open SQLite database");

        // Enable WAL mode & foreign keys for high performance
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("Failed to configure SQLite");

        create_tables(&conn).expect("Failed to create tables");
        migrate(&conn, Some(&db_path))
            .expect("Failed to migrate database; original data preserved");
        if let Some(legacy) = imported {
            let _ = set_setting(&conn, "imported_from", &legacy.to_string_lossy());
        }

        DbState {
            conn: Mutex::new(conn),
        }
    }
}

pub fn migrate(conn: &Connection, db_path: Option<&std::path::Path>) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= 1 {
        return Ok(());
    }
    if let Some(path) = db_path {
        let backup = path.with_file_name("netamipin.before-v1.db");
        if !backup.exists() {
            conn.backup(DatabaseName::Main, backup, None)?;
        }
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("ALTER TABLE bookmarks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE capture_receipts (request_id TEXT PRIMARY KEY, url TEXT NOT NULL, bookmark_id INTEGER NOT NULL, outcome TEXT NOT NULL);
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;")?;
    tx.execute(
        "INSERT INTO app_settings (key,value) VALUES ('capture_token',?1)",
        params![format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )],
    )?;
    tx.execute(
        "INSERT INTO app_settings (key,value) VALUES ('close_to_tray','true')",
        [],
    )?;
    tx.commit()
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryCounts {
    pub total: i64,
    pub favorites: i64,
}

pub fn get_counts(conn: &Connection) -> Result<LibraryCounts> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(is_favorite),0) FROM bookmarks",
        [],
        |r| {
            Ok(LibraryCounts {
                total: r.get(0)?,
                favorites: r.get(1)?,
            })
        },
    )
}

pub fn setting(conn: &Connection, key: &str) -> Result<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| {
        r.get(0)
    })
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT INTO app_settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
    Ok(())
}

/// Overrides the library folder; tests use it to stay away from user data.
pub const DATA_DIR_ENV: &str = "NETAMIPIN_DATA_DIR";
const DB_FILE: &str = "netamipin.db";

fn get_db_path() -> PathBuf {
    if let Some(directory) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(directory).join(DB_FILE);
    }
    match dirs::data_dir() {
        Some(data_dir) => data_dir.join("Netami Pin").join(DB_FILE),
        None => PathBuf::from(DB_FILE),
    }
}

/// Schema version 0. Public so `examples/test_libraries.rs` builds fixtures from the real schema.
pub fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            icon TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            description TEXT,
            image_url TEXT,
            favicon_url TEXT,
            domain TEXT NOT NULL,
            notes TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookmark_tags (
            bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (bookmark_id, tag_id)
        );

        CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks(domain);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_fav ON bookmarks(is_favorite);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_collection ON bookmarks(collection_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at DESC);",
    )?;

    // Insert default collections if empty
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?;
    if count == 0 {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Разработка", "#6366f1", "code", now],
        )?;
        conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Дизайн & UI", "#ec4899", "palette", now],
        )?;
        conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Статьи / Читать", "#10b981", "book-open", now],
        )?;
    }

    Ok(())
}

pub fn insert_or_update_bookmark(
    conn: &Connection,
    url: &str,
    title: &str,
    description: Option<&str>,
    image_url: Option<&str>,
    favicon_url: Option<&str>,
    domain: &str,
    collection_id: Option<i64>,
    tags: Option<&[String]>,
) -> Result<Bookmark> {
    // Capture is additive: an existing URL must never overwrite user data.
    if let Some(id) = conn
        .query_row("SELECT id FROM bookmarks WHERE url=?1", [url], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
    {
        return get_bookmark_by_id(conn, id);
    }
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO bookmarks (url, title, description, image_url, favicon_url, domain, collection_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![url, title, description, image_url, favicon_url, domain, collection_id, now],
    )?;

    let bookmark_id: i64 = conn.query_row(
        "SELECT id FROM bookmarks WHERE url = ?1",
        params![url],
        |r| r.get(0),
    )?;

    if let Some(tag_list) = tags {
        for tag_name in tag_list {
            let clean = tag_name.trim().to_lowercase();
            if !clean.is_empty() {
                conn.execute(
                    "INSERT INTO tags (name, created_at) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                    params![clean, now],
                )?;
                let tag_id: i64 =
                    conn.query_row("SELECT id FROM tags WHERE name = ?1", params![clean], |r| {
                        r.get(0)
                    })?;
                conn.execute(
                    "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                    params![bookmark_id, tag_id],
                )?;
            }
        }
    }

    get_bookmark_by_id(conn, bookmark_id)
}

pub fn get_bookmark_by_id(conn: &Connection, id: i64) -> Result<Bookmark> {
    let mut stmt = conn.prepare(
        "SELECT id, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, created_at, updated_at, revision
         FROM bookmarks WHERE id = ?1",
    )?;

    let mut b = stmt.query_row(params![id], |row| {
        let fav_int: i32 = row.get(8)?;
        Ok(Bookmark {
            id: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            image_url: row.get(4)?,
            favicon_url: row.get(5)?,
            domain: row.get(6)?,
            notes: row.get(7)?,
            is_favorite: fav_int != 0,
            collection_id: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            tags: None,
            revision: row.get(12)?,
        })
    })?;

    b.tags = Some(get_tags_for_bookmark(conn, b.id)?);
    Ok(b)
}

pub fn get_tags_for_bookmark(conn: &Connection, bookmark_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t
         JOIN bookmark_tags bt ON t.id = bt.tag_id
         WHERE bt.bookmark_id = ?1",
    )?;
    let rows = stmt.query_map(params![bookmark_id], |row| row.get(0))?;
    let mut tags = Vec::new();
    for r in rows {
        tags.push(r?);
    }
    Ok(tags)
}

pub fn get_bookmarks(
    conn: &Connection,
    search: Option<String>,
    collection_id: Option<i64>,
    tag: Option<String>,
    domain: Option<String>,
    only_favorites: bool,
) -> Result<Vec<Bookmark>> {
    let mut query = String::from(
        "SELECT DISTINCT b.id, b.url, b.title, b.description, b.image_url, b.favicon_url, b.domain, b.notes, b.is_favorite, b.collection_id, b.created_at, b.updated_at, b.revision
         FROM bookmarks b
         LEFT JOIN bookmark_tags bt ON b.id = bt.bookmark_id
         LEFT JOIN tags t ON bt.tag_id = t.id
         WHERE 1=1",
    );

    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    if only_favorites {
        query.push_str(" AND b.is_favorite = 1");
    }

    if let Some(col_id) = collection_id {
        query.push_str(" AND b.collection_id = ?");
        params_vec.push(col_id.into());
    }

    if let Some(ref d) = domain {
        query.push_str(" AND b.domain = ?");
        params_vec.push(d.clone().into());
    }

    if let Some(ref t) = tag {
        query.push_str(" AND t.name = ?");
        params_vec.push(t.clone().into());
    }

    query.push_str(" ORDER BY b.created_at DESC, b.id DESC");

    let mut stmt = conn.prepare(&query)?;
    let params_slice: Vec<&dyn rusqlite::types::ToSql> = params_vec
        .iter()
        .map(|p| p as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(&params_slice[..], |row| {
        let fav_int: i32 = row.get(8)?;
        Ok(Bookmark {
            id: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            image_url: row.get(4)?,
            favicon_url: row.get(5)?,
            domain: row.get(6)?,
            notes: row.get(7)?,
            is_favorite: fav_int != 0,
            collection_id: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            tags: None,
            revision: row.get(12)?,
        })
    })?;

    let mut bookmarks = Vec::new();
    for b_res in rows {
        let mut b = b_res?;
        b.tags = Some(get_tags_for_bookmark(conn, b.id)?);
        if let Some(ref search) = search {
            let haystack = format!(
                "{} {} {} {} {} {}",
                b.title,
                b.url,
                b.domain,
                b.notes.as_deref().unwrap_or(""),
                b.description.as_deref().unwrap_or(""),
                b.tags.as_ref().map(|t| t.join(" ")).unwrap_or_default()
            )
            .to_lowercase();
            if !haystack.contains(&search.to_lowercase()) {
                continue;
            }
        }
        bookmarks.push(b);
    }

    Ok(bookmarks)
}

pub fn update_bookmark(
    conn: &Connection,
    id: i64,
    title: Option<String>,
    notes: Option<String>,
    is_favorite: Option<bool>,
    collection_id: Option<Option<i64>>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark> {
    let tx = conn.unchecked_transaction()?;
    let conn = &*tx;
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(t) = title {
        conn.execute(
            "UPDATE bookmarks SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![t, now, id],
        )?;
    }
    if let Some(n) = notes {
        conn.execute(
            "UPDATE bookmarks SET notes = ?1, updated_at = ?2 WHERE id = ?3",
            params![n, now, id],
        )?;
    }
    if let Some(f) = is_favorite {
        conn.execute(
            "UPDATE bookmarks SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![if f { 1 } else { 0 }, now, id],
        )?;
    }
    if let Some(c_opt) = collection_id {
        conn.execute(
            "UPDATE bookmarks SET collection_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![c_opt, now, id],
        )?;
    }

    if let Some(tag_list) = tags {
        // clear old tags
        conn.execute(
            "DELETE FROM bookmark_tags WHERE bookmark_id = ?1",
            params![id],
        )?;
        for tag_name in tag_list {
            let clean = tag_name.trim().to_lowercase();
            if !clean.is_empty() {
                conn.execute(
                    "INSERT INTO tags (name, created_at) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                    params![clean, now],
                )?;
                let tag_id: i64 =
                    conn.query_row("SELECT id FROM tags WHERE name = ?1", params![clean], |r| {
                        r.get(0)
                    })?;
                conn.execute(
                    "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                    params![id, tag_id],
                )?;
            }
        }
    }

    conn.execute(
        "UPDATE bookmarks SET revision=revision+1,updated_at=?1 WHERE id=?2",
        params![now, id],
    )?;
    let updated = get_bookmark_by_id(conn, id)?;
    tx.commit()?;
    Ok(updated)
}

pub fn enrich_bookmark(
    conn: &Connection,
    id: i64,
    initial_revision: i64,
    meta: &crate::metadata::PageMetadata,
) -> Result<Option<Bookmark>> {
    let changed = conn.execute("UPDATE bookmarks SET
        title=CASE WHEN revision=?1 THEN COALESCE(?2,title) ELSE title END,
        description=COALESCE(?3,description),image_url=COALESCE(?4,image_url),favicon_url=COALESCE(?5,favicon_url),
        revision=revision+1,updated_at=?6 WHERE id=?7",
        params![initial_revision,meta.title,meta.description,meta.image_url,meta.favicon_url,chrono::Utc::now().to_rfc3339(),id])?;
    if changed == 0 {
        Ok(None)
    } else {
        get_bookmark_by_id(conn, id).map(Some)
    }
}

pub fn delete_bookmark(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_collections(conn: &Connection) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.color, c.icon, c.created_at, COUNT(b.id) as count
         FROM collections c
         LEFT JOIN bookmarks b ON c.id = b.collection_id
         GROUP BY c.id
         ORDER BY c.name ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Collection {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            icon: row.get(3)?,
            created_at: row.get(4)?,
            count: Some(row.get(5)?),
        })
    })?;

    let mut cols = Vec::new();
    for r in rows {
        cols.push(r?);
    }
    Ok(cols)
}

pub fn create_collection(
    conn: &Connection,
    name: &str,
    color: Option<&str>,
    icon: Option<&str>,
) -> Result<Collection> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, color, icon, now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Collection {
        id,
        name: name.to_string(),
        color: color.map(|s| s.to_string()),
        icon: icon.map(|s| s.to_string()),
        count: Some(0),
        created_at: now,
    })
}

pub fn delete_collection(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, COUNT(bt.bookmark_id) as count
         FROM tags t
         JOIN bookmark_tags bt ON t.id = bt.tag_id
         GROUP BY t.id
         ORDER BY count DESC, t.name ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            count: Some(row.get(2)?),
        })
    })?;

    let mut tags = Vec::new();
    for r in rows {
        tags.push(r?);
    }
    Ok(tags)
}

pub fn get_domains(conn: &Connection) -> Result<Vec<DomainCount>> {
    let mut stmt = conn.prepare(
        "SELECT domain, COUNT(id) as count
         FROM bookmarks
         GROUP BY domain
         ORDER BY count DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(DomainCount {
            domain: row.get(0)?,
            count: row.get(1)?,
        })
    })?;

    let mut domains = Vec::new();
    for r in rows {
        domains.push(r?);
    }
    Ok(domains)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_legacy_data_and_backs_up_wal_snapshot() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("netamipin.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .unwrap();
        create_tables(&conn).unwrap();
        conn.execute("INSERT INTO bookmarks (url,title,domain,notes,is_favorite,collection_id,created_at,updated_at) VALUES ('https://example.com/legacy','Старая закладка','example.com','Личная заметка',1,1,'2020-01-01','2020-01-01')", []).unwrap();
        conn.execute(
            "INSERT INTO tags (name,created_at) VALUES ('архитектура','2020-01-01')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO bookmark_tags VALUES (1,1)", [])
            .unwrap();
        migrate(&conn, Some(&path)).unwrap();
        let bookmark = get_bookmark_by_id(&conn, 1).unwrap();
        assert_eq!(bookmark.title, "Старая закладка");
        assert_eq!(bookmark.notes.as_deref(), Some("Личная заметка"));
        assert_eq!(bookmark.collection_id, Some(1));
        assert_eq!(bookmark.tags.unwrap(), vec!["архитектура"]);
        assert!(bookmark.is_favorite);
        let token = setting(&conn, "capture_token").unwrap();
        migrate(&conn, Some(&path)).unwrap();
        assert_eq!(setting(&conn, "capture_token").unwrap(), token);
        let backup = Connection::open(directory.join("netamipin.before-v1.db")).unwrap();
        assert_eq!(
            backup
                .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            backup
                .query_row::<String, _, _>("SELECT notes FROM bookmarks WHERE id=1", [], |r| r
                    .get(0))
                .unwrap(),
            "Личная заметка"
        );
        assert_eq!(
            backup
                .query_row::<i64, _, _>("SELECT count(*) FROM bookmark_tags", [], |r| r.get(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn collection_patch_keeps_clears_and_rolls_back_on_write_error() {
        let conn = setup_test_db();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let bookmark = insert_or_update_bookmark(
            &conn,
            "https://example.com/patch",
            "Original",
            None,
            None,
            None,
            "example.com",
            Some(1),
            None,
        )
        .unwrap();
        let kept = update_bookmark(
            &conn,
            bookmark.id,
            None,
            Some("Note".into()),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(kept.collection_id, Some(1));
        let cleared =
            update_bookmark(&conn, bookmark.id, None, None, None, Some(None), None).unwrap();
        assert_eq!(cleared.collection_id, None);
        assert!(update_bookmark(
            &conn,
            bookmark.id,
            Some("Must roll back".into()),
            None,
            None,
            Some(Some(9999)),
            None
        )
        .is_err());
        let after = get_bookmark_by_id(&conn, bookmark.id).unwrap();
        assert_eq!(after.title, "Original");
        assert_eq!(after.revision, cleared.revision);
    }

    #[test]
    fn unicode_search_and_counts_are_independent_of_results() {
        let conn = setup_test_db();
        let bookmark = insert_or_update_bookmark(
            &conn,
            "https://example.com/search",
            "Архитектура и свет",
            None,
            None,
            None,
            "example.com",
            None,
            None,
        )
        .unwrap();
        update_bookmark(&conn, bookmark.id, None, None, Some(true), None, None).unwrap();
        assert_eq!(
            get_bookmarks(&conn, Some("АРХИТЕКТУРА".into()), None, None, None, false)
                .unwrap()
                .len(),
            1
        );
        assert!(
            get_bookmarks(&conn, Some("Ничего".into()), None, None, None, false)
                .unwrap()
                .is_empty()
        );
        assert_eq!(get_counts(&conn).unwrap().total, 1);
        assert_eq!(get_counts(&conn).unwrap().favorites, 1);
    }

    #[test]
    fn equal_timestamps_have_deterministic_order() {
        let conn = setup_test_db();
        let first = insert_or_update_bookmark(
            &conn,
            "https://example.com/1",
            "One",
            None,
            None,
            None,
            "example.com",
            None,
            None,
        )
        .unwrap();
        let second = insert_or_update_bookmark(
            &conn,
            "https://example.com/2",
            "Two",
            None,
            None,
            None,
            "example.com",
            None,
            None,
        )
        .unwrap();
        conn.execute("UPDATE bookmarks SET created_at='2020-01-01'", [])
            .unwrap();
        update_bookmark(
            &conn,
            first.id,
            Some("Edited".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let rows = get_bookmarks(&conn, None, None, None, None, false).unwrap();
        assert_eq!(
            rows.iter().map(|b| b.id).collect::<Vec<_>>(),
            vec![second.id, first.id]
        );
    }

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        migrate(&conn, None).unwrap();
        conn
    }

    #[test]
    fn test_crud_bookmarks() {
        let conn = setup_test_db();
        let tags = vec!["rust".to_string(), "tauri".to_string()];

        // Insert
        let bm = insert_or_update_bookmark(
            &conn,
            "https://tauri.app",
            "Tauri Desktop",
            Some("Awesome framework"),
            Some("https://tauri.app/og.png"),
            Some("https://tauri.app/favicon.ico"),
            "tauri.app",
            None,
            Some(&tags),
        )
        .unwrap();

        assert_eq!(bm.url, "https://tauri.app");
        assert_eq!(bm.title, "Tauri Desktop");
        assert_eq!(bm.domain, "tauri.app");
        assert_eq!(bm.tags.unwrap().len(), 2);

        // Query
        let list = get_bookmarks(&conn, None, None, None, None, false).unwrap();
        assert_eq!(list.len(), 1);

        // Update
        let updated = update_bookmark(
            &conn,
            bm.id,
            Some("Updated Title".to_string()),
            Some("Note here".to_string()),
            Some(true),
            None,
            None,
        )
        .unwrap();
        assert_eq!(updated.title, "Updated Title");
        assert!(updated.is_favorite);

        // Delete
        delete_bookmark(&conn, bm.id).unwrap();
        let empty = get_bookmarks(&conn, None, None, None, None, false).unwrap();
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn test_collections_and_domains() {
        let conn = setup_test_db();
        let col = create_collection(&conn, "Книги", Some("#10b981"), None).unwrap();
        assert_eq!(col.name, "Книги");

        let cols = get_collections(&conn).unwrap();
        assert!(cols.iter().any(|c| c.name == "Книги"));

        // Insert 2 bookmarks for domain grouping
        insert_or_update_bookmark(
            &conn,
            "https://github.com/1",
            "GH 1",
            None,
            None,
            None,
            "github.com",
            Some(col.id),
            None,
        )
        .unwrap();
        insert_or_update_bookmark(
            &conn,
            "https://github.com/2",
            "GH 2",
            None,
            None,
            None,
            "github.com",
            Some(col.id),
            None,
        )
        .unwrap();

        let domains = get_domains(&conn).unwrap();
        let gh = domains.iter().find(|d| d.domain == "github.com").unwrap();
        assert_eq!(gh.count, 2);
    }
}
