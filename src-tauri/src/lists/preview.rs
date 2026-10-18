//! What a list would do to this library, for the dialog before anything is
//! written (K1). Reads only.

use super::format::{self, ParsedList};
use super::{CollectionMatch, ListFeedEntry, ListPreview, ListPreviewGroup, ListPreviewItem, ListPreviewKind, ListPreviewStatus};
use crate::db;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;

/// The bookmark with this exact address, and whether it is in the trash.
fn bookmark_at(conn: &Connection, url: &str) -> rusqlite::Result<Option<(i64, bool)>> {
    conn.prepare_cached("SELECT id, deleted_at IS NOT NULL FROM bookmarks WHERE url = ?1")?
        .query_row([url], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
}

/// Whether the library has a bookmark with this exact address: in the trash
/// (`Some(true)`) or out of it (`Some(false)`). The rule of Р-29.
pub(crate) fn saved(conn: &Connection, url: &str) -> rusqlite::Result<Option<bool>> {
    Ok(bookmark_at(conn, url)?.map(|(_, trashed)| trashed))
}

/// The followed feed with this address, by its uid.
fn feed_at(conn: &Connection, url: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT uid FROM feeds WHERE url = ?1")?.query_row([url], |r| r.get(0)).optional()
}

pub(crate) fn followed(conn: &Connection, url: &str) -> rusqlite::Result<bool> {
    Ok(feed_at(conn, url)?.is_some())
}

/// A row of the preview: where it is in the file, its first section, and the row itself.
type Row<'a> = (usize, Option<&'a str>, ListPreviewItem);

/// One row per link and feed, each looked up in the library once; the counts and the groups
/// are both taken from these rows. Links first, then feeds, each in the list's order.
fn rows<'a>(conn: &Connection, list: &'a ParsedList) -> rusqlite::Result<Vec<Row<'a>>> {
    let mut rows: Vec<Row<'a>> = Vec::with_capacity(list.links.len() + list.feeds.len());
    for link in &list.links {
        let (status, bookmark_id) = match bookmark_at(conn, &link.url)? {
            Some((id, true)) => (ListPreviewStatus::InTrash, Some(id)),
            Some((id, false)) => (ListPreviewStatus::Saved, Some(id)),
            None => (ListPreviewStatus::New, None),
        };
        let item = ListPreviewItem {
            kind: ListPreviewKind::Link,
            url: link.url.clone(),
            title: link.title.clone(),
            host: crate::metadata::extract_domain(&link.url),
            site: None,
            status,
            bookmark_id,
            feed_uid: None,
        };
        rows.push((link.at, link.sections.first().map(String::as_str), item));
    }
    for feed in &list.feeds {
        let feed_uid = feed_at(conn, &feed.url)?;
        let item = ListPreviewItem {
            kind: ListPreviewKind::Feed,
            url: feed.url.clone(),
            title: feed.title.clone(),
            host: crate::metadata::extract_domain(&feed.url),
            site: feed.site.clone(),
            status: if feed_uid.is_some() { ListPreviewStatus::Followed } else { ListPreviewStatus::New },
            bookmark_id: None,
            feed_uid,
        };
        rows.push((feed.at, feed.section.as_deref(), item));
    }
    Ok(rows)
}

/// The rows of the preview by section (K10): the top level first, then each
/// section where it first appears, items in the file's order. A link is in
/// its first section only, as `tags_with` names it first.
fn groups(mut rows: Vec<Row<'_>>) -> Vec<ListPreviewGroup> {
    rows.sort_by_key(|(at, _, _)| *at);
    let mut groups = vec![ListPreviewGroup { name: None, tag: None, items: Vec::new() }];
    let mut group_at: HashMap<&str, usize> = HashMap::new();
    for (_, section, item) in rows {
        let at = match section {
            None => 0,
            Some(name) => *group_at.entry(name).or_insert_with(|| {
                groups.push(ListPreviewGroup { name: Some(name.to_owned()), tag: None, items: Vec::new() });
                groups.len() - 1
            }),
        };
        groups[at].items.push(item);
    }
    for group in &mut groups {
        // Feeds have no tags: a section of feeds only becomes none.
        if group.items.iter().any(|i| i.kind == ListPreviewKind::Link) {
            group.tag = group.name.as_deref().and_then(format::tag);
        }
    }
    groups.retain(|g| !g.items.is_empty());
    groups
}

/// The collection with this name, case aside (`db::fold`, as the bookmarks import compares).
pub(crate) fn collection_named(conn: &Connection, name: &str) -> rusqlite::Result<Option<CollectionMatch>> {
    let wanted = db::fold(name.trim());
    let mut statement = conn.prepare("SELECT id, name FROM collections ORDER BY id")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if db::fold(&name) == wanted {
            return Ok(Some(CollectionMatch { id: row.get(0)?, name }));
        }
    }
    Ok(None)
}

pub fn preview(conn: &Connection, list: &ParsedList, source: &str) -> rusqlite::Result<ListPreview> {
    let rows = rows(conn, list)?;
    let count = |status| rows.iter().filter(|(_, _, row)| row.status == status).count() as u32;
    let (already_saved, in_trash, feeds_followed) =
        (count(ListPreviewStatus::Saved), count(ListPreviewStatus::InTrash), count(ListPreviewStatus::Followed));
    // The feeds' rows follow the links' in the list's order, until `groups` sorts them.
    let new_feeds = list
        .feeds
        .iter()
        .zip(&rows[list.links.len()..])
        .filter(|(_, (_, _, row))| row.status == ListPreviewStatus::New)
        .map(|(feed, _)| ListFeedEntry {
            url: feed.url.clone(),
            title: feed.title.clone(),
            site: feed.site.clone(),
            section: feed.section.clone(),
        })
        .collect();
    let links = list.links.len() as u32;
    Ok(ListPreview {
        meta: list.meta.clone(),
        source: format::line(source, 255).unwrap_or_default(),
        newer: list.newer,
        links,
        feeds: list.feeds.len() as u32,
        sections: list.sections,
        sectioned_links: list.links.iter().filter(|l| !l.sections.is_empty()).count() as u32,
        new_links: links - already_saved - in_trash,
        already_saved,
        in_trash,
        repeated: list.repeated,
        not_web: list.not_web,
        invalid: list.invalid,
        feeds_followed,
        skipped_details: list.skipped_details,
        skipped_items: list.skipped_items,
        new_feeds,
        existing_collection: collection_named(conn, &list.meta.title)?,
        groups: groups(rows),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::format::parse;
    use crate::lists::tests::database;

    #[test]
    fn the_preview_counts_what_is_here_and_writes_nothing() {
        let c = database();
        let list = parse(include_str!("../../tests/fixtures/kpin/valid.kpin")).unwrap();
        c.execute_batch(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at) VALUES ('a', 'https://tokio.rs/', 'Tokio', 'tokio.rs', 'x', 'x');
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, deleted_at) VALUES ('b', 'https://this-week-in-rust.org/', 'TWiR', 'this-week-in-rust.org', 'x', 'x', 'x');
             INSERT INTO feeds (uid, url, created_at, updated_at) VALUES ('f', 'https://without.boats/index.xml', 'x', 'x');",
        )
        .unwrap();
        let named = db::create_collection(&c, "RUST blogs worth following", None, None).unwrap();
        let changes = c.total_changes();
        let p = preview(&c, &list, "rust-blogs.kpin").unwrap();
        assert_eq!(c.total_changes(), changes, "nothing written");
        assert_eq!(
            (p.links, p.feeds, p.sections, p.already_saved, p.in_trash, p.new_links, p.feeds_followed),
            (3, 2, 2, 1, 1, 1, 1)
        );
        assert_eq!(p.source, "rust-blogs.kpin");
        assert_eq!(p.new_feeds.len(), 1);
        assert_eq!(p.new_feeds[0].url, "https://blog.rust-lang.org/feed.xml");
        assert_eq!(p.new_feeds[0].title.as_deref(), Some("Rust Blog"));
        assert_eq!(p.new_feeds[0].site.as_deref(), Some("https://blog.rust-lang.org"));
        let found = p.existing_collection.unwrap();
        assert_eq!((found.id, found.name.as_str()), (named.id, "RUST blogs worth following"));
    }

    #[test]
    fn the_preview_reports_repeats_and_skips() {
        let c = database();
        let list = parse(include_str!("../../tests/fixtures/kpin/repeats.kpin")).unwrap();
        let p = preview(&c, &list, "").unwrap();
        assert_eq!((p.links, p.repeated, p.existing_collection), (1, 2, None));
        let list = parse(include_str!("../../tests/fixtures/kpin/unknown-type.kpin")).unwrap();
        let p = preview(&c, &list, "example.com").unwrap();
        assert_eq!((p.newer, p.skipped_items, p.skipped_details), (true, 1, 4));
        // The skipped items are in no group; the rest are.
        let rows: usize = p.groups.iter().map(|g| g.items.len()).sum();
        assert_eq!(rows as u32, p.links + p.feeds);
    }

    /// Each group's name and tag, and its rows' addresses.
    fn shape(p: &ListPreview) -> Vec<(Option<&str>, Option<&str>, Vec<&str>)> {
        p.groups.iter().map(|g| (g.name.as_deref(), g.tag.as_deref(), g.items.iter().map(|i| i.url.as_str()).collect())).collect()
    }

    #[test]
    fn the_rows_are_grouped_by_first_section_in_the_files_order() {
        let c = database();
        let list = parse(include_str!("../../tests/fixtures/kpin/groups.kpin")).unwrap();
        let p = preview(&c, &list, "groups.kpin").unwrap();
        assert_eq!(
            shape(&p),
            [
                (None, None, vec!["https://top-one.example.com/", "https://top-two.example.com/"]),
                (
                    Some("Tools"),
                    Some("tools"),
                    vec!["https://www.ripgrep.dev/", "https://tools.example.com/feed.xml", "https://fd.example.com/", "https://jq.example.com/"]
                ),
                (Some("Reading"), Some("reading"), vec!["https://books.example.com/"]),
                (Some("Feeds"), None, vec!["https://followed.example.com/rss", "https://new.example.com/atom.xml"]),
            ]
        );
        let ripgrep = &p.groups[1].items[0];
        assert_eq!((ripgrep.kind, ripgrep.title.as_deref(), ripgrep.host.as_str()), (ListPreviewKind::Link, Some("ripgrep"), "ripgrep.dev"));
        let tools = &p.groups[1].items[1];
        assert_eq!((tools.kind, tools.site.as_deref(), tools.host.as_str()), (ListPreviewKind::Feed, Some("https://tools.example.com/"), "tools.example.com"));
        // The top level first, wherever the file has it.
        let list = parse(include_str!("../../tests/fixtures/kpin/valid.kpin")).unwrap();
        let p = preview(&c, &list, "").unwrap();
        assert_eq!(p.groups.iter().map(|g| g.name.as_deref()).collect::<Vec<_>>(), [None, Some("Compiler and language"), Some("Async")]);
    }

    #[test]
    fn rows_say_what_is_saved_in_the_trash_or_followed_with_their_ids() {
        let c = database();
        c.execute_batch(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at) VALUES ('a', 'https://fd.example.com/', 'fd', 'fd.example.com', 'x', 'x');
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, deleted_at) VALUES ('b', 'https://books.example.com/', 'Books', 'books.example.com', 'x', 'x', 'x');
             INSERT INTO feeds (uid, url, created_at, updated_at) VALUES ('feed-uid', 'https://followed.example.com/rss', 'x', 'x');",
        )
        .unwrap();
        let saved_id: i64 = c.query_row("SELECT id FROM bookmarks WHERE uid = 'a'", [], |r| r.get(0)).unwrap();
        let trashed_id: i64 = c.query_row("SELECT id FROM bookmarks WHERE uid = 'b'", [], |r| r.get(0)).unwrap();
        let list = parse(include_str!("../../tests/fixtures/kpin/groups.kpin")).unwrap();
        let p = preview(&c, &list, "").unwrap();
        let row = |url: &str| p.groups.iter().flat_map(|g| &g.items).find(|i| i.url == url).unwrap().clone();
        let fd = row("https://fd.example.com/");
        assert_eq!((fd.status, fd.bookmark_id, fd.feed_uid), (ListPreviewStatus::Saved, Some(saved_id), None));
        let books = row("https://books.example.com/");
        assert_eq!((books.status, books.bookmark_id), (ListPreviewStatus::InTrash, Some(trashed_id)));
        let followed = row("https://followed.example.com/rss");
        assert_eq!((followed.status, followed.feed_uid.as_deref(), followed.bookmark_id), (ListPreviewStatus::Followed, Some("feed-uid"), None));
        let new_feed = row("https://new.example.com/atom.xml");
        assert_eq!((new_feed.status, new_feed.feed_uid), (ListPreviewStatus::New, None));
        let new_link = row("https://top-one.example.com/");
        assert_eq!((new_link.status, new_link.bookmark_id), (ListPreviewStatus::New, None));
        // A repeat is no row of its own and has no status: it is counted.
        let ripgreps = p.groups.iter().flat_map(|g| &g.items).filter(|i| i.url == "https://www.ripgrep.dev/").count();
        assert_eq!((ripgreps, p.repeated), (1, 1));
        assert_eq!(serde_json::to_value(ListPreviewStatus::InTrash).unwrap(), "in_trash");
        assert_eq!(serde_json::to_value(ListPreviewKind::Feed).unwrap(), "feed");
    }

    #[test]
    fn five_thousand_items_preview_under_one_and_a_half_megabytes() {
        let c = database();
        let list = parse(include_str!("../../tests/fixtures/kpin/max-items.kpin")).unwrap();
        assert_eq!(list.links.len() + list.feeds.len(), format::MAX_ITEMS);
        let p = preview(&c, &list, "max-items.kpin").unwrap();
        assert_eq!(p.groups.len(), 14, "the top level, 12 topics and the feeds");
        assert_eq!(p.groups.iter().map(|g| g.items.len()).sum::<usize>(), format::MAX_ITEMS);
        let bytes = serde_json::to_vec(&super::super::ListCheck::Ready { preview: p }).unwrap().len();
        assert!(bytes < 1_500_000, "{bytes} bytes");
    }
}
