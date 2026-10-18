//! Making a list ("Share as list…", NP-140, frame K2): links of collections
//! or a selection and followed feeds, written as a `.kpin` that
//! [`format::parse`] reads back. Only what the person chose goes in: the
//! list never holds uids, dates of the person's own activity, Inbox, Trash
//! or reading state, and notes only when asked for.

use super::format::{self, AUTHOR_LEN, DESCRIPTION_LEN, ID_LEN, ITEM_TITLE_LEN, SECTION_LEN, TAGS_PER_ITEM, TITLE_LEN};
use crate::{
    commands::{blocking, ExportOutcome, LastExport},
    db::DbState,
    error::CommandError,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, State};
use ts_rs::TS;

/// The version a builder writes.
pub const WRITER_VERSION: &str = "1.0";


/// Where the links and feeds of a list come from (K2, «What goes in»).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ListSource {
    /// The links of a collection, out of the trash.
    Collection { id: i64 },
    /// Selected bookmarks; those in the trash are left out.
    Bookmarks { ids: Vec<i64> },
    /// Followed feeds: these, or every one when none.
    Feeds { uids: Option<Vec<String>> },
}

/// «Sections».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ListSections {
    None,
    /// A link goes under its first tag, alphabetically.
    ByTag,
    ByCollection,
}

/// «License».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ListLicense {
    Cc0,
    CcBy,
    None,
}

impl ListLicense {
    fn spdx(self) -> Option<&'static str> {
        match self {
            ListLicense::Cc0 => Some("CC0-1.0"),
            ListLicense::CcBy => Some("CC-BY-4.0"),
            ListLicense::None => None,
        }
    }
}

/// The form of K2. Text fields come as typed; they are cleaned and capped here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
pub struct ListBuildOptions {
    pub sources: Vec<ListSource>,
    pub title: String,
    pub description: String,
    pub author_name: String,
    /// http(s) only; anything else is left out.
    pub author_url: String,
    pub license: ListLicense,
    /// «Titles and descriptions».
    pub titles: bool,
    pub tags: bool,
    /// «My notes»: a link's note replaces its description; one without a note keeps it.
    pub notes: bool,
    pub sections: ListSections,
    /// The name of the feeds' own section, in the interface's language.
    pub feeds_section: String,
    /// The word after a section of links named as the feeds' one: «Feeds · links».
    pub links_word: String,
    /// «More details»: made into a slug here; empty, none.
    pub id: String,
    /// A BCP 47 tag; anything else is left out.
    pub language: String,
    /// `YYYY-MM-DD`; anything else is left out.
    pub updated: String,
}

/// A followed feed as the builder writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedRow {
    pub uid: String,
    pub url: String,
    /// The name the person sees: their own, else the feed's.
    pub title: Option<String>,
    pub site: Option<String>,
}

impl From<&crate::feeds::Feed> for FeedRow {
    fn from(feed: &crate::feeds::Feed) -> Self {
        FeedRow {
            uid: feed.uid.clone(),
            url: feed.url.clone(),
            title: feed.title.clone().or_else(|| feed.feed_title.clone()),
            site: feed.site_url.clone(),
        }
    }
}

#[derive(Serialize)]
struct ListFile {
    format: &'static str,
    app: &'static str,
    kind: &'static str,
    version: &'static str,
    generator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<Author>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sections: Vec<Section>,
    items: Vec<Item>,
}

#[derive(Serialize)]
struct Author {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize)]
struct Section {
    name: String,
    items: Vec<Item>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item {
    Link {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tags: Vec<String>,
    },
    Feed {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        site: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

/// A bookmark as the builder reads it.
struct Link {
    url: String,
    title: Option<String>,
    description: Option<String>,
    note: Option<String>,
    /// Every tag, by name: the first one names its section «by tag».
    tags: Vec<String>,
    collection: Option<i64>,
}

/// The list's `id`: lowercase ASCII letters and digits, anything else a
/// dash, at most 64 characters. A title in another script has none.
pub fn slug(raw: &str) -> Option<String> {
    let mut slug = String::new();
    for c in raw.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let capped: String = slug.chars().take(ID_LEN).collect();
    let capped = capped.trim_end_matches('-');
    (!capped.is_empty()).then(|| capped.to_owned())
}

/// The links of the sources, in their order and newest first within each,
/// without the trash and without repeats (the same bookmark, or the same
/// address as `dedupe::url_key` compares them).
fn links(conn: &Connection, sources: &[ListSource]) -> rusqlite::Result<Vec<Link>> {
    let mut tags_of = conn.prepare("SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?1 ORDER BY t.name")?;
    let columns = "b.id, b.url, b.title, b.description, b.notes, b.collection_id";
    let mut by_collection = conn.prepare(&format!(
        "SELECT {columns} FROM bookmarks b WHERE b.deleted_at IS NULL AND b.collection_id = ?1 ORDER BY b.created_at DESC, b.id DESC"
    ))?;
    let mut by_ids = conn.prepare(&format!(
        "SELECT {columns} FROM bookmarks b WHERE b.deleted_at IS NULL AND b.id IN (SELECT value FROM json_each(?1)) ORDER BY b.created_at DESC, b.id DESC"
    ))?;
    type Row = (i64, String, Option<String>, Option<String>, Option<String>, Option<i64>);
    let row = |r: &rusqlite::Row| -> rusqlite::Result<Row> { Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)) };
    let (mut seen_ids, mut seen_keys) = (HashSet::new(), HashSet::new());
    let mut found = Vec::new();
    for source in sources {
        let rows: Vec<Row> = match source {
            ListSource::Collection { id } => by_collection.query_map([id], row)?.collect::<Result<_, _>>()?,
            ListSource::Bookmarks { ids } => by_ids.query_map([crate::db::id_list(ids)?], row)?.collect::<Result<_, _>>()?,
            ListSource::Feeds { .. } => continue,
        };
        for (id, url, title, description, note, collection) in rows {
            // What the reader would skip is not written: the file holds only what the preview shows.
            // The reader's own rule, credentials (`user:pass@`) dropped: the file holds what it reads back.
            let Ok(url) = format::link_url(&url) else { continue };
            let key = crate::dedupe::url_key(&url).unwrap_or_else(|| url.clone());
            if !seen_ids.insert(id) || !seen_keys.insert(key) {
                continue;
            }
            let mut tags = Vec::new();
            for name in tags_of.query_map([id], |r| r.get::<_, String>(0))? {
                if let Some(tag) = format::tag(&name?) {
                    if !tags.contains(&tag) {
                        tags.push(tag);
                    }
                }
            }
            tags.sort();
            found.push(Link {
                url,
                title: title.as_deref().and_then(|t| format::line(t, ITEM_TITLE_LEN)),
                description: description.as_deref().and_then(|d| format::paragraph(d, DESCRIPTION_LEN)),
                note: note.as_deref().and_then(|n| format::paragraph(n, DESCRIPTION_LEN)),
                tags,
                collection,
            });
        }
    }
    Ok(found)
}

/// The feeds of the sources, in the order `feeds` holds them, each once.
fn feeds<'a>(sources: &[ListSource], followed: &'a [FeedRow]) -> Vec<&'a FeedRow> {
    let mut wanted: Option<HashSet<&str>> = Some(HashSet::new());
    let mut any = false;
    for source in sources {
        if let ListSource::Feeds { uids } = source {
            any = true;
            match (uids, &mut wanted) {
                (None, _) => wanted = None,
                (Some(uids), Some(set)) => set.extend(uids.iter().map(String::as_str)),
                (Some(_), None) => {}
            }
        }
    }
    if !any {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    followed
        .iter()
        .filter(|f| wanted.as_ref().is_none_or(|set| set.contains(f.uid.as_str())))
        .filter(|f| format::feed_url(&f.url).is_ok_and(|url| seen.insert(url.to_string())))
        .collect()
}

/// The list's text: pretty UTF-8 JSON that [`format::parse`] reads back.
/// With an empty title it is a draft for the preview, which Save refuses.
pub fn build(conn: &Connection, options: &ListBuildOptions, followed: &[FeedRow], generator: &str) -> rusqlite::Result<String> {
    let links = links(conn, &options.sources)?;
    let feeds = feeds(&options.sources, followed);
    // Sections by collection follow the sidebar's order; by tag, the alphabet.
    let collections = match options.sections {
        ListSections::ByCollection => crate::db::get_collections(conn)?,
        _ => Vec::new(),
    };
    let names: HashMap<i64, &str> = collections.iter().map(|c| (c.id, c.name.as_str())).collect();
    let order: Vec<i64> = collections.iter().map(|c| c.id).collect();

    let mut top: Vec<Item> = Vec::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut section_at: HashMap<String, usize> = HashMap::new();
    let mut place = |sections: &mut Vec<Section>, name: String, item: Item| {
        let at = *section_at.entry(name.clone()).or_insert_with(|| {
            sections.push(Section { name, items: Vec::new() });
            sections.len() - 1
        });
        sections[at].items.push(item);
    };
    let mut keyed: Vec<(String, Item)> = Vec::new();
    let mut by_collection: Vec<(usize, String, Item)> = Vec::new();
    for link in links {
        let description = match (options.notes, &link.note) {
            (true, Some(note)) => Some(note.clone()),
            _ if options.titles => link.description.clone(),
            _ => None,
        };
        let mut tags: Vec<String> = if options.tags { link.tags.clone() } else { Vec::new() };
        tags.truncate(TAGS_PER_ITEM);
        let section = match options.sections {
            ListSections::None => None,
            // Only tags the person shares become sections: with «Tags» off none is written.
            ListSections::ByTag if options.tags => link.tags.first().and_then(|t| format::line(t, SECTION_LEN)),
            ListSections::ByTag => None,
            ListSections::ByCollection => link.collection.and_then(|id| names.get(&id)).and_then(|n| format::line(n, SECTION_LEN)),
        };
        let item = Item::Link { url: link.url, title: if options.titles { link.title } else { None }, description, tags };
        match (section, options.sections) {
            (None, _) => top.push(item),
            (Some(name), ListSections::ByCollection) => {
                let rank = link.collection.and_then(|id| order.iter().position(|&o| o == id)).unwrap_or(usize::MAX);
                by_collection.push((rank, name, item));
            }
            (Some(name), _) => keyed.push((name, item)),
        }
    }
    let feeds_name = format::line(&options.feeds_section, SECTION_LEN).unwrap_or_else(|| "Feeds".to_owned());
    // A tag or a collection named as the feeds' section keeps its links apart from the feeds.
    let apart = |name: String| -> String {
        if feeds.is_empty() || name.to_lowercase() != feeds_name.to_lowercase() {
            return name;
        }
        let word = format::line(&options.links_word, SECTION_LEN).unwrap_or_else(|| "links".to_owned());
        format::line(&format!("{name} · {word}"), SECTION_LEN).unwrap_or(name)
    };
    // Stable sorts: within a section the links keep their order.
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, item) in keyed {
        place(&mut sections, apart(name), item);
    }
    by_collection.sort_by_key(|(rank, _, _)| *rank);
    for (_, name, item) in by_collection {
        place(&mut sections, apart(name), item);
    }
    if !feeds.is_empty() {
        let name = feeds_name;
        for feed in feeds {
            // `feeds` kept only addresses `feed_url` reads, without credentials.
            let Ok(url) = format::feed_url(&feed.url).map(|u| u.to_string()) else { continue };
            let item = Item::Feed {
                url,
                site: feed.site.as_deref().and_then(|s| format::link_url(s).ok()),
                title: if options.titles { feed.title.as_deref().and_then(|t| format::line(t, ITEM_TITLE_LEN)) } else { None },
            };
            place(&mut sections, name.clone(), item);
        }
    }

    let author = Author {
        name: format::line(&options.author_name, AUTHOR_LEN),
        url: format::link_url(&options.author_url).ok(),
    };
    let file = ListFile {
        format: "koona",
        app: "pin",
        kind: "list",
        version: WRITER_VERSION,
        generator: generator.to_owned(),
        id: slug(&options.id),
        title: format::line(&options.title, TITLE_LEN).unwrap_or_default(),
        description: format::paragraph(&options.description, DESCRIPTION_LEN),
        author: (author.name.is_some() || author.url.is_some()).then_some(author),
        license: options.license.spdx(),
        language: format::language(options.language.trim()),
        updated: format::date(options.updated.trim()),
        sections,
        items: top,
    };
    Ok(serde_json::to_string_pretty(&file).expect("a list is plain data") + "\n")
}

/// The preview of K2 and the text Save writes: built anew on every change of the form.
#[tauri::command]
pub async fn build_list(app: AppHandle, state: State<'_, Arc<DbState>>, options: ListBuildOptions) -> Result<String, CommandError> {
    let followed: Vec<FeedRow> = if options.sources.iter().any(|s| matches!(s, ListSource::Feeds { .. })) {
        crate::feeds::all_feeds(&app, &state).await?.iter().map(FeedRow::from).collect()
    } else {
        Vec::new()
    };
    let generator = format!("Koona Pin {}", app.package_info().version);
    blocking(&state, move |conn| Ok(build(conn, &options, &followed, &generator)?)).await
}

/// The name Save offers: the list's id, else `list`, with `.kpin`.
pub fn file_name(id: &str) -> String {
    format!("{}.kpin", slug(id).unwrap_or_else(|| "list".to_owned()))
}

/// «Save .kpin…»: the text the preview shows, checked as a reader would
/// read it, through the system Save dialog, written as an export is.
#[tauri::command]
pub async fn save_list(app: AppHandle, last: State<'_, LastExport>, text: String, id: String) -> Result<ExportOutcome, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let checked = text.clone();
    let list = tauri::async_runtime::spawn_blocking(move || format::parse(&checked)).await.map_err(CommandError::internal)??;
    let count = (list.links.len() + list.feeds.len()) as u32;
    let dialog = app.dialog().file().set_file_name(file_name(&id)).add_filter("Koona list", &["kpin"]);
    let dialog = crate::commands::over_main_window(&app, dialog);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(ExportOutcome::Cancelled);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let folder = path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let target = path.clone();
    let written = tauri::async_runtime::spawn_blocking(move || crate::export::write_atomically(&target, text.as_bytes()))
        .await
        .map_err(CommandError::internal)?;
    Ok(match written {
        Ok(()) => {
            *last.0.lock().map_err(CommandError::internal)? = Some(path);
            ExportOutcome::Saved { file_name, count }
        }
        Err(error) => ExportOutcome::Failed { file_name, folder, problem: crate::export::problem_of(&error), detail: error.to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::{apply::apply, format::parse, tests::database, ExistingLinks, ListCollection, ListImportOptions};
    use serde_json::Value;

    const VALID: &str = include_str!("../../tests/fixtures/kpin/valid.kpin");
    const GENERATOR: &str = "Koona Pin 2.4.0";

    /// The links of `valid.kpin` in a collection «Rust», with its sections as tags.
    fn library() -> (Connection, i64) {
        let c = database();
        let list = parse(VALID).unwrap();
        let options = ListImportOptions {
            collection: ListCollection::New { name: "Rust".into() },
            to_inbox: false,
            sections_as_tags: true,
            existing_links: ExistingLinks::Leave,
            follow_feeds: Vec::new(),
        };
        let id = apply(&c, &list, &options, |_, _| {}).unwrap().report.collection_id.unwrap();
        (c, id)
    }

    fn options(sources: Vec<ListSource>) -> ListBuildOptions {
        ListBuildOptions {
            sources,
            title: "  Rust reading  ".into(),
            description: "Blogs and books.".into(),
            author_name: "".into(),
            author_url: "".into(),
            license: ListLicense::Cc0,
            titles: true,
            tags: true,
            notes: false,
            sections: ListSections::None,
            feeds_section: "Feeds".into(),
            links_word: "links".into(),
            id: "rust-reading".into(),
            language: "en".into(),
            updated: "2026-10-18".into(),
        }
    }

    fn feeds() -> Vec<FeedRow> {
        vec![
            FeedRow { uid: "f1".into(), url: "https://blog.rust-lang.org/feed.xml".into(), title: Some("Rust Blog".into()), site: Some("https://blog.rust-lang.org".into()) },
            FeedRow { uid: "f2".into(), url: "https://without.boats/index.xml".into(), title: None, site: None },
        ]
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn id_of(c: &Connection, url: &str) -> i64 {
        c.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get(0)).unwrap()
    }

    /// The rules of `tests/fixtures/kpin/kpin-format.schema.json` a writer
    /// must keep, checked by hand: the crate has no JSON Schema validator.
    fn schema_valid(value: &Value) {
        let schema: Value = serde_json::from_str(include_str!("../../tests/fixtures/kpin/kpin-format.schema.json")).unwrap();
        let root = value.as_object().unwrap();
        for key in schema["required"].as_array().unwrap() {
            assert!(root.contains_key(key.as_str().unwrap()), "required {key}");
        }
        assert_eq!(root["format"], schema["properties"]["format"]["const"]);
        assert!(root.contains_key("items") || root.contains_key("sections"));
        let version = root["version"].as_str().unwrap();
        assert!(version.starts_with("1.") && version[2..].chars().all(|c| c.is_ascii_digit()));
        let text_ok = |v: &Value, max: u64| {
            let s = v.as_str().unwrap();
            assert!(!s.trim().is_empty() && s.chars().count() as u64 <= max, "{s:?}");
        };
        let max = |path: &str| schema.pointer(path).and_then(Value::as_u64).unwrap();
        text_ok(&root["title"], max("/properties/title/maxLength"));
        if let Some(id) = root.get("id") {
            let id = id.as_str().unwrap();
            assert!(slug(id).as_deref() == Some(id), "{id}");
        }
        let http = |v: &Value| {
            let s = v.as_str().unwrap();
            assert!(s.len() <= 2048 && (s.starts_with("http://") || s.starts_with("https://")), "{s}");
        };
        if let Some(author) = root.get("author") {
            if let Some(url) = author.get("url") {
                http(url);
            }
        }
        let item = |item: &Value| {
            http(&item["url"]);
            match item["type"].as_str().unwrap() {
                "link" => {
                    if let Some(title) = item.get("title") {
                        text_ok(title, max("/$defs/link/properties/title/maxLength"));
                    }
                    if let Some(tags) = item.get("tags") {
                        let tags = tags.as_array().unwrap();
                        assert!(tags.len() as u64 <= max("/$defs/link/properties/tags/maxItems"));
                        let unique: HashSet<&str> = tags.iter().map(|t| t.as_str().unwrap()).collect();
                        assert_eq!(unique.len(), tags.len());
                        tags.iter().for_each(|t| text_ok(t, 64));
                    }
                }
                "feed" => {
                    if let Some(site) = item.get("site") {
                        http(site);
                    }
                }
                other => panic!("a writer writes no {other}"),
            }
        };
        let sections = root.get("sections").and_then(Value::as_array).cloned().unwrap_or_default();
        assert!(sections.len() as u64 <= max("/properties/sections/maxItems"));
        for section in &sections {
            text_ok(&section["name"], max("/properties/sections/items/properties/name/maxLength"));
            section["items"].as_array().unwrap().iter().for_each(item);
        }
        root.get("items").and_then(Value::as_array).cloned().unwrap_or_default().iter().for_each(item);
    }

    #[test]
    fn a_collection_becomes_a_list_that_reads_back() {
        let (c, rust) = library();
        let mut opts = options(vec![ListSource::Collection { id: rust }, ListSource::Feeds { uids: None }]);
        opts.author_name = " Koona ".into();
        opts.author_url = "https://koona.app".into();
        let text = build(&c, &opts, &feeds(), GENERATOR).unwrap();
        let value = json(&text);
        schema_valid(&value);
        assert_eq!(value["format"], "koona");
        assert_eq!(value["app"], "pin");
        assert_eq!(value["kind"], "list");
        assert_eq!(value["version"], "1.0");
        assert_eq!(value["generator"], GENERATOR);
        assert_eq!(value["license"], "CC0-1.0");
        assert_eq!(value["author"], serde_json::json!({ "name": "Koona", "url": "https://koona.app" }));

        let list = parse(&text).unwrap();
        assert_eq!(list.meta.title, "Rust reading");
        assert_eq!(list.meta.description.as_deref(), Some("Blogs and books."));
        assert_eq!(list.meta.id.as_deref(), Some("rust-reading"));
        assert_eq!(list.meta.language.as_deref(), Some("en"));
        assert_eq!(list.meta.updated.as_deref(), Some("2026-10-18"));
        assert_eq!((list.links.len(), list.feeds.len()), (3, 2));
        assert_eq!((list.repeated, list.not_web, list.invalid, list.skipped_items, list.skipped_details), (0, 0, 0, 0, 0));
        let nomicon = list.links.iter().find(|l| l.url == "https://doc.rust-lang.org/nomicon/").unwrap();
        assert_eq!(nomicon.title.as_deref(), Some("The Rustonomicon"));
        assert_eq!(nomicon.description.as_deref(), Some("The dark arts of unsafe Rust."));
        assert_eq!(nomicon.tags, ["book", "compiler and language", "unsafe"]);
        // Feeds always have their own section; the links stay at the top level.
        assert_eq!(value["sections"].as_array().unwrap().len(), 1);
        assert_eq!(value["sections"][0]["name"], "Feeds");
        assert_eq!(value["items"].as_array().unwrap().len(), 3);
        assert_eq!(list.feeds[0].title.as_deref(), Some("Rust Blog"));
        assert_eq!(list.feeds[0].site.as_deref(), Some("https://blog.rust-lang.org"));
        assert_eq!(list.feeds[1].title, None);
    }

    #[test]
    fn nothing_of_the_persons_own_goes_in() {
        let (c, rust) = library();
        let text = build(&c, &options(vec![ListSource::Collection { id: rust }]), &[], GENERATOR).unwrap();
        for word in ["uid", "created_at", "triaged", "deleted", "inbox", "reading", "read_at", "notes", "favorite", "source", "collection"] {
            assert!(!text.contains(&format!("\"{word}")), "{word} in {text}");
        }
    }

    #[test]
    fn sections_by_tag_take_the_first_tag_alphabetically() {
        let (c, rust) = library();
        let mut opts = options(vec![ListSource::Collection { id: rust }]);
        opts.sections = ListSections::ByTag;
        let value = json(&build(&c, &opts, &[], GENERATOR).unwrap());
        schema_valid(&value);
        let names: Vec<&str> = value["sections"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        // Nomicon: book < compiler and language < unsafe; Tokio: async < runtime.
        assert_eq!(names, ["async", "book"]);
        assert_eq!(value["sections"][1]["items"][0]["url"], "https://doc.rust-lang.org/nomicon/");
        // The untagged link stays at the top level.
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
        assert_eq!(value["items"][0]["url"], "https://this-week-in-rust.org/");
        let list = parse(&value.to_string()).unwrap();
        assert_eq!(list.sections, 2);
        // With «Tags» off the tags are kept out of the sections too.
        opts.tags = false;
        let value = json(&build(&c, &opts, &[], GENERATOR).unwrap());
        assert!(value.get("sections").is_none(), "{value}");
        assert_eq!(value["items"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn sections_by_collection_follow_the_sidebar() {
        let (c, _) = library();
        let other = crate::db::create_collection(&c, "Async", None, None).unwrap();
        let tokio = id_of(&c, "https://tokio.rs/");
        c.execute("UPDATE bookmarks SET collection_id = ?1 WHERE id = ?2", [other.id, tokio]).unwrap();
        let loose = id_of(&c, "https://this-week-in-rust.org/");
        c.execute("UPDATE bookmarks SET collection_id = NULL WHERE id = ?1", [loose]).unwrap();
        let all: Vec<i64> = c.prepare("SELECT id FROM bookmarks").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let mut opts = options(vec![ListSource::Bookmarks { ids: all }, ListSource::Feeds { uids: Some(vec!["f2".into()]) }]);
        opts.sections = ListSections::ByCollection;
        let value = json(&build(&c, &opts, &feeds(), GENERATOR).unwrap());
        schema_valid(&value);
        let names: Vec<&str> = value["sections"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        // By name, as the sidebar has them before any are moved by hand; feeds last.
        assert_eq!(names, ["Async", "Rust", "Feeds"]);
        assert_eq!(value["sections"][0]["items"][0]["url"], "https://tokio.rs/");
        assert_eq!(value["sections"][2]["items"].as_array().unwrap().len(), 1, "only the chosen feed");
        assert_eq!(value["items"][0]["url"], "https://this-week-in-rust.org/");
    }

    #[test]
    fn notes_replace_descriptions_only_when_asked_and_only_where_there_is_one() {
        let (c, rust) = library();
        c.execute("UPDATE bookmarks SET notes = 'My private thought' WHERE url = 'https://tokio.rs/'", []).unwrap();
        c.execute("UPDATE bookmarks SET description = 'Async runtime.' WHERE url = 'https://tokio.rs/'", []).unwrap();
        let mut opts = options(vec![ListSource::Collection { id: rust }]);
        let off = build(&c, &opts, &[], GENERATOR).unwrap();
        assert!(!off.contains("My private thought"));
        assert!(off.contains("Async runtime."));
        opts.notes = true;
        let on = parse(&build(&c, &opts, &[], GENERATOR).unwrap()).unwrap();
        let tokio = on.links.iter().find(|l| l.url == "https://tokio.rs/").unwrap();
        assert_eq!(tokio.description.as_deref(), Some("My private thought"));
        let nomicon = on.links.iter().find(|l| l.url == "https://doc.rust-lang.org/nomicon/").unwrap();
        assert_eq!(nomicon.description.as_deref(), Some("The dark arts of unsafe Rust."), "no note: its own description");
        // Without titles and descriptions, a note still goes in when asked for; nothing else does.
        opts.titles = false;
        opts.tags = false;
        let bare = parse(&build(&c, &opts, &feeds(), GENERATOR).unwrap()).unwrap();
        assert!(bare.links.iter().all(|l| l.title.is_none() && l.tags.is_empty()));
        assert_eq!(bare.links.iter().filter(|l| l.description.is_some()).count(), 1);
    }

    #[test]
    fn the_trash_and_repeats_stay_out() {
        let (c, rust) = library();
        let tokio = id_of(&c, "https://tokio.rs/");
        crate::db::trash_bookmark(&c, tokio).unwrap();
        let nomicon = id_of(&c, "https://doc.rust-lang.org/nomicon/");
        // The collection and a selection with the same bookmark: once.
        let opts = options(vec![ListSource::Collection { id: rust }, ListSource::Bookmarks { ids: vec![nomicon, tokio] }]);
        let list = parse(&build(&c, &opts, &[], GENERATOR).unwrap()).unwrap();
        assert_eq!(list.links.len(), 2);
        assert_eq!(list.repeated, 0);
        assert!(list.links.iter().all(|l| l.url != "https://tokio.rs/"));
    }

    #[test]
    fn details_are_cleaned_or_left_out() {
        let (c, rust) = library();
        let mut opts = options(vec![ListSource::Collection { id: rust }]);
        opts.id = "Rust Blogs, 2026!".into();
        opts.language = "not a language".into();
        opts.updated = "yesterday".into();
        opts.author_url = "mailto:me@example.com".into();
        opts.license = ListLicense::None;
        let value = json(&build(&c, &opts, &[], GENERATOR).unwrap());
        assert_eq!(value["id"], "rust-blogs-2026");
        for key in ["language", "updated", "author", "license"] {
            assert!(value.get(key).is_none(), "{key}");
        }
        opts.license = ListLicense::CcBy;
        assert_eq!(json(&build(&c, &opts, &[], GENERATOR).unwrap())["license"], "CC-BY-4.0");
        assert_eq!(slug("Блоги о Rust"), Some("rust".into()));
        assert_eq!(slug("Блоги"), None);
        assert_eq!(file_name("Блоги"), "list.kpin");
        assert_eq!(file_name("rust-blogs"), "rust-blogs.kpin");
        assert_eq!(slug(&"a".repeat(80)).unwrap().len(), ID_LEN);
    }

    #[test]
    fn a_draft_without_a_title_is_not_a_list() {
        let (c, rust) = library();
        let mut opts = options(vec![ListSource::Collection { id: rust }]);
        opts.title = "   ".into();
        assert_eq!(parse(&build(&c, &opts, &[], GENERATOR).unwrap()).err(), Some(crate::lists::ListError::NotAList));
        // Nothing chosen: a list with no items, which the reader calls empty.
        let empty = options(Vec::new());
        assert_eq!(parse(&build(&c, &empty, &[], GENERATOR).unwrap()).err(), Some(crate::lists::ListError::Empty));
    }

    #[test]
    fn user_names_and_passwords_never_leave_an_address() {
        let (c, rust) = library();
        c.execute("UPDATE bookmarks SET url = 'https://me:secret@tokio.rs/' WHERE url = 'https://tokio.rs/'", []).unwrap();
        let followed = vec![FeedRow {
            uid: "f9".into(),
            url: "https://reader:pw@example.com/feed.xml".into(),
            title: None,
            site: Some("https://reader@example.com/".into()),
        }];
        let mut opts = options(vec![ListSource::Collection { id: rust }, ListSource::Feeds { uids: None }]);
        opts.author_url = "https://me:pw@koona.app/".into();
        let text = build(&c, &opts, &followed, GENERATOR).unwrap();
        for private in ["me:secret", "secret@", "reader", ":pw@"] {
            assert!(!text.contains(private), "{private} in {text}");
        }
        let list = parse(&text).unwrap();
        assert!(list.links.iter().any(|l| l.url == "https://tokio.rs/"));
        assert_eq!(list.feeds[0].url, "https://example.com/feed.xml");
        assert_eq!(list.feeds[0].site.as_deref(), Some("https://example.com/"));
        assert_eq!(list.meta.author_url.as_deref(), Some("https://koona.app/"));
        // An address without them is written as it was.
        assert_eq!(format::link_url("https://example.com/a?b=c#d").unwrap(), "https://example.com/a?b=c#d");
    }

    #[test]
    fn a_section_named_as_the_feeds_one_keeps_its_links_apart() {
        let (c, _) = library();
        let named = crate::db::create_collection(&c, "FEEDS", None, None).unwrap();
        c.execute("UPDATE bookmarks SET collection_id = ?1 WHERE url = 'https://tokio.rs/'", [named.id]).unwrap();
        let tokio = id_of(&c, "https://tokio.rs/");
        let mut opts = options(vec![ListSource::Bookmarks { ids: vec![tokio] }, ListSource::Feeds { uids: None }]);
        opts.sections = ListSections::ByCollection;
        let value = json(&build(&c, &opts, &feeds(), GENERATOR).unwrap());
        schema_valid(&value);
        let names: Vec<&str> = value["sections"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["FEEDS · links", "Feeds"]);
        assert_eq!(value["sections"][1]["items"].as_array().unwrap().len(), 2, "only the feeds");
        // By tag: a tag «feeds».
        c.execute("INSERT INTO tags (name, uid, created_at) VALUES ('feeds', 'tag-feeds', '2026-10-18T00:00:00Z')", []).unwrap();
        c.execute("INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT ?1, id FROM tags WHERE name = 'feeds'", [tokio]).unwrap();
        opts.sections = ListSections::ByTag;
        let value = json(&build(&c, &opts, &feeds(), GENERATOR).unwrap());
        let names: Vec<&str> = value["sections"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["async", "Feeds"], "the first tag alphabetically is async");
        c.execute("DELETE FROM bookmark_tags WHERE bookmark_id = ?1 AND tag_id <> (SELECT id FROM tags WHERE name = 'feeds')", [tokio]).unwrap();
        let value = json(&build(&c, &opts, &feeds(), GENERATOR).unwrap());
        let names: Vec<&str> = value["sections"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["feeds · links", "Feeds"]);
        // Without feeds in the list the name stays as it is.
        let alone = options(vec![ListSource::Bookmarks { ids: vec![tokio] }]);
        let value = json(&build(&c, &ListBuildOptions { sections: ListSections::ByTag, ..alone }, &feeds(), GENERATOR).unwrap());
        assert_eq!(value["sections"][0]["name"], "feeds");
    }

    /// Each link's address and its tags, sorted, as the library holds them.
    fn tags_by_url(c: &Connection) -> Vec<(String, Vec<String>)> {
        let mut statement = c
            .prepare(
                "SELECT b.url, coalesce(group_concat(t.name, '|'), '') FROM bookmarks b
                 LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id LEFT JOIN tags t ON t.id = bt.tag_id
                 WHERE b.deleted_at IS NULL GROUP BY b.id ORDER BY b.url",
            )
            .unwrap();
        let rows = statement
            .query_map([], |r| {
                let mut tags: Vec<String> = r.get::<_, String>(1)?.split('|').filter(|t| !t.is_empty()).map(str::to_owned).collect();
                tags.sort();
                Ok((r.get(0)?, tags))
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn a_list_built_here_imports_into_another_library_and_is_all_here_in_its_own() {
        // The library: valid.kpin's links in «Rust», their feeds followed, a private note on one.
        let original = database();
        let source = parse(VALID).unwrap();
        let followed: Vec<String> = source.feeds.iter().map(|f| f.url.clone()).collect();
        let options_in = ListImportOptions {
            collection: ListCollection::New { name: "Rust".into() },
            to_inbox: false,
            sections_as_tags: true,
            existing_links: ExistingLinks::Leave,
            follow_feeds: followed.clone(),
        };
        let rust = apply(&original, &source, &options_in, |_, _| {}).unwrap().report.collection_id.unwrap();
        original.execute("UPDATE bookmarks SET notes = 'private' WHERE url = 'https://tokio.rs/'", []).unwrap();
        let rows: Vec<FeedRow> = original
            .prepare("SELECT uid, url FROM feeds ORDER BY url")
            .unwrap()
            .query_map([], |r| Ok(FeedRow { uid: r.get(0)?, url: r.get(1)?, title: None, site: None }))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.len(), 2);

        // Built with sections by tag and no notes.
        let mut opts = options(vec![ListSource::Collection { id: rust }, ListSource::Feeds { uids: None }]);
        opts.sections = ListSections::ByTag;
        let text = build(&original, &opts, &rows, GENERATOR).unwrap();
        assert!(!text.contains("private"));

        // Into a fresh library, with sections as tags.
        let fresh = database();
        let list = parse(&text).unwrap();
        let preview = crate::lists::preview::preview(&fresh, &list, "rust-reading.kpin").unwrap();
        assert_eq!((preview.links, preview.feeds, preview.new_links, preview.new_feeds.len(), preview.repeated), (3, 2, 3, 2, 0));
        assert_eq!((preview.not_web, preview.invalid, preview.skipped_items, preview.skipped_details), (0, 0, 0, 0));
        // Two links went under a tag and the feeds have a section of their own; one link has none.
        assert_eq!((preview.sections, preview.sectioned_links), (3, 2));
        let options_out = ListImportOptions {
            collection: ListCollection::New { name: list.meta.title.clone() },
            to_inbox: false,
            sections_as_tags: true,
            existing_links: ExistingLinks::Leave,
            follow_feeds: preview.new_feeds.iter().map(|f| f.url.clone()).collect(),
        };
        let report = apply(&fresh, &list, &options_out, |_, _| {}).unwrap().report;
        assert_eq!((report.added, report.feeds_followed, report.repeated, report.already_saved), (3, 2, 0, 0));
        // The same links with the same tags: a section by tag is one of the link's tags.
        assert_eq!(tags_by_url(&fresh), tags_by_url(&original));
        let feeds_of = |c: &Connection| -> Vec<String> { c.prepare("SELECT url FROM feeds ORDER BY url").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect() };
        assert_eq!(feeds_of(&fresh), feeds_of(&original));
        let notes: i64 = fresh.query_row("SELECT count(*) FROM bookmarks WHERE notes IS NOT NULL AND notes != ''", [], |r| r.get(0)).unwrap();
        assert_eq!(notes, 0, "no note travels");

        // In its own library everything is here already.
        let home = crate::lists::preview::preview(&original, &list, "rust-reading.kpin").unwrap();
        assert_eq!((home.new_links, home.already_saved, home.in_trash, home.feeds_followed, home.new_feeds.len()), (0, 3, 0, 2, 0));
    }
}
