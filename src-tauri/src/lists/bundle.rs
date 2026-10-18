//! Making a list of what the bundle holds: sections the interface keeps in
//! memory as ids, written as a `.kpin` that [`format::parse`] reads back.
//! The sections are a snapshot of what was added; a bookmark's title,
//! description and tags are read here, as the library has them now. As for
//! [`super::export`], the list never holds uids, dates of the person's own
//! activity, Inbox, Trash or reading state, and a note only when asked for.

use super::export::{self, Author, FeedRow, Item, ListFile, Section, WRITER_VERSION};
use super::format::{self, AUTHOR_LEN, DESCRIPTION_LEN, ITEM_TITLE_LEN, MAX_BYTES, MAX_ITEMS, MAX_SECTIONS, SECTION_LEN, TAGS_PER_ITEM, TITLE_LEN};
use crate::{commands::blocking, db::DbState, error::CommandError};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, State};
use ts_rs::TS;

/// What made a section of the bundle.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum BundleOrigin {
    /// A collection: the section takes its current name, else the stored one.
    Collection { id: i64 },
    Tag { name: String },
    /// Bookmarks added one by one or by a view: the list's top-level `items`.
    Links,
    /// Feeds: one section named by `BundleModel::feeds_section`.
    Feeds,
}

/// An item of the bundle, by id.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum BundleItem {
    /// `use_note`: the bookmark's note goes in as its description.
    Bookmark { id: i64, use_note: bool },
    Feed { uid: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
pub struct BundleSection {
    /// The name when the section was added: a collection's, if it is gone, or the tag's.
    pub name: String,
    pub origin: BundleOrigin,
    pub items: Vec<BundleItem>,
}

/// The bundle as the interface holds it. Text fields come as typed; they are cleaned and capped here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
pub struct BundleModel {
    pub title: String,
    pub description: String,
    pub author_name: String,
    /// The name of the feeds' section, in the interface's language.
    pub feeds_section: String,
    /// The word after a section of links named as the feeds' one: «Feeds · links».
    pub links_word: String,
    pub sections: Vec<BundleSection>,
}

/// The list's text and what went in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct BundleBuild {
    pub text: String,
    /// Links and feeds written.
    pub items: u32,
    /// Items left out because they were deleted, moved to the trash or unfollowed.
    pub left: u32,
    /// Past the format's limits (2 MB, 5,000 items, 200 sections): the size the
    /// text would have, in bytes, and `text` is empty. Save refuses such a list.
    pub too_big: Option<u32>,
}

/// A bookmark as the bundle writes it, or `None` when it is gone or in the trash.
fn link(conn: &Connection, id: i64, use_note: bool) -> rusqlite::Result<Option<Item>> {
    let row = conn
        .prepare_cached("SELECT url, title, description, notes FROM bookmarks WHERE id = ?1 AND deleted_at IS NULL")?
        .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))
        .optional()?;
    let Some((url, title, description, note)) = row else { return Ok(None) };
    let mut tags = Vec::new();
    let mut tags_of = conn.prepare_cached("SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?1 ORDER BY t.name")?;
    for name in tags_of.query_map([id], |r| r.get::<_, String>(0))? {
        if let Some(tag) = format::tag(&name?) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    tags.sort();
    tags.truncate(TAGS_PER_ITEM);
    let note = note.as_deref().and_then(|n| format::paragraph(n, DESCRIPTION_LEN)).filter(|_| use_note);
    Ok(Some(Item::Link {
        url,
        title: title.as_deref().and_then(|t| format::line(t, ITEM_TITLE_LEN)),
        description: note.or_else(|| description.as_deref().and_then(|d| format::paragraph(d, DESCRIPTION_LEN))),
        tags,
    }))
}

/// The list's text; past the format's limits, its size in `too_big` instead.
/// `language` is the interface's; `today` is `YYYY-MM-DD`.
pub fn build(
    conn: &Connection,
    model: &BundleModel,
    followed: &[FeedRow],
    generator: &str,
    language: &str,
    today: &str,
) -> rusqlite::Result<BundleBuild> {
    let feeds_by_uid: HashMap<&str, &FeedRow> = followed.iter().map(|f| (f.uid.as_str(), f)).collect();
    let feeds_name = format::line(&model.feeds_section, SECTION_LEN).unwrap_or_else(|| "Feeds".to_owned());
    let mut collection_name = conn.prepare_cached("SELECT name FROM collections WHERE id = ?1")?;
    let (mut seen_links, mut seen_feeds) = (HashSet::new(), HashSet::new());
    let (mut items, mut left) = (0u32, 0u32);
    let mut top: Vec<Item> = Vec::new();
    // Named sections in the model's order, merged by name once their names are final.
    let mut named: Vec<(String, Vec<Item>)> = Vec::new();
    let mut feed_items: Vec<Item> = Vec::new();
    for section in &model.sections {
        let name = match &section.origin {
            BundleOrigin::Links => None,
            BundleOrigin::Feeds => None,
            BundleOrigin::Collection { id } => {
                let current: Option<String> = collection_name.query_row([id], |r| r.get(0)).optional()?;
                Some(current.and_then(|n| format::line(&n, SECTION_LEN)).or_else(|| format::line(&section.name, SECTION_LEN)).unwrap_or_default())
            }
            BundleOrigin::Tag { name } => Some(format::line(name, SECTION_LEN).or_else(|| format::line(&section.name, SECTION_LEN)).unwrap_or_default()),
        };
        let mut written = Vec::new();
        for item in &section.items {
            match item {
                BundleItem::Bookmark { id, use_note } => {
                    let Some(Item::Link { url, title, description, tags }) = link(conn, *id, *use_note)? else {
                        left += 1;
                        continue;
                    };
                    // What the reader would skip is not written; credentials (`user:pass@`) are dropped.
                    let Ok(url) = format::link_url(&url) else { continue };
                    let key = crate::dedupe::url_key(&url).unwrap_or_else(|| url.clone());
                    if !seen_links.insert(key) {
                        continue;
                    }
                    written.push(Item::Link { url, title, description, tags });
                }
                BundleItem::Feed { uid } => {
                    let Some(feed) = feeds_by_uid.get(uid.as_str()) else {
                        left += 1;
                        continue;
                    };
                    let Ok(url) = format::feed_url(&feed.url).map(|u| u.to_string()) else { continue };
                    if !seen_feeds.insert(url.clone()) {
                        continue;
                    }
                    written.push(Item::Feed {
                        url,
                        site: feed.site.as_deref().and_then(|s| format::link_url(s).ok()),
                        title: feed.title.as_deref().and_then(|t| format::line(t, ITEM_TITLE_LEN)),
                    });
                }
            }
        }
        items += written.len() as u32;
        match name {
            // Feeds are one section, written last whatever the model's order.
            _ if section.origin == BundleOrigin::Feeds => feed_items.extend(written),
            None => top.extend(written),
            Some(_) if written.is_empty() => {}
            // A section without a name reads as the top level: so it is written.
            Some(name) if name.is_empty() => top.extend(written),
            Some(name) => named.push((name, written)),
        }
    }
    // A collection or a tag named as the feeds' section keeps its links apart from the feeds.
    let apart = |name: String| -> String {
        if feed_items.is_empty() || name.to_lowercase() != feeds_name.to_lowercase() {
            return name;
        }
        let word = format::line(&model.links_word, SECTION_LEN).unwrap_or_else(|| "links".to_owned());
        format::line(&format!("{name} · {word}"), SECTION_LEN).unwrap_or(name)
    };
    let mut sections: Vec<Section> = Vec::new();
    for (name, written) in named {
        let name = apart(name);
        match sections.iter_mut().find(|s| s.name == name) {
            Some(same) => same.items.extend(written),
            None => sections.push(Section { name, items: written }),
        }
    }
    if !feed_items.is_empty() {
        sections.push(Section { name: feeds_name, items: feed_items });
    }
    let section_count = sections.len();
    let title = format::line(&model.title, TITLE_LEN).unwrap_or_default();
    let author = format::line(&model.author_name, AUTHOR_LEN);
    let file = ListFile {
        format: "koona",
        app: "pin",
        kind: "list",
        version: WRITER_VERSION,
        generator: generator.to_owned(),
        id: export::slug(&title),
        description: format::paragraph(&model.description, DESCRIPTION_LEN),
        title,
        author: author.map(|name| Author { name: Some(name), url: None }),
        license: Some("CC0-1.0"),
        language: format::language(language.trim()),
        updated: format::date(today),
        sections,
        items: top,
    };
    let text = serde_json::to_string_pretty(&file).expect("a list is plain data") + "\n";
    if items as usize > MAX_ITEMS || section_count > MAX_SECTIONS || text.len() > MAX_BYTES {
        let bytes = u32::try_from(text.len()).unwrap_or(u32::MAX);
        return Ok(BundleBuild { text: String::new(), items, left, too_big: Some(bytes) });
    }
    Ok(BundleBuild { text, items, left, too_big: None })
}

/// The bundle's list: what the panel checks its limits by and Save and Copy use.
#[tauri::command]
pub async fn build_bundle_list(app: AppHandle, state: State<'_, Arc<DbState>>, model: BundleModel) -> Result<BundleBuild, CommandError> {
    let has_feeds = model.sections.iter().any(|s| s.items.iter().any(|i| matches!(i, BundleItem::Feed { .. })));
    let followed: Vec<FeedRow> = if has_feeds {
        crate::feeds::all_feeds(&app, &state).await?.iter().map(FeedRow::from).collect()
    } else {
        Vec::new()
    };
    let generator = format!("Koona Pin {}", app.package_info().version);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    blocking(&state, move |conn| {
        let language = crate::sorting::stored_language(conn).unwrap_or_default();
        Ok(build(conn, &model, &followed, &generator, &language, &today)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::ListError;
    use crate::lists::{apply::apply, format::parse, tests::database, ExistingLinks, ListCollection, ListImportOptions};
    use serde_json::Value;

    const VALID: &str = include_str!("../../tests/fixtures/kpin/valid.kpin");
    const GENERATOR: &str = "Koona Pin 2.5.0";

    /// The links of `valid.kpin` in a collection «Rust», with its sections as tags.
    fn library() -> (Connection, i64) {
        let c = database();
        let options = ListImportOptions {
            collection: ListCollection::New { name: "Rust".into() },
            to_inbox: false,
            sections_as_tags: true,
            existing_links: ExistingLinks::Leave,
            follow_feeds: Vec::new(),
            leave_out: Vec::new(),
        };
        let id = apply(&c, &parse(VALID).unwrap(), &options, |_, _| {}).unwrap().report.collection_id.unwrap();
        (c, id)
    }

    fn id_of(c: &Connection, url: &str) -> i64 {
        c.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get(0)).unwrap()
    }

    fn feeds() -> Vec<FeedRow> {
        vec![
            FeedRow { uid: "f1".into(), url: "https://blog.rust-lang.org/feed.xml".into(), title: Some("Rust Blog".into()), site: Some("https://blog.rust-lang.org".into()) },
            FeedRow { uid: "f2".into(), url: "https://without.boats/index.xml".into(), title: None, site: None },
        ]
    }

    fn bookmark(id: i64) -> BundleItem {
        BundleItem::Bookmark { id, use_note: false }
    }

    fn model(sections: Vec<BundleSection>) -> BundleModel {
        BundleModel { title: "  Rust reading  ".into(), description: "Blogs and books.".into(), author_name: " Koona ".into(), feeds_section: "Feeds".into(), links_word: "links".into(), sections }
    }

    fn section(name: &str, origin: BundleOrigin, items: Vec<BundleItem>) -> BundleSection {
        BundleSection { name: name.into(), origin, items }
    }

    fn built(c: &Connection, model: &BundleModel) -> BundleBuild {
        build(c, model, &feeds(), GENERATOR, "en", "2026-10-18").unwrap()
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn names(value: &Value) -> Vec<String> {
        value["sections"].as_array().map_or_else(Vec::new, |s| s.iter().map(|s| s["name"].as_str().unwrap().to_owned()).collect())
    }

    /// Everything of `valid.kpin`: the collection, a loose link and both feeds.
    fn everything(c: &Connection, rust: i64) -> BundleModel {
        let loose = id_of(c, "https://this-week-in-rust.org/");
        let in_rust = [id_of(c, "https://doc.rust-lang.org/nomicon/"), id_of(c, "https://tokio.rs/")];
        model(vec![
            section("Links", BundleOrigin::Links, vec![bookmark(loose)]),
            section("Rust", BundleOrigin::Collection { id: rust }, in_rust.into_iter().map(bookmark).collect()),
            section("Feeds", BundleOrigin::Feeds, vec![BundleItem::Feed { uid: "f1".into() }, BundleItem::Feed { uid: "f2".into() }]),
        ])
    }

    #[test]
    fn links_are_the_top_level_and_feeds_have_their_section() {
        let (c, rust) = library();
        let mut m = everything(&c, rust);
        m.feeds_section = "Ленты".into();
        let b = built(&c, &m);
        assert_eq!((b.items, b.left), (5, 0));
        let value = json(&b.text);
        assert_eq!(names(&value), ["Rust", "Ленты"], "no section named Links");
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
        assert_eq!(value["items"][0]["url"], "https://this-week-in-rust.org/");
        assert_eq!(value["sections"][1]["items"].as_array().unwrap().len(), 2);
        // A model without a feeds name still names them.
        m.feeds_section = "  ".into();
        assert_eq!(names(&json(&built(&c, &m).text)), ["Rust", "Feeds"]);
    }

    #[test]
    fn the_file_is_cc0_named_after_its_title_and_dated() {
        let (c, rust) = library();
        let value = json(&built(&c, &everything(&c, rust)).text);
        assert_eq!((&value["format"], &value["app"], &value["kind"], &value["version"]), (&"koona".into(), &"pin".into(), &"list".into(), &"1.0".into()));
        assert_eq!(value["license"], "CC0-1.0");
        assert_eq!(value["id"], "rust-reading");
        assert_eq!(value["title"], "Rust reading");
        assert_eq!(value["description"], "Blogs and books.");
        assert_eq!(value["author"], serde_json::json!({ "name": "Koona" }));
        assert_eq!((&value["language"], &value["updated"], &value["generator"]), (&"en".into(), &"2026-10-18".into(), &GENERATOR.into()));
        // A title in another script has no slug; a language the format does not know is left out.
        let mut m = everything(&c, rust);
        m.title = "Блоги".into();
        m.author_name = "".into();
        let value = json(&build(&c, &m, &feeds(), GENERATOR, "not a language", "2026-10-18").unwrap().text);
        for key in ["id", "language", "author"] {
            assert!(value.get(key).is_none(), "{key}");
        }
        assert_eq!(value["license"], "CC0-1.0");
    }

    #[test]
    fn a_collection_takes_its_current_name_or_keeps_the_stored_one() {
        let (c, rust) = library();
        c.execute("UPDATE collections SET name = 'Rust, renamed' WHERE id = ?1", [rust]).unwrap();
        assert_eq!(names(&json(&built(&c, &everything(&c, rust)).text)), ["Rust, renamed", "Feeds"]);
        // Deleted: the name it had when it was added, its links as they are.
        crate::db::delete_collection(&c, rust).unwrap();
        let b = built(&c, &everything(&c, rust));
        assert_eq!(names(&json(&b.text)), ["Rust", "Feeds"]);
        assert_eq!((b.items, b.left), (5, 0));
    }

    #[test]
    fn a_trashed_or_deleted_item_is_left_out_and_counted() {
        let (c, rust) = library();
        crate::db::trash_bookmark(&c, id_of(&c, "https://tokio.rs/")).unwrap();
        let nomicon = id_of(&c, "https://doc.rust-lang.org/nomicon/");
        let mut m = everything(&c, rust);
        c.execute("DELETE FROM bookmarks WHERE id = ?1", [nomicon]).unwrap();
        // An unfollowed feed is gone as well.
        m.sections[2].items.push(BundleItem::Feed { uid: "gone".into() });
        let b = built(&c, &m);
        assert_eq!((b.items, b.left), (3, 3));
        let list = parse(&b.text).unwrap();
        assert!(list.links.iter().all(|l| l.url != "https://tokio.rs/" && l.url != "https://doc.rust-lang.org/nomicon/"));
        // The collection's section had nothing left: it is not written.
        assert_eq!(names(&json(&b.text)), ["Feeds"]);
    }

    #[test]
    fn a_note_goes_in_only_when_asked_for() {
        let (c, rust) = library();
        c.execute("UPDATE bookmarks SET notes = 'My private thought', description = 'Async runtime.' WHERE url = 'https://tokio.rs/'", []).unwrap();
        let tokio = id_of(&c, "https://tokio.rs/");
        let nomicon = id_of(&c, "https://doc.rust-lang.org/nomicon/");
        let with = |use_note: bool| {
            let m = model(vec![section("Links", BundleOrigin::Links, vec![BundleItem::Bookmark { id: tokio, use_note }, BundleItem::Bookmark { id: nomicon, use_note: true }])]);
            parse(&built(&c, &m).text).unwrap()
        };
        let off = with(false);
        assert_eq!(off.links[0].description.as_deref(), Some("Async runtime."));
        let on = with(true);
        assert_eq!(on.links[0].description.as_deref(), Some("My private thought"));
        assert_eq!(on.links[1].description.as_deref(), Some("The dark arts of unsafe Rust."), "no note: its own description");
        // Its tags and title come as the library has them now.
        assert_eq!(on.links[1].tags, ["book", "compiler and language", "unsafe"]);
        assert_eq!(on.links[1].title.as_deref(), Some("The Rustonomicon"));
        let _ = rust;
    }

    #[test]
    fn an_address_is_kept_once_in_the_first_section_it_is_in() {
        let (c, rust) = library();
        let tokio = id_of(&c, "https://tokio.rs/");
        // Another bookmark with the same page by `url_key`.
        c.execute("INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at) VALUES ('w', 'https://www.tokio.rs/?utm_source=x', 'Tokio again', 'tokio.rs', 'x', 'x')", []).unwrap();
        let again = id_of(&c, "https://www.tokio.rs/?utm_source=x");
        let m = model(vec![
            section("Links", BundleOrigin::Links, vec![bookmark(tokio)]),
            section("Rust", BundleOrigin::Collection { id: rust }, vec![bookmark(again), bookmark(tokio), bookmark(id_of(&c, "https://doc.rust-lang.org/nomicon/"))]),
            section("Feeds", BundleOrigin::Feeds, vec![BundleItem::Feed { uid: "f1".into() }, BundleItem::Feed { uid: "f1".into() }]),
        ]);
        let b = built(&c, &m);
        assert_eq!((b.items, b.left), (3, 0));
        let value = json(&b.text);
        assert_eq!(value["items"][0]["url"], "https://tokio.rs/");
        assert_eq!(value["sections"][0]["items"].as_array().unwrap().len(), 1);
        let list = parse(&b.text).unwrap();
        assert_eq!((list.links.len(), list.feeds.len(), list.repeated), (2, 1, 0));
    }

    #[test]
    fn a_tag_section_is_named_by_the_tag() {
        let (c, _) = library();
        let tokio = id_of(&c, "https://tokio.rs/");
        let m = model(vec![section("runtime", BundleOrigin::Tag { name: "runtime".into() }, vec![bookmark(tokio)])]);
        let value = json(&built(&c, &m).text);
        assert_eq!(names(&value), ["runtime"]);
        assert!(value["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn past_a_limit_the_bundle_is_too_big() {
        let c = database();
        let insert = |n: usize, long: bool| -> Vec<i64> {
            let tx = c.unchecked_transaction().unwrap();
            let mut ids = Vec::new();
            let description = if long { "d".repeat(DESCRIPTION_LEN) } else { String::new() };
            for i in 0..n {
                tx.execute(
                    "INSERT INTO bookmarks (uid, url, title, description, domain, created_at, updated_at) VALUES (?1, ?2, 't', ?3, 'example.com', 'x', 'x')",
                    rusqlite::params![format!("u{long}{i}"), format!("https://example.com/{long}/{i}"), description],
                )
                .unwrap();
                ids.push(tx.last_insert_rowid());
            }
            tx.commit().unwrap();
            ids
        };
        let links = |ids: &[i64]| model(vec![section("Links", BundleOrigin::Links, ids.iter().copied().map(bookmark).collect())]);
        let ids = insert(MAX_ITEMS + 1, false);
        assert_eq!(built(&c, &links(&ids[..MAX_ITEMS])).items as usize, MAX_ITEMS);
        let over = |m: &BundleModel| build(&c, m, &[], GENERATOR, "en", "2026-10-18").unwrap();
        assert_eq!(built(&c, &links(&ids[..MAX_ITEMS])).too_big, None);
        let items = over(&links(&ids));
        assert!(items.text.is_empty() && items.too_big.is_some_and(|b| b as usize <= MAX_BYTES), "items");
        // Sections: 200 named ones are fine, 201 are not.
        let sectioned = |n: usize| model((0..n).map(|i| section(&format!("S{i}"), BundleOrigin::Tag { name: format!("s{i}") }, vec![bookmark(ids[i])])).collect());
        assert_eq!(over(&sectioned(MAX_SECTIONS)).too_big, None);
        assert!(over(&sectioned(MAX_SECTIONS + 1)).too_big.is_some(), "sections");
        // Bytes: 1,100 links with long descriptions are past 2 MB.
        let long = insert(1_100, true);
        // The size comes back, for «2.3 MB of 2 MB».
        let bytes = over(&links(&long));
        assert!(bytes.text.is_empty() && bytes.too_big.is_some_and(|b| b as usize > MAX_BYTES), "bytes");
    }

    #[test]
    fn a_section_named_as_the_feeds_one_keeps_its_links_apart() {
        let (c, rust) = library();
        c.execute("UPDATE collections SET name = 'FEEDS' WHERE id = ?1", [rust]).unwrap();
        let tokio = id_of(&c, "https://tokio.rs/");
        let mut m = everything(&c, rust);
        m.sections.push(section("feeds", BundleOrigin::Tag { name: "feeds".into() }, vec![bookmark(tokio), bookmark(id_of(&c, "https://doc.rust-lang.org/nomicon/"))]));
        let value = json(&built(&c, &m).text);
        // The tag's links were all in the collection already: it has none left.
        assert_eq!(names(&value), ["FEEDS · links", "Feeds"]);
        assert_eq!(value["sections"][1]["items"].as_array().unwrap().len(), 2, "only the feeds");
        // Without feeds in the bundle the name stays as it is.
        m.sections.retain(|s| s.origin != BundleOrigin::Feeds);
        assert_eq!(names(&json(&built(&c, &m).text)), ["FEEDS"]);
    }

    #[test]
    fn feeds_are_written_last_whatever_the_order() {
        let (c, rust) = library();
        let mut m = everything(&c, rust);
        m.sections.reverse();
        let value = json(&built(&c, &m).text);
        assert_eq!(names(&value), ["Rust", "Feeds"]);
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_tag_section_takes_the_tags_name() {
        let (c, _) = library();
        let tokio = id_of(&c, "https://tokio.rs/");
        let m = model(vec![section("Runtime, as added", BundleOrigin::Tag { name: "runtime".into() }, vec![bookmark(tokio)])]);
        assert_eq!(names(&json(&built(&c, &m).text)), ["runtime"]);
        let blank = model(vec![section("runtime", BundleOrigin::Tag { name: "  ".into() }, vec![bookmark(tokio)])]);
        assert_eq!(names(&json(&built(&c, &blank).text)), ["runtime"]);
    }

    #[test]
    fn an_emptied_section_is_left_out_and_the_rest_stays() {
        let (c, rust) = library();
        crate::db::trash_bookmark(&c, id_of(&c, "https://tokio.rs/")).unwrap();
        crate::db::trash_bookmark(&c, id_of(&c, "https://doc.rust-lang.org/nomicon/")).unwrap();
        let mut m = everything(&c, rust);
        m.sections.retain(|s| s.origin != BundleOrigin::Feeds);
        let b = built(&c, &m);
        assert_eq!((b.items, b.left), (1, 2));
        let value = json(&b.text);
        assert!(value.get("sections").is_none(), "{value}");
        assert_eq!(value["items"][0]["url"], "https://this-week-in-rust.org/");
        assert_eq!(parse(&b.text).unwrap().sections, 0);
    }

    #[test]
    fn without_a_title_the_build_is_a_draft_save_refuses() {
        let (c, rust) = library();
        let mut m = everything(&c, rust);
        m.title = "   ".into();
        let b = built(&c, &m);
        assert_eq!(b.items, 5);
        let value = json(&b.text);
        assert_eq!(value["title"], "");
        assert!(value.get("id").is_none());
        assert_eq!(parse(&b.text).err(), Some(ListError::NotAList));
    }

    #[test]
    fn the_model_reads_as_the_interface_sends_it() {
        let m: BundleModel = serde_json::from_value(serde_json::json!({
            "title": "T", "description": "", "author_name": "", "feeds_section": "Feeds", "links_word": "links",
            "sections": [
                { "name": "Links", "origin": { "kind": "links" }, "items": [{ "kind": "bookmark", "id": 1, "use_note": true }] },
                { "name": "Dev", "origin": { "kind": "collection", "id": 4 }, "items": [] },
                { "name": "crypto", "origin": { "kind": "tag", "name": "crypto" }, "items": [] },
                { "name": "Feeds", "origin": { "kind": "feeds" }, "items": [{ "kind": "feed", "uid": "abc" }] }
            ]
        }))
        .unwrap();
        assert_eq!(m.sections[0].items[0], BundleItem::Bookmark { id: 1, use_note: true });
        assert_eq!(m.sections[1].origin, BundleOrigin::Collection { id: 4 });
        assert_eq!(m.sections[2].origin, BundleOrigin::Tag { name: "crypto".into() });
        assert_eq!(m.sections[3].items[0], BundleItem::Feed { uid: "abc".into() });
    }

    #[test]
    fn a_bundle_reads_back_and_imports_into_an_empty_library_as_the_same_items() {
        let (c, rust) = library();
        let b = built(&c, &everything(&c, rust));
        let list = parse(&b.text).unwrap();
        assert_eq!((list.links.len(), list.feeds.len(), list.sections), (3, 2, 2));
        assert_eq!((list.repeated, list.not_web, list.invalid, list.skipped_items, list.skipped_details), (0, 0, 0, 0, 0));
        let fresh = database();
        let preview = crate::lists::preview::preview(&fresh, &list, "rust-reading.kpin").unwrap();
        assert_eq!((preview.new_links, preview.new_feeds.len()), (3, 2));
        let options = ListImportOptions {
            collection: ListCollection::None,
            to_inbox: false,
            sections_as_tags: false,
            existing_links: ExistingLinks::Leave,
            follow_feeds: preview.new_feeds.iter().map(|f| f.url.clone()).collect(),
            leave_out: Vec::new(),
        };
        let report = apply(&fresh, &list, &options, |_, _| {}).unwrap().report;
        assert_eq!((report.added, report.feeds_followed), (3, 2));
        let items = |c: &Connection| -> Vec<(String, Option<String>, Option<String>)> {
            c.prepare("SELECT url, title, description FROM bookmarks WHERE deleted_at IS NULL ORDER BY url")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(items(&fresh), items(&c));
        let tags = |c: &Connection| -> Vec<(String, String)> {
            c.prepare("SELECT b.url, t.name FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id JOIN tags t ON t.id = bt.tag_id ORDER BY 1, 2")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(tags(&fresh), tags(&c));
        let followed: Vec<String> = fresh.prepare("SELECT url FROM feeds ORDER BY url").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(followed, ["https://blog.rust-lang.org/feed.xml", "https://without.boats/index.xml"]);
    }
}
