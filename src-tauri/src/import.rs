//! Import of a browser bookmarks file (NP-031, Р-10 point 4): the Netscape
//! HTML that Chrome, Edge and Firefox export. Folders become nested
//! collections down to [`db::MAX_DEPTH`] levels (2.19.0; before that only the
//! top level did); the names of folders deeper than that become tags, and
//! Firefox's own tags stay tags. The browser's own roots (bookmarks bar,
//! other bookmarks, mobile) are not folders of their own.
//!
//! A folder reuses the collection of its name (case aside) that sits in the
//! same place, inside the collection its parent folder became. Names are
//! unique across the library, so a name taken in another place is made
//! "Docs (Home)" after the parent it lands under, then "Docs (Home) 2"…; a
//! top-level one has no parent to name and gets "Docs 2". The same file again
//! finds the collections it made under those names.
//!
//! The whole file is written in one transaction: an error leaves the library
//! as it was.

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
    /// The folders it sits in, outermost first, at most [`db::MAX_DEPTH`];
    /// empty: no collection.
    pub path: Vec<String>,
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
    /// Collections the import created, in the order of the file, a nested
    /// one with its path: "Work/Docs" (2.19.0).
    pub collections: Vec<String>,
    /// Tags the import created.
    pub tags: u32,
    /// The bookmarks it created: their previews are fetched next.
    #[serde(skip)]
    #[ts(skip)]
    pub created: Vec<i64>,
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
        let mut folders: Vec<String> = link
            .path
            .iter()
            .enumerate()
            .filter_map(|(depth, f)| {
                let root = if firefox { f.toolbar || f.unfiled } else { chrome && depth == 0 };
                (!root && !f.name.trim().is_empty()).then(|| f.name.trim().to_owned())
            })
            .collect();
        // What the tree cannot hold becomes tags, as every nested folder did before.
        let deeper = folders.split_off(folders.len().min(db::MAX_DEPTH));
        let mut tags: Vec<String> = deeper.into_iter().chain(link.tags).map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
        let mut unique = HashSet::new();
        tags.retain(|t| unique.insert(t.clone()));
        parsed.links.push(ImportLink {
            title: link.title,
            path: folders,
            tags,
            added_at: link.add_date.and_then(|d| parse_time(&d, now)),
            url,
        });
    }
    parsed
}

/// The library's collections as the import finds and makes them (2.19.0).
struct Collections {
    /// Every collection by its folded name: its id and parent. Names are
    /// unique across the library.
    by_name: HashMap<String, (i64, Option<i64>)>,
    names: HashMap<i64, String>,
    /// Where each folder of the file already landed: (parent, folded name).
    placed: HashMap<(Option<i64>, String), i64>,
    /// A folder (its folded path) whose links of an earlier import sit in a
    /// collection of its name somewhere else: the person moved it since.
    moved: HashMap<Vec<String>, i64>,
}

impl Collections {
    fn load(conn: &Connection, links: &[ImportLink]) -> rusqlite::Result<Collections> {
        let mut known = Collections { by_name: HashMap::new(), names: HashMap::new(), placed: HashMap::new(), moved: HashMap::new() };
        let rows = conn
            .prepare("SELECT id, name, parent_id FROM collections")?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name, parent) in rows {
            known.by_name.insert(db::fold(&name), (id, parent));
            known.names.insert(id, name);
        }
        let mut sits = conn.prepare("SELECT collection_id FROM bookmarks WHERE url = ?1")?;
        for link in links.iter().filter(|l| !l.path.is_empty()) {
            let key: Vec<String> = link.path.iter().map(|f| db::fold(f)).collect();
            if known.moved.contains_key(&key) {
                continue;
            }
            let Some(Some(id)) = sits.query_row([&link.url], |r| r.get::<_, Option<i64>>(0)).optional()? else { continue };
            // Its own name, or one the import made of it: «Docs (Work)», «Docs 2».
            let folder = &key[key.len() - 1];
            let name = known.names.get(&id).map(|n| db::fold(n)).unwrap_or_default();
            if name == *folder || name.starts_with(&format!("{folder} ")) {
                known.moved.insert(key, id);
            }
        }
        Ok(known)
    }

    /// The level of a collection, 1 at the top; a loop synced in ends it.
    fn depth(&self, id: i64) -> usize {
        let parents: HashMap<i64, Option<i64>> = self.by_name.values().copied().collect();
        let mut line = vec![id];
        while let Some(&Some(up)) = line.last().and_then(|x| parents.get(x)) {
            if line.contains(&up) {
                break;
            }
            line.push(up);
        }
        line.len()
    }

    /// The collection the last folder of `path` stands for, made with the
    /// ones above it when the library lacks them. A folder the person moved
    /// is found where it is now, with what is below it, while that still fits.
    fn at(&mut self, conn: &Connection, path: &[String], summary: &mut ImportSummary) -> rusqlite::Result<i64> {
        let folded: Vec<String> = path.iter().map(|f| db::fold(f)).collect();
        let (start, mut parent) = (1..=path.len())
            .rev()
            .find_map(|n| {
                let id = *self.moved.get(&folded[..n])?;
                (self.depth(id) + path.len() - n <= db::MAX_DEPTH).then_some((n, Some(id)))
            })
            .unwrap_or((0, None));
        for folder in &path[start..] {
            let key = (parent, db::fold(folder));
            let id = match self.placed.get(&key) {
                Some(&id) => id,
                None => {
                    let id = self.find_or_make(conn, folder, parent, summary)?;
                    self.placed.insert(key, id);
                    id
                }
            };
            parent = Some(id);
        }
        Ok(parent.expect("a link with a collection has a folder"))
    }

    /// The names a folder may have in turn: its own, then after the parent,
    /// then numbered. The first one a collection of this place has is the
    /// folder's; the first one nobody has is made.
    fn find_or_make(&mut self, conn: &Connection, folder: &str, parent: Option<i64>, summary: &mut ImportSummary) -> rusqlite::Result<i64> {
        let parent_name = parent.and_then(|p| self.names.get(&p)).cloned();
        for attempt in 0.. {
            let name = match (attempt, &parent_name) {
                (0, _) => folder.to_owned(),
                (1, Some(up)) => format!("{folder} ({up})"),
                (n, Some(up)) => format!("{folder} ({up}) {n}"),
                (n, None) => format!("{folder} {}", n + 1),
            };
            match self.by_name.get(&db::fold(&name)) {
                Some(&(id, at)) if at == parent => return Ok(id),
                Some(_) => continue,
                None => {
                    let created = db::create_collection_under(conn, &name, parent, None, None)?;
                    self.by_name.insert(db::fold(&name), (created.id, parent));
                    self.names.insert(created.id, created.name);
                    summary.collections.push(db::collection_path(conn, created.id)?.join("/"));
                    return Ok(created.id);
                }
            }
        }
        unreachable!("the names run out before the attempts do")
    }
}

/// Saves the links in one transaction. A link already in the library keeps
/// everything the user set; one in the trash stays there. A collection is
/// created only when a new bookmark lands in it or below it (2.19.0), and an
/// existing one with the same name (case aside) in the same place is reused.
/// `progress(done, total)` is called as links are written. Metadata is not
/// fetched: an import of thousands must not start thousands of requests.
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

    let mut collections = Collections::load(&tx, &parsed.links)?;
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
                let collection_id = match link.path.is_empty() {
                    true => None,
                    false => Some(collections.at(&tx, &link.path, &mut summary)?),
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
                let id = tx.last_insert_rowid();
                if !link.tags.is_empty() {
                    db::link_tags(&tx, id, &link.tags, &now)?;
                }
                summary.created.push(id);
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
    /// (url, collection path, tags) of every link, in file order.
    fn placed(parsed: &Parsed) -> Vec<(&str, Vec<&str>, Vec<&str>)> {
        parsed
            .links
            .iter()
            .map(|l| (l.url.as_str(), l.path.iter().map(String::as_str).collect(), l.tags.iter().map(String::as_str).collect()))
            .collect()
    }
    fn skipped(parsed: &Parsed) -> Vec<(&str, SkipReason)> {
        parsed.skipped.iter().map(|s| (s.address.as_str(), s.reason)).collect()
    }

    #[test]
    fn chrome_roots_are_not_folders_the_user_s_folders_are_nested_collections() {
        let parsed = parse(CHROME, now());
        assert_eq!(
            placed(&parsed),
            vec![
                ("https://news.ycombinator.com/", vec![], vec![]),
                ("https://github.com/", vec!["Работа"], vec![]),
                ("https://doc.rust-lang.org/book/", vec!["Работа", "Rust"], vec![]),
                ("https://tokio.rs/", vec!["Работа", "Rust", "Async"], vec![]),
                ("https://habr.com/ru/articles/", vec![], vec![]),
                ("https://example.com/long-read", vec!["Чтение"], vec![]),
                ("https://m.example.com/", vec![], vec![]),
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
                ("https://learn.microsoft.com/", vec![], vec![]),
                ("https://www.figma.com/", vec!["Design"], vec![]),
                ("https://rsms.me/inter/", vec!["Design", "Fonts"], vec![]),
                ("https://linear.app/", vec!["работа"], vec![]),
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
                ("https://www.mozilla.org/en-US/firefox/central/", vec![], vec![]),
                ("https://support.mozilla.org/en-US/products/firefox", vec!["Mozilla Firefox"], vec![]),
                ("https://cooking.example/borscht", vec!["Recipes"], vec!["soup", "beets"]),
                ("https://cooking.example/syrniki", vec!["Recipes", "Desserts"], vec!["breakfast"]),
                ("https://developer.mozilla.org/", vec![], vec![]),
                ("https://example.org/essay", vec!["Reading"], vec![]),
                ("https://example.net/unfiled", vec![], vec!["later"]),
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
                ("https://a.example/", vec!["Shelf"], vec![]),
                ("https://b.example/", vec!["Shelf", "Deep"], vec![]),
                ("https://c.example/", vec![], vec![]),
            ]
        );
    }

    /// Three levels are collections; the names of the folders below become
    /// tags, lower case, ahead of the link's own tags.
    #[test]
    fn folders_deeper_than_the_tree_become_tags() {
        let parsed = parse(
            r#"<DL><DT><H3>One</H3><DL><DT><H3>Two</H3><DL><DT><H3>Three</H3><DL><DT><H3>Four</H3><DL><DT><H3>Five</H3><DL>
               <DT><A HREF="https://deep.example/" TAGS="Own">Deep</A></DL></DL></DL></DL></DL></DL>"#,
            now(),
        );
        assert_eq!(placed(&parsed), vec![("https://deep.example/", vec!["One", "Two", "Three"], vec!["four", "five", "own"])]);
        assert_eq!(db::MAX_DEPTH, 3);
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
            (7, 0, 0, 2, 0, 1, 0)
        );
        assert_eq!(summary.collections, ["Работа", "Работа/Rust", "Работа/Rust/Async", "Чтение"]);
        // The ids of the new bookmarks, for the refresh of their previews.
        let created: Vec<i64> = c.prepare("SELECT id FROM bookmarks ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(summary.created, created);
        assert_eq!(summary.skipped.len(), 3);
        let (collection, created_at, triaged_at, source): (Option<String>, String, Option<String>, String) = c
            .query_row(
                "SELECT c.name, b.created_at, b.triaged_at, b.source FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id WHERE url = 'https://tokio.rs/'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(collection.as_deref(), Some("Async"));
        let work: i64 = c.query_row("SELECT id FROM collections WHERE name = 'Работа'", [], |r| r.get(0)).unwrap();
        let async_id: i64 = c.query_row("SELECT id FROM collections WHERE name = 'Async'", [], |r| r.get(0)).unwrap();
        assert_eq!(db::collection_path(&c, async_id).unwrap(), ["Работа", "Rust", "Async"]);
        assert_eq!(db::collection_subtree(&c, work).unwrap().len(), 3);
        assert_eq!(created_at, "2023-07-22T04:31:40.000Z", "the browser's save date");
        assert!(triaged_at.is_some(), "the library: sorted");
        assert_eq!(source, "import");
        // The parent shows its own link and those of the collections inside it.
        let inside = db::get_bookmarks(&c, &db::BookmarkQuery { collection_id: Some(work), ..Default::default() }).unwrap();
        assert_eq!(inside.items.len(), 3);
    }

    #[test]
    fn firefox_tags_stay_tags_and_a_folder_a_level_below_the_top_is_a_collection() {
        let c = database();
        let summary = import(&c, &parse(FIREFOX, now()), false, |_, _| {}).unwrap();
        assert_eq!(summary.collections, ["Mozilla Firefox", "Recipes", "Recipes/Desserts", "Reading"]);
        assert_eq!(summary.tags, 4, "soup, beets, breakfast, later");
        let syrniki = db::get_bookmarks(&c, &db::BookmarkQuery { search: Some("syrniki".into()), ..Default::default() }).unwrap();
        assert_eq!(syrniki.items[0].tags.as_deref(), Some(&["breakfast".to_string()][..]));
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
        assert_eq!(summary.collections, ["Design", "Design/Fonts"]);
        let names: Vec<String> = c.prepare("SELECT name FROM collections ORDER BY id LIMIT -1 OFFSET ?1").unwrap().query_map([seeded], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(names, ["Работа", "Rust", "Async", "Чтение", "Design", "Fonts"], "no «Пустая»: no link landed there");
        let linear: String = c
            .query_row("SELECT c.name FROM bookmarks b JOIN collections c ON c.id = b.collection_id WHERE url = 'https://linear.app/'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(linear, "Работа");
    }

    fn folder_html(path: &[&str], url: &str) -> String {
        let open: String = path.iter().map(|f| format!("<DT><H3>{f}</H3><DL>")).collect();
        format!("<DL>{open}<DT><A HREF=\"{url}\">Link</A>{}</DL>", "</DL>".repeat(path.len()))
    }

    /// Collections are reused in the same place only; a name taken elsewhere
    /// is made after the parent, then numbered; the same file finds them again.
    #[test]
    fn a_name_taken_in_another_place_becomes_name_parent_then_numbered() {
        let c = database();
        let home = db::create_collection(&c, "Home", None, None).unwrap();
        db::create_collection_under(&c, "Docs", Some(home.id), None, None).unwrap();
        let path = |name: &str| {
            let id: i64 = c.query_row("SELECT id FROM collections WHERE name = ?1", [name], |r| r.get(0)).unwrap();
            db::collection_path(&c, id).unwrap()
        };
        let run = |folders: &[&str], url: &str| import(&c, &parse(&folder_html(folders, url), now()), false, |_, _| {}).unwrap();

        // «Docs» is Home's: under Work it is «Docs (Work)»; the same place again reuses it.
        assert_eq!(run(&["Work", "Docs"], "https://a.example/").collections, ["Work", "Work/Docs (Work)"]);
        assert_eq!(path("Docs (Work)"), ["Work", "Docs (Work)"]);
        let again = run(&["work", "docs"], "https://b.example/");
        assert!(again.collections.is_empty(), "{:?}", again.collections);
        // Inside Home, case aside, it is the existing one.
        assert!(run(&["HOME", "docs"], "https://c.example/").collections.is_empty());
        let docs_in_home: i64 = c.query_row("SELECT count(*) FROM bookmarks b JOIN collections c ON c.id = b.collection_id WHERE c.name = 'Docs'", [], |r| r.get(0)).unwrap();
        assert_eq!(docs_in_home, 1);
        // A top-level «Docs» has no parent to name: «Docs 2», found again by the next import.
        assert_eq!(run(&["Docs"], "https://d.example/").collections, ["Docs 2"]);
        assert!(run(&["docs"], "https://d2.example/").collections.is_empty());
        // «Docs (Team)» is taken under Work: under Team the folder is numbered.
        let work = path("Work");
        assert_eq!(work, ["Work"]);
        let work_id: i64 = c.query_row("SELECT id FROM collections WHERE name = 'Work'", [], |r| r.get(0)).unwrap();
        db::create_collection(&c, "Team", None, None).unwrap();
        db::create_collection_under(&c, "Docs (Team)", Some(work_id), None, None).unwrap();
        assert_eq!(run(&["Team", "Docs"], "https://e.example/").collections, ["Team/Docs (Team) 2"]);
        // Docs inside Docs: the third level is named after its parent.
        assert_eq!(run(&["Home", "Docs", "Docs"], "https://f.example/").collections, ["Home/Docs/Docs (Docs)"]);
        assert_eq!(path("Docs (Docs)"), ["Home", "Docs", "Docs (Docs)"]);
    }

    /// A folder the person moved since the last import is where its links
    /// are now: the same file with a new link makes no «Work 2».
    #[test]
    fn a_moved_folder_is_found_where_its_links_are() {
        let c = database();
        let file = |urls: &[&str]| urls.iter().map(|u| folder_html(&["Work", "Docs"], u)).collect::<String>();
        let run = |html: &str| import(&c, &parse(html, now()), false, |_, _| {}).unwrap();
        assert_eq!(run(&file(&["https://a.example/"])).collections, ["Work", "Work/Docs"]);
        let id = |name: &str| c.query_row("SELECT id FROM collections WHERE name = ?1", [name], |r| r.get::<_, i64>(0)).unwrap();
        let projects = db::create_collection(&c, "Projects", None, None).unwrap().id;
        db::move_collection(&c, id("Work"), Some(projects), None).unwrap();
        let again = run(&file(&["https://a.example/", "https://b.example/"]));
        assert!(again.collections.is_empty(), "{:?}", again.collections);
        // Docs out on its own: still found by its links.
        db::move_collection(&c, id("Docs"), None, None).unwrap();
        assert!(run(&file(&["https://a.example/", "https://c.example/"])).collections.is_empty());
        let in_docs: i64 = c.query_row("SELECT count(*) FROM bookmarks WHERE collection_id = ?1", [id("Docs")], |r| r.get(0)).unwrap();
        assert_eq!(in_docs, 3);
    }

    /// A parent is made for a child that gets a new bookmark; folders whose
    /// links are all in the library already leave nothing behind.
    #[test]
    fn a_parent_is_made_for_its_child_but_only_when_a_new_link_lands_below() {
        let c = database();
        let before: i64 = c.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        let first = import(&c, &parse(&folder_html(&["A", "B", "C"], "https://a.example/"), now()), false, |_, _| {}).unwrap();
        assert_eq!(first.collections, ["A", "A/B", "A/B/C"]);
        let none = import(&c, &parse(&folder_html(&["X", "Y"], "https://a.example/"), now()), false, |_, _| {}).unwrap();
        assert!((none.added, none.collections.len()) == (0, 0) && none.existing == 1);
        let count: i64 = c.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
        assert_eq!(count, before + 3);
        // A new link in a folder that exists, below one that does not.
        let later = import(&c, &parse(&folder_html(&["a", "b", "c"], "https://b.example/"), now()), false, |_, _| {}).unwrap();
        assert!(later.collections.is_empty());
        let in_c: i64 = c.query_row("SELECT count(*) FROM bookmarks WHERE collection_id = (SELECT id FROM collections WHERE name = 'C')", [], |r| r.get(0)).unwrap();
        assert_eq!(in_c, 2);
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
