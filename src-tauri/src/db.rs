use rusqlite::{params, Connection, Result};
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

        let conn = Connection::open(&db_path).expect("Failed to open SQLite database");

        // Enable WAL mode & foreign keys for high performance
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        );

        create_tables(&conn).expect("Failed to create tables");

        DbState {
            conn: Mutex::new(conn),
        }
    }
}

fn get_db_path() -> PathBuf {
    if let Some(mut data_dir) = dirs::data_dir() {
        data_dir.push("OddClicks");
        data_dir.push("oddclicks.db");
        data_dir
    } else {
        PathBuf::from("oddclicks.db")
    }
}

fn create_tables(conn: &Connection) -> Result<()> {
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
        let _ = conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Разработка", "#6366f1", "code", now],
        );
        let _ = conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Дизайн & UI", "#ec4899", "palette", now],
        );
        let _ = conn.execute(
            "INSERT INTO collections (name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
            params!["Статьи / Читать", "#10b981", "book-open", now],
        );
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
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO bookmarks (url, title, description, image_url, favicon_url, domain, collection_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(url) DO UPDATE SET
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE bookmarks.title END,
            description = COALESCE(excluded.description, bookmarks.description),
            image_url = COALESCE(excluded.image_url, bookmarks.image_url),
            favicon_url = COALESCE(excluded.favicon_url, bookmarks.favicon_url),
            updated_at = excluded.updated_at",
        params![url, title, description, image_url, favicon_url, domain, collection_id, now],
    )?;

    let bookmark_id: i64 = conn.query_row("SELECT id FROM bookmarks WHERE url = ?1", params![url], |r| r.get(0))?;

    if let Some(tag_list) = tags {
        for tag_name in tag_list {
            let clean = tag_name.trim().to_lowercase();
            if !clean.is_empty() {
                conn.execute(
                    "INSERT INTO tags (name, created_at) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                    params![clean, now],
                )?;
                let tag_id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![clean], |r| r.get(0))?;
                let _ = conn.execute(
                    "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                    params![bookmark_id, tag_id],
                );
            }
        }
    }

    get_bookmark_by_id(conn, bookmark_id)
}

pub fn get_bookmark_by_id(conn: &Connection, id: i64) -> Result<Bookmark> {
    let mut stmt = conn.prepare(
        "SELECT id, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, created_at, updated_at
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
        "SELECT DISTINCT b.id, b.url, b.title, b.description, b.image_url, b.favicon_url, b.domain, b.notes, b.is_favorite, b.collection_id, b.created_at, b.updated_at
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

    if let Some(ref s) = search {
        let pattern = format!("%{}%", s.to_lowercase());
        query.push_str(" AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(b.domain) LIKE ? OR LOWER(b.notes) LIKE ?)");
        params_vec.push(pattern.clone().into());
        params_vec.push(pattern.clone().into());
        params_vec.push(pattern.clone().into());
        params_vec.push(pattern.into());
    }

    query.push_str(" ORDER BY b.created_at DESC");

    let mut stmt = conn.prepare(&query)?;
    let params_slice: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();

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
        })
    })?;

    let mut bookmarks = Vec::new();
    for b_res in rows {
        let mut b = b_res?;
        b.tags = Some(get_tags_for_bookmark(conn, b.id)?);
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
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(t) = title {
        conn.execute("UPDATE bookmarks SET title = ?1, updated_at = ?2 WHERE id = ?3", params![t, now, id])?;
    }
    if let Some(n) = notes {
        conn.execute("UPDATE bookmarks SET notes = ?1, updated_at = ?2 WHERE id = ?3", params![n, now, id])?;
    }
    if let Some(f) = is_favorite {
        conn.execute("UPDATE bookmarks SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3", params![if f { 1 } else { 0 }, now, id])?;
    }
    if let Some(c_opt) = collection_id {
        conn.execute("UPDATE bookmarks SET collection_id = ?1, updated_at = ?2 WHERE id = ?3", params![c_opt, now, id])?;
    }

    if let Some(tag_list) = tags {
        // clear old tags
        conn.execute("DELETE FROM bookmark_tags WHERE bookmark_id = ?1", params![id])?;
        for tag_name in tag_list {
            let clean = tag_name.trim().to_lowercase();
            if !clean.is_empty() {
                conn.execute(
                    "INSERT INTO tags (name, created_at) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                    params![clean, now],
                )?;
                let tag_id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![clean], |r| r.get(0))?;
                let _ = conn.execute(
                    "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                    params![id, tag_id],
                );
            }
        }
    }

    get_bookmark_by_id(conn, id)
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

pub fn create_collection(conn: &Connection, name: &str, color: Option<&str>, icon: Option<&str>) -> Result<Collection> {
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

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
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
        ).unwrap();

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
        ).unwrap();
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
        ).unwrap();
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
        ).unwrap();

        let domains = get_domains(&conn).unwrap();
        let gh = domains.iter().find(|d| d.domain == "github.com").unwrap();
        assert_eq!(gh.count, 2);
    }
}
