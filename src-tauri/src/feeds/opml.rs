//! OPML import and export with `quick-xml` (NP-131, plan §7).
//!
//! Import takes every `outline` with an `xmlUrl` at any depth, whatever its
//! `type` (some readers leave it out); folders are dropped, as feeds have
//! none in 2.0.0. Export writes OPML 2.0, one `outline type="rss"` per feed.

use super::{FeedDestination, OpmlImport, OpmlSkip, OpmlSkipReason};
use crate::error::{CommandError, ErrorCode};
use quick_xml::{
    events::{BytesDecl, BytesText, Event},
    Reader, Writer, XmlVersion,
};
use rusqlite::Connection;

/// A larger file is no list of feeds.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// A feed an OPML file names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outline {
    /// The feed's own name as the file has it: `title` (unless it is just the
    /// address), else `text`; none when the file names it by its address only.
    pub title: Option<String>,
    /// The person's own name: Koona Pin's export marks a rename with its own
    /// attribute (`koonaName`, which other readers ignore). Other readers'
    /// `text` and `title` are both the feed's name as they show it, often not
    /// the same words, so neither is taken for a rename (NP-131).
    pub name: Option<String>,
    pub url: String,
}

impl Outline {
    /// What a report calls it: its title, else its address.
    pub fn label(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.url)
    }
}

/// What [`import`] did: the report, and the new subscriptions with the name
/// the file gave each, for the cache to show until the first fetch brings
/// the feed's own (NP-131).
#[derive(Debug, Clone)]
pub struct Imported {
    pub report: OpmlImport,
    pub named: Vec<(String, String)>,
}

fn not_opml() -> CommandError {
    CommandError::new(ErrorCode::InvalidRequest, "Not an OPML file")
}

/// Every `outline` with an `xmlUrl`, in document order. A file broken half
/// way keeps the feeds read before the break; one with none is no OPML.
pub fn parse(text: &str) -> Result<Vec<Outline>, CommandError> {
    let mut reader = Reader::from_str(text);
    // Hand-written files close tags loosely; only the outlines matter.
    reader.config_mut().check_end_names = false;
    let mut found = Vec::new();
    let mut broken = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) if e.local_name().as_ref().eq_ignore_ascii_case("outline") => {
                let (mut url, mut title, mut words, mut renamed) = (None, None, None, None);
                for attr in e.attributes().with_checks(false).flatten() {
                    let Ok(value) = attr.normalized_value(XmlVersion::Implicit1_0) else {
                        continue;
                    };
                    let value = value.trim().to_string();
                    match attr.key.local_name().as_ref().to_ascii_lowercase().as_str() {
                        "xmlurl" => url = Some(value),
                        "title" => title = Some(value),
                        "text" => words = Some(value),
                        "koonaname" => renamed = Some(value),
                        _ => {}
                    }
                }
                if let Some(url) = url.filter(|u| !u.is_empty()) {
                    let (title, words) = (title.filter(|t| !t.is_empty()), words.filter(|t| !t.is_empty()));
                    let name = renamed.filter(|n| !n.is_empty());
                    let title = title.filter(|t| *t != url).or(words);
                    found.push(Outline { title, name, url });
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => {
                broken = true;
                break;
            }
        }
    }
    if found.is_empty() && (broken || !text.to_ascii_lowercase().contains("<opml")) {
        return Err(not_opml());
    }
    Ok(found)
}

/// The text the interface read from the picked file, at most [`MAX_BYTES`].
pub fn checked(text: &str) -> Result<&str, CommandError> {
    if text.len() as u64 > MAX_BYTES {
        return Err(CommandError::invalid("An OPML file is at most 5 MB"));
    }
    Ok(text)
}

/// Reads the file, at most [`MAX_BYTES`].
pub fn read(path: &std::path::Path) -> Result<String, CommandError> {
    let size = std::fs::metadata(path).map_err(CommandError::internal)?.len();
    if size > MAX_BYTES {
        return Err(CommandError::invalid("An OPML file is at most 5 MB"));
    }
    let bytes = std::fs::read(path).map_err(CommandError::internal)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Follows every outline, in one library transaction through the same guard
/// and helper as `subscribe_feed`: local addresses and other non-web ones
/// are skipped with a reason, those already followed are counted. The first
/// fetches are the refresh loop's, which spreads them (NP-129).
/// `progress(done, total)` is called per outline.
///
/// A file's names are mostly not the person's: readers write the feed's own
/// title there, or the address. Only a rename Koona Pin's export marked
/// (`koonaName`) becomes the feed's name; otherwise the file's name is only
/// shown until the first fetch (`Imported::named`), not kept as a synced
/// name that would hide the feed's own title for good.
pub fn import(
    conn: &Connection,
    outlines: &[Outline],
    mut progress: impl FnMut(usize, usize),
) -> rusqlite::Result<Imported> {
    let tx = conn.unchecked_transaction()?;
    let mut report = OpmlImport { added: 0, existing: 0, skipped: Vec::new() };
    let mut named = Vec::new();
    for (index, outline) in outlines.iter().enumerate() {
        match super::feed_url(&outline.url) {
            Ok(url) => {
                let followed: bool =
                    tx.query_row("SELECT EXISTS (SELECT 1 FROM feeds WHERE url = ?1)", [url.as_str()], |r| r.get(0))?;
                if followed {
                    report.existing += 1;
                } else {
                    let feed = super::subscribe(&tx, &url, outline.name.clone(), FeedDestination::Feeds)?;
                    if let Some(title) = &outline.title {
                        named.push((feed.uid, title.clone()));
                    }
                    report.added += 1;
                }
            }
            Err(_) => report.skipped.push(OpmlSkip {
                title: outline.label().to_string(),
                url: outline.url.clone(),
                reason: skip_reason(&outline.url),
            }),
        }
        progress(index + 1, outlines.len());
    }
    tx.commit()?;
    Ok(Imported { report, named })
}

/// Why `feed_url` refused an address: not a web one, or a local one.
fn skip_reason(raw: &str) -> OpmlSkipReason {
    match url::Url::parse(raw.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => OpmlSkipReason::Refused,
        _ => OpmlSkipReason::InvalidUrl,
    }
}

/// A subscription as exported.
#[derive(Debug, Clone)]
pub struct Exported {
    /// `text`: the person's name, else the feed's own, else the address.
    pub name: String,
    /// `title`: the feed's own, else the address.
    pub title: String,
    /// `koonaName`: the person's own name, read back as a rename (NP-131).
    pub renamed: Option<String>,
    pub url: String,
    pub site_url: Option<String>,
}

/// OPML 2.0 of `feeds`.
pub fn write(feeds: &[Exported], created: chrono::DateTime<chrono::Utc>) -> std::io::Result<Vec<u8>> {
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    writer.create_element("opml").with_attribute(("version", "2.0")).write_inner_content(|w| {
        w.create_element("head").write_inner_content(|w| {
            w.create_element("title").write_text_content(BytesText::new("Koona Pin feeds"))?;
            w.create_element("dateCreated").write_text_content(BytesText::new(&created.to_rfc2822()))?;
            Ok(())
        })?;
        w.create_element("body").write_inner_content(|w| {
            for feed in feeds {
                let mut outline = w.create_element("outline").with_attributes([
                    ("type", "rss"),
                    ("text", feed.name.as_str()),
                    ("title", feed.title.as_str()),
                    ("xmlUrl", feed.url.as_str()),
                ]);
                if let Some(site) = &feed.site_url {
                    outline = outline.with_attribute(("htmlUrl", site.as_str()));
                }
                if let Some(renamed) = &feed.renamed {
                    outline = outline.with_attribute(("koonaName", renamed.as_str()));
                }
                outline.write_empty()?;
            }
            Ok(())
        })?;
        Ok(())
    })?;
    let mut bytes = writer.into_inner();
    bytes.push(b'\n');
    Ok(bytes)
}

/// The subscriptions to export, named as the list names them.
pub fn exported(feeds: &[super::Feed]) -> Vec<Exported> {
    feeds
        .iter()
        .map(|feed| Exported {
            name: feed.title.clone().or_else(|| feed.feed_title.clone()).unwrap_or_else(|| feed.url.clone()),
            title: feed.feed_title.clone().unwrap_or_else(|| feed.url.clone()),
            renamed: feed.title.clone(),
            url: feed.url.clone(),
            site_url: feed.site_url.clone(),
        })
        .collect()
}

/// Writes the file atomically, as the library's export does.
pub fn save(path: &std::path::Path, feeds: &[Exported]) -> Result<(), CommandError> {
    let bytes = write(feeds, chrono::Utc::now()).map_err(CommandError::internal)?;
    crate::export::write_atomically(path, &bytes).map_err(CommandError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{feeds, library};
    use std::path::PathBuf;

    fn folder() -> PathBuf {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("opml-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/opml").join(name)
    }

    fn library_in(folder: &std::path::Path) -> Connection {
        library::open(&library::Paths::new(folder.join("koonapin.db"))).unwrap().conn
    }

    #[test]
    fn every_feed_at_any_depth_with_its_title() {
        let outlines = parse(&read(&fixture("nested.opml")).unwrap()).unwrap();
        let found: Vec<(&str, &str)> = outlines.iter().map(|o| (o.label(), o.url.as_str())).collect();
        assert_eq!(
            found,
            [
                ("Example Kitchen", "https://kitchen.example.com/feed"),
                ("Notes & Tools", "https://notes.example.org/atom.xml"),
                ("Links Weekly", "https://links.example.net/feed.json"),
                ("Text only", "https://text.example.com/rss"),
                ("Home server", "http://192.168.1.20/feed.xml"),
                ("This computer", "http://localhost:8080/rss"),
                ("Not the web", "ftp://files.example.com/feed.xml"),
                ("Example Kitchen again", "https://kitchen.example.com/feed"),
            ],
            "folders and outlines without xmlUrl are dropped"
        );
    }

    #[test]
    fn import_skips_local_and_odd_addresses_and_counts_existing() {
        let folder = folder();
        let conn = library_in(&folder);
        let url = feeds::feed_url("https://text.example.com/rss").unwrap();
        feeds::subscribe(&conn, &url, Some("Mine".into()), FeedDestination::Notify).unwrap();
        let outlines = parse(&read(&fixture("nested.opml")).unwrap()).unwrap();
        let mut steps = Vec::new();
        let Imported { report, named } = import(&conn, &outlines, |done, total| steps.push((done, total))).unwrap();
        assert_eq!((report.added, report.existing), (3, 2), "the one followed before and the repeat in the file");
        let skipped: Vec<(&str, OpmlSkipReason)> = report.skipped.iter().map(|s| (s.title.as_str(), s.reason)).collect();
        assert_eq!(
            skipped,
            [("Home server", OpmlSkipReason::Refused), ("This computer", OpmlSkipReason::Refused), ("Not the web", OpmlSkipReason::InvalidUrl)]
        );
        assert_eq!(steps.len(), 8);
        assert_eq!(steps.last(), Some(&(8, 8)));
        let all = feeds::feeds(&conn).unwrap();
        assert_eq!(all.len(), 4);
        let mine = all.iter().find(|f| f.url == "https://text.example.com/rss").unwrap();
        assert_eq!((mine.title.as_deref(), mine.destination), (Some("Mine"), FeedDestination::Notify), "an existing one is untouched");
        let kitchen = all.iter().find(|f| f.url == "https://kitchen.example.com/feed").unwrap();
        assert_eq!((kitchen.title.as_deref(), kitchen.destination), (None, FeedDestination::Feeds), "the file's name is not the person's");
        assert!(named.iter().any(|(uid, title)| *uid == kitchen.uid && title == "Example Kitchen"), "it is shown until the first fetch");
    }

    #[test]
    fn export_then_import_is_a_round_trip() {
        let folder = folder();
        let conn = library_in(&folder);
        for (url, title) in [("https://a.example.com/feed", Some("Café & Co")), ("https://b.example.com/rss", None)] {
            feeds::subscribe(&conn, &feeds::feed_url(url).unwrap(), title.map(str::to_string), FeedDestination::Feeds).unwrap();
        }
        let mut list = feeds::feeds(&conn).unwrap();
        list[1].feed_title = Some("B's own <title>".into());
        list[1].site_url = Some("https://b.example.com/".into());
        let path = folder.join("feeds.opml");
        save(&path, &exported(&list)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(r#"<opml version="2.0">"#) && text.contains("<title>Koona Pin feeds</title>") && text.contains("<dateCreated>"));
        assert!(text.contains(r#"type="rss""#) && text.contains(r#"htmlUrl="https://b.example.com/""#));
        let leftovers = std::fs::read_dir(&folder).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0, "written atomically");

        let back = parse(&read(&path).unwrap()).unwrap();
        assert_eq!(
            back,
            [
                Outline { title: Some("Café & Co".into()), name: Some("Café & Co".into()), url: "https://a.example.com/feed".into() },
                Outline { title: Some("B's own <title>".into()), name: None, url: "https://b.example.com/rss".into() },
            ]
        );
        let other = library_in(&folder.join("other"));
        let report = import(&other, &back, |_, _| {}).unwrap().report;
        assert_eq!((report.added, report.existing, report.skipped.len()), (2, 0, 0));
        let names: Vec<(String, Option<String>)> = feeds::feeds(&other).unwrap().into_iter().map(|f| (f.url, f.title)).collect();
        assert!(names.contains(&("https://a.example.com/feed".into(), Some("Café & Co".into()))), "a rename survives the round trip");
        assert!(names.contains(&("https://b.example.com/rss".into(), None)), "the feed's own name is not pinned");
        let urls: Vec<String> = feeds::feeds(&other).unwrap().into_iter().map(|f| f.url).collect();
        assert_eq!(urls.len(), 2);
        assert!(urls.contains(&"https://a.example.com/feed".to_string()) && urls.contains(&"https://b.example.com/rss".to_string()));
    }

    /// Another reader's text and title are the feed's name in two forms, not a
    /// rename; only Koona Pin's `koonaName` is one (NP-131).
    #[test]
    fn only_a_marked_rename_is_the_persons_name() {
        let outlines = parse(
            r#"<opml version="2.0"><body>
                <outline text="The Verge" title="The Verge - All Posts" xmlUrl="https://v.example.com/rss"/>
                <outline text="Ars" title="Ars Technica" koonaName="Ars" xmlUrl="https://a.example.com/feed"/>
            </body></opml>"#,
        )
        .unwrap();
        assert_eq!(outlines[0].name, None);
        assert_eq!(outlines[0].title.as_deref(), Some("The Verge - All Posts"));
        assert_eq!(outlines[1].name.as_deref(), Some("Ars"));
    }

    #[test]
    fn not_opml_or_too_large_is_refused() {
        assert!(parse("<html><body>a page</body></html>").is_err());
        assert!(parse("not xml at all").is_err());
        // A list with no feeds yet is no error.
        assert_eq!(parse(r#"<opml version="2.0"><head/><body/></opml>"#).unwrap(), []);
        let folder = folder();
        let big = folder.join("big.opml");
        std::fs::write(&big, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(read(&big).unwrap_err().code, ErrorCode::InvalidRequest);
    }
}
