use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Mutex};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DomainCount {
    pub domain: String,
    pub count: i64,
}

/// The open library. Opening, checks and migrations live in `library.rs`.
pub struct DbState {
    pub conn: Mutex<Connection>,
    /// Read by the close handler on the main thread, which must never wait for the database.
    pub close_to_tray: AtomicBool,
}

impl DbState {
    pub fn new(conn: Connection) -> Self {
        let close_to_tray = setting(&conn, "close_to_tray").map_or(true, |v| v == "true");
        DbState {
            conn: Mutex::new(conn),
            close_to_tray: AtomicBool::new(close_to_tray),
        }
    }
}

/// UTC with milliseconds, the only time format of the library: as text it
/// sorts the same way as in time (Р-10, point 7).
pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Lower-case UUIDv7: the identity of a record across devices (Р-4).
pub fn new_uid() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Where a bookmark was saved from; `NULL` in the database means before v2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    App,
    Chrome,
    Edge,
    Firefox,
    Extension,
    Bookmarklet,
    Import,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::App => "app",
            Source::Chrome => "chrome",
            Source::Edge => "edge",
            Source::Firefox => "firefox",
            Source::Extension => "extension",
            Source::Bookmarklet => "bookmarklet",
            Source::Import => "import",
        }
    }

    /// The browser named by the extension (NP-016). An unknown or missing name
    /// still saves the link, as "extension".
    pub fn from_extension(name: Option<&str>) -> Self {
        match name {
            Some("chrome") => Source::Chrome,
            Some("edge") => Source::Edge,
            Some("firefox") => Source::Firefox,
            _ => Source::Extension,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
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

pub fn db_path() -> PathBuf {
    if let Some(directory) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(directory).join(DB_FILE);
    }
    match dirs::data_dir() {
        Some(data_dir) => data_dir.join("Netami Pin").join(DB_FILE),
        None => PathBuf::from(DB_FILE),
    }
}

fn tag_id(conn: &Connection, name: &str, now: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING",
        params![new_uid(), name, now],
    )?;
    conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
}

fn link_tags(conn: &Connection, bookmark_id: i64, tags: &[String], now: &str) -> Result<()> {
    for tag_name in tags {
        let clean = tag_name.trim().to_lowercase();
        if !clean.is_empty() {
            let tag_id = tag_id(conn, &clean, now)?;
            conn.execute(
                "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                params![bookmark_id, tag_id],
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
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
    source: Source,
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
    let now = now();
    // New links wait in the inbox; an import goes straight to the library (Р-10).
    let triaged_at = (source == Source::Import).then(|| now.clone());

    conn.execute(
        "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, collection_id, source, created_at, updated_at, triaged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
        params![new_uid(), url, title, description, image_url, favicon_url, domain, collection_id, source.as_str(), now, triaged_at],
    )?;
    let bookmark_id = conn.last_insert_rowid();
    if let Some(tag_list) = tags {
        link_tags(conn, bookmark_id, tag_list, &now)?;
    }

    get_bookmark_by_id(conn, bookmark_id)
}

pub fn get_bookmark_by_id(conn: &Connection, id: i64) -> Result<Bookmark> {
    let mut stmt = conn.prepare(
        "SELECT id, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, created_at, updated_at, revision
         FROM bookmarks WHERE id = ?1",
    )?;

    let mut b = stmt.query_row(params![id], bookmark_row)?;
    attach_tags(conn, std::slice::from_mut(&mut b))?;
    Ok(b)
}

/// What the list shows: search, filters and the page to read.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct BookmarkQuery {
    #[ts(optional)]
    pub search: Option<String>,
    #[ts(optional)]
    pub collection_id: Option<i64>,
    #[ts(optional)]
    pub tag: Option<String>,
    #[ts(optional)]
    pub domain: Option<String>,
    #[serde(default)]
    pub only_favorites: bool,
    /// Only this bookmark: whether a changed one still belongs to the list.
    #[ts(optional)]
    pub id: Option<i64>,
    /// Read after this bookmark; none for the first page.
    #[ts(optional)]
    pub after: Option<PageCursor>,
    /// Bookmarks per page: 100 by default, at most 1000.
    #[ts(optional)]
    pub limit: Option<u32>,
    /// Times in the stored format, for example the starts of today and
    /// yesterday in the user's time zone. The first page counts how many
    /// matches were saved at or after each: the list's date groups (NP-012).
    #[ts(optional)]
    pub since: Option<Vec<String>>,
}

/// A position in the order `created_at DESC, id DESC`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PageCursor {
    pub created_at: String,
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BookmarkPage {
    pub items: Vec<Bookmark>,
    /// Every bookmark that matches, not only this page. Counted for the
    /// first page only: the next ones would repeat the same work.
    pub total: Option<i64>,
    /// Where the next page starts; none after the last one.
    pub next: Option<PageCursor>,
    /// For each of `since`, the matches saved at or after it; first page only.
    pub since_counts: Option<Vec<i64>>,
}

pub const PAGE_SIZE: u32 = 100;
const MAX_PAGE_SIZE: u32 = 1_000;
/// A trigram index cannot look up shorter terms.
const TRIGRAM: usize = 3;

/// «ё» as «е», as the index stores it (schema 2). Case is left to the index:
/// its tokenizer folds a query word exactly as it folded the text.
fn without_yo(text: &str) -> String {
    text.replace('ё', "е").replace('Ё', "Е")
}

/// How short words compare, where the index cannot help: lower case one
/// character at a time, like the trigram tokenizer (so no final-sigma rule
/// of `str::to_lowercase`), «ё» as «е».
pub fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'ё' => 'е',
            'ς' => 'σ',
            c => c,
        })
        .collect()
}

/// A search word prepared for [`Needle::found_in`], which runs for every bookmark.
enum Needle {
    /// Every spelling that folds to the word: «ру» is «ру», «Ру», «рУ», «РУ».
    /// Plain substring search over them is much faster than folding the text.
    Spellings(Vec<String>),
    /// Characters whose case does not map one to one: fold the text.
    Folded(String),
}

impl Needle {
    /// More spellings than this, and folding the text is cheaper.
    const MAX_SPELLINGS: usize = 16;

    fn new(word: &str) -> Self {
        let folded = fold(word);
        let mut spellings = vec![String::new()];
        for c in folded.chars() {
            let mut forms = vec![c];
            let mut upper = c.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(u), None) if u != c && u.to_lowercase().eq([c]) => forms.push(u),
                (Some(u), None) if u == c => {}
                _ => return Needle::Folded(folded),
            }
            // Letters `fold` merges with another one.
            match c {
                'е' => forms.extend(['ё', 'Ё']),
                'σ' => forms.push('ς'),
                _ => {}
            }
            if spellings.len() * forms.len() > Self::MAX_SPELLINGS {
                return Needle::Folded(folded);
            }
            spellings = spellings
                .iter()
                .flat_map(|s| forms.iter().map(move |f| format!("{s}{f}")))
                .collect();
        }
        Needle::Spellings(spellings)
    }

    fn found_in(&self, text: &str) -> bool {
        match self {
            Needle::Spellings(spellings) => spellings.iter().any(|s| text.contains(s.as_str())),
            Needle::Folded(word) => fold(text).contains(word.as_str()),
        }
    }
}

/// SQL functions the queries use; set on every connection in `library::configure`.
/// `np_contains(word, field…)`: the word, folded, is in one of the fields, folded.
pub fn register_functions(conn: &Connection) -> Result<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::ValueRef;
    conn.create_scalar_function(
        "np_contains",
        -1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            // Prepared once per query, not once per row.
            let needle = ctx.get_or_create_aux(0, |word| -> Result<Needle> {
                Ok(Needle::new(word.as_str()?))
            })?;
            for i in 1..ctx.len() {
                if let ValueRef::Text(bytes) = ctx.get_raw(i) {
                    let text = std::str::from_utf8(bytes)
                        .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
                    if needle.found_in(text) {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        },
    )
}

/// The query as words: each must appear somewhere in the bookmark, in any
/// order (NP-011). Long words go to the index, short ones are checked on
/// the rows the index has left.
fn search_terms(search: Option<&str>) -> (Option<String>, Vec<String>) {
    let mut indexed = Vec::new();
    let mut short = Vec::new();
    for word in search.unwrap_or("").split_whitespace() {
        if word.chars().count() >= TRIGRAM {
            indexed.push(format!("\"{}\"", without_yo(word).replace('"', "\"\"")));
        } else {
            short.push(word.to_string());
        }
    }
    ((!indexed.is_empty()).then(|| indexed.join(" AND ")), short)
}

/// Bookmarks whose tags contain a short word; tags are few, each is checked once.
const SHORT_IN_TAGS: &str = "SELECT bt.bookmark_id FROM bookmark_tags bt
    JOIN tags t ON t.id = bt.tag_id WHERE np_contains(?, t.name)";
/// A short word in the other fields of the index.
const SHORT_IN_FIELDS: &str = "np_contains(?, b.title, b.url, b.domain, b.description, b.notes)";

fn bookmark_row(row: &rusqlite::Row) -> Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        image_url: row.get(4)?,
        favicon_url: row.get(5)?,
        domain: row.get(6)?,
        notes: row.get(7)?,
        is_favorite: row.get::<_, i32>(8)? != 0,
        collection_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        tags: None,
        revision: row.get(12)?,
    })
}

/// One page of the list, newest first, with the total for the whole query.
pub fn get_bookmarks(conn: &Connection, query: &BookmarkQuery) -> Result<BookmarkPage> {
    use rusqlite::types::Value;
    let mut filter = String::from(" WHERE 1=1");
    let mut values: Vec<Value> = Vec::new();
    if query.only_favorites {
        filter.push_str(" AND b.is_favorite = 1");
    }
    if let Some(id) = query.id {
        filter.push_str(" AND b.id = ?");
        values.push(id.into());
    }
    if let Some(collection) = query.collection_id {
        filter.push_str(" AND b.collection_id = ?");
        values.push(collection.into());
    }
    if let Some(domain) = &query.domain {
        filter.push_str(" AND b.domain = ?");
        values.push(domain.clone().into());
    }
    if let Some(tag) = &query.tag {
        filter.push_str(
            " AND EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
               WHERE bt.bookmark_id = b.id AND t.name = ?)",
        );
        values.push(tag.clone().into());
    }
    let (indexed, short) = search_terms(query.search.as_deref());
    let narrowed = indexed.is_some();
    if let Some(expression) = indexed {
        filter.push_str(
            " AND b.id IN (SELECT rowid FROM bookmarks_search WHERE bookmarks_search MATCH ?)",
        );
        values.push(expression.into());
    }
    for word in short {
        if narrowed {
            // Checked only on the rows the index has left.
            filter.push_str(&format!(
                " AND ({SHORT_IN_FIELDS} OR b.id IN ({SHORT_IN_TAGS}))"
            ));
        } else {
            // Without the index: one pass in table order collects the ids,
            // instead of reading rows one by one in list order.
            filter.push_str(&format!(
                " AND b.id IN (SELECT b.id FROM bookmarks b WHERE {SHORT_IN_FIELDS} UNION {SHORT_IN_TAGS})"
            ));
        }
        values.extend([word.clone().into(), word.into()]);
    }

    // The total and the date-group counts in one pass, first page only.
    let (total, since_counts) = match query.after {
        None => {
            let since = query.since.as_deref().unwrap_or_default();
            let columns: String = since
                .iter()
                .map(|_| ", COALESCE(sum(b.created_at >= ?), 0)")
                .collect();
            let mut counted: Vec<Value> = since.iter().map(|s| s.clone().into()).collect();
            counted.extend(values.iter().cloned());
            let row = conn.query_row(
                &format!("SELECT count(*){columns} FROM bookmarks b{filter}"),
                rusqlite::params_from_iter(&counted),
                |r| {
                    (0..=since.len())
                        .map(|i| r.get::<_, i64>(i))
                        .collect::<Result<Vec<_>>>()
                },
            )?;
            let total = row[0];
            (Some(total), query.since.as_ref().map(|_| row[1..].to_vec()))
        }
        Some(_) => (None, None),
    };

    let mut page_filter = filter;
    if let Some(after) = &query.after {
        // A row value, so the page starts by a seek in `idx_bookmarks_order`.
        page_filter.push_str(" AND (b.created_at, b.id) < (?, ?)");
        values.extend([after.created_at.clone().into(), after.id.into()]);
    }
    let limit = query.limit.unwrap_or(PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    // One more row than asked tells whether a next page exists.
    values.push(i64::from(limit + 1).into());
    let mut items = conn
        .prepare(&format!(
            "SELECT b.id, b.url, b.title, b.description, b.image_url, b.favicon_url, b.domain, b.notes, b.is_favorite, b.collection_id, b.created_at, b.updated_at, b.revision
             FROM bookmarks b{page_filter}
             ORDER BY b.created_at DESC, b.id DESC LIMIT ?"
        ))?
        .query_map(rusqlite::params_from_iter(&values), bookmark_row)?
        .collect::<Result<Vec<_>>>()?;
    let next = (items.len() > limit as usize).then(|| {
        items.truncate(limit as usize);
        let last = &items[items.len() - 1];
        PageCursor {
            created_at: last.created_at.clone(),
            id: last.id,
        }
    });
    attach_tags(conn, &mut items)?;
    Ok(BookmarkPage {
        items,
        total,
        next,
        since_counts,
    })
}

/// Tags of a whole page in one query.
fn attach_tags(conn: &Connection, bookmarks: &mut [Bookmark]) -> Result<()> {
    let ids = serde_json::to_string(&bookmarks.iter().map(|b| b.id).collect::<Vec<_>>())
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let mut tags = std::collections::HashMap::<i64, Vec<String>>::new();
    let mut statement = conn.prepare(
        "SELECT bt.bookmark_id, t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
         WHERE bt.bookmark_id IN (SELECT value FROM json_each(?1))
         ORDER BY bt.bookmark_id, bt.tag_id",
    )?;
    let rows = statement.query_map([ids], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?)))?;
    for row in rows {
        let (id, name) = row?;
        tags.entry(id).or_default().push(name);
    }
    for bookmark in bookmarks {
        bookmark.tags = Some(tags.remove(&bookmark.id).unwrap_or_default());
    }
    Ok(())
}

/// Builds the search index anew from the library, in one transaction.
/// Returns the number of bookmarks indexed.
pub fn rebuild_search(conn: &Connection) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "INSERT INTO bookmarks_search (bookmarks_search) VALUES ('delete-all');
         INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
         SELECT * FROM bookmarks_search_source;",
    )?;
    let count = tx.query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))?;
    tx.commit()?;
    Ok(count)
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
    let now = now();

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
        link_tags(conn, id, &tag_list, &now)?;
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
        params![initial_revision,meta.title,meta.description,meta.image_url,meta.favicon_url,now(),id])?;
    if changed == 0 {
        Ok(None)
    } else {
        get_bookmark_by_id(conn, id).map(Some)
    }
}

/// Until the trash (NP-022) deletion is final; the tombstone keeps the `uid`
/// so a future sync can delete the record on other devices.
pub fn delete_bookmark(conn: &Connection, id: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let now = now();
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
         SELECT uid, 'bookmark', ?1, ?1 FROM bookmarks WHERE id = ?2",
        params![now, id],
    )?;
    tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    tx.commit()
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
    let now = now();
    conn.execute(
        "INSERT INTO collections (uid, name, color, icon, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_uid(), name, color, icon, now],
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

/// Bookmarks stay in the library without a collection.
pub fn delete_collection(conn: &Connection, id: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let now = now();
    tx.execute(
        "UPDATE bookmarks SET collection_id=NULL,revision=revision+1,updated_at=?1 WHERE collection_id=?2",
        params![now, id],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
         SELECT uid, 'collection', ?1, ?1 FROM collections WHERE id = ?2",
        params![now, id],
    )?;
    tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    tx.commit()
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
            Source::App,
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
            Source::App,
        )
        .unwrap();
        update_bookmark(&conn, bookmark.id, None, None, Some(true), None, None).unwrap();
        assert_eq!(found(&conn, "АРХИТЕКТУРА"), [bookmark.id]);
        assert!(found(&conn, "Ничего").is_empty());
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
            Source::App,
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
            Source::App,
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
        let rows = everything(&conn);
        assert_eq!(
            rows.iter().map(|b| b.id).collect::<Vec<_>>(),
            vec![second.id, first.id]
        );
    }

    fn setup_test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    /// The whole list in one page.
    fn everything(conn: &Connection) -> Vec<Bookmark> {
        let query = BookmarkQuery {
            limit: Some(MAX_PAGE_SIZE),
            ..Default::default()
        };
        get_bookmarks(conn, &query).unwrap().items
    }

    /// Ids found by `search` on every page, in list order; the total must agree.
    fn found(conn: &Connection, search: &str) -> Vec<i64> {
        let mut query = BookmarkQuery {
            search: Some(search.into()),
            limit: Some(MAX_PAGE_SIZE),
            ..Default::default()
        };
        let mut ids = Vec::new();
        let mut total = None;
        loop {
            let page = get_bookmarks(conn, &query).unwrap();
            // Counted on the first page only.
            assert_eq!(page.total.is_some(), query.after.is_none());
            total = total.or(page.total);
            ids.extend(page.items.iter().map(|b| b.id));
            match page.next {
                Some(next) => query.after = Some(next),
                None => {
                    assert_eq!(total, Some(ids.len() as i64), "{search}");
                    return ids;
                }
            }
        }
    }

    fn add(conn: &Connection, url: &str, title: &str, tags: &[&str]) -> Bookmark {
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        insert_or_update_bookmark(
            conn,
            url,
            title,
            None,
            None,
            None,
            url.split('/').nth(2).unwrap(),
            None,
            Some(&tags),
            Source::App,
        )
        .unwrap()
    }

    #[test]
    fn search_folds_case_and_yo_in_every_field() {
        let conn = setup_test_db();
        let tree = add(&conn, "https://example.com/a", "Новогодняя Ёлка", &[]);
        let hedgehog = add(&conn, "https://пример.рф/ёж", "Без названия", &["Ёжики"]);
        let noted = add(&conn, "https://example.org/b", "Заметка", &[]);
        update_bookmark(
            &conn,
            noted.id,
            None,
            Some("Про ЁЖИКОВ и ёлки".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let described = add(&conn, "https://example.net/c", "Описание", &[]);
        conn.execute(
            "UPDATE bookmarks SET description = 'Елочные игрушки' WHERE id = ?1",
            [described.id],
        )
        .unwrap();

        assert_eq!(found(&conn, "елка"), [tree.id]);
        assert_eq!(found(&conn, "ЁЛКА"), [tree.id]);
        assert_eq!(found(&conn, "ёлоч"), [described.id]);
        assert_eq!(
            found(&conn, "ежик"),
            [noted.id, hedgehog.id],
            "tags and notes"
        );
        assert_eq!(found(&conn, "ПРИМЕР.РФ"), [hedgehog.id], "domain");
        assert_eq!(found(&conn, "example.org/b"), [noted.id], "url");
        assert!(found(&conn, "ёлкин").is_empty());
    }

    #[test]
    fn every_word_must_match_in_any_order_and_field() {
        let conn = setup_test_db();
        let guide = add(
            &conn,
            "https://doc.rust-lang.org/book",
            "Руководство",
            &["rust"],
        );
        let other = add(&conn, "https://example.com/guide", "Руководство по Go", &[]);
        assert_eq!(found(&conn, "руководство rust"), [guide.id]);
        assert_eq!(found(&conn, "  RUST   руковод "), [guide.id]);
        assert_eq!(found(&conn, "руководство"), [other.id, guide.id]);
        // Words shorter than a trigram are still found, alone and with others.
        assert_eq!(found(&conn, "go"), [other.id]);
        assert_eq!(found(&conn, "go руководство"), [other.id]);
        assert_eq!(found(&conn, "о"), [other.id, guide.id]);
        assert!(found(&conn, "go rust").is_empty());
        // Query syntax is text, not an FTS5 expression.
        assert!(found(&conn, "\"rust\" OR NOT").is_empty());
        assert_eq!(found(&conn, "rust*"), Vec::<i64>::new());
        assert_eq!(found(&conn, ""), [other.id, guide.id]);
    }

    #[test]
    fn query_words_fold_as_the_index_folds_the_text() {
        let conn = setup_test_db();
        let street = add(&conn, "https://example.gr/a", "ΟΔΟΣ Ερμού", &[]);
        let city = add(&conn, "https://example.tr/b", "İstanbul rehberi", &[]);
        let sea = add(&conn, "https://example.gr/c", "Νησος", &[]);
        assert_eq!(found(&conn, "οδος"), [street.id]);
        assert_eq!(found(&conn, "ΟΔΟΣ"), [street.id]);
        assert_eq!(found(&conn, "İSTANBUL"), [city.id]);
        assert_eq!(found(&conn, "İstanbul"), [city.id]);
        // Short words: final sigma is the same letter.
        assert_eq!(found(&conn, "ος"), [sea.id, street.id]);
        assert_eq!(found(&conn, "ΟΣ"), [sea.id, street.id]);
    }

    #[test]
    fn id_asks_whether_one_bookmark_belongs_to_the_list() {
        let conn = setup_test_db();
        let rust = add(&conn, "https://example.com/r", "Rust guide", &[]);
        let other = add(&conn, "https://example.com/o", "Other", &[]);
        let matches = |id: i64, search: &str| {
            let query = BookmarkQuery {
                id: Some(id),
                search: Some(search.into()),
                ..Default::default()
            };
            get_bookmarks(&conn, &query).unwrap().total == Some(1)
        };
        assert!(matches(rust.id, "guide"));
        assert!(!matches(other.id, "guide"));
        assert!(!matches(rust.id, "nothing"));
    }

    #[test]
    fn index_follows_every_write() {
        let conn = setup_test_db();
        let b = add(&conn, "https://example.com/x", "Первое", &["alpha"]);
        update_bookmark(&conn, b.id, Some("Второе".into()), None, None, None, None).unwrap();
        assert!(found(&conn, "первое").is_empty());
        assert_eq!(found(&conn, "второе"), [b.id]);

        update_bookmark(
            &conn,
            b.id,
            None,
            None,
            None,
            None,
            Some(vec!["beta".into()]),
        )
        .unwrap();
        assert!(found(&conn, "alpha").is_empty());
        assert_eq!(found(&conn, "beta"), [b.id]);

        let meta = crate::metadata::PageMetadata {
            title: Some("Из метаданных".into()),
            description: Some("Описание страницы".into()),
            image_url: None,
            favicon_url: None,
            domain: "example.com".into(),
        };
        let revision = get_bookmark_by_id(&conn, b.id).unwrap().revision;
        enrich_bookmark(&conn, b.id, revision, &meta).unwrap();
        assert_eq!(found(&conn, "метаданных"), [b.id]);
        assert_eq!(found(&conn, "страницы"), [b.id]);

        conn.execute("UPDATE tags SET name = 'gamma' WHERE name = 'beta'", [])
            .unwrap();
        assert_eq!(found(&conn, "gamma"), [b.id]);
        conn.execute("DELETE FROM tags WHERE name = 'gamma'", [])
            .unwrap();
        assert!(found(&conn, "gamma").is_empty());
        assert_eq!(found(&conn, "метаданных"), [b.id], "the rest stays indexed");

        delete_bookmark(&conn, b.id).unwrap();
        assert!(found(&conn, "метаданных").is_empty());
        let indexed: i64 = conn
            .query_row("SELECT count(*) FROM bookmarks_search", [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 0);
    }

    #[test]
    fn a_failed_write_leaves_the_index_as_it_was() {
        let conn = setup_test_db();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let b = add(&conn, "https://example.com/x", "Исходное", &[]);
        assert!(update_bookmark(
            &conn,
            b.id,
            Some("Откатится".into()),
            None,
            None,
            Some(Some(9999)),
            None
        )
        .is_err());
        assert_eq!(found(&conn, "исходное"), [b.id]);
        assert!(found(&conn, "откатится").is_empty());
    }

    #[test]
    fn pages_cover_the_list_once_in_order() {
        let conn = setup_test_db();
        let collection = create_collection(&conn, "Полка", None, None).unwrap();
        for i in 0..250 {
            let b = add(
                &conn,
                &format!("https://example.com/{i}"),
                &format!("Запись {i}"),
                &[],
            );
            if i % 2 == 0 {
                update_bookmark(
                    &conn,
                    b.id,
                    None,
                    None,
                    None,
                    Some(Some(collection.id)),
                    None,
                )
                .unwrap();
            }
        }
        // Equal times: the order and the cursor rely on the id.
        conn.execute(
            "UPDATE bookmarks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id % 3 = 0",
            [],
        )
        .unwrap();
        let read_all = |base: BookmarkQuery| {
            let mut seen = Vec::new();
            let mut total = 0;
            let mut query = BookmarkQuery {
                limit: Some(40),
                ..base
            };
            loop {
                let page = get_bookmarks(&conn, &query).unwrap();
                assert!(page.items.len() <= 40);
                total = page.total.unwrap_or(total);
                seen.extend(page.items.iter().map(|b| (b.created_at.clone(), b.id)));
                match page.next {
                    Some(next) => query.after = Some(next),
                    None => return (seen, total),
                }
            }
        };
        let (all, total) = read_all(BookmarkQuery::default());
        assert_eq!(total, 250);
        let mut expected = all.clone();
        expected.sort_by(|a, b| b.cmp(a));
        expected.dedup();
        assert_eq!(all, expected, "newest first, no repeats");
        assert_eq!(all.len(), 250);

        let (shelf, total) = read_all(BookmarkQuery {
            collection_id: Some(collection.id),
            search: Some("запись 1".into()),
            ..Default::default()
        });
        // "запись 1" means both words: "запись" and "1".
        let expected = (0..250)
            .filter(|i| i % 2 == 0 && i.to_string().contains('1'))
            .count();
        assert_eq!((shelf.len(), total), (expected, expected as i64));
    }

    #[test]
    fn first_page_counts_matches_since_each_time() {
        let conn = setup_test_db();
        for (i, created) in [
            "2026-10-03T08:00:00.000Z",
            "2026-10-02T20:00:00.000Z",
            "2026-09-29T10:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        ]
        .iter()
        .enumerate()
        {
            let b = add(&conn, &format!("https://example.com/{i}"), "Запись", &[]);
            conn.execute(
                "UPDATE bookmarks SET created_at = ?1 WHERE id = ?2",
                params![created, b.id],
            )
            .unwrap();
        }
        let since = vec![
            "2026-10-03T00:00:00.000Z".to_string(),
            "2026-10-02T00:00:00.000Z".to_string(),
            "2026-09-26T00:00:00.000Z".to_string(),
        ];
        let query = BookmarkQuery {
            since: Some(since.clone()),
            limit: Some(2),
            ..Default::default()
        };
        let first = get_bookmarks(&conn, &query).unwrap();
        assert_eq!(first.total, Some(4));
        assert_eq!(first.since_counts, Some(vec![1, 2, 3]));
        let second = get_bookmarks(
            &conn,
            &BookmarkQuery {
                after: first.next,
                ..query.clone()
            },
        )
        .unwrap();
        assert_eq!((second.total, second.since_counts), (None, None));
        // With a filter, and nothing found.
        let none = BookmarkQuery {
            search: Some("нет-такого".into()),
            since: Some(since),
            ..Default::default()
        };
        assert_eq!(
            get_bookmarks(&conn, &none).unwrap().since_counts,
            Some(vec![0, 0, 0])
        );
        assert_eq!(
            get_bookmarks(&conn, &BookmarkQuery::default())
                .unwrap()
                .since_counts,
            None
        );
    }

    #[test]
    fn rebuild_repairs_a_lost_index() {
        let conn = setup_test_db();
        let b = add(&conn, "https://example.com/x", "Потерянное", &["тег"]);
        conn.execute(
            "INSERT INTO bookmarks_search (bookmarks_search) VALUES ('delete-all')",
            [],
        )
        .unwrap();
        assert!(found(&conn, "потерянное").is_empty());
        assert_eq!(rebuild_search(&conn).unwrap(), 1);
        assert_eq!(found(&conn, "потерянное"), [b.id]);
        assert_eq!(found(&conn, "тег"), [b.id]);
    }

    /// The search before NP-011, kept as the reference: the fields joined,
    /// lower case. Now also «ё» as «е» and every word on its own.
    fn reference(conn: &Connection, search: &str) -> Vec<i64> {
        let words: Vec<String> = fold(search).split_whitespace().map(String::from).collect();
        let mut statement = conn
            .prepare("SELECT id FROM bookmarks ORDER BY created_at DESC, id DESC")
            .unwrap();
        let ids: Vec<i64> = statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap();
        ids.into_iter()
            .filter(|id| {
                let b = get_bookmark_by_id(conn, *id).unwrap();
                let haystack = fold(&format!(
                    "{} {} {} {} {} {}",
                    b.title,
                    b.url,
                    b.domain,
                    b.notes.as_deref().unwrap_or(""),
                    b.description.as_deref().unwrap_or(""),
                    b.tags.unwrap_or_default().join(" ")
                ));
                words.iter().all(|w| haystack.contains(w.as_str()))
            })
            .collect()
    }

    #[test]
    fn migrated_library_finds_what_the_old_search_found() {
        use crate::{migrations, test_libraries as fixtures};
        let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("search-reference-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("netamipin.db");
        let conn = fixtures::fresh_at(&path, 1);
        // Words include «ёлка», domains «пример.рф»; tags, notes, descriptions vary.
        fixtures::generated(&conn, 2_000, 11);
        fixtures::finish(conn);

        let mut conn = Connection::open(&path).unwrap();
        crate::library::configure(&conn).unwrap();
        migrations::migrate(&mut conn, Some(&folder.join("backups"))).unwrap();
        assert_eq!(migrations::user_version(&conn).unwrap(), 2);
        assert!(folder.join("backups/netamipin.before-v2.db").exists());

        let queries = [
            "архитект",
            "АРХИТЕКТУРА",
            "елка",
            "Ёлка",
            "ёж",
            "rust",
            "TAURI",
            "заметка",
            "example.com",
            "пример.рф",
            "github.com/1",
            "/12",
            "12",
            "1",
            "а",
            "ё",
            "s",
            "дизайн rust",
            "rust дизайн",
            "свет поиск музыка",
            "кириллица 99",
            "нет-такого",
        ];
        for query in queries {
            assert_eq!(found(&conn, query), reference(&conn, query), "{query}");
        }
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
            Source::App,
        )
        .unwrap();

        assert_eq!(bm.url, "https://tauri.app");
        assert_eq!(bm.title, "Tauri Desktop");
        assert_eq!(bm.domain, "tauri.app");
        assert_eq!(bm.tags.unwrap().len(), 2);

        // Query
        let list = everything(&conn);
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
        let empty = everything(&conn);
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
            Source::App,
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
            Source::App,
        )
        .unwrap();

        let domains = get_domains(&conn).unwrap();
        let gh = domains.iter().find(|d| d.domain == "github.com").unwrap();
        assert_eq!(gh.count, 2);
    }
}
