//! Import of a browser bookmarks file (NP-031, Р-10 point 4): the Netscape
//! HTML that Chrome, Edge and Firefox export. Top-level folders become
//! collections, nested folders tags; the browser's own roots (bookmarks bar,
//! other bookmarks, mobile) are not folders of their own. The whole file is
//! written in one transaction: an error leaves the library as it was.

use crate::db::{self, Source};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{ElementRef, Html};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;
use url::Url;

/// A link of the file, ready to be saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLink {
    pub url: String,
    pub title: String,
    pub collection: Option<String>,
    pub tags: Vec<String>,
    /// When the browser saved it (`ADD_DATE`), in the library's format.
    pub added_at: Option<String>,
}

/// Why a link of the file is not imported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SkipReason {
    /// Not HTTP or HTTPS: `javascript:`, `place:`, `file:`, `chrome:`…
    NotWeb,
    /// Not an address at all, no host, or too long.
    Invalid,
    /// The same address earlier in the file.
    Repeated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SkippedLink {
    pub address: String,
    pub reason: SkipReason,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub links: Vec<ImportLink>,
    pub skipped: Vec<SkippedLink>,
}

/// What an import did: the report of the dialog (frame 28).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ImportSummary {
    /// New bookmarks.
    pub added: u32,
    /// Already in the library: left exactly as they were.
    pub existing: u32,
    /// In the trash: left there, an import does not undo a clean-up (Р-10 point 2).
    pub in_trash: u32,
    pub not_web: u32,
    pub invalid: u32,
    pub repeated: u32,
    /// The first skipped links, for «Show the skipped addresses».
    pub skipped: Vec<SkippedLink>,
    /// Collections the import created, in the order of the file.
    pub collections: Vec<String>,
    /// Tags the import created.
    pub tags: u32,
}

/// The report lists this many skipped addresses; the counts cover all of them.
pub const SKIPPED_LISTED: usize = 200;
/// Longer addresses are not saved (as for a capture).
const MAX_URL: usize = 8192;

#[derive(Debug, Clone)]
struct RawFolder {
    name: String,
    toolbar: bool,
    unfiled: bool,
}

struct RawLink {
    href: String,
    title: String,
    path: Vec<RawFolder>,
    tags: Vec<String>,
    add_date: Option<String>,
}

fn flag(element: &ElementRef, name: &str) -> bool {
    element
        .value()
        .attr(name)
        .is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

fn text_of(element: &ElementRef) -> String {
    element.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Walks the tree in document order. A folder is an `H3` followed by the
/// `DL` of its contents; the parser may put that `DL` inside the `DT` of the
/// heading or after it, so a heading not yet matched travels up to the parent.
fn walk(
    node: ElementRef,
    path: &mut Vec<RawFolder>,
    roots: &mut Vec<RawFolder>,
    out: &mut Vec<RawLink>,
) -> Option<RawFolder> {
    let mut pending: Option<RawFolder> = None;
    for child in node.children() {
        let Some(element) = ElementRef::wrap(child) else {
            continue;
        };
        match element.value().name() {
            "h3" => {
                pending = Some(RawFolder {
                    name: text_of(&element),
                    toolbar: flag(&element, "personal_toolbar_folder"),
                    unfiled: flag(&element, "unfiled_bookmarks_folder"),
                })
            }
            "dl" => {
                let folder = pending.take();
                let opened = folder.is_some();
                if let Some(folder) = folder {
                    if path.is_empty() {
                        roots.push(folder.clone());
                    }
                    path.push(folder);
                }
                walk(element, path, roots, out);
                if opened {
                    path.pop();
                }
            }
            "a" => {
                if let Some(href) = element.value().attr("href") {
                    out.push(RawLink {
                        href: href.to_owned(),
                        title: text_of(&element),
                        path: path.clone(),
                        // Firefox keeps its own tags in the link (owner's choice, NP-031).
                        tags: element
                            .value()
                            .attr("tags")
                            .map(|t| t.split(',').map(str::to_owned).collect())
                            .unwrap_or_default(),
                        add_date: element.value().attr("add_date").map(str::to_owned),
                    });
                }
            }
            _ => {
                if let Some(folder) = walk(element, path, roots, out) {
                    pending = Some(folder);
                }
            }
        }
    }
    pending
}

/// An address as it would be saved, or why it is not.
fn classify(href: &str) -> Result<String, SkipReason> {
    let href = href.trim();
    match Url::parse(href) {
        Ok(url) if !matches!(url.scheme(), "http" | "https") => Err(SkipReason::NotWeb),
        Ok(url) if url.host_str().is_some() && href.len() <= MAX_URL => Ok(href.to_owned()),
        _ => Err(SkipReason::Invalid),
    }
}

/// `ADD_DATE` in the library's format. Browsers write Unix seconds; other
/// tools milliseconds or microseconds, told apart by size, or an ISO date.
/// A time before 1990 or in the future is not a real save date.
pub fn parse_time(raw: &str, now: DateTime<Utc>) -> Option<String> {
    let raw = raw.trim();
    let time = match raw.parse::<i64>() {
        Ok(n) => {
            let (seconds, nanos) = match n {
                n if n >= 100_000_000_000_000 => (n / 1_000_000, (n % 1_000_000) * 1_000),
                n if n >= 100_000_000_000 => (n / 1_000, (n % 1_000) * 1_000_000),
                n => (n, 0),
            };
            Utc.timestamp_opt(seconds, u32::try_from(nanos).ok()?).single()?
        }
        Err(_) => DateTime::parse_from_rfc3339(raw).ok()?.with_timezone(&Utc),
    };
    (time.year() >= 1990 && time <= now + chrono::Duration::days(1)).then(|| db::stamp(time))
}

/// The links of a bookmarks file and what is skipped, with the folder rule
/// applied. Which folders are the browser's own roots depends on the file:
/// - Firefox marks them (`PERSONAL_TOOLBAR_FOLDER`, `UNFILED_BOOKMARKS_FOLDER`);
///   everything else at the top is the bookmarks menu, its folders are the user's.
/// - Chrome and Edge put every root at the top level, the bar marked: then
///   all top-level folders are roots.
/// - A file with neither has no roots: its top-level folders are collections.
pub fn parse(html: &str, now: DateTime<Utc>) -> Parsed {
    let document = Html::parse_document(html);
    let mut path = Vec::new();
    let mut roots = Vec::new();
    let mut raw = Vec::new();
    walk(document.root_element(), &mut path, &mut roots, &mut raw);

    let firefox = roots.iter().any(|f| f.unfiled);
    let chrome = !firefox && roots.iter().any(|f| f.toolbar);
    let mut seen = HashSet::new();
    let mut parsed = Parsed::default();
    for link in raw {
        let url = match classify(&link.href) {
            Ok(url) => url,
            Err(reason) => {
                parsed.skipped.push(SkippedLink { address: link.href.trim().to_owned(), reason });
                continue;
            }
        };
        if !seen.insert(url.clone()) {
            parsed.skipped.push(SkippedLink { address: url, reason: SkipReason::Repeated });
            continue;
        }
        let mut folders = link.path.iter().enumerate().filter_map(|(depth, f)| {
            let root = if firefox { f.toolbar || f.unfiled } else { chrome && depth == 0 };
            (!root && !f.name.trim().is_empty()).then(|| f.name.trim().to_owned())
        });
        let collection = folders.next();
        let mut tags: Vec<String> = folders.chain(link.tags).map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
        let mut unique = HashSet::new();
        tags.retain(|t| unique.insert(t.clone()));
        parsed.links.push(ImportLink {
            title: link.title,
            collection,
            tags,
            added_at: link.add_date.and_then(|d| parse_time(&d, now)),
            url,
        });
    }
    parsed
}

/// Saves the links in one transaction. A link already in the library keeps
/// everything the user set; one in the trash stays there. A collection is
/// created only when a new bookmark lands in it, and an existing one with
/// the same name (case aside) is reused. `progress(done, total)` is called
/// as links are written. Metadata is not fetched: an import of thousands
/// must not start thousands of requests.
pub fn import(
    conn: &Connection,
    parsed: &Parsed,
    to_inbox: bool,
    mut progress: impl FnMut(usize, usize),
) -> rusqlite::Result<ImportSummary> {
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let mut summary = ImportSummary::default();
    for skipped in &parsed.skipped {
        match skipped.reason {
            SkipReason::NotWeb => summary.not_web += 1,
            SkipReason::Invalid => summary.invalid += 1,
            SkipReason::Repeated => summary.repeated += 1,
        }
    }
    summary.skipped = parsed.skipped.iter().take(SKIPPED_LISTED).cloned().collect();

    let mut collections: HashMap<String, i64> = tx
        .prepare("SELECT id, name FROM collections")?
        .query_map([], |r| Ok((db::fold(&r.get::<_, String>(1)?), r.get(0)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let tags_before: i64 = tx.query_row("SELECT count(*) FROM tags", [], |r| r.get(0))?;
    let triaged_at = (!to_inbox).then(|| now.clone());
    let total = parsed.links.len();
    for (index, link) in parsed.links.iter().enumerate() {
        let existing = tx
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM bookmarks WHERE url = ?1",
                [&link.url],
                |r| r.get::<_, bool>(0),
            )
            .optional()?;
        match existing {
            Some(true) => summary.in_trash += 1,
            Some(false) => summary.existing += 1,
            None => {
                let collection_id = match &link.collection {
                    None => None,
                    Some(name) => Some(match collections.get(&db::fold(name)) {
                        Some(&id) => id,
                        None => {
                            let created = db::create_collection(&tx, name, None, None)?;
                            collections.insert(db::fold(name), created.id);
                            summary.collections.push(created.name);
                            created.id
                        }
                    }),
                };
                let title = if link.title.is_empty() { &link.url } else { &link.title };
                tx.execute(
                    "INSERT INTO bookmarks (uid, url, title, domain, collection_id, source, created_at, updated_at, triaged_at, url_key)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        db::new_uid(),
                        link.url,
                        title,
                        crate::metadata::extract_domain(&link.url),
                        collection_id,
                        Source::Import.as_str(),
                        link.added_at.as_deref().unwrap_or(&now),
                        now,
                        triaged_at,
                        crate::dedupe::url_key(&link.url),
                    ],
                )?;
                if !link.tags.is_empty() {
                    db::link_tags(&tx, tx.last_insert_rowid(), &link.tags, &now)?;
                }
                summary.added += 1;
            }
        }
        if (index + 1) % 100 == 0 || index + 1 == total {
            progress(index + 1, total);
        }
    }
    let tags_after: i64 = tx.query_row("SELECT count(*) FROM tags", [], |r| r.get(0))?;
    summary.tags = u32::try_from(tags_after - tags_before).unwrap_or(0);
    tx.commit()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME: &str = include_str!("../../tests/fixtures/bookmarks/chrome.html");
    const EDGE: &str = include_str!("../../tests/fixtures/bookmarks/edge.html");
    const FIREFOX: &str = include_str!("../../tests/fixtures/bookmarks/firefox.html");

    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        db::register_functions(&c).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap()
    }
    /// (url, collection, tags) of every link, in file order.
    fn placed(parsed: &Parsed) -> Vec<(&str, Option<&str>, Vec<&str>)> {
        parsed
            .links
            .iter()
            .map(|l| (l.url.as_str(), l.collection.as_deref(), l.tags.iter().map(String::as_str).collect()))
            .collect()
    }
    fn skipped(parsed: &Parsed) -> Vec<(&str, SkipReason)> {
        parsed.skipped.iter().map(|s| (s.address.as_str(), s.reason)).collect()
    }

    #[test]
    fn chrome_roots_are_not_folders_top_level_ones_are_collections_nested_ones_tags() {
        let parsed = parse(CHROME, now());
        assert_eq!(
            placed(&parsed),
            vec![
                ("https://news.ycombinator.com/", None, vec![]),
                ("https://github.com/", Some("Работа"), vec![]),
                ("https://doc.rust-lang.org/book/", Some("Работа"), vec!["rust"]),
                ("https://tokio.rs/", Some("Работа"), vec!["rust", "async"]),
                ("https://habr.com/ru/articles/", None, vec![]),
                ("https://example.com/long-read", Some("Чтение"), vec![]),
                ("https://m.example.com/", None, vec![]),
            ]
        );
        assert_eq!(
            skipped(&parsed),
            vec![
                ("javascript:void(document.title)", SkipReason::NotWeb),
                ("https://github.com/", SkipReason::Repeated),
                ("chrome://settings/", SkipReason::NotWeb),
            ]
        );
        assert_eq!(parsed.links[0].title, "Hacker News");
        assert_eq!(parsed.links[0].added_at.as_deref(), Some("2024-09-26T12:01:40.000Z"));
    }

    #[test]
    fn edge_roots_and_addresses_that_are_not_saved() {
        let parsed = parse(EDGE, now());
        assert_eq!(
            placed(&parsed),
            vec![
                ("https://learn.microsoft.com/", None, vec![]),
                ("https://www.figma.com/", Some("Design"), vec![]),
                ("https://rsms.me/inter/", Some("Design"), vec!["fonts"]),
                ("https://linear.app/", Some("работа"), vec![]),
            ]
        );
        assert_eq!(
            skipped(&parsed),
            vec![
                ("file:///C:/Users/me/notes.html", SkipReason::NotWeb),
                ("https://", SkipReason::Invalid),
            ]
        );
    }

    #[test]
    fn firefox_menu_folders_are_collections_its_marked_roots_are_not_and_tags_come_along() {
        let parsed = parse(FIREFOX, now());
        assert_eq!(
            placed(&parsed),
            vec![
                ("https://www.mozilla.org/en-US/firefox/central/", None, vec![]),
                ("https://support.mozilla.org/en-US/products/firefox", Some("Mozilla Firefox"), vec![]),
                ("https://cooking.example/borscht", Some("Recipes"), vec!["soup", "beets"]),
                ("https://cooking.example/syrniki", Some("Recipes"), vec!["desserts", "breakfast"]),
                ("https://developer.mozilla.org/", None, vec![]),
                ("https://example.org/essay", Some("Reading"), vec![]),
                ("https://example.net/unfiled", None, vec!["later"]),
            ]
        );
        assert_eq!(skipped(&parsed), vec![("place:sort=8&maxResults=10", SkipReason::NotWeb)]);
        // The description after a link is not part of its title.
        assert_eq!(parsed.links[2].title, "Borscht");
    }

    #[test]
    fn a_file_without_browser_roots_keeps_its_top_level_folders() {
        let parsed = parse(
            r#"<DL><DT><H3>Shelf</H3><DL><DT><A HREF="https://a.example/">A</A><DT><H3>Deep</H3><DL><DT><A HREF="https://b.example/">B</A></DL></DL><DT><A HREF="https://c.example/">C</A></DL>"#,
            now(),
        );
        assert_eq!(
            placed(&parsed),
            vec![
                ("https://a.example/", Some("Shelf"), vec![]),
                ("https://b.example/", Some("Shelf"), vec!["deep"]),
                ("https://c.example/", None, vec![]),
            ]
        );
    }

    #[test]
    fn save_dates_in_seconds_milliseconds_microseconds_or_iso_and_nonsense_ignored() {
        let now = now();
        let at = |raw| parse_time(raw, now);
        assert_eq!(at("1727352000").as_deref(), Some("2024-09-26T12:00:00.000Z"));
        assert_eq!(at("1727352000123").as_deref(), Some("2024-09-26T12:00:00.123Z"));
        assert_eq!(at("1727352000123456").as_deref(), Some("2024-09-26T12:00:00.123Z"));
        assert_eq!(at("2024-09-26T15:00:00+03:00").as_deref(), Some("2024-09-26T12:00:00.000Z"));
        // Not a save date: none, zero, before 1990, the future, words.
        for raw in ["", "0", "315532800", "4102444800", "22 ноября 2026", "-5"] {
            assert_eq!(at(raw), None, "{raw}");
        }
    }

    #[test]
    fn import_follows_the_rule_keeps_dates_and_reports_everything() {
        let c = database();
        let summary = import(&c, &parse(CHROME, now()), false, |_, _| {}).unwrap();
        assert_eq!(
            (summary.added, summary.existing, summary.in_trash, summary.not_web, summary.invalid, summary.repeated, summary.tags),
            (7, 0, 0, 2, 0, 1, 2)
        );
        assert_eq!(summary.collections, ["Работа", "Чтение"]);
        assert_eq!(summary.skipped.len(), 3);
        let (collection, created_at, triaged_at, source): (Option<String>, String, Option<String>, String) = c
            .query_row(
                "SELECT c.name, b.created_at, b.triaged_at, b.source FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id WHERE url = 'https://tokio.rs/'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(collection.as_deref(), Some("Работа"));
        assert_eq!(created_at, "2023-07-22T04:31:40.000Z", "the browser's save date");
        assert!(triaged_at.is_some(), "the library: sorted");
        assert_eq!(source, "import");
        let tokio = db::get_bookmarks(&c, &db::BookmarkQuery { search: Some("tokio".into()), ..Default::default() }).unwrap();
        assert_eq!(tokio.items[0].tags.as_deref(), Some(&["rust".to_string(), "async".to_string()][..]));
    }

    #[test]
    fn into_the_inbox_the_imported_wait_to_be_sorted() {
        let c = database();
        import(&c, &parse(FIREFOX, now()), true, |_, _| {}).unwrap();
        let counts = db::get_counts(&c).unwrap();
        assert_eq!((counts.total, counts.inbox, counts.inbox_imported), (7, 7, 7));
    }

    #[test]
    fn a_repeated_import_adds_nothing_and_changes_no_user_edit() {
        let c = database();
        import(&c, &parse(CHROME, now()), false, |_, _| {}).unwrap();
        let id: i64 = c.query_row("SELECT id FROM bookmarks WHERE url = 'https://github.com/'", [], |r| r.get(0)).unwrap();
        db::update_bookmark(&c, id, Some("Мой GitHub".into()), Some("заметка".into()), Some(true), Some(None), Some(vec!["свой".into()])).unwrap();
        let trashed: i64 = c.query_row("SELECT id FROM bookmarks WHERE url = 'https://habr.com/ru/articles/'", [], |r| r.get(0)).unwrap();
        db::trash_bookmark(&c, trashed).unwrap();
        let before: Vec<(String, i64)> = c
            .prepare("SELECT url, revision FROM bookmarks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        let again = import(&c, &parse(CHROME, now()), false, |_, _| {}).unwrap();
        assert_eq!((again.added, again.existing, again.in_trash, again.collections.len(), again.tags), (0, 6, 1, 0, 0));
        let after: Vec<(String, i64)> = c
            .prepare("SELECT url, revision FROM bookmarks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(after, before, "no row written");
        let b = db::get_bookmark_by_id(&c, id).unwrap();
        assert_eq!((b.title.as_str(), b.notes.as_deref(), b.is_favorite, b.collection_id), ("Мой GitHub", Some("заметка"), true, None));
        assert_eq!(b.tags.unwrap(), ["свой"]);
        assert!(db::get_bookmark_by_id(&c, trashed).unwrap().deleted_at.is_some());
    }

    #[test]
    fn existing_collections_are_reused_case_aside_and_empty_ones_are_not_created() {
        let c = database();
        let seeded: i64 = c.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        import(&c, &parse(CHROME, now()), false, |_, _| {}).unwrap();
        // Edge has «работа» in lower case: Chrome's «Работа» takes the link.
        let summary = import(&c, &parse(EDGE, now()), false, |_, _| {}).unwrap();
        assert_eq!(summary.collections, ["Design"]);
        let names: Vec<String> = c.prepare("SELECT name FROM collections ORDER BY id LIMIT -1 OFFSET ?1").unwrap().query_map([seeded], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(names, ["Работа", "Чтение", "Design"], "no «Пустая»: no link landed there");
        let linear: String = c
            .query_row("SELECT c.name FROM bookmarks b JOIN collections c ON c.id = b.collection_id WHERE url = 'https://linear.app/'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(linear, "Работа");
    }

    #[test]
    fn a_failure_in_the_middle_leaves_nothing_and_ten_thousand_links_are_one_transaction() {
        let c = database();
        let seeded: i64 = c.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        let mut html = String::from("<DL>");
        for i in 0..10_000 {
            html.push_str(&format!(r#"<DT><A HREF="https://example.com/{i}" ADD_DATE="1700000000">Link {i}</A>"#));
        }
        html.push_str("</DL>");
        let parsed = parse(&html, now());
        let mut calls = Vec::new();
        let started = std::time::Instant::now();
        assert_eq!(import(&c, &parsed, false, |done, total| calls.push((done, total))).unwrap().added, 10_000);
        println!("import of 10 000 links: {:?}", started.elapsed());
        assert_eq!(calls.len(), 100);
        assert_eq!(calls.last(), Some(&(10_000, 10_000)));

        // The library refuses writes halfway: nothing of the file stays.
        let mut broken = parse(r#"<DL><DT><H3>Новая</H3><DL><DT><A HREF="https://example.org/a">A</A><DT><A HREF="https://example.org/b">B</A></DL></DL>"#, now());
        broken.links[1].url = "https://example.com/0".into();
        c.execute_batch("CREATE TEMP TRIGGER fail BEFORE INSERT ON bookmarks WHEN NEW.url = 'https://example.org/a' BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        assert!(import(&c, &broken, false, |_, _| {}).is_err());
        assert_eq!(db::get_counts(&c).unwrap().total, 10_000);
        let collections: i64 = c.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        assert_eq!(collections, seeded, "the collection created on the way is rolled back too");
    }
}
