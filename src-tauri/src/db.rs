use crate::journal::Journal;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
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
    /// When the bookmark was sorted; none while it waits in the inbox.
    pub triaged_at: Option<String>,
    /// When the bookmark went to the trash; none outside it (NP-022).
    pub deleted_at: Option<String>,
    /// Where it was saved from: `app`, `chrome`, `edge`, `firefox`, `safari`,
    /// `extension`, `import`, `mcp`; none for links of unknown origin. Triage shows it (NP-025).
    pub source: Option<String>,
    /// The assistant that saved it over MCP (NP-091), as triage names it:
    /// «Claude», «Claude Code», or the name the assistant gave.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// The sort keys of the title and of the site in hex (NP-114): compared
    /// as text, they order rows as «Title A–Z» and «Site A–Z» do.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_key: Option<String>,
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
    /// Where the person put it in the sidebar (NP-114); none until the first
    /// move, and for a collection made since: those follow by name.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
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
    /// Every write of the library goes through this connection, under its
    /// lock: the journal relies on it.
    pub conn: Mutex<Connection>,
    /// Commands to undo (NP-024), for this run only. Locked after `conn`.
    pub journal: Mutex<Journal>,
    /// Read by the close handler on the main thread, which must never wait for the database.
    pub close_to_tray: AtomicBool,
    /// Without a tray the first close explains that the app keeps running
    /// (NP-096); once the window has been hidden that way, closing just hides.
    pub background_explained: AtomicBool,
}

impl DbState {
    pub fn new(conn: Connection) -> Self {
        let state = DbState {
            close_to_tray: AtomicBool::new(true),
            background_explained: AtomicBool::new(false),
            conn: Mutex::new(conn),
            journal: Mutex::new(Journal::default()),
        };
        if let Ok(conn) = state.conn.lock() {
            state.reload_settings(&conn);
        }
        state
    }

    /// The settings the close handler reads, after an opening or a restore.
    pub fn reload_settings(&self, conn: &Connection) {
        let tray = setting(conn, "close_to_tray").map_or(true, |v| v == "true");
        self.close_to_tray.store(tray, Ordering::Relaxed);
        let explained = setting(conn, "background_explained").is_ok_and(|v| v == "true");
        self.background_explained.store(explained, Ordering::Relaxed);
    }
}

/// UTC with milliseconds, the only time format of the library: as text it
/// sorts the same way as in time (Р-10, point 7).
pub fn now() -> String {
    stamp(chrono::Utc::now())
}

pub fn stamp(time: chrono::DateTime<chrono::Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Lower-case UUIDv7: the identity of a record across devices (Р-4).
pub fn new_uid() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Where a bookmark was saved from; `NULL` in the database means before v2.
/// The schema also allows `bookmarklet`: the bookmarklet is gone (NP-016),
/// but a released schema step does not change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    App,
    Chrome,
    Edge,
    Firefox,
    Extension,
    Import,
    /// An AI assistant over MCP (NP-091, schema 8).
    Mcp,
    /// The Safari extension on macOS (NP-119, schema 9).
    Safari,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::App => "app",
            Source::Chrome => "chrome",
            Source::Edge => "edge",
            Source::Firefox => "firefox",
            Source::Extension => "extension",
            Source::Import => "import",
            Source::Mcp => "mcp",
            Source::Safari => "safari",
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct LibraryCounts {
    pub total: i64,
    pub favorites: i64,
    /// Bookmarks waiting for a decision (NP-021).
    pub inbox: i64,
    /// When the newest of them was saved: the inbox banner hidden before it
    /// comes back once a newer one arrives.
    pub inbox_newest: Option<String>,
    /// Of the waiting ones, those an import put there: «— 340 из импорта» (frame 24, NP-031).
    pub inbox_imported: i64,
    /// Bookmarks in the trash (NP-022); none of the others count them.
    pub trash: i64,
    /// Groups of duplicates (NP-035): the sidebar and the menu «⋯». Counted
    /// by the command, not by [`get_counts`]: schemas before 5 have no key.
    pub duplicates: i64,
    /// Links a check found broken or moved (NP-036): «Проверка ссылок N».
    /// Counted by the command too: schemas before 6 have no results.
    pub links: i64,
}

/// The trash is counted apart, every other count leaves it out. Each count
/// reads its own index (schema 7), not the table: a pass over 100 000
/// bookmarks took 27 ms, and the sidebar asks after every change.
pub fn get_counts(conn: &Connection) -> Result<LibraryCounts> {
    let live = "FROM bookmarks WHERE deleted_at IS NULL";
    let inbox = format!("{live} AND triaged_at IS NULL");
    conn.query_row(
        &format!(
            "SELECT (SELECT count(*) {live}),
                    (SELECT count(*) {live} AND is_favorite = 1),
                    (SELECT count(*) {inbox}),
                    (SELECT max(created_at) {inbox}),
                    (SELECT count(*) {inbox} AND source = 'import'),
                    (SELECT count(*) FROM bookmarks WHERE deleted_at IS NOT NULL)"
        ),
        [],
        |r| {
            Ok(LibraryCounts {
                total: r.get(0)?,
                favorites: r.get(1)?,
                inbox: r.get(2)?,
                inbox_newest: r.get(3)?,
                inbox_imported: r.get(4)?,
                trash: r.get(5)?,
                duplicates: 0,
                links: 0,
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
pub const DATA_DIR_ENV: &str = "KOONAPIN_DATA_DIR";
const DB_FILE: &str = "koonapin.db";
/// The brand's folder in the platform data folder (`dirs::data_dir`: `%APPDATA%`,
/// `$XDG_DATA_HOME`, `~/Library/Application Support`): each Koona app keeps its
/// data in its own subfolder and never touches the others (Р-56).
pub const BRAND_FOLDER: &str = "Koona";
/// The library folder in [`BRAND_FOLDER`]; the uninstaller may remove it (NP-037).
pub const DATA_FOLDER: &str = "Pin";

pub fn db_path() -> PathBuf {
    if let Some(directory) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(directory).join(DB_FILE);
    }
    match dirs::data_dir() {
        Some(data_dir) => data_dir.join(BRAND_FOLDER).join(DATA_FOLDER).join(DB_FILE),
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

pub(crate) fn link_tags(
    conn: &Connection,
    bookmark_id: i64,
    tags: &[String],
    now: &str,
) -> Result<()> {
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
        "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, collection_id, source, created_at, updated_at, triaged_at, url_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12)",
        params![new_uid(), url, title, description, image_url, favicon_url, domain, collection_id, source.as_str(), now, triaged_at, crate::dedupe::url_key(url)],
    )?;
    let bookmark_id = conn.last_insert_rowid();
    if let Some(tag_list) = tags {
        link_tags(conn, bookmark_id, tag_list, &now)?;
    }

    get_bookmark_by_id(conn, bookmark_id)
}

/// The columns [`bookmark_row`] reads, in its order.
const BOOKMARK_COLUMNS: &str = "id, url, title, description, image_url, favicon_url, domain, notes, is_favorite, collection_id, created_at, updated_at, revision, triaged_at, deleted_at, source, hex(title_key), hex(site_key), source_name";

pub fn get_bookmark_by_id(conn: &Connection, id: i64) -> Result<Bookmark> {
    let mut stmt = conn.prepare(&format!("SELECT {BOOKMARK_COLUMNS} FROM bookmarks WHERE id = ?1"))?;
    let mut b = stmt.query_row(params![id], bookmark_row)?;
    attach_tags(conn, std::slice::from_mut(&mut b))?;
    Ok(b)
}

/// Those of `ids` that exist, with their tags, in no particular order.
pub fn get_bookmarks_by_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<Bookmark>> {
    let ids = id_list(ids)?;
    let mut items = conn
        .prepare(&format!(
            "SELECT {BOOKMARK_COLUMNS} FROM bookmarks WHERE id IN (SELECT value FROM json_each(?1))"
        ))?
        .query_map([ids], bookmark_row)?
        .collect::<Result<Vec<_>>>()?;
    attach_tags(conn, &mut items)?;
    Ok(items)
}

/// The order of the list (NP-114, Р-59). The trash is always read newest
/// deletion first, whatever is chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BookmarkSort {
    /// Newest saved first: the order of the inbox and of every new library.
    #[default]
    Newest,
    Oldest,
    /// By title in the interface's language, equal titles newest first.
    Title,
    /// By site (the domain without `www.`), the links of a site newest first.
    Site,
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
    /// Only bookmarks waiting in the inbox.
    #[serde(default)]
    pub only_inbox: bool,
    /// The trash instead of the library, newest deletion first (NP-022).
    /// Every other query leaves the trash out.
    #[serde(default)]
    pub only_trash: bool,
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
    /// matches were saved (in the trash: deleted) at or after each: the
    /// list's date groups (NP-012).
    #[ts(optional)]
    pub since: Option<Vec<String>>,
    /// Newest first when none (NP-114).
    #[ts(optional)]
    pub sort: Option<BookmarkSort>,
}

impl BookmarkQuery {
    /// The order the query reads in: the trash keeps its own.
    pub fn order(&self) -> BookmarkSort {
        match self.only_trash {
            true => BookmarkSort::Newest,
            false => self.sort.unwrap_or_default(),
        }
    }
}

/// A position in the list's order: `at` is when the bookmark was saved, or
/// deleted in the trash; `key` is its title or site key in hex in the orders
/// by title and by site (NP-114).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PageCursor {
    pub at: String,
    pub id: i64,
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
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
    )?;
    // `np_url_key(url)`: the address key of duplicates (NP-035); schema 5 and
    // `dedupe::fill_keys` use it, every insert writes the key itself.
    conn.create_scalar_function(
        "np_url_key",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(crate::dedupe::url_key(&ctx.get::<String>(0)?)),
    )?;
    // `np_sort_key` and `np_site_key` (NP-114): the triggers of schema 7 write
    // the sort keys with them. English until `library::open` applies the
    // language of the stored keys.
    crate::sorting::register(conn, crate::sorting::DEFAULT_LANGUAGE)
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
        triaged_at: row.get(13)?,
        deleted_at: row.get(14)?,
        source: row.get(15)?,
        // `hex(NULL)` is an empty text.
        title_key: Some(row.get::<_, String>(16)?).filter(|k| !k.is_empty()),
        site_key: Some(row.get::<_, String>(17)?).filter(|k| !k.is_empty()),
        source_name: row.get(18)?,
    })
}

/// The `WHERE` of a query over `bookmarks b`, its values, and the column the
/// list is ordered by: when a bookmark was saved, or deleted in the trash.
fn query_filter(query: &BookmarkQuery) -> (String, &'static str, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let (mut filter, at) = match query.only_trash {
        true => (
            String::from(" WHERE b.deleted_at IS NOT NULL"),
            "b.deleted_at",
        ),
        false => (String::from(" WHERE b.deleted_at IS NULL"), "b.created_at"),
    };
    let mut values: Vec<Value> = Vec::new();
    if query.only_favorites {
        filter.push_str(" AND b.is_favorite = 1");
    }
    if query.only_inbox {
        filter.push_str(" AND b.triaged_at IS NULL");
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
        // From the tag to its bookmarks (`idx_bookmark_tags_tag`, schema 7),
        // not a check on every row: a rare tag read 100 000 rows before.
        filter.push_str(
            " AND b.id IN (SELECT bt.bookmark_id FROM bookmark_tags bt
               WHERE bt.tag_id = (SELECT id FROM tags WHERE name = ?))",
        );
        values.push(tag.clone().into());
    }
    let (indexed, short) = search_terms(query.search.as_deref());
    let mut narrowed = indexed.is_some();
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
            // The next short words are checked on the rows this one left
            // («东京 旅行», NP-090), not in a pass of their own.
            filter.push_str(&format!(
                " AND b.id IN (SELECT b.id FROM bookmarks b WHERE {SHORT_IN_FIELDS} UNION {SHORT_IN_TAGS})"
            ));
            narrowed = true;
        }
        values.extend([word.clone().into(), word.into()]);
    }
    (filter, at, values)
}

/// The key column of the orders by title and by site.
fn key_column(order: BookmarkSort) -> Option<&'static str> {
    match order {
        BookmarkSort::Title => Some("b.title_key"),
        BookmarkSort::Site => Some("b.site_key"),
        BookmarkSort::Newest | BookmarkSort::Oldest => None,
    }
}

/// `ORDER BY` of the list, `at` being its time column. Every order ends on
/// the id, so equal times and keys still give one order; each matches an
/// index (`idx_bookmarks_order`, `_inbox`, `_trash`, `_title`, `_site`).
fn order_by(order: BookmarkSort, at: &str) -> String {
    match key_column(order) {
        Some(key) => format!("{key}, b.created_at DESC, b.id DESC"),
        None if order == BookmarkSort::Oldest => format!("{at}, b.id"),
        None => format!("{at} DESC, b.id DESC"),
    }
}

/// The rows past `cursor` in that order, written so the index seeks to them.
fn after_cursor(
    order: BookmarkSort,
    at: &str,
    cursor: &PageCursor,
    values: &mut Vec<rusqlite::types::Value>,
) -> String {
    let place = [cursor.at.clone().into(), cursor.id.into()];
    match key_column(order) {
        Some(key) => {
            // `>=` gives the index a start; equal keys go on by time and id.
            let hex = cursor.key.clone().unwrap_or_default();
            values.extend([hex.clone().into(), hex.into()]);
            values.extend(place);
            format!(" AND {key} >= unhex(?) AND ({key} > unhex(?) OR (b.created_at, b.id) < (?, ?))")
        }
        None => {
            values.extend(place);
            let sign = if order == BookmarkSort::Oldest { ">" } else { "<" };
            format!(" AND ({at}, b.id) {sign} (?, ?)")
        }
    }
}

/// The orders by title and by site need the keys of every bookmark: a library
/// migrated to schema 7 gets them here if the interface has not set its
/// language yet (it does on start, `sorting::set_language`).
fn ensure_keys(conn: &Connection, order: BookmarkSort) -> Result<()> {
    if key_column(order).is_some() && crate::sorting::stored_language(conn).is_none() {
        crate::sorting::set_language(conn, crate::sorting::DEFAULT_LANGUAGE)?;
    }
    Ok(())
}

/// Every bookmark the query matches, in list order, without the page limit:
/// `Ctrl A` selects what is not loaded yet (NP-028). Ids only, read from the
/// order index alone, so 100 000 of them still answer quickly.
pub fn get_bookmark_ids(conn: &Connection, query: &BookmarkQuery) -> Result<Vec<i64>> {
    let order = query.order();
    ensure_keys(conn, order)?;
    let (filter, at, values) = query_filter(query);
    let ids = conn
        .prepare(&format!(
            "SELECT b.id FROM bookmarks b{filter} ORDER BY {}",
            order_by(order, at)
        ))?
        .query_map(rusqlite::params_from_iter(&values), |r| r.get(0))?
        .collect();
    ids
}

/// How many bookmarks a search finds in each filter of the browser's quick
/// search (NP-082): all, the inbox, favorites and per collection. One pass
/// over the matches; the trash is left out as in every list.
pub struct SearchCounts {
    pub all: i64,
    pub inbox: i64,
    pub favorites: i64,
    pub collections: Vec<(i64, i64)>,
}

pub fn search_counts(conn: &Connection, search: Option<&str>) -> Result<SearchCounts> {
    let query = BookmarkQuery {
        search: search.map(str::to_string),
        ..Default::default()
    };
    let (filter, _, values) = query_filter(&query);
    let (all, inbox, favorites) = conn.query_row(
        &format!(
            "SELECT count(*), COALESCE(sum(b.triaged_at IS NULL), 0), COALESCE(sum(b.is_favorite = 1), 0)
             FROM bookmarks b{filter}"
        ),
        rusqlite::params_from_iter(&values),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let collections = conn
        .prepare(&format!(
            "SELECT b.collection_id, count(*) FROM bookmarks b{filter} AND b.collection_id IS NOT NULL
             GROUP BY b.collection_id"
        ))?
        .query_map(rusqlite::params_from_iter(&values), |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    Ok(SearchCounts {
        all,
        inbox,
        favorites,
        collections,
    })
}

/// One page of the list in the query's order (newest first by default), with
/// the total for the whole query. The trash is ordered by when a bookmark
/// was deleted.
pub fn get_bookmarks(conn: &Connection, query: &BookmarkQuery) -> Result<BookmarkPage> {
    use rusqlite::types::Value;
    let order = query.order();
    ensure_keys(conn, order)?;
    let (filter, at, mut values) = query_filter(query);

    // The total and the date-group counts in one pass, first page only.
    let (total, since_counts) = match query.after {
        None => {
            let since = query.since.as_deref().unwrap_or_default();
            let columns: String = since
                .iter()
                .map(|_| format!(", COALESCE(sum({at} >= ?), 0)"))
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
        // A row value, so the page starts by a seek in the order's index.
        page_filter.push_str(&after_cursor(order, at, after, &mut values));
    }
    let limit = query.limit.unwrap_or(PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    // One more row than asked tells whether a next page exists.
    values.push(i64::from(limit + 1).into());
    let mut items = conn
        .prepare(&format!(
            "SELECT {BOOKMARK_COLUMNS} FROM bookmarks b{page_filter} ORDER BY {} LIMIT ?",
            order_by(order, at)
        ))?
        .query_map(rusqlite::params_from_iter(&values), bookmark_row)?
        .collect::<Result<Vec<_>>>()?;
    let next = (items.len() > limit as usize).then(|| {
        items.truncate(limit as usize);
        let last = &items[items.len() - 1];
        PageCursor {
            at: last
                .deleted_at
                .clone()
                .unwrap_or_else(|| last.created_at.clone()),
            id: last.id,
            key: match order {
                BookmarkSort::Title => last.title_key.clone(),
                BookmarkSort::Site => last.site_key.clone(),
                BookmarkSort::Newest | BookmarkSort::Oldest => None,
            },
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
    let ids = id_list(&bookmarks.iter().map(|b| b.id).collect::<Vec<_>>())?;
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

    // Any decision about a bookmark sorts it: it leaves the inbox (NP-021).
    conn.execute(
        "UPDATE bookmarks SET revision=revision+1,updated_at=?1,triaged_at=COALESCE(triaged_at,?1) WHERE id=?2",
        params![now, id],
    )?;
    let updated = get_bookmark_by_id(conn, id)?;
    tx.commit()?;
    Ok(updated)
}

/// What an AI assistant may change on a bookmark (NP-091).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantChange {
    /// Adds these tags; the ones it has stay.
    Tag(Vec<String>),
    /// Into this collection.
    Move(i64),
    Favorite(bool),
}

/// An assistant's change, in one transaction. Unlike a change the person
/// makes, it is no decision: a bookmark in the inbox stays there for the
/// person to sort (Р-67). The trash is out of reach. A change that changes
/// nothing writes nothing and keeps the revision.
pub fn assistant_update(conn: &Connection, id: i64, change: &AssistantChange) -> Result<Bookmark> {
    let tx = conn.unchecked_transaction()?;
    let before = get_bookmark_by_id(&tx, id)?;
    if before.deleted_at.is_some() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let now = now();
    let changed = match change {
        AssistantChange::Tag(tags) => {
            let had = before.tags.clone().unwrap_or_default();
            let new: Vec<String> = tags
                .iter()
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty() && !had.contains(t))
                .collect();
            link_tags(&tx, id, &new, &now)?;
            !new.is_empty()
        }
        AssistantChange::Move(collection) => {
            tx.execute(
                "UPDATE bookmarks SET collection_id=?1 WHERE id=?2 AND collection_id IS NOT ?1",
                params![collection, id],
            )? > 0
        }
        AssistantChange::Favorite(favorite) => {
            tx.execute(
                "UPDATE bookmarks SET is_favorite=?1 WHERE id=?2 AND is_favorite<>?1",
                params![favorite, id],
            )? > 0
        }
    };
    if !changed {
        return Ok(before);
    }
    tx.execute(
        "UPDATE bookmarks SET revision=revision+1, updated_at=?1 WHERE id=?2",
        params![now, id],
    )?;
    let after = get_bookmark_by_id(&tx, id)?;
    tx.commit()?;
    Ok(after)
}

/// Who saved a bookmark over MCP (NP-091), next to `source = 'mcp'`.
pub fn set_source_name(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute("UPDATE bookmarks SET source_name=?1 WHERE id=?2", params![name, id])?;
    Ok(())
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

/// «Обновить превью» (NP-087): the picture and icon of the page, read again.
/// A new one replaces the old, what was not found keeps what there was. Title
/// and description fill in only where empty: the person may have edited them.
/// The trash is left alone.
pub fn refresh_preview(conn: &Connection, id: i64, meta: &crate::metadata::PageMetadata) -> Result<Bookmark> {
    conn.execute(
        "UPDATE bookmarks SET image_url=COALESCE(?1,image_url), favicon_url=COALESCE(?2,favicon_url),
            description=COALESCE(NULLIF(description,''),?3),
            title=CASE WHEN title='' OR title=url THEN COALESCE(?4,title) ELSE title END,
            revision=revision+1, updated_at=?5
         WHERE id=?6 AND deleted_at IS NULL",
        params![meta.image_url, meta.favicon_url, meta.description, meta.title, now(), id],
    )?;
    get_bookmark_by_id(conn, id)
}

/// Sends a bookmark to the trash (NP-022) in one UPDATE: it is there whole
/// or not at all. Note, tags, collection, star and inbox flag stay for a
/// restore. A bookmark already in the trash keeps its time there.
pub fn trash_bookmark(conn: &Connection, id: i64) -> Result<Bookmark> {
    conn.execute(
        "UPDATE bookmarks SET deleted_at=?1, updated_at=?1, revision=revision+1
         WHERE id=?2 AND deleted_at IS NULL",
        params![now(), id],
    )?;
    get_bookmark_by_id(conn, id)
}

/// Takes a bookmark out of the trash with everything it had. `to_inbox`
/// when a link from the trash is saved again: it waits for a decision anew
/// (Р-10, point 2).
pub fn restore_bookmark(conn: &Connection, id: i64, to_inbox: bool) -> Result<Bookmark> {
    conn.execute(
        "UPDATE bookmarks SET deleted_at=NULL, updated_at=?1, revision=revision+1,
                triaged_at=CASE WHEN ?3 THEN NULL ELSE triaged_at END
         WHERE id=?2 AND deleted_at IS NOT NULL",
        params![now(), id, to_inbox],
    )?;
    get_bookmark_by_id(conn, id)
}

/// What a bulk action does to every selected bookmark (NP-029, Р-27).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bulk {
    /// Into a collection, or out of any.
    Move(Option<i64>),
    /// Adds one tag; the tags a bookmark has stay.
    Tag(String),
    /// Stars all of them, or takes the star off all.
    Favorite(bool),
    Trash,
    Restore,
}

/// `ids` as the JSON array `json_each` reads.
pub(crate) fn id_list(ids: &[i64]) -> Result<String> {
    serde_json::to_string(ids).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

/// Applies `bulk` to those of `ids` that exist, in one transaction: all of
/// them or none. Only bookmarks whose fields change get a new revision; a
/// decision about one sorts it out of the inbox, like a single edit. The
/// trash is touched by «Восстановить» only. Returns how many of `ids` the
/// action applies to and the bookmarks it changed.
pub fn apply_bulk(conn: &Connection, ids: &[i64], bulk: &Bulk) -> Result<(usize, Vec<Bookmark>)> {
    let tx = conn.unchecked_transaction()?;
    let done = bulk_in(&tx, ids, bulk)?;
    tx.commit()?;
    Ok(done)
}

/// Whether every one of `ids` outside the trash has a star, and there is one:
/// the selection bar offers «Из избранного» then (NP-029).
pub fn all_favorite(conn: &Connection, ids: &[i64]) -> Result<bool> {
    conn.query_row(
        "SELECT COALESCE(SUM(NOT is_favorite), 1) = 0 FROM bookmarks
         WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL",
        [id_list(ids)?],
        |r| r.get(0),
    )
}

/// The id the next collection gets: collections use AUTOINCREMENT, so a
/// deleted newest one is not reused. Its colour follows the id.
pub fn next_collection_id(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'collections'), 0) + 1",
        [],
        |r| r.get(0),
    )
}

/// «Новая коллекция из выбранного» (Р-27, point 3): the collection and the
/// move in one transaction, so a failure leaves no empty collection.
pub fn bulk_into_new_collection(
    conn: &Connection,
    ids: &[i64],
    name: &str,
) -> Result<(Collection, usize, Vec<Bookmark>)> {
    let tx = conn.unchecked_transaction()?;
    let collection = create_collection(&tx, name, None, None)?;
    let (count, changed) = bulk_in(&tx, ids, &Bulk::Move(Some(collection.id)))?;
    tx.commit()?;
    Ok((Collection { count: Some(count as i64), ..collection }, count, changed))
}

fn bulk_in(conn: &Connection, ids: &[i64], bulk: &Bulk) -> Result<(usize, Vec<Bookmark>)> {
    use rusqlite::types::Value;
    let now = now();
    let all = id_list(ids)?;
    let place = if *bulk == Bulk::Restore { "deleted_at IS NOT NULL" } else { "deleted_at IS NULL" };
    let count: i64 = conn.query_row(
        &format!("SELECT count(*) FROM bookmarks WHERE id IN (SELECT value FROM json_each(?1)) AND {place}"),
        [&all],
        |r| r.get(0),
    )?;
    // Which of them change, and what is written: `?2` is the value, `?3` the time.
    // A new tag is only looked up here and created below, once a bookmark
    // gets it: an action that changes nothing leaves no empty tag behind.
    let tag_name = match bulk {
        Bulk::Tag(name) => Some(name.trim().to_lowercase()),
        _ => None,
    };
    let tag: Option<i64> = match &tag_name {
        Some(name) => conn
            .query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
            .optional()?,
        None => None,
    };
    let sorts = "triaged_at=COALESCE(triaged_at,?3)";
    let (changes, set, value): (&str, String, Value) = match bulk {
        Bulk::Move(collection) => (
            "(collection_id IS NOT ?2 OR triaged_at IS NULL)",
            format!("collection_id=?2, {sorts}"),
            (*collection).into(),
        ),
        Bulk::Tag(_) => (
            "(triaged_at IS NULL OR NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id=bookmarks.id AND bt.tag_id=?2))",
            sorts.to_string(),
            tag.into(),
        ),
        Bulk::Favorite(on) => (
            "(is_favorite IS NOT ?2 OR triaged_at IS NULL)",
            format!("is_favorite=?2, {sorts}"),
            (*on).into(),
        ),
        // A bookmark keeps everything in the trash, as a single one does (Р-21).
        Bulk::Trash => ("?2 IS NULL", "deleted_at=?3".to_string(), Value::Null),
        Bulk::Restore => ("?2 IS NULL", "deleted_at=NULL".to_string(), Value::Null),
    };
    let changing: Vec<i64> = conn
        .prepare(&format!(
            "SELECT id FROM bookmarks WHERE id IN (SELECT value FROM json_each(?1)) AND {place} AND {changes}"
        ))?
        .query_map(params![all, value], |r| r.get(0))?
        .collect::<Result<_>>()?;
    if changing.is_empty() {
        return Ok((count as usize, Vec::new()));
    }
    let list = id_list(&changing)?;
    if let Some(name) = &tag_name {
        let tag = tag_id(conn, name, &now)?;
        conn.execute(
            "INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT value, ?2 FROM json_each(?1) WHERE true
             ON CONFLICT DO NOTHING",
            params![list, tag],
        )?;
    }
    conn.execute(
        &format!(
            "UPDATE bookmarks SET {set}, updated_at=?3, revision=revision+1
             WHERE id IN (SELECT value FROM json_each(?1))"
        ),
        params![list, value, now],
    )?;
    Ok((count as usize, get_bookmarks_by_ids(conn, &changing)?))
}

/// Which bookmarks of the trash go for good.
pub enum Purge<'a> {
    /// «Удалить навсегда» on one bookmark.
    One(i64),
    /// «Удалить навсегда…» on the selection in the trash (NP-029).
    Some(&'a [i64]),
    /// The cleanup: deleted at this time or earlier.
    Before(&'a str),
    /// «Очистить корзину».
    All,
}

/// Final deletion (NP-023), only ever from the trash: a bookmark in the
/// library is never deleted at once. One transaction; the tombstone keeps
/// the `uid` and the time it went to the trash so a future sync can delete
/// the record on other devices (Р-10). Returns the `id` and revision of each.
pub fn purge_trash(conn: &Connection, which: Purge) -> Result<Vec<(i64, i64)>> {
    let (filter, value): (&str, rusqlite::types::Value) = match which {
        Purge::One(id) => ("id = ?1", id.into()),
        Purge::Some(ids) => ("id IN (SELECT value FROM json_each(?1))", id_list(ids)?.into()),
        Purge::Before(time) => ("deleted_at <= ?1", time.to_string().into()),
        Purge::All => ("?1 IS NULL", rusqlite::types::Value::Null),
    };
    let condition = format!("deleted_at IS NOT NULL AND {filter}");
    let tx = conn.unchecked_transaction()?;
    let gone = tx
        .prepare(&format!(
            "SELECT id, revision FROM bookmarks WHERE {condition}"
        ))?
        .query_map([&value], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    tx.execute(
        &format!(
            "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at)
             SELECT uid, 'bookmark', deleted_at, ?2 FROM bookmarks WHERE {condition}"
        ),
        params![value, now()],
    )?;
    tx.execute(
        &format!("DELETE FROM bookmarks WHERE {condition}"),
        [&value],
    )?;
    tx.commit()?;
    Ok(gone)
}

/// In the sidebar's order (NP-114): where the person put them, then those
/// never moved by name in the language of the sort keys.
pub fn get_collections(conn: &Connection) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.color, c.icon, c.created_at, COUNT(b.id) as count, c.position
         FROM collections c
         LEFT JOIN bookmarks b ON c.id = b.collection_id AND b.deleted_at IS NULL
         GROUP BY c.id
         ORDER BY c.position IS NULL, c.position, np_sort_key(c.name), c.id",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Collection {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            icon: row.get(3)?,
            created_at: row.get(4)?,
            count: Some(row.get(5)?),
            position: row.get(6)?,
        })
    })?;

    let mut cols = Vec::new();
    for r in rows {
        cols.push(r?);
    }
    Ok(cols)
}

/// The sidebar's order after a move (NP-114): `ids` from first to last, the
/// interface sends all of them. One left out keeps the position it had (a
/// collection made meanwhile has none and stays at the end); unknown ids
/// change nothing. One transaction, only the positions that change are written.
pub fn reorder_collections(conn: &Connection, ids: &[i64]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut place =
            tx.prepare("UPDATE collections SET position = ?1 WHERE id = ?2 AND position IS NOT ?1")?;
        for (position, id) in ids.iter().enumerate() {
            place.execute(params![position as i64, id])?;
        }
    }
    tx.commit()
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
        // After the moved ones: a new collection appears at the end (NP-114).
        position: None,
    })
}

/// Colour and icon of each starter collection, in the order of their names.
const STARTERS: [(&str, &str); 3] = [
    ("#6366f1", "code"),
    ("#ec4899", "palette"),
    ("#10b981", "book-open"),
];

/// A new library waits for its first collections (`starter_collections` in
/// `app_settings`, NP-085): the interface names them in its language. Only
/// once — deleted ones never come back, older libraries never get them.
pub fn create_starter_collections(conn: &Connection, names: &[String]) -> Result<Vec<Collection>> {
    create_starter_library(conn, names, &[]).map(|made| made.collections)
}

/// A link of the starter set (NP-117), named by the interface in its language.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct StarterLink {
    pub url: String,
    pub title: String,
    pub description: String,
}

/// What a new library got on its first open; empty for any other library.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct StarterLibrary {
    pub collections: Vec<Collection>,
    /// The starter links in the inbox, the first of the set first.
    pub links: Vec<Bookmark>,
}

/// The `uid`s of the starter links in `app_settings`, as a JSON array: triage
/// says «from Koona Pin» instead of «added by hand» (NP-117).
const STARTER_LINKS: &str = "starter_links";

/// The starter collections and links of a new library in one transaction, by
/// the same mark as [`create_starter_collections`]. The links wait in the
/// inbox with the set's titles and descriptions, the first of the set the
/// newest; a link that is not HTTP(S) or already saved is left out.
pub fn create_starter_library(conn: &Connection, names: &[String], links: &[StarterLink]) -> Result<StarterLibrary> {
    let tx = conn.unchecked_transaction()?;
    if tx.execute("DELETE FROM app_settings WHERE key = 'starter_collections'", [])? == 0 {
        return Ok(StarterLibrary { collections: Vec::new(), links: Vec::new() });
    }
    let collections = STARTERS
        .iter()
        .zip(names)
        .filter(|(_, name)| !name.trim().is_empty())
        .map(|((color, icon), name)| create_collection(&tx, name.trim(), Some(color), Some(icon)))
        .collect::<Result<Vec<_>>>()?;
    let mut made = Vec::new();
    // Newest first in the list: the last of the set is saved first.
    for link in links.iter().rev() {
        let Ok(url) = crate::capture::validate_url(&link.url) else { continue };
        let exists = tx
            .query_row("SELECT 1 FROM bookmarks WHERE url=?1", [&url], |_| Ok(()))
            .optional()?
            .is_some();
        let title = link.title.trim();
        if exists || title.is_empty() {
            continue;
        }
        let description = Some(link.description.trim()).filter(|d| !d.is_empty());
        let domain = crate::metadata::extract_domain(&url);
        made.push(insert_or_update_bookmark(&tx, &url, title, description, None, None, &domain, None, None, Source::App)?);
    }
    made.reverse();
    let uids = made
        .iter()
        .map(|b| tx.query_row("SELECT uid FROM bookmarks WHERE id=?1", [b.id], |r| r.get::<_, String>(0)))
        .collect::<Result<Vec<_>>>()?;
    if !uids.is_empty() {
        set_setting(&tx, STARTER_LINKS, &serde_json::to_string(&uids).unwrap_or_default())?;
    }
    tx.commit()?;
    Ok(StarterLibrary { collections, links: made })
}

/// The ids of the starter links still in the library (NP-117).
pub fn starter_link_ids(conn: &Connection) -> Result<Vec<i64>> {
    let Some(uids) = setting(conn, STARTER_LINKS).optional()? else {
        return Ok(Vec::new());
    };
    conn.prepare("SELECT id FROM bookmarks WHERE uid IN (SELECT value FROM json_each(?1)) ORDER BY id")?
        .query_map([uids], |r| r.get(0))?
        .collect()
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

/// Tags in use outside the trash, most used first. Every link is counted
/// from the tag index and the few in the trash are taken off, instead of
/// looking up each linked bookmark: 54 ms on 100 000 bookmarks before
/// schema 7, and the sidebar asks after every change.
pub fn get_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, l.n - COALESCE(d.n, 0) AS count
         FROM tags t
         JOIN (SELECT tag_id, count(*) AS n FROM bookmark_tags GROUP BY tag_id) l ON l.tag_id = t.id
         -- CROSS JOIN keeps the trash outside: SQLite would start from every link.
         LEFT JOIN (SELECT bt.tag_id, count(*) AS n FROM bookmarks b
                    CROSS JOIN bookmark_tags bt ON bt.bookmark_id = b.id
                    WHERE b.deleted_at IS NOT NULL GROUP BY bt.tag_id) d ON d.tag_id = t.id
         WHERE count > 0
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

/// The collection triage offers under key 1 (NP-026, Р-25), and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Suggestion {
    pub collection_id: i64,
    /// Other bookmarks of the site in that collection.
    pub count: i64,
    /// Other bookmarks of the site in any collection.
    pub filed: i64,
}

/// Fewer bookmarks of a site in one collection suggest nothing.
pub const SUGGEST_AT_LEAST: i64 = 2;

/// Where the other bookmarks of the same site (exact domain, outside the
/// trash) mostly lie: a collection holding at least two of them and more
/// than half of those filed anywhere. A tie or too little data suggests
/// nothing. Only reads: nothing changes until the user chooses.
pub fn suggest_collection(conn: &Connection, id: i64) -> Result<Option<Suggestion>> {
    let counts = conn
        .prepare(
            "SELECT o.collection_id, count(*) FROM bookmarks b
             JOIN bookmarks o ON o.domain = b.domain AND o.id <> b.id
                 AND o.deleted_at IS NULL AND o.collection_id IS NOT NULL
             WHERE b.id = ?1
             GROUP BY o.collection_id ORDER BY count(*) DESC, o.collection_id",
        )?
        .query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    let filed: i64 = counts.iter().map(|(_, n)| n).sum();
    Ok(counts.first().and_then(|&(collection_id, count)| {
        (count >= SUGGEST_AT_LEAST && count * 2 > filed).then_some(Suggestion {
            collection_id,
            count,
            filed,
        })
    }))
}

pub fn get_domains(conn: &Connection) -> Result<Vec<DomainCount>> {
    let mut stmt = conn.prepare(
        "SELECT domain, COUNT(id) as count
         FROM bookmarks
         WHERE deleted_at IS NULL
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
    fn the_library_lives_in_the_brand_folder() {
        // Р-56, and Р-9: the folder never changes after the first public installer.
        if std::env::var_os(DATA_DIR_ENV).is_some() {
            return;
        }
        let data = dirs::data_dir().unwrap();
        assert_eq!(db_path(), data.join("Koona").join("Pin").join("koonapin.db"));
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

    #[test]
    fn new_links_wait_in_the_inbox_until_a_decision() {
        let conn = setup_test_db();
        let save = |url: &str, title: &str, source| {
            insert_or_update_bookmark(
                &conn,
                url,
                title,
                None,
                None,
                None,
                "example.com",
                None,
                None,
                source,
            )
            .unwrap()
        };
        let captured = save(
            "https://example.com/captured",
            "Захват из браузера",
            Source::Chrome,
        );
        let added = save(
            "https://example.com/added",
            "Добавлено вручную",
            Source::App,
        );
        let imported = save("https://example.com/imported", "Импорт", Source::Import);
        assert_eq!(captured.triaged_at, None);
        assert_eq!(added.triaged_at, None);
        // Triage says where each came from (NP-025).
        let sources = [&captured, &added, &imported].map(|b| b.source.as_deref());
        assert_eq!(sources, [Some("chrome"), Some("app"), Some("import")]);
        assert!(
            imported.triaged_at.is_some(),
            "an import goes to the library"
        );
        conn.execute(
            "UPDATE bookmarks SET created_at = CASE id WHEN ?1 THEN '2026-10-01T10:00:00.000Z' ELSE '2026-10-02T10:00:00.000Z' END",
            [captured.id],
        )
        .unwrap();

        let inbox = |search: Option<&str>| {
            let page = get_bookmarks(
                &conn,
                &BookmarkQuery {
                    only_inbox: true,
                    search: search.map(Into::into),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(page.total, Some(page.items.len() as i64));
            page.items.iter().map(|b| b.id).collect::<Vec<_>>()
        };
        assert_eq!(inbox(None), [added.id, captured.id]);
        assert_eq!(
            inbox(Some("браузера")),
            [captured.id],
            "search stays in the section"
        );
        assert_eq!(
            everything(&conn).len(),
            3,
            "the inbox is also in All bookmarks"
        );
        let counts = get_counts(&conn).unwrap();
        assert_eq!((counts.total, counts.inbox), (3, 2));
        assert_eq!(
            counts.inbox_newest.as_deref(),
            Some("2026-10-02T10:00:00.000Z")
        );

        // Metadata and a removed collection are not decisions.
        let meta = crate::metadata::PageMetadata {
            title: Some("Новое название".into()),
            ..Default::default()
        };
        enrich_bookmark(&conn, captured.id, captured.revision, &meta).unwrap();
        let collection = create_collection(&conn, "Временная", None, None).unwrap();
        conn.execute(
            "UPDATE bookmarks SET collection_id = ?1 WHERE id = ?2",
            [collection.id, captured.id],
        )
        .unwrap();
        delete_collection(&conn, collection.id).unwrap();
        assert_eq!(
            get_bookmark_by_id(&conn, captured.id).unwrap().triaged_at,
            None
        );

        // Any change by the user is one: the star sorts the bookmark, and a
        // later edit keeps the time of that first decision.
        let starred =
            update_bookmark(&conn, captured.id, None, None, Some(true), None, None).unwrap();
        let sorted_at = starred.triaged_at.clone().expect("sorted");
        assert_eq!(inbox(None), [added.id]);
        let edited = update_bookmark(
            &conn,
            captured.id,
            None,
            Some("Заметка".into()),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(edited.triaged_at, Some(sorted_at));
        let counts = get_counts(&conn).unwrap();
        assert_eq!(counts.inbox, 1);
        assert_eq!(
            counts.inbox_newest.as_deref(),
            Some("2026-10-02T10:00:00.000Z")
        );

        update_bookmark(
            &conn,
            added.id,
            Some("Решено".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let counts = get_counts(&conn).unwrap();
        assert_eq!((counts.inbox, counts.inbox_newest), (0, None));
        assert!(inbox(None).is_empty());
    }

    #[test]
    fn the_trash_keeps_everything_and_stays_out_of_the_library() {
        let conn = setup_test_db();
        let collection = create_collection(&conn, "Железо", None, None).unwrap();
        let kept = add(&conn, "https://example.com/kept", "Оставленная", &["общий"]);
        let first = add(
            &conn,
            "https://example.com/first",
            "Первая в корзину",
            &["общий", "только-корзина"],
        );
        let second = add(&conn, "https://other.org/second", "Вторая в корзину", &[]);
        update_bookmark(
            &conn,
            first.id,
            None,
            Some("Заметка".into()),
            Some(true),
            Some(Some(collection.id)),
            None,
        )
        .unwrap();
        let first = get_bookmark_by_id(&conn, first.id).unwrap();

        let trashed = trash_bookmark(&conn, first.id).unwrap();
        assert!(trashed.deleted_at.is_some());
        assert_eq!(trashed.revision, first.revision + 1);
        conn.execute(
            "UPDATE bookmarks SET deleted_at='2026-10-01T10:00:00.000Z' WHERE id=?1",
            [first.id],
        )
        .unwrap();
        trash_bookmark(&conn, second.id).unwrap();
        conn.execute(
            "UPDATE bookmarks SET deleted_at='2026-10-03T10:00:00.000Z' WHERE id=?1",
            [second.id],
        )
        .unwrap();
        // Trashing again keeps the time it went there.
        assert_eq!(
            trash_bookmark(&conn, second.id)
                .unwrap()
                .deleted_at
                .as_deref(),
            Some("2026-10-03T10:00:00.000Z")
        );

        // Out of the library, its search, counts, collections, tags and sites.
        assert_eq!(
            everything(&conn).iter().map(|b| b.id).collect::<Vec<_>>(),
            [kept.id]
        );
        assert!(found(&conn, "корзину").is_empty());
        let counts = get_counts(&conn).unwrap();
        assert_eq!(
            (counts.total, counts.favorites, counts.inbox, counts.trash),
            (1, 0, 1, 2)
        );
        assert_eq!(
            get_collections(&conn)
                .unwrap()
                .iter()
                .find(|c| c.id == collection.id)
                .unwrap()
                .count,
            Some(0)
        );
        let tags = get_tags(&conn).unwrap();
        assert_eq!(
            tags.iter()
                .map(|t| (t.name.as_str(), t.count))
                .collect::<Vec<_>>(),
            [("общий", Some(1))]
        );
        assert!(get_domains(&conn)
            .unwrap()
            .iter()
            .all(|d| d.domain != "other.org"));

        // The trash: newest deletion first, pages and groups by that time, its own search.
        let trash = |search: Option<&str>, after: Option<PageCursor>, limit: u32| {
            get_bookmarks(
                &conn,
                &BookmarkQuery {
                    only_trash: true,
                    search: search.map(Into::into),
                    after,
                    limit: Some(limit),
                    since: Some(vec!["2026-10-02T00:00:00.000Z".into()]),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let page = trash(None, None, 1);
        assert_eq!(
            page.items.iter().map(|b| b.id).collect::<Vec<_>>(),
            [second.id]
        );
        assert_eq!(
            (page.total, page.since_counts.clone()),
            (Some(2), Some(vec![1]))
        );
        let next = page.next.expect("a second page");
        assert_eq!(next.at, "2026-10-03T10:00:00.000Z");
        assert_eq!(trash(None, Some(next), 1).items[0].id, first.id);
        assert_eq!(
            trash(Some("первая"), None, 10)
                .items
                .iter()
                .map(|b| b.id)
                .collect::<Vec<_>>(),
            [first.id]
        );

        // Late metadata does not bring a bookmark back.
        let meta = crate::metadata::PageMetadata {
            description: Some("Описание".into()),
            ..Default::default()
        };
        enrich_bookmark(&conn, first.id, trashed.revision, &meta).unwrap();
        assert!(get_bookmark_by_id(&conn, first.id)
            .unwrap()
            .deleted_at
            .is_some());

        // A failed write leaves the bookmark where it was.
        conn.execute_batch("PRAGMA query_only = ON").unwrap();
        assert!(restore_bookmark(&conn, first.id, false).is_err());
        assert!(trash_bookmark(&conn, kept.id).is_err());
        conn.execute_batch("PRAGMA query_only = OFF").unwrap();
        assert!(get_bookmark_by_id(&conn, first.id)
            .unwrap()
            .deleted_at
            .is_some());
        assert!(get_bookmark_by_id(&conn, kept.id)
            .unwrap()
            .deleted_at
            .is_none());

        // Restored with everything, inbox flag included.
        let back = restore_bookmark(&conn, first.id, false).unwrap();
        assert_eq!(back.deleted_at, None);
        assert_eq!(
            (back.notes.as_deref(), back.is_favorite, back.collection_id),
            (Some("Заметка"), true, Some(collection.id))
        );
        assert_eq!(back.tags.unwrap(), ["общий", "только-корзина"]);
        assert_eq!(back.triaged_at, first.triaged_at);
        assert_eq!(found(&conn, "корзину"), [first.id]);
        assert_eq!(get_counts(&conn).unwrap().trash, 1);
    }

    #[test]
    fn a_collection_is_suggested_by_where_the_site_mostly_lies() {
        let conn = setup_test_db();
        let hardware = create_collection(&conn, "Железо", None, None).unwrap();
        let work = create_collection(&conn, "Работа", None, None).unwrap();
        let file = |url: &str, collection: Option<i64>| {
            let b = add(&conn, url, "Ссылка", &[]);
            if collection.is_some() {
                update_bookmark(&conn, b.id, None, None, None, Some(collection), None).unwrap();
            }
            b
        };
        let new = file("https://trezor.io/new", None);
        let suggest = || suggest_collection(&conn, new.id).unwrap();
        let expect = |collection_id, count, filed| {
            Some(Suggestion {
                collection_id,
                count,
                filed,
            })
        };

        // Too little: nothing filed, then one link only.
        assert_eq!(suggest(), None);
        file("https://trezor.io/a", Some(hardware.id));
        assert_eq!(suggest(), None);
        // Unfiled links, other sites and the bookmark itself do not count.
        file("https://trezor.io/kept", None);
        file("https://other.org/x", Some(work.id));
        file("https://other.org/y", Some(work.id));
        update_bookmark(&conn, new.id, None, None, None, Some(Some(work.id)), None).unwrap();
        assert_eq!(suggest(), None);

        file("https://trezor.io/b", Some(hardware.id));
        assert_eq!(suggest(), expect(hardware.id, 2, 2));
        // A tie suggests nothing; a majority does.
        file("https://trezor.io/c", Some(work.id));
        let tie = file("https://trezor.io/d", Some(work.id));
        assert_eq!(suggest(), None);
        let third = file("https://trezor.io/e", Some(hardware.id));
        assert_eq!(suggest(), expect(hardware.id, 3, 5));
        // The trash is not where the site lies.
        trash_bookmark(&conn, third.id).unwrap();
        trash_bookmark(&conn, tie.id).unwrap();
        assert_eq!(suggest(), expect(hardware.id, 2, 3));

        // Reading a suggestion changes nothing, also in a read-only library.
        let before = get_bookmark_by_id(&conn, new.id).unwrap();
        conn.execute_batch("PRAGMA query_only = ON").unwrap();
        assert_eq!(suggest(), expect(hardware.id, 2, 3));
        conn.execute_batch("PRAGMA query_only = OFF").unwrap();
        assert_eq!(get_bookmark_by_id(&conn, new.id).unwrap().revision, before.revision);
        assert_eq!(suggest_collection(&conn, 9_999).unwrap(), None);
    }

    #[test]
    fn refreshing_a_preview_keeps_what_the_person_wrote() {
        let conn = setup_test_db();
        let url = "https://example.org/imported";
        let imported = insert_or_update_bookmark(&conn, url, url, None, None, None, "example.org", None, None, Source::Import).unwrap();
        let meta = crate::metadata::PageMetadata {
            title: Some("Page title".into()),
            description: Some("From the page".into()),
            image_url: Some("https://example.org/og.jpg".into()),
            favicon_url: Some("https://example.org/touch.png".into()),
            domain: "example.org".into(),
        };
        let refreshed = refresh_preview(&conn, imported.id, &meta).unwrap();
        // An imported link had nothing: it gets everything.
        assert_eq!(refreshed.title, "Page title");
        assert_eq!(refreshed.description.as_deref(), Some("From the page"));
        assert_eq!(refreshed.image_url.as_deref(), Some("https://example.org/og.jpg"));
        assert_eq!(refreshed.favicon_url.as_deref(), Some("https://example.org/touch.png"));
        assert!(refreshed.revision > imported.revision);
        // Edited words stay; a picture not found again stays too.
        update_bookmark(&conn, imported.id, Some("Mine".into()), None, None, None, None).unwrap();
        conn.execute("UPDATE bookmarks SET description='My words' WHERE id=?1", [imported.id]).unwrap();
        let none = crate::metadata::PageMetadata { title: Some("Other".into()), description: Some("Other".into()), ..Default::default() };
        let again = refresh_preview(&conn, imported.id, &none).unwrap();
        assert_eq!((again.title.as_str(), again.description.as_deref()), ("Mine", Some("My words")));
        assert_eq!(again.image_url.as_deref(), Some("https://example.org/og.jpg"));
        // The trash is left alone.
        trash_bookmark(&conn, imported.id).unwrap();
        let trashed = refresh_preview(&conn, imported.id, &meta).unwrap();
        assert_eq!(trashed.revision, get_bookmark_by_id(&conn, imported.id).unwrap().revision);
        assert_eq!(trashed.title, "Mine");
    }

    #[test]
    fn starter_links_come_once_into_the_inbox_of_a_new_library() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        let link = |url: &str, title: &str| StarterLink { url: url.into(), title: title.into(), description: format!("About {title}") };
        let links = [
            link("https://koona.app/pin/#how", "Start here"),
            link("https://koona.app/pin/changelog/", "What's new"),
            link("ftp://example.com/", "Not a web page"),
            link("https://bun.com/", "Bun"),
            link("https://www.lunacyapp.com/", "Lunacy"),
        ];
        let names = ["Development", "Design", "Reading"].map(String::from);
        let made = create_starter_library(&conn, &names, &links).unwrap();
        assert_eq!(made.collections.len(), 3);
        let titles: Vec<_> = made.links.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(titles, ["Start here", "What's new", "Bun", "Lunacy"]);
        // In the inbox, newest first in the order of the set, with the set's words.
        let list: Vec<_> = everything(&conn).into_iter().map(|b| (b.title, b.triaged_at, b.source, b.description)).collect();
        assert_eq!(list[0], ("Start here".into(), None, Some("app".into()), Some("About Start here".into())));
        assert_eq!(list.iter().map(|b| b.0.as_str()).collect::<Vec<_>>(), titles);
        let lunacy = &made.links[3];
        assert_eq!(lunacy.domain, "lunacyapp.com");
        // Search and the duplicate key know them like any saved link.
        let found = get_bookmarks(&conn, &BookmarkQuery { search: Some("lunacy".into()), ..Default::default() }).unwrap();
        assert_eq!(found.items.len(), 1);
        let key: Option<String> = conn.query_row("SELECT url_key FROM bookmarks WHERE id=?1", [lunacy.id], |r| r.get(0)).unwrap();
        assert!(key.is_some());
        let mut ids: Vec<_> = made.links.iter().map(|b| b.id).collect();
        ids.sort();
        assert_eq!(starter_link_ids(&conn).unwrap(), ids);
        // Once: a second call, or a library made before, gets nothing.
        let again = create_starter_library(&conn, &names, &links).unwrap();
        assert!(again.collections.is_empty() && again.links.is_empty());
        assert_eq!(everything(&conn).len(), 4);
        // A starter link sent to the trash and deleted for good drops out of the list.
        trash_bookmark(&conn, ids[0]).unwrap();
        purge_trash(&conn, Purge::One(ids[0])).unwrap();
        assert_eq!(starter_link_ids(&conn).unwrap(), ids[1..]);
    }

    #[test]
    fn a_library_without_starter_links_names_none() {
        let conn = setup_test_db();
        assert!(starter_link_ids(&conn).unwrap().is_empty());
    }

    fn setup_test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        let names = ["Development", "Design & UI", "Articles / To read"].map(String::from);
        create_starter_collections(&conn, &names).unwrap();
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
    fn two_character_cjk_words_are_found_inside_text_without_spaces() {
        // Chinese and Japanese write without spaces, and their words are
        // often two characters: shorter than a trigram (NP-090).
        let conn = setup_test_db();
        let tokyo = add(&conn, "https://example.jp/a", "东京旅行指南", &[]);
        let search = add(&conn, "https://example.jp/b", "全文検索の仕組み", &["読書"]);
        let korean = add(&conn, "https://example.kr/c", "여행 검색 도구", &[]);
        assert_eq!(found(&conn, "东京"), [tokyo.id]);
        assert_eq!(found(&conn, "旅行"), [tokyo.id]);
        assert_eq!(found(&conn, "検索"), [search.id]);
        assert_eq!(found(&conn, "読書"), [search.id]);
        assert_eq!(found(&conn, "검색"), [korean.id]);
        // Two short words, and a short word with an indexed one.
        assert_eq!(found(&conn, "东京 指南"), [tokyo.id]);
        assert_eq!(found(&conn, "検索 仕組み"), [search.id]);
        assert_eq!(found(&conn, "旅行指南"), [tokyo.id]);
        assert_eq!(found(&conn, "の"), [search.id]);
        assert!(found(&conn, "东京 검색").is_empty());
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

        trash_bookmark(&conn, b.id).unwrap();
        purge_trash(&conn, Purge::One(b.id)).unwrap();
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
        let ids = |rows: &[(String, i64)]| rows.iter().map(|(_, id)| *id).collect::<Vec<_>>();
        let (all, total) = read_all(BookmarkQuery::default());
        assert_eq!(total, 250);
        let mut expected = all.clone();
        expected.sort_by(|a, b| b.cmp(a));
        expected.dedup();
        assert_eq!(all, expected, "newest first, no repeats");
        assert_eq!(all.len(), 250);
        // `Ctrl A`: the same bookmarks in the same order, without pages.
        assert_eq!(
            get_bookmark_ids(&conn, &BookmarkQuery::default()).unwrap(),
            ids(&all)
        );

        let filtered = BookmarkQuery {
            collection_id: Some(collection.id),
            search: Some("запись 1".into()),
            ..Default::default()
        };
        let (shelf, total) = read_all(filtered.clone());
        // "запись 1" means both words: "запись" and "1".
        let expected = (0..250)
            .filter(|i| i % 2 == 0 && i.to_string().contains('1'))
            .count();
        assert_eq!((shelf.len(), total), (expected, expected as i64));
        assert_eq!(get_bookmark_ids(&conn, &filtered).unwrap(), ids(&shelf));
    }

    #[test]
    fn ids_of_a_large_section_answer_quickly() {
        let conn = setup_test_db();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, triaged_at)
             SELECT 'uid-' || i, 'https://example.com/' || i, 'Запись ' || i, 'example.com',
                    printf('2026-01-01T00:00:%05d', i), '2026-01-01', NULL FROM n;",
        )
        .unwrap();
        let started = std::time::Instant::now();
        let ids = get_bookmark_ids(
            &conn,
            &BookmarkQuery {
                only_inbox: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ids.len(), 10_000);
        assert_eq!((ids[0], ids[9_999]), (10_000, 1));
        // Generous for a debug build on a busy runner; release is far below.
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
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

    /// Every page of `base` through the cursor, `size` at a time, and the total.
    fn read_pages(conn: &Connection, base: &BookmarkQuery, size: u32) -> (Vec<i64>, i64) {
        let mut query = BookmarkQuery { limit: Some(size), ..base.clone() };
        let (mut ids, mut total) = (Vec::new(), 0);
        loop {
            let page = get_bookmarks(conn, &query).unwrap();
            total = page.total.unwrap_or(total);
            ids.extend(page.items.iter().map(|b| b.id));
            match page.next {
                Some(next) => query.after = Some(next),
                None => return (ids, total),
            }
        }
    }

    /// Ties everywhere: nine titles and four sites repeated, three bookmarks
    /// per second. Every order, alone and with filters, reads each matching
    /// bookmark once in the order the collator gives, pages of 7 cutting
    /// through equal keys and times; `Ctrl A` gives the same ids.
    #[test]
    fn every_order_pages_through_the_list_once() {
        use std::cmp::Reverse;
        let conn = setup_test_db();
        let shelf = create_collection(&conn, "Полка", None, None).unwrap();
        let titles = ["Zebra", "äpfel", "Apfel", "Chapter 10", "Chapter 9", "Bär", "apfel", "Ёж", "ель"];
        let sites = ["www.b.example", "a.example", "B.example", "c.example"];
        for i in 0..90usize {
            let url = format!("https://{}/{i}", sites[i % sites.len()]);
            let tags = if i % 5 == 0 { vec!["пятый".to_string()] } else { Vec::new() };
            let b = insert_or_update_bookmark(&conn, &url, titles[i % titles.len()], None, None, None, sites[i % sites.len()], None, Some(&tags), Source::App).unwrap();
            conn.execute(
                "UPDATE bookmarks SET created_at = ?1, collection_id = ?2 WHERE id = ?3",
                params![format!("2026-01-01T00:00:{:02}.000Z", i / 3), (i % 2 == 0).then_some(shelf.id), b.id],
            )
            .unwrap();
        }
        trash_bookmark(&conn, 5).unwrap();
        let rows = everything(&conn);
        let collator = crate::sorting::collator("en");
        let key = |text: &str| crate::sorting::key(&collator, text);
        let filters = [
            BookmarkQuery::default(),
            BookmarkQuery { collection_id: Some(shelf.id), ..Default::default() },
            BookmarkQuery { tag: Some("пятый".into()), ..Default::default() },
            BookmarkQuery { search: Some("apfel".into()), ..Default::default() },
        ];
        for sort in [BookmarkSort::Newest, BookmarkSort::Oldest, BookmarkSort::Title, BookmarkSort::Site] {
            for filter in &filters {
                let query = BookmarkQuery { sort: Some(sort), ..filter.clone() };
                let ids: std::collections::HashSet<i64> = get_bookmark_ids(&conn, &BookmarkQuery::default()).unwrap().into_iter().collect();
                let mut expected: Vec<&Bookmark> = rows
                    .iter()
                    .filter(|b| ids.contains(&b.id))
                    .filter(|b| filter.collection_id.is_none_or(|c| b.collection_id == Some(c)))
                    .filter(|b| filter.tag.is_none() || b.tags.as_ref().unwrap().contains(&"пятый".to_string()))
                    .filter(|b| filter.search.is_none() || key(&b.title) == key("apfel"))
                    .collect();
                match sort {
                    BookmarkSort::Newest => expected.sort_by_key(|b| Reverse((b.created_at.clone(), b.id))),
                    BookmarkSort::Oldest => expected.sort_by_key(|b| (b.created_at.clone(), b.id)),
                    BookmarkSort::Title => expected.sort_by_key(|b| (key(&b.title), Reverse((b.created_at.clone(), b.id)))),
                    BookmarkSort::Site => {
                        expected.sort_by_key(|b| (key(crate::sorting::site(&b.domain)), Reverse((b.created_at.clone(), b.id))))
                    }
                }
                let expected: Vec<i64> = expected.iter().map(|b| b.id).collect();
                let (paged, total) = read_pages(&conn, &query, 7);
                assert_eq!(paged, expected, "{sort:?} {filter:?}");
                assert_eq!(total, expected.len() as i64);
                assert_eq!(get_bookmark_ids(&conn, &query).unwrap(), expected, "Ctrl A, {sort:?}");
            }
        }
        // The title order as a person reads it (case aside, so «Apfel» and
        // «apfel» mix by time), and «www.» left out of the site.
        let mut first: Vec<String> = get_bookmarks(&conn, &BookmarkQuery { sort: Some(BookmarkSort::Title), limit: Some(90), ..Default::default() })
            .unwrap()
            .items
            .iter()
            .map(|b| b.title.to_lowercase())
            .collect();
        first.dedup();
        assert_eq!(first, ["apfel", "äpfel", "bär", "chapter 9", "chapter 10", "zebra", "ёж", "ель"]);
        let page = get_bookmarks(&conn, &BookmarkQuery { sort: Some(BookmarkSort::Site), limit: Some(90), ..Default::default() }).unwrap();
        let first_sites: Vec<&str> = page.items.iter().map(|b| crate::sorting::site(&b.domain)).collect();
        assert_eq!(first_sites.first(), Some(&"a.example"));
        assert!(first_sites.windows(2).all(|w| key(w[0]) <= key(w[1])));
        // The trash keeps its own order whatever is chosen.
        let trash = BookmarkQuery { only_trash: true, sort: Some(BookmarkSort::Title), ..Default::default() };
        assert_eq!(read_pages(&conn, &trash, 7).0, [5]);
    }

    #[test]
    fn the_title_order_follows_the_interface_language() {
        let conn = setup_test_db();
        for title in ["cvet", "čaj", "zec"] {
            add(&conn, &format!("https://example.com/{title}"), title, &[]);
        }
        let titles = |conn: &Connection| -> Vec<String> {
            let query = BookmarkQuery { sort: Some(BookmarkSort::Title), ..Default::default() };
            get_bookmarks(conn, &query).unwrap().items.into_iter().map(|b| b.title).collect()
        };
        // English keeps «č» with «c»; Serbian Latin has it as a letter after «c».
        assert_eq!(titles(&conn), ["čaj", "cvet", "zec"]);
        assert!(crate::sorting::set_language(&conn, "sr-Latn").unwrap());
        assert_eq!(titles(&conn), ["cvet", "čaj", "zec"]);
        assert!(!crate::sorting::set_language(&conn, "sr-Latn").unwrap(), "the same language writes nothing");
        // Saved and renamed after the change: keys of the same language.
        add(&conn, "https://example.com/c", "ćup", &[]);
        let renamed = add(&conn, "https://example.com/r", "ako", &[]);
        update_bookmark(&conn, renamed.id, Some("džep".into()), None, None, None, None).unwrap();
        assert_eq!(titles(&conn), ["cvet", "čaj", "ćup", "džep", "zec"]);
        assert_eq!(crate::sorting::stored_language(&conn).as_deref(), Some("sr-Latn"));
        // Keys of other collation data (an update of ICU4X) are written anew.
        set_setting(&conn, "sort_keys", "0.0.0").unwrap();
        assert!(crate::sorting::set_language(&conn, "sr-Latn").unwrap());
        assert_eq!(titles(&conn), ["cvet", "čaj", "ćup", "džep", "zec"]);
    }

    #[test]
    fn collections_keep_the_order_the_person_gives_them() {
        let conn = setup_test_db();
        let names = |conn: &Connection| get_collections(conn).unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>();
        // Never moved: by name.
        assert_eq!(names(&conn), ["Articles / To read", "Design & UI", "Development"]);
        let ids: Vec<i64> = get_collections(&conn).unwrap().iter().map(|c| c.id).collect();
        reorder_collections(&conn, &[ids[2], ids[0], ids[1]]).unwrap();
        assert_eq!(names(&conn), ["Development", "Articles / To read", "Design & UI"]);
        assert_eq!(get_collections(&conn).unwrap()[0].position, Some(0));
        // A new one goes to the end whatever its name; unknown ids change nothing.
        create_collection(&conn, "Aardvark", None, None).unwrap();
        reorder_collections(&conn, &[9_999]).unwrap();
        assert_eq!(names(&conn), ["Development", "Articles / To read", "Design & UI", "Aardvark"]);
        delete_collection(&conn, ids[0]).unwrap();
        assert_eq!(names(&conn), ["Development", "Design & UI", "Aardvark"]);
        // Moving again writes every place.
        let ids: Vec<i64> = get_collections(&conn).unwrap().iter().map(|c| c.id).collect();
        reorder_collections(&conn, &[ids[2], ids[1], ids[0]]).unwrap();
        assert_eq!(names(&conn), ["Aardvark", "Design & UI", "Development"]);
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
        let path = folder.join("koonapin.db");
        let conn = fixtures::fresh_at(&path, 1);
        // Words include «ёлка», domains «пример.рф»; tags, notes, descriptions vary.
        fixtures::generated(&conn, 2_000, 11);
        fixtures::finish(conn);

        let mut conn = Connection::open(&path).unwrap();
        crate::library::configure(&conn).unwrap();
        migrations::migrate(&mut conn, Some(&folder.join("backups"))).unwrap();
        let version = migrations::SCHEMA_VERSION;
        assert_eq!(migrations::user_version(&conn).unwrap(), version);
        assert!(folder
            .join(format!("backups/koonapin.before-v{version}.db"))
            .exists());

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
        trash_bookmark(&conn, bm.id).unwrap();
        purge_trash(&conn, Purge::One(bm.id)).unwrap();
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
