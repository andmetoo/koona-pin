//! What a list would do to this library, for the dialog before anything is
//! written (K1). Reads only.

use super::format::ParsedList;
use super::{CollectionMatch, ListFeedEntry, ListPreview};
use crate::db;
use rusqlite::{Connection, OptionalExtension};

/// Whether the library has a bookmark with this exact address: in the trash
/// (`Some(true)`) or out of it (`Some(false)`). The rule of Р-29.
pub(crate) fn saved(conn: &Connection, url: &str) -> rusqlite::Result<Option<bool>> {
    conn.prepare_cached("SELECT deleted_at IS NOT NULL FROM bookmarks WHERE url = ?1")?
        .query_row([url], |r| r.get(0))
        .optional()
}

pub(crate) fn followed(conn: &Connection, url: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT EXISTS (SELECT 1 FROM feeds WHERE url = ?1)")?.query_row([url], |r| r.get(0))
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
    let (mut already_saved, mut in_trash) = (0, 0);
    for link in &list.links {
        match saved(conn, &link.url)? {
            Some(true) => in_trash += 1,
            Some(false) => already_saved += 1,
            None => {}
        }
    }
    let mut feeds_followed = 0;
    let mut new_feeds = Vec::new();
    for feed in &list.feeds {
        if followed(conn, &feed.url)? {
            feeds_followed += 1;
        } else {
            new_feeds.push(ListFeedEntry {
                url: feed.url.clone(),
                title: feed.title.clone(),
                site: feed.site.clone(),
                section: feed.section.clone(),
            });
        }
    }
    let links = list.links.len() as u32;
    Ok(ListPreview {
        meta: list.meta.clone(),
        source: super::format::line(source, 255).unwrap_or_default(),
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
    }
}
