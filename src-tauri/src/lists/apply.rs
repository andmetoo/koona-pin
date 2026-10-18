//! A list into the library (NP-137), by the rules of the bookmarks import
//! (Р-29): one transaction, an error leaves the library as it was, a
//! collection is made only when a new bookmark lands in it, a link in the
//! trash stays there. The rows are ordinary inserts: the triggers of schema
//! 10 record them for sync as they record the bookmarks import's.

use super::format::ParsedList;
use super::preview::{collection_named, followed, saved};
use super::{ExistingLinks, ListCollection, ListImportOptions, ListImportReport};
use crate::db;
use crate::feeds::{self, FeedDestination};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use url::Url;

/// Where the new bookmarks go, decided once the first one needs it.
enum Target {
    None,
    Id(i64),
    Create(String),
}

/// What [`apply`] did, with what the command does next.
#[derive(Debug, Default)]
pub struct Applied {
    pub report: ListImportReport,
    /// The bookmarks it created: their previews are fetched next.
    pub created: Vec<i64>,
    /// The feeds it followed with the list's name for them, shown until their first fetch.
    pub named: Vec<(String, String)>,
}

/// Writes the list. `progress(done, total)` is called every 100 links and
/// at the last one: the dialog says «N of M links», as the bookmarks import
/// does; the feeds after them are few and quick.
pub fn apply(
    conn: &Connection,
    list: &ParsedList,
    options: &ListImportOptions,
    mut progress: impl FnMut(usize, usize),
) -> rusqlite::Result<Applied> {
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let mut applied = Applied::default();
    let report = &mut applied.report;
    report.repeated = list.repeated;
    report.not_web = list.not_web;
    report.invalid = list.invalid;
    report.skipped_items = list.skipped_items;

    let mut target = match &options.collection {
        ListCollection::None => Target::None,
        ListCollection::Existing { id } => {
            tx.query_row("SELECT id FROM collections WHERE id = ?1", [id], |r| r.get(0)).map(Target::Id)?
        }
        ListCollection::New { name } => match collection_named(&tx, name)? {
            Some(found) => Target::Id(found.id),
            None => Target::Create(name.trim().to_owned()),
        },
    };
    if let Target::Id(id) = target {
        report.collection_id = Some(id);
    }
    let triaged_at = (!options.to_inbox).then(|| now.clone());
    let follow: HashSet<String> =
        options.follow_feeds.iter().filter_map(|u| Url::parse(u.trim()).ok()).map(|u| u.to_string()).collect();
    let total = list.links.len();
    let mut done = 0;
    let mut step = |done: usize| {
        if done % 100 == 0 || done == total {
            progress(done, total);
        }
    };

    for link in &list.links {
        let tags = link.tags_with(options.sections_as_tags);
        match saved(&tx, &link.url)? {
            Some(true) => report.in_trash += 1,
            Some(false) => {
                report.already_saved += 1;
                if options.existing_links == ExistingLinks::AddTags && !tags.is_empty() {
                    let id: i64 = tx.query_row("SELECT id FROM bookmarks WHERE url = ?1", [&link.url], |r| r.get(0))?;
                    let tagged = |tx: &Connection| -> rusqlite::Result<i64> {
                        tx.prepare_cached("SELECT count(*) FROM bookmark_tags WHERE bookmark_id = ?1")?.query_row([id], |r| r.get(0))
                    };
                    let before = tagged(&tx)?;
                    db::link_tags(&tx, id, &tags, &now)?;
                    // A change of the bookmark, as a bulk «Tag» is: only when a tag was added.
                    if tagged(&tx)? != before {
                        tx.execute("UPDATE bookmarks SET revision=revision+1, updated_at=?1 WHERE id=?2", params![now, id])?;
                    }
                }
            }
            None => {
                let collection_id = match &target {
                    Target::None => None,
                    Target::Id(id) => Some(*id),
                    Target::Create(name) => {
                        let created = db::create_collection(&tx, name, None, None)?;
                        target = Target::Id(created.id);
                        report.collection_id = Some(created.id);
                        Some(created.id)
                    }
                };
                let title = link.title.as_deref().unwrap_or(&link.url);
                tx.execute(
                    "INSERT INTO bookmarks (uid, url, title, description, domain, collection_id, source, source_name, created_at, updated_at, triaged_at, url_key)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11)",
                    params![
                        db::new_uid(),
                        link.url,
                        title,
                        link.description,
                        crate::metadata::extract_domain(&link.url),
                        collection_id,
                        db::Source::List.as_str(),
                        list.meta.title,
                        now,
                        triaged_at,
                        crate::dedupe::url_key(&link.url),
                    ],
                )?;
                let id = tx.last_insert_rowid();
                if !tags.is_empty() {
                    db::link_tags(&tx, id, &tags, &now)?;
                }
                applied.created.push(id);
                report.added += 1;
            }
        }
        done += 1;
        step(done);
    }

    for feed in &list.feeds {
        if followed(&tx, &feed.url)? {
            report.feeds_already += 1;
        } else if follow.contains(&feed.url) {
            let url = Url::parse(&feed.url).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            // No name of the person's own: the list's title is shown until the feed's own arrives (as OPML).
            let made = feeds::subscribe(&tx, &url, None, FeedDestination::Feeds)?;
            if let Some(title) = &feed.title {
                applied.named.push((made.uid, title.clone()));
            }
            report.feeds_followed += 1;
        }
    }
    tx.commit()?;
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::format::parse;
    use crate::lists::tests::database;

    const VALID: &str = include_str!("../../tests/fixtures/kpin/valid.kpin");
    const REPEATS: &str = include_str!("../../tests/fixtures/kpin/repeats.kpin");

    fn options(collection: ListCollection) -> ListImportOptions {
        ListImportOptions {
            collection,
            to_inbox: false,
            sections_as_tags: true,
            existing_links: ExistingLinks::Leave,
            follow_feeds: vec!["https://blog.rust-lang.org/feed.xml".into(), "https://without.boats/index.xml".into()],
        }
    }
    fn new_collection(name: &str) -> ListCollection {
        ListCollection::New { name: name.into() }
    }
    fn tags_of(c: &Connection, url: &str) -> Vec<String> {
        c.prepare("SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id JOIN bookmarks b ON b.id = bt.bookmark_id WHERE b.url = ?1 ORDER BY t.name")
            .unwrap()
            .query_map([url], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_list_becomes_bookmarks_in_a_new_collection_and_followed_feeds() {
        let c = database();
        let list = parse(VALID).unwrap();
        let mut calls = Vec::new();
        let applied = apply(&c, &list, &options(new_collection("Rust blogs worth following")), |d, t| calls.push((d, t))).unwrap();
        let r = &applied.report;
        assert_eq!((r.added, r.already_saved, r.in_trash, r.repeated, r.feeds_followed, r.feeds_already), (3, 0, 0, 0, 2, 0));
        assert_eq!(calls, [(3, 3)]);
        assert_eq!(applied.created.len(), 3);
        let collection = r.collection_id.unwrap();
        let (source, name, collection_id, triaged, description, key): (String, String, i64, Option<String>, Option<String>, String) = c
            .query_row(
                "SELECT source, source_name, collection_id, triaged_at, description, url_key FROM bookmarks WHERE url = 'https://doc.rust-lang.org/nomicon/'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!((source.as_str(), name.as_str(), collection_id), ("list", "Rust blogs worth following", collection));
        assert!(triaged.is_some(), "not to the Inbox: sorted");
        assert_eq!(description.as_deref(), Some("The dark arts of unsafe Rust."));
        assert_eq!(key, "doc.rust-lang.org/nomicon");
        assert_eq!(tags_of(&c, "https://doc.rust-lang.org/nomicon/"), ["book", "compiler and language", "unsafe"]);
        assert_eq!(tags_of(&c, "https://this-week-in-rust.org/"), Vec::<String>::new());
        let destinations: Vec<(String, Option<String>, String)> = c
            .prepare("SELECT url, title, destination FROM feeds ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            destinations,
            [
                ("https://blog.rust-lang.org/feed.xml".to_string(), None, "feeds".to_string()),
                ("https://without.boats/index.xml".to_string(), None, "feeds".to_string()),
            ]
        );
        assert_eq!(applied.named.len(), 2, "the list's names for the cache");
    }

    #[test]
    fn into_the_inbox_without_sections_and_only_the_checked_feeds() {
        let c = database();
        let mut o = options(ListCollection::None);
        o.to_inbox = true;
        o.sections_as_tags = false;
        o.follow_feeds = vec!["https://without.boats/index.xml".into(), "https://evil.example/not-in-the-file.xml".into()];
        let r = apply(&c, &parse(VALID).unwrap(), &o, |_, _| {}).unwrap().report;
        assert_eq!((r.added, r.feeds_followed, r.collection_id), (3, 1, None));
        assert_eq!(count(&c, "SELECT count(*) FROM bookmarks WHERE triaged_at IS NULL AND collection_id IS NULL"), 3);
        // The Inbox banner counts them as imported, as a bookmarks file's.
        let counts = db::get_counts(&c).unwrap();
        assert_eq!((counts.inbox, counts.inbox_imported), (3, 3));
        assert_eq!(tags_of(&c, "https://doc.rust-lang.org/nomicon/"), ["book", "unsafe"]);
        assert_eq!(count(&c, "SELECT count(*) FROM feeds"), 1, "only a feed of the file, and only a checked one");
    }

    #[test]
    fn importing_the_same_list_again_adds_nothing_and_reuses_the_collection_case_aside() {
        let c = database();
        let list = parse(VALID).unwrap();
        let first = apply(&c, &list, &options(new_collection("Rust blogs worth following")), |_, _| {}).unwrap().report;
        let collections = count(&c, "SELECT count(*) FROM collections");
        let before: Vec<(String, i64)> = c
            .prepare("SELECT url, revision FROM bookmarks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let changes = c.total_changes();
        let again = apply(&c, &list, &options(new_collection("RUST BLOGS worth following")), |_, _| {}).unwrap().report;
        assert_eq!((again.added, again.already_saved, again.feeds_followed, again.feeds_already), (0, 3, 0, 2));
        assert_eq!(again.collection_id, first.collection_id, "the same collection, whatever its case");
        assert_eq!(count(&c, "SELECT count(*) FROM collections"), collections);
        assert_eq!(c.total_changes(), changes, "no row written");
        let after: Vec<(String, i64)> = c
            .prepare("SELECT url, revision FROM bookmarks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn an_existing_collection_is_filled_and_one_never_needed_is_not_made() {
        let c = database();
        let shelf = db::create_collection(&c, "Shelf", None, None).unwrap();
        let r = apply(&c, &parse(VALID).unwrap(), &options(ListCollection::Existing { id: shelf.id }), |_, _| {}).unwrap().report;
        assert_eq!((r.added, r.collection_id), (3, Some(shelf.id)));
        assert_eq!(count(&c, &format!("SELECT count(*) FROM bookmarks WHERE collection_id = {}", shelf.id)), 3);
        // A gone collection: an error, nothing written.
        let gone = apply(&c, &parse(REPEATS).unwrap(), &options(ListCollection::Existing { id: 9_999 }), |_, _| {});
        assert!(matches!(gone, Err(rusqlite::Error::QueryReturnedNoRows)));
        // Every link already here: no new collection.
        let collections = count(&c, "SELECT count(*) FROM collections");
        let r = apply(&c, &parse(VALID).unwrap(), &options(new_collection("Never needed")), |_, _| {}).unwrap().report;
        assert_eq!((r.added, r.collection_id), (0, None));
        assert_eq!(count(&c, "SELECT count(*) FROM collections"), collections);
    }

    #[test]
    fn links_already_here_keep_their_place_get_tags_when_asked_and_the_trash_is_counted() {
        let c = database();
        let mine = db::create_collection(&c, "Mine", None, None).unwrap();
        c.execute_batch(&format!(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, collection_id) VALUES ('a', 'https://tokio.rs/', 'My Tokio', 'tokio.rs', 'x', 'x', {});
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, deleted_at) VALUES ('b', 'https://this-week-in-rust.org/', 'TWiR', 'this-week-in-rust.org', 'x', 'x', 'x');",
            mine.id
        ))
        .unwrap();
        let mut o = options(new_collection("Rust blogs worth following"));
        o.existing_links = ExistingLinks::AddTags;
        let r = apply(&c, &parse(VALID).unwrap(), &o, |_, _| {}).unwrap().report;
        assert_eq!((r.added, r.already_saved, r.in_trash), (1, 1, 1));
        let (title, collection): (String, i64) =
            c.query_row("SELECT title, collection_id FROM bookmarks WHERE uid = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), collection), ("My Tokio", mine.id), "its collection never changes");
        assert_eq!(tags_of(&c, "https://tokio.rs/"), ["async", "runtime"]);
        // A change for sync, as a bulk «Tag» is; the same tags again change nothing.
        let stamp = |c: &Connection| -> (i64, String) {
            c.query_row("SELECT revision, updated_at FROM bookmarks WHERE uid = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        let (revision, updated_at) = stamp(&c);
        assert_eq!(revision, 2);
        assert_ne!(updated_at, "x");
        apply(&c, &parse(VALID).unwrap(), &o, |_, _| {}).unwrap();
        assert_eq!(stamp(&c), (revision, updated_at));
        let trashed: Option<String> = c.query_row("SELECT deleted_at FROM bookmarks WHERE uid = 'b'", [], |r| r.get(0)).unwrap();
        assert!(trashed.is_some(), "stays in the trash");
        assert_eq!(tags_of(&c, "https://this-week-in-rust.org/"), Vec::<String>::new());
        // Left as they are by default.
        c.execute("DELETE FROM bookmark_tags", []).unwrap();
        apply(&c, &parse(VALID).unwrap(), &options(ListCollection::None), |_, _| {}).unwrap();
        assert_eq!(tags_of(&c, "https://tokio.rs/"), Vec::<String>::new());
    }

    #[test]
    fn a_repeat_inside_the_file_is_one_bookmark_with_both_tags() {
        let c = database();
        let r = apply(&c, &parse(REPEATS).unwrap(), &options(ListCollection::None), |_, _| {}).unwrap().report;
        assert_eq!((r.added, r.repeated, r.feeds_followed), (1, 2, 1));
        assert_eq!(tags_of(&c, "https://doc.rust-lang.org/book/"), ["beginner", "book", "books", "learning"]);
    }

    #[test]
    fn feeds_already_followed_are_left_as_they_are() {
        let c = database();
        let url = Url::parse("https://blog.rust-lang.org/feed.xml").unwrap();
        let mine = feeds::subscribe(&c, &url, Some("My Rust".into()), FeedDestination::Notify).unwrap();
        let changes = c.total_changes();
        let mut o = options(ListCollection::None);
        o.follow_feeds = vec![url.to_string()];
        let applied = apply(&c, &parse(REPEATS).unwrap(), &o, |_, _| {}).unwrap();
        assert_eq!((applied.report.feeds_followed, applied.report.feeds_already), (0, 1));
        assert!(applied.named.is_empty());
        let now = feeds::feed(&c, &mine.uid).unwrap();
        assert_eq!((now.title.as_deref(), now.destination), (Some("My Rust"), FeedDestination::Notify));
        // Only the bookmark and its tags were written.
        assert!(c.total_changes() > changes);
        assert_eq!(count(&c, "SELECT count(*) FROM feeds"), 1);
    }

    #[test]
    fn a_feed_that_fails_after_the_links_takes_the_links_back_too() {
        let c = database();
        let collections = count(&c, "SELECT count(*) FROM collections");
        c.execute_batch("CREATE TEMP TRIGGER fail BEFORE INSERT ON feeds WHEN NEW.url = 'https://without.boats/index.xml' BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        assert!(apply(&c, &parse(VALID).unwrap(), &options(new_collection("Rust blogs worth following")), |_, _| {}).is_err());
        assert_eq!(count(&c, "SELECT count(*) FROM bookmarks"), 0, "the links written before the feeds");
        assert_eq!(count(&c, "SELECT count(*) FROM feeds"), 0, "the feed followed before the failing one");
        assert_eq!(count(&c, "SELECT count(*) FROM collections"), collections);
        assert_eq!(count(&c, "SELECT count(*) FROM tags"), 0);
    }

    #[test]
    fn a_failure_after_tags_were_added_to_a_link_already_here_takes_them_back() {
        let c = database();
        c.execute_batch(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at) VALUES ('a', 'https://tokio.rs/', 'My Tokio', 'tokio.rs', 'x', 'x');
             CREATE TEMP TRIGGER fail BEFORE INSERT ON bookmarks WHEN NEW.url = 'https://this-week-in-rust.org/' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
        let mut o = options(ListCollection::None);
        o.existing_links = ExistingLinks::AddTags;
        assert!(apply(&c, &parse(VALID).unwrap(), &o, |_, _| {}).is_err());
        assert_eq!(tags_of(&c, "https://tokio.rs/"), Vec::<String>::new());
        let (revision, updated_at): (i64, String) =
            c.query_row("SELECT revision, updated_at FROM bookmarks WHERE uid = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((revision, updated_at.as_str()), (1, "x"));
        assert_eq!(count(&c, "SELECT count(*) FROM bookmarks"), 1);
        assert_eq!(count(&c, "SELECT count(*) FROM tags"), 0);
    }

    #[test]
    fn a_failure_in_the_middle_leaves_nothing_not_even_the_collection() {
        let c = database();
        let collections = count(&c, "SELECT count(*) FROM collections");
        c.execute_batch("CREATE TEMP TRIGGER fail BEFORE INSERT ON bookmarks WHEN NEW.url = 'https://tokio.rs/' BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        let result = apply(&c, &parse(VALID).unwrap(), &options(new_collection("Rust blogs worth following")), |_, _| {});
        assert!(result.is_err());
        assert_eq!(count(&c, "SELECT count(*) FROM bookmarks"), 0);
        assert_eq!(count(&c, "SELECT count(*) FROM collections"), collections, "the collection made on the way is rolled back");
        assert_eq!(count(&c, "SELECT count(*) FROM tags"), 0);
        assert_eq!(count(&c, "SELECT count(*) FROM feeds"), 0);
    }

    #[test]
    fn five_thousand_items_are_one_transaction() {
        let c = database();
        let items: Vec<String> = (0..5_000)
            .map(|i| match i % 10 {
                0 => format!(r#"{{"type":"feed","url":"https://feeds.example.com/{i}.xml","title":"Feed {i}"}}"#),
                _ => format!(r#"{{"type":"link","url":"https://example.com/{i}","title":"Link {i}","tags":["t{}"]}}"#, i % 7),
            })
            .collect();
        let text = format!(
            r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"Big","sections":[{{"name":"All","items":[{}]}}]}}"#,
            items.join(",")
        );
        let list = parse(&text).unwrap();
        let mut o = options(new_collection("Big"));
        o.follow_feeds = list.feeds.iter().map(|f| f.url.clone()).collect();
        let mut calls = Vec::new();
        let started = std::time::Instant::now();
        let r = apply(&c, &list, &o, |d, t| calls.push((d, t))).unwrap().report;
        let took = started.elapsed();
        println!("a list of 5 000 items: {took:?}");
        assert_eq!((r.added, r.feeds_followed), (4_500, 500));
        assert_eq!(calls.len(), 45);
        assert_eq!(calls.last(), Some(&(4_500, 4_500)));
        // About 1.6 s alone in a debug build on an M-series Mac, about 30 s
        // while the whole suite runs beside it (the bookmarks import's 10 000
        // take as long then): the bound only catches a quadratic slip.
        assert!(took < std::time::Duration::from_secs(120), "{took:?}");
    }
}
