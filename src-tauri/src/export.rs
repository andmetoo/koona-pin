//! Export of the library (NP-032, frame 29, Р-30): HTML for browsers, JSON —
//! the full versioned copy, CSV for spreadsheets. The file is written next
//! to the target and renamed over it only when complete.

use crate::db;
use chrono::{DateTime, Local, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ExportFormat {
    Html,
    Json,
    Csv,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Html => "html",
            ExportFormat::Json => "json",
            ExportFormat::Csv => "csv",
        }
    }
}

/// The JSON format: `format` and `version` say what the file is, the rest
/// is the library. Version 1 (Р-30); NP-033 restores it.
pub const JSON_FORMAT: &str = "koona-pin";
pub const JSON_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonCollection {
    pub uid: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonTag {
    pub uid: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonBookmark {
    pub uid: String,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub domain: String,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub is_favorite: bool,
    /// The `uid` of its collection.
    pub collection: Option<String>,
    /// Tag names; each is in `tags` of the file.
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Empty: waiting in the inbox.
    pub triaged_at: Option<String>,
    /// Set: in the trash since then.
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonLibrary {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub collections: Vec<JsonCollection>,
    pub tags: Vec<JsonTag>,
    pub bookmarks: Vec<JsonBookmark>,
}

/// What an export takes: the library, or the bookmarks selected (NP-029).
#[derive(Debug, Clone, Copy)]
pub enum Scope<'a> {
    Library,
    /// Exactly these, wherever they are: a selection in the trash exports
    /// what was selected there.
    Selected(&'a [i64]),
}

impl<'a> Scope<'a> {
    /// The selection when there is one, else the library.
    pub fn of(ids: Option<&'a [i64]>) -> Self {
        ids.map_or(Scope::Library, Scope::Selected)
    }
}

/// Every bookmark with its collection uid and tags, in list order (newest
/// first). The trash only when asked: HTML and CSV leave it out.
fn bookmarks(conn: &Connection, scope: Scope, with_trash: bool) -> rusqlite::Result<Vec<JsonBookmark>> {
    let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
    let mut statement = conn.prepare(
        // By name: the copy is the same whatever order the tags were created in.
        "SELECT bt.bookmark_id, t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id ORDER BY bt.bookmark_id, t.name",
    )?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, name) = row?;
        tags.entry(id).or_default().push(name);
    }
    // The selection binds its ids; the library binds nothing.
    let (filter, params): (&str, Vec<String>) = match scope {
        Scope::Selected(ids) => (
            "WHERE b.id IN (SELECT value FROM json_each(?1))",
            vec![db::id_list(ids)?],
        ),
        Scope::Library if with_trash => ("", Vec::new()),
        Scope::Library => ("WHERE b.deleted_at IS NULL", Vec::new()),
    };
    let mut statement = conn.prepare(&format!(
        "SELECT b.id, b.uid, b.url, b.title, b.description, b.notes, b.domain, b.image_url, b.favicon_url, b.is_favorite,
                c.uid, b.source, b.created_at, b.updated_at, b.triaged_at, b.deleted_at
         FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id {filter}
         ORDER BY b.created_at DESC, b.id DESC"
    ))?;
    let rows = statement.query_map(rusqlite::params_from_iter(params), |r| {
        Ok(JsonBookmark {
            tags: tags.remove(&r.get::<_, i64>(0)?).unwrap_or_default(),
            uid: r.get(1)?,
            url: r.get(2)?,
            title: r.get(3)?,
            description: r.get(4)?,
            notes: r.get(5)?,
            domain: r.get(6)?,
            image_url: r.get(7)?,
            favicon_url: r.get(8)?,
            is_favorite: r.get::<_, i64>(9)? != 0,
            collection: r.get(10)?,
            source: r.get(11)?,
            created_at: r.get(12)?,
            updated_at: r.get(13)?,
            triaged_at: r.get(14)?,
            deleted_at: r.get(15)?,
        })
    })?;
    rows.collect()
}

fn collections(conn: &Connection) -> rusqlite::Result<Vec<JsonCollection>> {
    conn.prepare("SELECT uid, name, color, icon, created_at FROM collections ORDER BY name COLLATE NOCASE, id")?
        .query_map([], |r| {
            Ok(JsonCollection { uid: r.get(0)?, name: r.get(1)?, color: r.get(2)?, icon: r.get(3)?, created_at: r.get(4)? })
        })?
        .collect()
}

/// The full copy: inbox and trash included, every field the user can set.
/// A selection carries only the collections and tags its bookmarks use.
pub fn json(conn: &Connection, scope: Scope, now: DateTime<Utc>) -> rusqlite::Result<(String, usize)> {
    let mut tags = conn
        .prepare("SELECT uid, name, created_at FROM tags ORDER BY name")?
        .query_map([], |r| Ok(JsonTag { uid: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let marks = bookmarks(conn, scope, true)?;
    let mut folders = collections(conn)?;
    if let Scope::Selected(_) = scope {
        folders.retain(|c| marks.iter().any(|b| b.collection.as_deref() == Some(c.uid.as_str())));
        tags.retain(|t| marks.iter().any(|b| b.tags.contains(&t.name)));
    }
    let library = JsonLibrary {
        format: JSON_FORMAT.into(),
        version: JSON_VERSION,
        exported_at: db::stamp(now),
        app_version: env!("CARGO_PKG_VERSION").into(),
        collections: folders,
        tags,
        bookmarks: marks,
    };
    let count = library.bookmarks.len();
    let text = serde_json::to_string_pretty(&library).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok((text + "\n", count))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Unix seconds, as browsers write `ADD_DATE`.
fn unix(stamp: &str) -> i64 {
    DateTime::parse_from_rfc3339(stamp).map(|t| t.timestamp()).unwrap_or(0)
}

/// The Netscape bookmarks file Chrome, Edge and Firefox import: collections
/// become folders, a bookmark without one sits at the top, tags go in
/// `TAGS` (Firefox reads them), notes in `DD`. The trash stays out.
pub fn html(conn: &Connection, scope: Scope) -> rusqlite::Result<(String, usize)> {
    let marks = bookmarks(conn, scope, false)?;
    let folders = collections(conn)?;
    let link = |b: &JsonBookmark, indent: &str| {
        let mut line = format!(
            "{indent}<DT><A HREF=\"{}\" ADD_DATE=\"{}\" LAST_MODIFIED=\"{}\"",
            escape(&b.url),
            unix(&b.created_at),
            unix(&b.updated_at)
        );
        if !b.tags.is_empty() {
            line.push_str(&format!(" TAGS=\"{}\"", escape(&b.tags.join(","))));
        }
        line.push_str(&format!(">{}</A>\n", escape(&b.title)));
        if let Some(notes) = b.notes.as_deref().filter(|n| !n.trim().is_empty()) {
            line.push_str(&format!("{indent}<DD>{}\n", escape(&notes.split_whitespace().collect::<Vec<_>>().join(" "))));
        }
        line
    };
    let mut out = String::from(
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n",
    );
    for folder in &folders {
        let inside: Vec<&JsonBookmark> = marks.iter().filter(|b| b.collection.as_deref() == Some(folder.uid.as_str())).collect();
        if inside.is_empty() {
            continue;
        }
        out.push_str(&format!("    <DT><H3 ADD_DATE=\"{}\">{}</H3>\n    <DL><p>\n", unix(&folder.created_at), escape(&folder.name)));
        for b in inside {
            out.push_str(&link(b, "        "));
        }
        out.push_str("    </DL><p>\n");
    }
    for b in marks.iter().filter(|b| b.collection.is_none()) {
        out.push_str(&link(b, "    "));
    }
    out.push_str("</DL><p>\n");
    Ok((out, marks.len()))
}

/// Column titles of the CSV, in the interface's language.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct CsvColumns {
    pub title: String,
    pub url: String,
    pub domain: String,
    pub collection: String,
    pub tags: String,
    pub notes: String,
    pub favorite: String,
    pub inbox: String,
    pub saved: String,
}

/// A field as Excel reads it: quoted when it holds the separator, a quote,
/// a line break or edge spaces. A leading `=`, `+`, `-`, `@` or tab would be
/// a formula in a spreadsheet, so such a field starts with `'`.
fn field(value: &str, separator: char) -> String {
    let value = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{value}") } else { value.to_owned() };
    if value.contains([separator, '"', '\n', '\r']) || value.starts_with(' ') || value.ends_with(' ') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// UTF-8 with a byte order mark and CRLF, the separator of the system's
/// list settings: Excel opens it with a double click (owner's choice).
/// The trash stays out; times are local.
pub fn csv(conn: &Connection, scope: Scope, columns: &CsvColumns, separator: char) -> rusqlite::Result<(String, usize)> {
    let marks = bookmarks(conn, scope, false)?;
    let names: HashMap<String, String> = collections(conn)?.into_iter().map(|c| (c.uid, c.name)).collect();
    let join = |fields: Vec<String>| fields.join(&separator.to_string()) + "\r\n";
    let mut out = String::from("\u{feff}");
    out.push_str(&join(
        [&columns.title, &columns.url, &columns.domain, &columns.collection, &columns.tags, &columns.notes, &columns.favorite, &columns.inbox, &columns.saved]
            .iter()
            .map(|c| field(c, separator))
            .collect(),
    ));
    let tag_separator = if separator == ',' { "; " } else { ", " };
    for b in &marks {
        let saved = DateTime::parse_from_rfc3339(&b.created_at)
            .map(|t| t.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        let collection = b.collection.as_ref().and_then(|uid| names.get(uid)).cloned().unwrap_or_default();
        out.push_str(&join(vec![
            field(&b.title, separator),
            field(&b.url, separator),
            field(&b.domain, separator),
            field(&collection, separator),
            field(&b.tags.join(tag_separator), separator),
            field(b.notes.as_deref().unwrap_or(""), separator),
            if b.is_favorite { "1" } else { "0" }.into(),
            if b.triaged_at.is_none() { "1" } else { "0" }.into(),
            saved,
        ]));
    }
    Ok((out, marks.len()))
}

/// The list separator of the Windows region settings; `,` elsewhere or when
/// it cannot be read or is not a single usable character.
pub fn list_separator() -> char {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (key, value) = (wide("Control Panel\\International"), wide("sList"));
        let mut buffer = [0u16; 8];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: the buffer and its size are passed together; the call writes at most `size` bytes.
        let status = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
        };
        if status == 0 {
            let read: String = char::decode_utf16(buffer.iter().copied().take_while(|&c| c != 0)).filter_map(Result::ok).collect();
            let mut chars = read.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if !matches!(c, '"' | '\r' | '\n' | ' ' | '\'') && !c.is_alphanumeric() {
                    return c;
                }
            }
        }
    }
    ','
}

/// Written next to the target under a temporary name, flushed to disk and
/// renamed over it: the old file stays as it was until the new one is
/// complete, and a failure leaves no half-written file.
pub fn write_atomically(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let folder = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = folder.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// Why a file was not saved, for the alert of frame 29.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExportProblem {
    DiskFull,
    /// The folder or the file may not be written to, or the file is read-only.
    NoPermission,
    /// Another program has the file open.
    InUse,
    Other,
}

pub fn problem_of(error: &std::io::Error) -> ExportProblem {
    use std::io::ErrorKind;
    // Windows codes: ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION; ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL.
    // On Linux the same numbers are other errors (39 is ENOTEMPTY), and ENOSPC is StorageFull.
    let windows_code = if cfg!(windows) { error.raw_os_error() } else { None };
    match (error.kind(), windows_code) {
        (_, Some(32 | 33)) => ExportProblem::InUse,
        (ErrorKind::StorageFull, _) | (_, Some(39 | 112)) => ExportProblem::DiskFull,
        (ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem, _) => ExportProblem::NoPermission,
        _ => ExportProblem::Other,
    }
}

/// `koona-pin-2026-10-04.html`: the local date of the export; a selection
/// is `koona-pin-selected-…`, so it does not replace a copy of the library.
pub fn default_name(format: ExportFormat, scope: Scope) -> String {
    let what = if let Scope::Selected(_) = scope { "selected-" } else { "" };
    format!("koona-pin-{what}{}.{}", Local::now().format("%Y-%m-%d"), format.extension())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        db::register_functions(&c).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    /// The Chrome file imported, plus edits: notes, a star, a bookmark in the trash, one in the inbox.
    fn library() -> Connection {
        let c = database();
        let now = Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap();
        crate::import::import(&c, &crate::import::parse(include_str!("../../tests/fixtures/bookmarks/chrome.html"), now), false, |_, _| {}).unwrap();
        let id = |url: &str| c.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get::<_, i64>(0)).unwrap();
        db::update_bookmark(&c, id("https://github.com/"), Some("GitHub \"code\" & <more>".into()), Some("заметка;\nвторая строка".into()), Some(true), None, None).unwrap();
        db::trash_bookmark(&c, id("https://habr.com/ru/articles/")).unwrap();
        c.execute("UPDATE bookmarks SET triaged_at = NULL, title = '=HYPERLINK(1)' WHERE url = 'https://m.example.com/'", []).unwrap();
        c
    }

    #[test]
    fn json_is_the_full_versioned_copy_with_inbox_and_trash() {
        let c = library();
        let (text, count) = json(&c, Scope::Library, Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap()).unwrap();
        let parsed: JsonLibrary = serde_json::from_str(&text).unwrap();
        assert_eq!((parsed.format.as_str(), parsed.version, count, parsed.bookmarks.len()), ("koona-pin", 1, 7, 7));
        assert_eq!(parsed.exported_at, "2026-10-04T12:00:00.000Z");
        let work = parsed.collections.iter().find(|c| c.name == "Работа").unwrap();
        let tokio = parsed.bookmarks.iter().find(|b| b.url == "https://tokio.rs/").unwrap();
        assert_eq!(tokio.collection.as_deref(), Some(work.uid.as_str()));
        assert_eq!(tokio.tags, ["async", "rust"]);
        assert_eq!(tokio.created_at, "2023-07-22T04:31:40.000Z");
        let github = parsed.bookmarks.iter().find(|b| b.url == "https://github.com/").unwrap();
        assert_eq!((github.is_favorite, github.notes.as_deref()), (true, Some("заметка;\nвторая строка")));
        assert!(parsed.bookmarks.iter().find(|b| b.url == "https://habr.com/ru/articles/").unwrap().deleted_at.is_some());
        assert!(parsed.bookmarks.iter().find(|b| b.url == "https://m.example.com/").unwrap().triaged_at.is_none());
        assert!(parsed.tags.iter().any(|t| t.name == "async" && !t.uid.is_empty()));
    }

    #[test]
    fn html_goes_back_through_our_import_with_folders_tags_and_dates() {
        let c = library();
        let (text, count) = html(&c, Scope::Library).unwrap();
        assert_eq!(count, 6, "the trash stays out");
        assert!(text.starts_with("<!DOCTYPE NETSCAPE-Bookmark-file-1>"));
        assert!(text.contains(r#"GitHub &quot;code&quot; &amp; &lt;more&gt;</A>"#));
        assert!(!text.contains("habr.com"));
        let back = crate::import::parse(&text, Utc::now());
        assert!(back.skipped.is_empty());
        let tokio = back.links.iter().find(|l| l.url == "https://tokio.rs/").unwrap();
        assert_eq!((tokio.collection.as_deref(), tokio.tags.as_slice(), tokio.added_at.as_deref()), (Some("Работа"), &["async".to_string(), "rust".to_string()][..], Some("2023-07-22T04:31:40.000Z")));
        let github = back.links.iter().find(|l| l.url == "https://github.com/").unwrap();
        assert_eq!(github.title, "GitHub \"code\" & <more>");
        assert_eq!(back.links.iter().find(|l| l.url == "https://news.ycombinator.com/").unwrap().collection, None);
        // Into an empty library: the same collections, nothing skipped.
        let fresh = database();
        let summary = crate::import::import(&fresh, &back, false, |_, _| {}).unwrap();
        assert_eq!((summary.added, summary.collections.len()), (6, 2));
    }

    #[test]
    fn csv_for_excel_bom_separator_quotes_formulas_and_local_times() {
        let c = library();
        let columns = CsvColumns {
            title: "Название".into(),
            url: "Адрес".into(),
            domain: "Сайт".into(),
            collection: "Коллекция".into(),
            tags: "Теги".into(),
            notes: "Заметка".into(),
            favorite: "Избранное".into(),
            inbox: "Во входящих".into(),
            saved: "Сохранено".into(),
        };
        let (text, count) = csv(&c, Scope::Library, &columns, ';').unwrap();
        assert_eq!(count, 6);
        assert!(text.starts_with("\u{feff}Название;Адрес;Сайт;Коллекция;Теги;Заметка;Избранное;Во входящих;Сохранено\r\n"));
        let tokio = text.lines().find(|l| l.contains("tokio.rs")).unwrap();
        assert!(tokio.starts_with("Tokio;https://tokio.rs/;tokio.rs;Работа;async, rust;;0;0;2023-07-22 "), "{tokio}");
        assert!(text.contains("GitHub \"\"code\"\" & <more>") && text.contains("\"заметка;\nвторая строка\";1;0;"));
        assert!(text.contains("'=HYPERLINK(1);https://m.example.com/;m.example.com;;;;0;1;"));
        assert!(!text.contains("habr.com"));
        // With a comma separator the tags are joined by «; » and quoted only when needed.
        let (comma, _) = csv(&c, Scope::Library, &columns, ',').unwrap();
        assert!(comma.contains("Tokio,https://tokio.rs/,tokio.rs,Работа,async; rust,,0,0,"));
    }

    #[test]
    fn a_selection_exports_exactly_what_was_selected() {
        let c = library();
        let id = |url: &str| c.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get::<_, i64>(0)).unwrap();
        // Tokio is in «Работа», habr.com in the trash: selected there, it is exported too.
        let ids = [id("https://tokio.rs/"), id("https://habr.com/ru/articles/")];
        let selected = Scope::Selected(&ids);
        let (text, count) = json(&c, selected, Utc::now()).unwrap();
        let parsed: JsonLibrary = serde_json::from_str(&text).unwrap();
        assert_eq!(count, 2);
        let mut urls: Vec<&str> = parsed.bookmarks.iter().map(|b| b.url.as_str()).collect();
        urls.sort();
        assert_eq!(urls, ["https://habr.com/ru/articles/", "https://tokio.rs/"]);
        let mut used: Vec<&str> = parsed.bookmarks.iter().flat_map(|b| b.tags.iter().map(String::as_str)).collect();
        used.sort();
        used.dedup();
        let mut tags: Vec<&str> = parsed.tags.iter().map(|t| t.name.as_str()).collect();
        tags.sort();
        assert_eq!(tags, used, "only the tags the selection uses");
        assert!(parsed.collections.iter().all(|f| parsed.bookmarks.iter().any(|b| b.collection.as_deref() == Some(f.uid.as_str()))));
        assert!(parsed.collections.iter().any(|f| f.name == "Работа"));
        let (text, count) = html(&c, selected).unwrap();
        assert_eq!(count, 2);
        assert!(text.contains("tokio.rs") && text.contains("habr.com") && !text.contains("github.com"));
        let (_, count) = csv(&c, Scope::Selected(&ids[..1]), &CsvColumns {
            title: "t".into(), url: "u".into(), domain: "d".into(), collection: "c".into(), tags: "g".into(),
            notes: "n".into(), favorite: "f".into(), inbox: "i".into(), saved: "s".into(),
        }, ';').unwrap();
        assert_eq!(count, 1);
        assert!(default_name(ExportFormat::Csv, selected).starts_with("koona-pin-selected-"));
        assert!(!default_name(ExportFormat::Csv, Scope::Library).contains("selected"));
    }

    #[test]
    fn a_failed_write_leaves_the_old_file_and_no_temporary_one() {
        let folder = std::env::temp_dir().join(format!("koonapin-export-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&folder).unwrap();
        let target = folder.join("library.json");
        std::fs::write(&target, "old").unwrap();
        write_atomically(&target, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");

        // A target that is a folder cannot be replaced: the error is reported, nothing is left behind.
        let blocked = folder.join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        assert!(write_atomically(&blocked, b"new").is_err());
        // A read-only file on Windows, a folder without write permission on Unix: the same. On Unix a
        // rename may replace a read-only file, as editors do; the folder decides.
        #[cfg(windows)]
        let locked = &target;
        #[cfg(unix)]
        let locked = &folder;
        let mut permissions = std::fs::metadata(locked).unwrap().permissions();
        let writable = permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(locked, permissions).unwrap();
        let result = write_atomically(&target, b"newer");
        let left: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name()).collect();
        std::fs::set_permissions(locked, writable).unwrap();
        assert_eq!(problem_of(&result.unwrap_err()), ExportProblem::NoPermission);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(left.len(), 2, "no temporary file: {left:?}");
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn problems_are_named_by_the_error() {
        use std::io::{Error, ErrorKind};
        #[cfg(windows)]
        {
            assert_eq!(problem_of(&Error::from_raw_os_error(112)), ExportProblem::DiskFull);
            assert_eq!(problem_of(&Error::from_raw_os_error(32)), ExportProblem::InUse);
        }
        // ENOSPC, and ENOTEMPTY and EPIPE, which share numbers with Windows codes.
        #[cfg(target_os = "linux")]
        {
            assert_eq!(problem_of(&Error::from_raw_os_error(28)), ExportProblem::DiskFull);
            assert_eq!(problem_of(&Error::from_raw_os_error(39)), ExportProblem::Other);
            assert_eq!(problem_of(&Error::from_raw_os_error(32)), ExportProblem::Other);
        }
        assert_eq!(problem_of(&Error::from(ErrorKind::PermissionDenied)), ExportProblem::NoPermission);
        assert_eq!(problem_of(&Error::from(ErrorKind::NotFound)), ExportProblem::Other);
    }

    /// The three files of the sample library, for importing into browsers and
    /// opening in Excel by hand (doc/testing.md):
    /// `KOONAPIN_EXPORT_SAMPLES=<folder> cargo test --lib export::tests::write_samples -- --ignored`
    #[test]
    #[ignore]
    fn write_samples() {
        let folder = std::path::PathBuf::from(std::env::var("KOONAPIN_EXPORT_SAMPLES").expect("KOONAPIN_EXPORT_SAMPLES"));
        std::fs::create_dir_all(&folder).unwrap();
        let c = library();
        let columns = CsvColumns {
            title: "Название".into(),
            url: "Адрес".into(),
            domain: "Сайт".into(),
            collection: "Коллекция".into(),
            tags: "Теги".into(),
            notes: "Заметка".into(),
            favorite: "Избранное".into(),
            inbox: "Во входящих".into(),
            saved: "Сохранено".into(),
        };
        write_atomically(&folder.join("sample.html"), html(&c, Scope::Library).unwrap().0.as_bytes()).unwrap();
        write_atomically(&folder.join("sample.json"), json(&c, Scope::Library, Utc::now()).unwrap().0.as_bytes()).unwrap();
        write_atomically(&folder.join("sample.csv"), csv(&c, Scope::Library, &columns, list_separator()).unwrap().0.as_bytes()).unwrap();
    }

    /// How long the three files take for a large library (doc/testing.md):
    /// `cargo test --release --lib export::tests::large_libraries -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn large_libraries() {
        for size in [10_000, 100_000] {
            let c = database();
            c.execute_batch(&format!(
                "INSERT INTO collections (uid, name, created_at) VALUES ('c1', 'Полка', '2026-01-01T00:00:00.000Z');
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {size})
                 INSERT INTO bookmarks (uid, url, title, domain, notes, collection_id, created_at, updated_at, triaged_at)
                 SELECT 'u' || i, 'https://example.com/' || i, 'Запись ' || i, 'example.com', 'заметка ' || i,
                        CASE WHEN i % 2 = 0 THEN (SELECT id FROM collections) END,
                        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM n;"
            ))
            .unwrap();
            let columns = CsvColumns {
                title: "t".into(), url: "u".into(), domain: "d".into(), collection: "c".into(), tags: "g".into(),
                notes: "n".into(), favorite: "f".into(), inbox: "i".into(), saved: "s".into(),
            };
            for (name, run) in [
                ("html", Box::new(|| html(&c, Scope::Library).unwrap()) as Box<dyn Fn() -> (String, usize)>),
                ("json", Box::new(|| json(&c, Scope::Library, Utc::now()).unwrap())),
                ("csv", Box::new(|| csv(&c, Scope::Library, &columns, ';').unwrap())),
            ] {
                let started = std::time::Instant::now();
                let (text, count) = run();
                assert_eq!(count, size);
                println!("{size} bookmarks, {name}: {:?}, {} KB", started.elapsed(), text.len() / 1024);
            }
        }
    }

    #[test]
    fn the_list_separator_is_one_usable_character() {
        let separator = list_separator();
        assert!(!separator.is_alphanumeric() && separator != '"', "{separator:?}");
    }
}
