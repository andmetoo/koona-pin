//! A fetched document into posts (NP-129, plan §4.1): feed-rs 3.0.0 with a
//! base URI, then our own layer (keys, excerpts, thumbnails, the item-level
//! `media:thumbnail` pass, limits, one repair retry).
//!
//! What feed-rs 3.0.0 gets wrong and this layer covers, each to go when its
//! upstream issue ships in a 3.0.x release (the fixtures show the day):
//!
//! - feed-rs/feed-rs#296: a `media:thumbnail` directly in an item (BBC,
//!   GitHub releases) is dropped. [`recover_thumbnails`] reads it again;
//! - feed-rs/feed-rs#297: an `<rss>` without `version` is no feed. [`repair`]
//!   adds `version="2.0"` and parses once more;
//! - feed-rs/feed-rs#298: JSON Feed `image` and `banner_image` are not read.
//!   [`json_images`] reads them with `serde_json`;
//! - feed-rs/feed-rs#295 (reported by someone else): unescaped markup inside
//!   an RSS text element is cut at the first child element, so
//!   `<title>Hello <b>world</b></title>` reads «Hello». Such feeds are
//!   invalid; nothing here repairs them, and a fixture pins what they give.
//!
//! Not reported: a JSON Feed item whose `id` is a number fails the whole
//! document, though JSON Feed 1.1 tells readers to take it as a string.
//! [`repair`] makes it one.

use feed_rs::model::{Entry, Feed, FeedType, Text};
use quick_xml::{encoding::DecodingReader, events::Event, name::ResolveResult, NsReader};
use scraper::{Html, Selector};
use std::{borrow::Cow, collections::{HashMap, HashSet}};
use url::Url;

/// A fetched document as the cache stores it: the contract between the
/// fetch (NP-129, which makes it) and the cache (NP-131, which stores it).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedFeed {
    pub title: Option<String>,
    /// The site's home page, for «Open site» and the icon.
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub description: Option<String>,
    /// RSS `<ttl>`, in minutes; the schedule may wait longer, never shorter.
    pub ttl_minutes: Option<u32>,
    /// In document order, at most 500.
    pub items: Vec<ParsedItem>,
}

/// One post of a [`ParsedFeed`]. Times are the library's UTC strings (`db::stamp`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedItem {
    /// guid / atom:id / JSON id, else the link, else feed-rs's hash: unique in its feed.
    pub key: String,
    /// Absolute http(s), or none.
    pub url: Option<String>,
    /// Plain text, entities decoded, at most 300 characters; never empty
    /// (a title-less post takes the start of its text).
    pub title: String,
    pub author: Option<String>,
    /// Plain text, at most 600 characters, for the list's three lines.
    pub excerpt: String,
    /// Raw HTML with absolute `src` and `href`, at most 512 KB; sanitised at render.
    pub content_html: Option<String>,
    /// The content looks like the whole article (about 150 words or more).
    pub full: bool,
    pub thumbnail_url: Option<String>,
    pub published_at: Option<String>,
}

/// The largest document read: the quick-xml denial-of-service advisories make
/// a cap worth having, patched or not.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
/// Entries kept of one document; the rest are ignored.
pub const MAX_ITEMS: usize = 500;
pub const MAX_TITLE: usize = 300;
pub const MAX_EXCERPT: usize = 600;
pub const MAX_CONTENT: usize = 512 * 1024;
/// About this many words and the content is the whole article, not a teaser.
pub const FULL_WORDS: usize = 150;
/// A post without a title takes this much of its text.
const UNTITLED: usize = 80;
/// The Media RSS namespace.
const MRSS: &str = "http://search.yahoo.com/mrss/";

/// Why a document gave no posts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Over [`MAX_BODY`].
    TooLarge,
    /// Not a feed, even after the repair.
    Invalid,
}

/// A document fetched from `base` into posts. When feed-rs refuses it, one
/// repair (a missing RSS version, a bare `&`) and one more try.
pub fn parse(bytes: &[u8], base: &Url) -> Result<ParsedFeed, ParseError> {
    if bytes.len() > MAX_BODY {
        return Err(ParseError::TooLarge);
    }
    let (feed, source) = match read(bytes, base) {
        Ok(feed) => (feed, Cow::Borrowed(bytes)),
        Err(_) => {
            let repaired = repair(bytes).ok_or(ParseError::Invalid)?;
            let feed = read(&repaired, base).map_err(|_| ParseError::Invalid)?;
            (feed, Cow::Owned(repaired))
        }
    };
    Ok(map(feed, &source, base))
}

/// Whether bytes look like a feed rather than a page: the root an XML feed
/// has, or a JSON Feed's version. For a pasted link (NP-129, plan §4.2).
pub fn looks_like_feed(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('{') {
        return head.contains("jsonfeed.org/version");
    }
    // The root, after the prolog, comments and a doctype.
    let mut rest = head;
    while let Some(after) = rest.strip_prefix('<') {
        if after.starts_with('?') || after.starts_with('!') {
            rest = after.split_once('>').map_or("", |(_, r)| r).trim_start();
            continue;
        }
        return after.starts_with("rss") || after.starts_with("feed") || after.starts_with("rdf:rdf");
    }
    false
}

fn read(bytes: &[u8], base: &Url) -> Result<Feed, feed_rs::parser::ParseFeedError> {
    feed_rs::parser::Builder::new()
        .base_uri(Some(base.as_str()))
        // No guid, no atom:id: the link is the key, as the cache's contract
        // says; feed-rs's hash only when there is no link either.
        .id_generator(|links, title, uri| match links.iter().find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate")) {
            Some(link) => link.href.clone(),
            None => feed_rs::parser::generate_id(links, title, uri),
        })
        .build()
        .parse(bytes)
}

/// The one repair (feed-rs/feed-rs#297, and ill-formed XML): `version="2.0"`
/// on an `<rss>` root without one, and a bare `&` escaped outside CDATA and
/// comments; for JSON Feed, numeric item ids as strings. None when there was
/// nothing to repair.
fn repair(bytes: &[u8]) -> Option<Vec<u8>> {
    let json = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes);
    if json.trim_ascii_start().starts_with(b"{") {
        return repair_json(json);
    }
    let mut out = Vec::with_capacity(bytes.len() + 64);
    let mut changed = false;
    let mut i = 0;
    let mut root_seen = false;
    while i < bytes.len() {
        let rest = &bytes[i..];
        // Copied as they are: what is inside is not markup.
        let verbatim = [(&b"<![CDATA["[..], &b"]]>"[..]), (b"<!--", b"-->"), (b"<?", b"?>")]
            .into_iter()
            .find(|(open, _)| rest.starts_with(open));
        if let Some((_, close)) = verbatim {
            let end = find(rest, close).map_or(rest.len(), |at| at + close.len());
            out.extend_from_slice(&rest[..end]);
            i += end;
            continue;
        }
        if !root_seen && rest.starts_with(b"<") && !rest.starts_with(b"<?") && !rest.starts_with(b"<!") {
            root_seen = true;
            let is_rss = rest.len() > 4 && rest[1..4].eq_ignore_ascii_case(b"rss") && matches!(rest[4], b' ' | b'>' | b'\t' | b'\r' | b'\n');
            if is_rss {
                let tag_end = rest.iter().position(|&b| b == b'>').unwrap_or(rest.len());
                if find(&rest[..tag_end], b"version").is_none() {
                    out.extend_from_slice(b"<rss version=\"2.0\"");
                    i += 4;
                    changed = true;
                    continue;
                }
            }
        }
        if rest[0] == b'&' && !is_reference(&rest[1..]) {
            out.extend_from_slice(b"&amp;");
            i += 1;
            changed = true;
            continue;
        }
        out.push(rest[0]);
        i += 1;
    }
    changed.then_some(out)
}

/// JSON Feed items with a numeric `id`, which feed-rs refuses, given a string one.
fn repair_json(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let mut changed = false;
    for item in json.get_mut("items")?.as_array_mut()? {
        if let Some(id) = item.get_mut("id").filter(|id| id.is_number()) {
            *id = serde_json::Value::String(id.to_string());
            changed = true;
        }
    }
    changed.then(|| serde_json::to_vec(&json).ok()).flatten()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// What follows an `&` that starts an entity or character reference.
fn is_reference(after: &[u8]) -> bool {
    let Some(end) = after.iter().take(32).position(|&b| b == b';') else {
        return false;
    };
    let name = &after[..end];
    match name {
        [] => false,
        [b'#', b'x' | b'X', hex @ ..] => !hex.is_empty() && hex.iter().all(u8::is_ascii_hexdigit),
        [b'#', digits @ ..] => !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
        _ => name[0].is_ascii_alphabetic() && name.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')),
    }
}

fn map(feed: Feed, source: &[u8], base: &Url) -> ParsedFeed {
    let entries = &feed.entries[..feed.entries.len().min(MAX_ITEMS)];
    // The pass runs only when it may find something (NP-129).
    let recovered = (feed.feed_type != FeedType::JSON
        && find(source, MRSS.as_bytes()).is_some()
        && entries.iter().any(|e| media_thumbnail(e, base).is_none()))
    .then(|| recover_thumbnails(source));
    let images = (feed.feed_type == FeedType::JSON).then(|| json_images(source)).unwrap_or_default();

    let mut keys = HashSet::new();
    let items = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let found = recovered.as_deref().and_then(|list| match_recovered(list, entry, index, feed.entries.len(), base));
            let image = images.get(&entry.id).or_else(|| images.get(&format!("#{index}"))).cloned();
            item(entry, base, found, image)
        })
        // A guid repeated in one document is one post: the first.
        .filter(|item| keys.insert(item.key.clone()))
        .collect();

    let site_url = feed
        .links
        .iter()
        .filter(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
        .find_map(|l| web_url(base, &l.href))
        .filter(|site| site != base.as_str());
    ParsedFeed {
        title: feed.title.as_ref().map(|t| clip(&title_of(&t.content), MAX_TITLE)).filter(|t| !t.is_empty()),
        site_url,
        icon_url: feed.icon.iter().chain(feed.logo.iter()).find_map(|image| web_url(base, &image.uri)),
        description: feed.description.as_ref().map(|t| clip(&text_of(&t.content), MAX_EXCERPT)).filter(|t| !t.is_empty()),
        ttl_minutes: feed.ttl,
        items,
    }
}

fn item(entry: &Entry, base: &Url, recovered: Option<String>, json_image: Option<String>) -> ParsedItem {
    let url = entry
        .links
        .iter()
        .filter(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
        .find_map(|l| web_url(base, &l.href));
    // Relative addresses in the content: against xml:base, else the post, else the feed.
    let item_base = entry
        .base
        .as_deref()
        .and_then(|b| base.join(b).ok())
        .or_else(|| url.as_deref().and_then(|u| Url::parse(u).ok()))
        .unwrap_or_else(|| base.clone());

    let content = entry.content.as_ref().and_then(|c| {
        let body = c.body.as_deref()?;
        Some(if c.content_type.essence().to_string() == "text/plain" { plain_to_html(body) } else { body.to_string() })
    });
    let summary = entry.summary.as_ref().map(html_of).filter(|s| !s.trim().is_empty());
    let html = content.clone().filter(|c| !c.trim().is_empty()).or_else(|| summary.clone());
    let content_html = html.as_deref().map(|h| cap_html(&absolutize(h, &item_base)));

    let body_text = html.as_deref().map(text_of).unwrap_or_default();
    let excerpt_text = summary.as_deref().map(text_of).filter(|t| !t.is_empty()).unwrap_or_else(|| body_text.clone());
    let full = body_text.split_whitespace().count() >= FULL_WORDS;

    let mut title = entry.title.as_ref().map(|t| clip(&title_of(&t.content), MAX_TITLE)).unwrap_or_default();
    if title.is_empty() {
        title = clip(&excerpt_text, UNTITLED);
    }
    if title.is_empty() {
        title = url.clone().unwrap_or_else(|| entry.id.clone());
    }

    let thumbnail_url = media_thumbnail(entry, base)
        .or_else(|| recovered.and_then(|raw| web_url(&item_base, &raw)))
        .or_else(|| media_image(entry, base))
        .or_else(|| json_image.and_then(|raw| web_url(base, &raw)))
        .or_else(|| content.as_deref().and_then(|h| first_img(h, &item_base)))
        .or_else(|| summary.as_deref().and_then(|h| first_img(h, &item_base)));

    ParsedItem {
        key: entry.id.trim().to_string(),
        url,
        title,
        author: entry
            .authors
            .iter()
            .filter_map(|a| a.name.as_deref())
            .map(|name| text_of(name))
            .find(|name| !name.is_empty()),
        excerpt: clip(&excerpt_text, MAX_EXCERPT),
        content_html,
        full,
        thumbnail_url,
        published_at: entry.published.or(entry.updated).map(crate::db::stamp),
    }
}

/// A Media RSS thumbnail feed-rs kept (inside `media:content` or `media:group`).
fn media_thumbnail(entry: &Entry, base: &Url) -> Option<String> {
    entry.media.iter().flat_map(|m| m.thumbnails.iter()).find_map(|t| web_url(base, &t.image.uri))
}

/// An image `media:content`, an image enclosure, or an Atom enclosure link.
fn media_image(entry: &Entry, base: &Url) -> Option<String> {
    let image_path = |url: &str| {
        let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
        [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].iter().any(|ext| path.ends_with(ext))
    };
    entry
        .media
        .iter()
        .flat_map(|m| m.content.iter())
        .filter_map(|c| {
            let url = c.url.as_ref()?.as_str();
            let image = match &c.content_type {
                Some(kind) => kind.ty().as_str() == "image",
                None => image_path(url),
            };
            image.then(|| web_url(base, url)).flatten()
        })
        .next()
        .or_else(|| {
            entry
                .links
                .iter()
                .filter(|l| l.rel.as_deref() == Some("enclosure") && l.media_type.as_deref().is_some_and(|t| t.starts_with("image/")))
                .find_map(|l| web_url(base, &l.href))
        })
}

/// The first `<img src>` of some HTML that is not a tracking pixel.
fn first_img(html: &str, base: &Url) -> Option<String> {
    let fragment = Html::parse_fragment(html);
    let selector = Selector::parse("img[src]").ok()?;
    fragment
        .select(&selector)
        .filter(|img| !["width", "height"].iter().any(|a| img.value().attr(a).is_some_and(|v| v.trim() == "1")))
        .find_map(|img| web_url(base, img.value().attr("src")?))
}

/// An absolute http(s) address, resolved against `base`.
fn web_url(base: &Url, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = base.join(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The HTML of a text construct: plain text escaped, HTML as it is.
fn html_of(text: &Text) -> String {
    if text.content_type.essence().to_string() == "text/plain" {
        plain_to_html(&text.content)
    } else {
        text.content.clone()
    }
}

/// Plain text as paragraphs of HTML.
fn plain_to_html(text: &str) -> String {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    text.split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p>{}</p>", escape(p)))
        .collect()
}

/// Text of HTML, or of text that may hold markup or entities once more
/// (double-escaped titles): tags stripped, entities decoded, scripts and
/// styles left out, whitespace collapsed.
pub fn text_of(html: &str) -> String {
    if !html.contains(['<', '&']) {
        return html.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let fragment = Html::parse_fragment(html);
    let mut text = String::new();
    for node in fragment.root_element().descendants() {
        let Some(chunk) = node.value().as_text() else {
            // A block or a break between two texts is a space; inline markup is not.
            if node.value().as_element().is_some_and(|e| {
                matches!(
                    e.name(),
                    "p" | "br" | "div" | "li" | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre"
                        | "tr" | "td" | "th" | "section" | "article" | "figure" | "figcaption" | "hr" | "dd" | "dt"
                )
            }) {
                text.push(' ');
            }
            continue;
        };
        let hidden = node
            .ancestors()
            .any(|a| a.value().as_element().is_some_and(|e| matches!(e.name(), "script" | "style" | "template")));
        if !hidden {
            text.push_str(chunk);
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A title as text: tags stripped and entities decoded, and once more when
/// that left markup or entities behind (a double-escaped title).
fn title_of(raw: &str) -> String {
    let once = text_of(raw);
    if once.contains(['<', '&']) {
        text_of(&once)
    } else {
        once
    }
}

/// At most `max` characters, cut at a word with «…» when it was longer.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max - 1).collect();
    let at_word = match cut.rfind(char::is_whitespace) {
        Some(space) if space > cut.len() / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", at_word.trim_end())
}

/// Content over [`MAX_CONTENT`] is cut before a tag that would be left half
/// open; the interface's sanitizer closes the rest.
fn cap_html(html: &str) -> String {
    if html.len() <= MAX_CONTENT {
        return html.to_string();
    }
    let mut end = MAX_CONTENT;
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    let cut = &html[..end];
    match (cut.rfind('<'), cut.rfind('>')) {
        (Some(open), Some(close)) if open > close => cut[..open].to_string(),
        (Some(open), None) => cut[..open].to_string(),
        _ => cut.to_string(),
    }
}

/// Relative `src` and `href` made absolute against `base`, so the sanitizer
/// of the article sheet sees only absolute addresses. Other markup is left
/// byte for byte.
fn absolutize(html: &str, base: &Url) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut copied = 0;
    let mut at = 0;
    while let Some(found) = ["src", "href"].iter().filter_map(|name| find_attr(&lower, at, name)).min_by_key(|(start, ..)| *start) {
        let (_, value_start, value_end) = found;
        at = value_end.max(value_start + 1);
        let value = &html[value_start..value_end];
        let trimmed = value.trim();
        let keep = trimmed.is_empty()
            || trimmed.starts_with('#')
            || Url::parse(trimmed).is_ok()
            || trimmed.to_ascii_lowercase().starts_with("data:");
        if keep {
            continue;
        }
        let Ok(absolute) = base.join(&decode_attr(trimmed)) else {
            continue;
        };
        out.push_str(&html[copied..value_start]);
        out.push_str(&absolute.as_str().replace('"', "%22").replace('\'', "%27"));
        copied = value_end;
    }
    out.push_str(&html[copied..]);
    out
}

/// `&amp;` in an attribute value is `&`: the address is joined decoded.
fn decode_attr(value: &str) -> Cow<'_, str> {
    if value.contains("&amp;") {
        Cow::Owned(value.replace("&amp;", "&"))
    } else {
        Cow::Borrowed(value)
    }
}

/// The next ` name=` attribute inside a tag from `from`: its start and its
/// value's range, quotes excluded.
fn find_attr(lower: &str, from: usize, name: &str) -> Option<(usize, usize, usize)> {
    let bytes = lower.as_bytes();
    let mut search = from;
    while let Some(offset) = lower.get(search..)?.find(name) {
        let start = search + offset;
        search = start + name.len();
        let before_ok = start > 0 && matches!(bytes[start - 1], b' ' | b'\t' | b'\n' | b'\r' | b'/');
        if !before_ok {
            continue;
        }
        // Inside a tag: the last `<` before it comes after the last `>`.
        let head = &lower[..start];
        if head.rfind('<') < head.rfind('>') || head.rfind('<').is_none() {
            continue;
        }
        let mut i = start + name.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        return Some(match bytes[i] {
            quote @ (b'"' | b'\'') => {
                let end = lower[i + 1..].find(quote as char).map_or(bytes.len(), |e| i + 1 + e);
                (start, i + 1, end)
            }
            _ => {
                let end = lower[i..].find(|c: char| c.is_ascii_whitespace() || c == '>').map_or(bytes.len(), |e| i + e);
                (start, i, end)
            }
        });
    }
    None
}

/// What the item-level pass found in one `<item>` or `<entry>`.
#[derive(Debug, Clone, Default, PartialEq)]
struct Recovered {
    id: Option<String>,
    link: Option<String>,
    thumbnail: Option<String>,
}

/// One streaming pass over the document (feed-rs/feed-rs#296): for each
/// `<item>`/`<entry>`, the first `media:thumbnail@url` directly inside it,
/// with its guid/id and link to match it to feed-rs's entry. A document
/// quick-xml cannot read to the end gives what it read before.
fn recover_thumbnails(source: &[u8]) -> Vec<Recovered> {
    let mut reader = NsReader::from_reader(DecodingReader::new(source));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut found = Vec::new();
    let mut depth = 0usize;
    // The depth of the open item, and what it has so far.
    let mut item: Option<(usize, Recovered)> = None;
    // A direct child whose text is wanted: `id` or `link`.
    let mut capture: Option<(&'static str, String)> = None;
    loop {
        let Ok((ns, event)) = reader.read_resolved_event_into(&mut buf) else {
            break;
        };
        let mrss = matches!(&ns, ResolveResult::Bound(n) if n.as_ref() == MRSS);
        match event {
            Event::Decl(decl) => {
                if let Some(encoding) = decl.encoder() {
                    reader.get_mut().set_encoding(encoding);
                }
            }
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                let local = e.local_name().as_ref().to_string();
                let attr = |name: &str| {
                    e.attributes().flatten().find(|a| a.key.local_name().as_ref() == name).map(|a| {
                        quick_xml::escape::unescape(&a.value).map(|v| v.into_owned()).unwrap_or_else(|_| a.value.to_string())
                    })
                };
                match &mut item {
                    None if !empty && (local == "item" || local == "entry") => {
                        item = Some((depth + 1, Recovered::default()));
                    }
                    Some((at, current)) if depth == *at => {
                        if mrss && local == "thumbnail" && current.thumbnail.is_none() {
                            current.thumbnail = attr("url");
                        } else if (local == "guid" || local == "id") && current.id.is_none() && !empty {
                            capture = Some(("id", String::new()));
                        } else if local == "link" && current.link.is_none() {
                            match attr("href") {
                                // Atom: the alternate link's href.
                                Some(href) if attr("rel").is_none_or(|r| r == "alternate") => current.link = Some(href),
                                Some(_) => {}
                                None if !empty => capture = Some(("link", String::new())),
                                None => {}
                            }
                        }
                    }
                    _ => {}
                }
                if !empty {
                    depth += 1;
                }
            }
            Event::Text(ref t) => {
                if let Some((_, text)) = &mut capture {
                    text.push_str(t);
                }
            }
            Event::CData(ref t) => {
                if let Some((_, text)) = &mut capture {
                    text.push_str(t);
                }
            }
            Event::GeneralRef(ref r) => {
                if let Some((_, text)) = &mut capture {
                    match r.resolve_char_ref() {
                        Ok(Some(ch)) => text.push(ch),
                        _ => {
                            if let Some(resolved) = quick_xml::escape::resolve_predefined_entity(r.as_ref()) {
                                text.push_str(resolved);
                            }
                        }
                    }
                }
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if let Some((field, text)) = capture.take() {
                    if let Some((_, current)) = &mut item {
                        let text = Some(text.trim().to_string()).filter(|t| !t.is_empty());
                        match field {
                            "id" => current.id = text,
                            _ => current.link = text,
                        }
                    }
                }
                if item.as_ref().is_some_and(|(at, _)| depth + 1 == *at) {
                    found.push(item.take().map(|(_, r)| r).unwrap_or_default());
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    found
}

/// The recovered thumbnail of feed-rs's `entry`: by guid/id, else by link,
/// else by position when both saw the same number of entries.
fn match_recovered(list: &[Recovered], entry: &Entry, index: usize, total: usize, base: &Url) -> Option<String> {
    let link = entry.links.first().map(|l| l.href.as_str());
    let by_id = list.iter().find(|r| r.id.as_deref() == Some(entry.id.trim()));
    let by_link = || {
        list.iter().find(|r| {
            let resolved = r.link.as_deref().and_then(|l| base.join(l).ok());
            resolved.is_some() && resolved.as_ref().map(Url::as_str) == link
        })
    };
    let by_position = || (list.len() == total).then(|| list.get(index)).flatten();
    by_id.or_else(by_link).or_else(by_position).and_then(|r| r.thumbnail.clone())
}

/// JSON Feed `image`, else `banner_image`, of each item, by its id (and by
/// `#position` for an item without one), which feed-rs 3.0.0 does not read
/// (feed-rs/feed-rs#298).
fn json_images(source: &[u8]) -> HashMap<String, String> {
    let source = source.strip_prefix("\u{feff}".as_bytes()).unwrap_or(source);
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(source) else {
        return HashMap::new();
    };
    let Some(items) = json.get("items").and_then(|i| i.as_array()) else {
        return HashMap::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let image = ["image", "banner_image"].iter().find_map(|k| item.get(*k)?.as_str().filter(|s| !s.trim().is_empty()))?;
            let id = match item.get("id") {
                Some(serde_json::Value::String(id)) => id.trim().to_string(),
                Some(serde_json::Value::Number(id)) => id.to_string(),
                _ => format!("#{index}"),
            };
            Some((id, image.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use feed_rs::model::FeedType;

    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feeds").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn parsed(name: &str, base: &str) -> ParsedFeed {
        parse(&fixture(name), &Url::parse(base).unwrap()).unwrap_or_else(|e| panic!("{name}: {e:?}"))
    }

    /// The three formats into one model: what the cache will key, link and date by.
    #[test]
    fn feed_rs_reads_rss_atom_and_json_feed() {
        let parser = |base: &str| feed_rs::parser::Builder::new().base_uri(Some(base)).build();

        let rss = parser("https://kitchen.example.com/feed").parse(fixture("rss2.xml").as_slice()).unwrap();
        assert_eq!(rss.feed_type, FeedType::RSS2);
        assert_eq!(rss.title.unwrap().content, "Example Kitchen");
        assert_eq!(rss.entries.len(), 2);
        let first = &rss.entries[0];
        assert_eq!(first.id, "kitchen-0002", "the guid is the key");
        assert_eq!(first.links[0].href, "https://kitchen.example.com/posts/roast-potatoes");
        assert_eq!(first.authors[0].name.as_deref(), Some("Ann Example"));
        assert_eq!(first.published.unwrap().to_rfc3339(), "2026-10-15T09:12:00+00:00");
        assert!(first.summary.as_ref().unwrap().content.contains("<em>rough up</em>"));

        let atom = parser("https://notes.example.org/atom.xml").parse(fixture("atom.xml").as_slice()).unwrap();
        assert_eq!(atom.feed_type, FeedType::Atom);
        let entry = &atom.entries[0];
        assert_eq!(entry.id, "tag:notes.example.org,2026:small-tools");
        assert_eq!(entry.links[0].href, "https://notes.example.org/2026/small-tools");
        assert_eq!(entry.authors[0].name.as_deref(), Some("Ben Example"));
        assert!(entry.content.as_ref().unwrap().body.as_deref().unwrap().contains("<b>little</b>"));

        let json = parser("https://links.example.net/feed.json").parse(fixture("feed.json").as_slice()).unwrap();
        assert_eq!(json.feed_type, FeedType::JSON);
        assert_eq!(json.entries.len(), 2);
        assert_eq!(json.entries[0].id, "links-0042");
        assert_eq!(json.entries[0].title.as_ref().unwrap().content, "Maps drawn by hand");
        assert!(json.entries[1].title.is_none(), "a JSON item may have no title");
    }

    #[test]
    fn rss_2_with_a_guid_maps_to_posts() {
        let feed = parsed("rss2.xml", "https://kitchen.example.com/feed");
        assert_eq!(feed.title.as_deref(), Some("Example Kitchen"));
        assert_eq!(feed.site_url.as_deref(), Some("https://kitchen.example.com/"));
        assert_eq!(feed.description.as_deref(), Some("Recipes tested twice."));
        let first = &feed.items[0];
        assert_eq!(first.key, "kitchen-0002");
        assert_eq!(first.url.as_deref(), Some("https://kitchen.example.com/posts/roast-potatoes"));
        assert_eq!(first.title, "Crisp roast potatoes");
        assert_eq!(first.author.as_deref(), Some("Ann Example"));
        assert_eq!(first.excerpt, "Parboil, rough up, then roast hot.");
        assert_eq!(first.content_html.as_deref(), Some("<p>Parboil, <em>rough up</em>, then roast hot.</p>"));
        assert_eq!(first.published_at.as_deref(), Some("2026-10-15T09:12:00.000Z"));
        assert!(!first.full);
        assert_eq!(feed.items[1].key, "https://kitchen.example.com/posts/no-knead");
    }

    #[test]
    fn rss_without_guid_keys_by_link_and_keeps_its_quirks() {
        let feed = parsed("rss2-quirks.xml", "https://garden.example.com/rss");
        assert_eq!(feed.ttl_minutes, Some(180));
        let [relative, double, enclosure, undated, untitled, img] = &feed.items[..] else {
            panic!("{:#?}", feed.items);
        };
        // No guid: the link is the key, resolved against the fetch address.
        assert_eq!(relative.key, "https://garden.example.com/posts/compost");
        assert_eq!(relative.url.as_deref(), Some("https://garden.example.com/posts/compost"));
        // Relative addresses in the content are absolute.
        let html = relative.content_html.as_deref().unwrap();
        assert!(html.contains(r#"src="https://garden.example.com/img/heap.jpg""#), "{html}");
        assert!(html.contains(r#"href="https://garden.example.com/posts/worms""#), "{html}");
        assert!(html.contains(r#"href="https://other.example.org/x""#), "{html}");
        assert!(html.contains(r##"href="#notes""##), "{html}");
        // A double-escaped title reads cleanly.
        assert_eq!(double.title, "Beans & peas: a bold start");
        assert_eq!(enclosure.thumbnail_url.as_deref(), Some("https://cdn.garden.example.com/tomato.jpg"));
        assert_eq!(undated.published_at, None);
        // No title at all: the start of its text.
        assert!(untitled.title.starts_with("Leaves fall and"), "{}", untitled.title);
        assert!(untitled.title.chars().count() <= 80);
        assert_eq!(img.thumbnail_url.as_deref(), Some("https://garden.example.com/img/first.png"), "the first <img>, not the pixel");
        assert!(img.full, "a long post is the whole article");
        assert!(img.excerpt.chars().count() <= MAX_EXCERPT);
        assert!(img.excerpt.ends_with('…'));
    }

    #[test]
    fn rss_1_0_is_read() {
        let feed = parsed("rss1.rdf", "https://journal.example.org/index.rdf");
        assert_eq!(feed.title.as_deref(), Some("Example Journal"));
        assert_eq!(feed.items.len(), 2);
        assert_eq!(feed.items[0].url.as_deref(), Some("https://journal.example.org/2026/10/one"));
        assert_eq!(feed.items[0].title, "Issue one");
        assert!(feed.items[0].published_at.is_some(), "dc:date");
    }

    #[test]
    fn atom_with_xml_base_resolves_relative_links() {
        let feed = parsed("atom-xml-base.xml", "https://press.example.com/feeds/atom.xml");
        assert_eq!(feed.site_url.as_deref(), Some("https://press.example.com/blog/"));
        assert_eq!(feed.icon_url.as_deref(), Some("https://press.example.com/blog/icon.png"));
        let entry = &feed.items[0];
        assert_eq!(entry.url.as_deref(), Some("https://press.example.com/blog/2026/ink"));
        let html = entry.content_html.as_deref().unwrap();
        assert!(html.contains(r#"src="https://press.example.com/blog/2026/media/ink.jpg""#), "{html}");
        assert_eq!(entry.thumbnail_url.as_deref(), Some("https://press.example.com/blog/2026/media/ink.jpg"));
        assert_eq!(entry.published_at.as_deref(), Some("2026-10-10T08:00:00.000Z"), "updated when not published");
        // xhtml content keeps its markup.
        assert!(feed.items[1].content_html.as_deref().unwrap().contains("<em>"), "{:?}", feed.items[1].content_html);
    }

    #[test]
    fn json_feed_reads_images_and_titles_itself() {
        let feed = parsed("jsonfeed-images.json", "https://photos.example.net/feed.json");
        assert_eq!(feed.title.as_deref(), Some("Example Photos"));
        assert_eq!(feed.site_url.as_deref(), Some("https://photos.example.net/"));
        assert_eq!(feed.icon_url.as_deref(), Some("https://photos.example.net/favicon.png"));
        let [image, banner, numbered, untitled] = &feed.items[..] else {
            panic!("{:#?}", feed.items);
        };
        assert_eq!(image.thumbnail_url.as_deref(), Some("https://photos.example.net/img/harbour.jpg"));
        assert_eq!(banner.thumbnail_url.as_deref(), Some("https://photos.example.net/img/banner.jpg"));
        assert_eq!(numbered.key, "7");
        assert_eq!(numbered.thumbnail_url.as_deref(), Some("https://photos.example.net/img/seven.jpg"));
        assert!(untitled.title.chars().count() <= 80 && untitled.title.starts_with("A morning walk"), "{}", untitled.title);
        assert!(untitled.title.ends_with('…'));
        assert!(untitled.content_html.as_deref().unwrap().starts_with("<p>"), "plain text as paragraphs");
        // The fixture of NP-128: a title-less item.
        let older = parsed("feed.json", "https://links.example.net/feed.json");
        assert_eq!(older.items[1].title, "A post without a title.");
    }

    #[test]
    fn windows_1251_and_a_bom_are_decoded() {
        let feed = parsed("windows-1251.xml", "https://news.example.ru/rss");
        assert_eq!(feed.title.as_deref(), Some("Пример новостей"));
        assert_eq!(feed.items[0].title, "Осенний урожай");
        assert_eq!(feed.items[0].excerpt, "Картофель, морковь и свёкла.");
        assert_eq!(feed.items[0].thumbnail_url.as_deref(), Some("https://news.example.ru/i/harvest.jpg"));

        let feed = parsed("bom.xml", "https://bom.example.com/feed");
        assert_eq!(feed.title.as_deref(), Some("Byte Order"));
        assert_eq!(feed.items[0].title, "Marked at the start");
    }

    #[test]
    fn item_level_thumbnails_are_recovered() {
        // BBC-shaped: a media:thumbnail directly in each item (feed-rs/feed-rs#296).
        let feed = parsed("bbc-thumbnails.xml", "https://news.example.co.uk/rss.xml");
        let thumbs: Vec<_> = feed.items.iter().map(|i| i.thumbnail_url.as_deref()).collect();
        assert_eq!(
            thumbs,
            [
                Some("https://ichef.example.co.uk/240/one.jpg"),
                Some("https://ichef.example.co.uk/240/two.jpg"),
                None,
                Some("https://ichef.example.co.uk/240/four.jpg"),
            ]
        );
        // GitHub-shaped Atom releases.
        let feed = parsed("github-releases.atom", "https://code.example.com/tool/releases.atom");
        assert_eq!(feed.items.len(), 2);
        for item in &feed.items {
            assert_eq!(item.thumbnail_url.as_deref(), Some("https://avatars.example.com/u/42?s=60&v=4"), "{}", item.key);
        }
        assert_eq!(feed.items[0].url.as_deref(), Some("https://code.example.com/tool/releases/tag/v2.1.0"));
    }

    #[test]
    fn the_pass_matches_by_id_then_link_then_position() {
        let base = Url::parse("https://example.com/feed").unwrap();
        let entry = |id: &str, link: &str| {
            let mut e = Entry { id: id.into(), ..Default::default() };
            e.links.push(feed_rs::model::Link { href: link.to_string(), target: None, rel: None, media_type: None, href_lang: None, title: None, length: None });
            e
        };
        let found = |id: Option<&str>, link: Option<&str>, thumb: &str| Recovered {
            id: id.map(Into::into),
            link: link.map(Into::into),
            thumbnail: Some(thumb.into()),
        };
        let list = [found(Some("a"), None, "1"), found(None, Some("/b"), "2"), found(None, None, "3")];
        assert_eq!(match_recovered(&list, &entry("a", "https://example.com/x"), 2, 3, &base).as_deref(), Some("1"));
        assert_eq!(match_recovered(&list, &entry("z", "https://example.com/b"), 0, 3, &base).as_deref(), Some("2"));
        assert_eq!(match_recovered(&list, &entry("z", "https://example.com/c"), 2, 3, &base).as_deref(), Some("3"));
        assert_eq!(match_recovered(&list, &entry("z", "https://example.com/c"), 2, 4, &base), None, "counts differ: no guessing");
    }

    #[test]
    fn rss_without_version_and_a_bare_ampersand_are_repaired_once() {
        let feed = parsed("rss-no-version.xml", "https://plain.example.com/rss");
        assert_eq!(feed.items[0].title, "Still a feed");
        let feed = parsed("bare-ampersand.xml", "https://plain.example.com/rss");
        assert_eq!(feed.title.as_deref(), Some("Salt & Pepper"));
        assert_eq!(feed.items[0].title, "Fish & chips");
        assert_eq!(feed.items[0].url.as_deref(), Some("https://plain.example.com/p?a=1&b=2"));
        assert!(feed.items[0].excerpt.contains("R&D"), "{}", feed.items[0].excerpt);
        // CDATA is left as it is, and so are proper references.
        assert_eq!(repair(b"<rss version=\"2.0\"><![CDATA[a & b]]>&amp;&#38;&#x26;</rss>"), None);
        assert_eq!(repair(b"<rss>x</rss>").as_deref(), Some(&b"<rss version=\"2.0\">x</rss>"[..]));
        assert_eq!(repair(b"<rss version=\"2.0\">a & b</rss>").as_deref(), Some(&b"<rss version=\"2.0\">a &amp; b</rss>"[..]));
    }

    /// feed-rs/feed-rs#295: markup inside an RSS title is cut at the first
    /// child element on 3.0.0. Invalid feeds; this pins what they give.
    #[test]
    fn unescaped_markup_in_rss_text_is_cut_as_feed_rs_reads_it() {
        let feed = parsed("unescaped-markup.xml", "https://loose.example.com/rss");
        assert_eq!(feed.items[0].title, "Hello");
        assert_eq!(feed.items.len(), 1);
    }

    #[test]
    fn garbage_and_pages_are_not_feeds() {
        let base = Url::parse("https://example.com/").unwrap();
        assert_eq!(parse(b"not a feed at all", &base), Err(ParseError::Invalid));
        assert_eq!(parse(&fixture("page.html"), &base), Err(ParseError::Invalid));
        assert_eq!(parse(b"{\"oops\": ", &base), Err(ParseError::Invalid));
    }

    fn many(entries: usize, body: &str) -> Vec<u8> {
        let mut xml = String::from(r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title>"#);
        for n in 0..entries {
            xml.push_str(&format!("<item><guid>n{n}</guid><title>Post {n}</title><description><![CDATA[{body}]]></description></item>"));
        }
        xml.push_str("</channel></rss>");
        xml.into_bytes()
    }

    #[test]
    fn limits_keep_500_posts_512_kb_of_content_and_4_mb_of_document() {
        let base = Url::parse("https://example.com/").unwrap();
        let feed = parse(&many(600, "<p>x</p>"), &base).unwrap();
        assert_eq!(feed.items.len(), MAX_ITEMS);
        assert_eq!(feed.items[499].key, "n499");

        let big = format!("<p>{}</p><p>tail</p>", "word ".repeat(105 * 1024));
        let feed = parse(&many(1, &big), &base).unwrap();
        let html = feed.items[0].content_html.as_deref().unwrap();
        assert!(html.len() <= MAX_CONTENT && html.len() > MAX_CONTENT - 16, "{}", html.len());
        assert!(feed.items[0].full);

        let title = "t".repeat(400);
        let xml = format!(r#"<rss version="2.0"><channel><item><guid>a</guid><title>{title}</title></item></channel></rss>"#);
        assert_eq!(parse(xml.as_bytes(), &base).unwrap().items[0].title.chars().count(), MAX_TITLE);

        let huge = vec![b' '; MAX_BODY + 1];
        assert_eq!(parse(&huge, &base), Err(ParseError::TooLarge));
    }

    #[test]
    fn titles_and_excerpts_are_plain_text() {
        assert_eq!(text_of("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(text_of("<b>Bold</b>   move<script>alert(1)</script>"), "Bold move");
        assert_eq!(text_of("a < b"), "a < b");
        assert_eq!(clip("one two three", 9), "one two…");
        assert_eq!(clip("short", 9), "short");
    }

    #[test]
    fn content_addresses_become_absolute_and_the_rest_stays() {
        let base = Url::parse("https://example.com/posts/one").unwrap();
        let html = r#"<p class="x" data-src="keep.jpg"><a href='../two?a=1&amp;b=2'>t</a><img alt="src=no" src=pic.png><a href="mailto:me@example.com">m</a><img src="data:image/png;base64,AA"></p> src="text.png""#;
        let out = absolutize(html, &base);
        assert!(out.contains("href='https://example.com/two?a=1&b=2'"), "{out}");
        assert!(out.contains("src=https://example.com/posts/pic.png"), "{out}");
        assert!(out.contains(r#"data-src="keep.jpg""#), "{out}");
        assert!(out.contains(r#"alt="src=no""#), "{out}");
        assert!(out.contains("mailto:me@example.com") && out.contains("data:image/png"), "{out}");
        assert!(out.ends_with(r#"src="text.png""#), "text outside a tag stays: {out}");
    }

    #[test]
    fn a_feed_is_told_from_a_page() {
        assert!(looks_like_feed(&fixture("rss2.xml")));
        assert!(looks_like_feed(&fixture("atom.xml")));
        assert!(looks_like_feed(&fixture("rss1.rdf")));
        assert!(looks_like_feed(&fixture("bom.xml")));
        assert!(looks_like_feed(&fixture("feed.json")));
        assert!(!looks_like_feed(&fixture("page.html")));
        assert!(!looks_like_feed(b"{\"name\": \"not a feed\"}"));
    }
}
