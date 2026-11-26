//! A fetched document into posts (NP-129, plan §4.1): feed-rs 3.1.0 with a
//! base URI, then our own layer (keys, excerpts, thumbnails, limits, one
//! repair).
//!
//! feed-rs 3.1.0 fixed what 3.0.0 got wrong and this layer used to cover:
//! feed-rs/feed-rs#295 (unescaped markup in RSS text), #296 (an item-level
//! `media:thumbnail`), #297 (an `<rss>` without `version`), #298 (JSON Feed
//! `image` and `banner_image`) and numeric JSON Feed ids. What is left:
//!
//! - feed-rs reads a JSON Feed `image` or `banner_image` only when it is an
//!   absolute address. [`json_images`] reads relative ones against the feed;
//! - a bare `&` is ill-formed XML, and feed-rs 3.1.0 reads the elements
//!   around it as empty; [`repair`] escapes it before the document is read.

use feed_rs::model::{Entry, Feed, FeedType, Text};
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
    /// RSS `<language>`, Atom `xml:lang`, JSON Feed `language`: a BCP 47 tag such as `en-gb`,
    /// for the reader's hyphens and fonts.
    pub language: Option<String>,
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

/// Why a document gave no posts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Over [`MAX_BODY`].
    TooLarge,
    /// Not a feed, even after the repair.
    Invalid,
}

/// A document fetched from `base` into posts. An XML document with a bare
/// `&` is repaired before it is read: feed-rs 3.1.0 no longer refuses it but
/// leaves the elements around it empty, so the repair cannot wait for an error.
pub fn parse(bytes: &[u8], base: &Url) -> Result<ParsedFeed, ParseError> {
    if bytes.len() > MAX_BODY {
        return Err(ParseError::TooLarge);
    }
    let json = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes).trim_ascii_start().starts_with(b"{");
    let source = match (!json).then(|| repair(bytes)).flatten() {
        Some(repaired) => Cow::Owned(repaired),
        None => Cow::Borrowed(bytes),
    };
    let feed = read(&source, base).map_err(|_| ParseError::Invalid)?;
    Ok(map(feed, &source, base))
}

/// Whether bytes look like a feed rather than a page: the root an XML feed
/// has, or a JSON Feed's version. For a pasted link (NP-129, plan §4.2).
pub fn looks_like_feed(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let head = if wide(head) { utf16_lossy(head) } else { String::from_utf8_lossy(head).into_owned() }.to_ascii_lowercase();
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

/// The one repair (ill-formed XML): a bare `&` escaped outside CDATA,
/// comments and processing instructions. None when there was nothing to
/// repair, found without copying the document, since it runs on every fetch.
/// The scan reads single bytes, so a document whose bytes are not ASCII where
/// they look like it is left alone: UTF-16 and UTF-32, and what encoding_rs
/// (feed-rs's decoder) calls not ASCII-compatible under any of its labels, such
/// as ISO-2022-JP, whose characters are pairs of ASCII bytes. UTF-7, which
/// encoding_rs does not know, is one too.
fn repair(bytes: &[u8]) -> Option<Vec<u8>> {
    let narrow_only = |label: String| {
        label == "utf-7" || encoding_rs::Encoding::for_label(label.as_bytes()).is_some_and(|e| !e.is_ascii_compatible())
    };
    if wide(bytes) || declared_encoding(bytes).is_some_and(narrow_only) {
        return None;
    }
    let mut at = bare_ampersand(bytes, 0)?;
    let mut out = Vec::with_capacity(bytes.len() + 64);
    let mut copied = 0;
    loop {
        out.extend_from_slice(&bytes[copied..at]);
        out.extend_from_slice(b"&amp;");
        copied = at + 1;
        match bare_ampersand(bytes, copied) {
            Some(next) => at = next,
            None => break,
        }
    }
    out.extend_from_slice(&bytes[copied..]);
    Some(out)
}

/// The next `&` from `from` that starts no reference, outside CDATA,
/// comments and processing instructions (what is inside them is not markup).
fn bare_ampersand(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while let Some(offset) = bytes[i..].iter().position(|&b| b == b'<' || b == b'&') {
        i += offset;
        let rest = &bytes[i..];
        if rest[0] == b'&' {
            if !is_reference(&rest[1..]) {
                return Some(i);
            }
            i += 1;
            continue;
        }
        let verbatim = [(&b"<![CDATA["[..], &b"]]>"[..]), (b"<!--", b"-->"), (b"<?", b"?>")]
            .into_iter()
            .find(|(open, _)| rest.starts_with(open));
        i += match verbatim {
            Some((open, close)) => find(&rest[open.len()..], close).map_or(rest.len(), |at| open.len() + at + close.len()),
            None => 1,
        };
    }
    None
}

/// A UTF-16 or UTF-32 document: its byte order mark, or a NUL in the first
/// bytes, which UTF-8 and the single-byte encodings never have there.
fn wide(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || bytes.iter().take(4).any(|&b| b == 0)
}

/// A [`wide`] document's text, its byte order (the mark, else where the NUL
/// of the first ASCII character is) read from its start. UTF-32 reads as
/// UTF-16 with a NUL after each character, and the NULs are left out.
fn utf16_lossy(bytes: &[u8]) -> String {
    let (little, bytes) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (true, rest),
        [0xFE, 0xFF, rest @ ..] => (false, rest),
        [0, ..] => (false, bytes),
        _ => (true, bytes),
    };
    let units = bytes.as_chunks::<2>().0.iter().map(|&pair| if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) });
    char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)).filter(|&c| c != '\0').collect()
}

/// The `encoding` of the XML declaration, lowercased, when there is one;
/// whitespace before it (ill-formed, but served) is passed over.
fn declared_encoding(bytes: &[u8]) -> Option<String> {
    let bytes = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes).trim_ascii_start();
    let decl = bytes.strip_prefix(b"<?xml")?;
    let decl = &decl[..find(decl, b"?>")?];
    let after = &decl[find(decl, b"encoding")? + b"encoding".len()..];
    let after = after.trim_ascii_start().strip_prefix(b"=")?.trim_ascii_start();
    let (&quote, value) = after.split_first()?;
    let value = &value[..value.iter().position(|&b| b == quote)?];
    Some(String::from_utf8_lossy(value).trim().to_ascii_lowercase())
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
    let json = feed.feed_type == FeedType::JSON;
    let images = if json { json_images(source) } else { HashMap::new() };

    let mut keys = HashSet::new();
    let items = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let image = images.get(entry.id.trim()).or_else(|| images.get(&format!("#{index}"))).cloned();
            item(entry, base, json, image)
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
        language: feed.language.as_deref().and_then(language_tag),
        ttl_minutes: feed.ttl,
        items,
    }
}

/// A language tag as the reader can put it in `lang`: `en_US` and `EN-us` become `en-us`;
/// anything that is not letters and digits in parts of up to eight is none.
fn language_tag(raw: &str) -> Option<String> {
    let tag = raw.trim().replace('_', "-").to_ascii_lowercase();
    let valid = tag.split('-').all(|part| (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric()));
    (valid && tag.split('-').next().is_some_and(|primary| (2..=3).contains(&primary.len()) && primary.bytes().all(|b| b.is_ascii_alphabetic()))).then_some(tag)
}

fn item(entry: &Entry, base: &Url, json: bool, json_image: Option<String>) -> ParsedItem {
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

    // JSON Feed: `image` before `banner_image`, relative or not, from our own
    // read; feed-rs's (absolute only, the banner as a thumbnail) when that
    // found none.
    let thumbnail_url = if json {
        json_image.and_then(|raw| web_url(base, &raw)).or_else(|| json_media(entry, base))
    } else {
        media_thumbnail(entry, base).or_else(|| media_image(entry, base))
    };
    let thumbnail_url = thumbnail_url
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
        // feed-rs's dates are `jiff`'s; the library's are `chrono`'s. jiff
        // counts a time before 1970 toward zero, with negative nanoseconds;
        // chrono wants the second below and nanoseconds from it.
        published_at: entry
            .published
            .as_ref()
            .or(entry.updated.as_ref())
            .map(|time| time.timestamp())
            .and_then(|at| {
                let (second, nano) = (at.as_second(), at.subsec_nanosecond());
                let (second, nano) = if nano < 0 { (second - 1, nano + 1_000_000_000) } else { (second, nano) };
                chrono::DateTime::from_timestamp(second, nano.try_into().ok()?)
            })
            .map(crate::db::stamp),
    }
}

/// A Media RSS thumbnail: directly in the item, or inside `media:content` or `media:group`.
fn media_thumbnail(entry: &Entry, base: &Url) -> Option<String> {
    entry.media.iter().flat_map(|m| m.thumbnails.iter()).find_map(|t| web_url(base, &t.image.uri))
}

/// A JSON Feed item's `image`, else its `banner_image`, as feed-rs read them.
fn json_media(entry: &Entry, base: &Url) -> Option<String> {
    let image = entry.media.iter().flat_map(|m| m.content.iter()).find_map(|c| web_url(base, c.url.as_ref()?.as_str()));
    image.or_else(|| media_thumbnail(entry, base))
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

/// JSON Feed `image`, else `banner_image`, of each item, by its id (and by
/// `#position` for an item without one): for the relative addresses feed-rs
/// 3.1.0 leaves out.
fn json_images(source: &[u8]) -> HashMap<String, String> {
    let source = source.strip_prefix("\u{feff}".as_bytes()).unwrap_or(source);
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(source) else {
        return HashMap::new();
    };
    let Some(items) = json.get("items").and_then(|i| i.as_array()) else {
        return HashMap::new();
    };
    // A repeated id is one post, the first (as `map` keeps it): its image, or none.
    let mut first: HashMap<String, Option<String>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let image = ["image", "banner_image"].iter().find_map(|k| item.get(*k)?.as_str().filter(|s| !s.trim().is_empty()));
        let id = match item.get("id") {
            Some(serde_json::Value::String(id)) => id.trim().to_string(),
            Some(serde_json::Value::Number(id)) => id.to_string(),
            _ => format!("#{index}"),
        };
        first.entry(id).or_insert(image.map(str::to_string));
    }
    first.into_iter().filter_map(|(id, image)| Some((id, image?))).collect()
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
        assert_eq!(first.published.as_ref().unwrap().timestamp().to_string(), "2026-10-15T09:12:00Z");
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
        assert_eq!(feed.language.as_deref(), Some("en-gb"));
        assert_eq!(language_tag(" pt-BR "), Some("pt-br".into()));
        assert_eq!(language_tag("zh-Hant-TW"), Some("zh-hant-tw".into()));
        for junk in ["", "english", "e", "en--us", "12", "en us", "en-<b>"] {
            assert_eq!(language_tag(junk), None, "{junk}");
        }
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
    fn item_level_thumbnails_are_read() {
        // BBC-shaped: a media:thumbnail directly in each item (feed-rs/feed-rs#296, fixed in 3.1.0).
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
    fn rss_without_version_is_read_and_a_bare_ampersand_is_repaired_once() {
        let feed = parsed("rss-no-version.xml", "https://plain.example.com/rss");
        assert_eq!(feed.items[0].title, "Still a feed");
        let feed = parsed("bare-ampersand.xml", "https://plain.example.com/rss");
        assert_eq!(feed.title.as_deref(), Some("Salt & Pepper"));
        assert_eq!(feed.items[0].title, "Fish & chips");
        assert_eq!(feed.items[0].url.as_deref(), Some("https://plain.example.com/p?a=1&b=2"));
        assert!(feed.items[0].excerpt.contains("R&D"), "{}", feed.items[0].excerpt);
        // CDATA is left as it is, and so are proper references.
        assert_eq!(repair(b"<rss version=\"2.0\"><![CDATA[a & b]]>&amp;&#38;&#x26;</rss>"), None);
        assert_eq!(repair(b"<rss version=\"2.0\">a & b</rss>").as_deref(), Some(&b"<rss version=\"2.0\">a &amp; b</rss>"[..]));
        assert_eq!(repair(b"<a>& <!-- & --> &x; <?p & ?> & <![CDATA[&]]>&</a>").as_deref(), Some(&b"<a>&amp; <!-- & --> &x; <?p & ?> &amp; <![CDATA[&]]>&amp;</a>"[..]));
        assert_eq!(repair(b"<a>&amp;</a>"), None, "nothing to repair: no copy");
    }

    /// The repair reads single bytes, so a UTF-16 document is not touched:
    /// its `&amp;` stays a reference.
    #[test]
    fn a_utf_16_feed_is_not_repaired() {
        let xml = r#"<?xml version="1.0" encoding="UTF-16"?><rss version="2.0"><channel><title>Fish &amp; chips</title><item><guid>a</guid><title>One</title></item></channel></rss>"#;
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(xml.encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert_eq!(repair(&utf16), None);
        let no_bom: Vec<u8> = xml.encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(repair(&no_bom), None);
        let feed = parse(&utf16, &Url::parse("https://wide.example.com/rss").unwrap()).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Fish & chips"));
        assert_eq!(feed.items[0].title, "One");
        // A pasted link to it is a feed, a comment of Cyrillic before the root
        // included (U+043E is the byte `>` and a 0x04).
        let commented = xml.replace("<rss", "<!-- о --><rss");
        assert!(looks_like_feed(&utf16));
        assert!(looks_like_feed(&no_bom));
        let le: Vec<u8> = commented.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(looks_like_feed(&le));
        let utf32: Vec<u8> = [0xFF, 0xFE, 0, 0].into_iter().chain(xml.chars().flat_map(|c| (c as u32).to_le_bytes())).collect();
        assert!(looks_like_feed(&utf32));
        let page: Vec<u8> = "<html><body>no</body></html>".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(!looks_like_feed(&page));
    }

    /// ISO-2022-JP writes each kanji as two ASCII bytes, `&` among them: the
    /// repair would cut a character in two.
    #[test]
    fn a_7_bit_stateful_encoding_is_not_repaired() {
        // 漢 in ISO-2022-JP: ESC $ B, 0x34 0x41; a pair with 0x26 (`&`) as its first byte, ESC ( B.
        let doc = b"<?xml version=\"1.0\" encoding=\"ISO-2022-JP\"?><rss version=\"2.0\"><channel><title>\x1b$B4A&A\x1b(B</title></channel></rss>";
        assert_eq!(repair(doc), None);
        assert_eq!(declared_encoding(doc).as_deref(), Some("iso-2022-jp"));
        assert_eq!(repair(b"<?xml version='1.0' encoding = 'utf-7' ?><a>&</a>"), None);
        // Any label encoding_rs knows for one, and a declaration after whitespace.
        for label in ["csISO2022JP", "hz-gb-2312", "ISO-2022-KR", "utf-16"] {
            let doc = format!("<?xml version=\"1.0\" encoding=\"{label}\"?><a>&</a>");
            assert_eq!(repair(doc.as_bytes()), None, "{label}");
        }
        assert_eq!(repair(b"\n  <?xml version=\"1.0\" encoding=\"ISO-2022-JP\"?><a>&</a>"), None);
        assert!(repair(b"<?xml version=\"1.0\" encoding=\"Shift_JIS\"?><a>&</a>").is_some(), "ASCII-compatible: repaired");
        assert!(repair(b"<?xml version=\"1.0\" encoding=\"windows-1251\"?><a>&</a>").is_some(), "ASCII-compatible: repaired");
        assert!(repair(b"<a>&</a>").is_some(), "no declaration: UTF-8");
    }

    #[test]
    fn json_feed_image_wins_over_an_absolute_banner() {
        let json = br#"{"version": "https://jsonfeed.org/version/1.1", "title": "P", "items": [
            {"id": "a", "url": "https://p.example.com/a", "title": "A", "content_html": "<p>a</p>",
             "image": "/img/a.jpg", "banner_image": "https://cdn.example.com/b.jpg"},
            {"id": "b", "url": "https://p.example.com/b", "title": "B", "content_html": "<p>b</p>",
             "banner_image": "https://cdn.example.com/b.jpg"}]}"#;
        let feed = parse(json, &Url::parse("https://p.example.com/feed.json").unwrap()).unwrap();
        assert_eq!(feed.items[0].thumbnail_url.as_deref(), Some("https://p.example.com/img/a.jpg"));
        assert_eq!(feed.items[1].thumbnail_url.as_deref(), Some("https://cdn.example.com/b.jpg"));

        // A repeated id is the first post, with the first item's image or none.
        let json = br#"{"version": "https://jsonfeed.org/version/1.1", "title": "P", "items": [
            {"id": "x", "url": "https://p.example.com/x", "title": "First", "content_html": "<p>1</p>", "image": "/img/first.jpg"},
            {"id": "x", "url": "https://p.example.com/x2", "title": "Again", "content_html": "<p>2</p>", "image": "/img/again.jpg"},
            {"id": "y", "url": "https://p.example.com/y", "title": "Bare", "content_html": "<p>3</p>"},
            {"id": "y", "url": "https://p.example.com/y2", "title": "Again", "content_html": "<p>4</p>", "image": "/img/later.jpg"}]}"#;
        let feed = parse(json, &Url::parse("https://p.example.com/feed.json").unwrap()).unwrap();
        assert_eq!(feed.items.len(), 2);
        assert_eq!((feed.items[0].title.as_str(), feed.items[0].thumbnail_url.as_deref()), ("First", Some("https://p.example.com/img/first.jpg")));
        assert_eq!((feed.items[1].title.as_str(), feed.items[1].thumbnail_url.as_deref()), ("Bare", None));
    }

    #[test]
    fn a_date_before_1970_keeps_its_fraction() {
        let xml = br#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Old</title><id>old</id><updated>2026-01-01T00:00:00Z</updated>
            <entry><id>e</id><title>Moon</title><published>1969-12-31T23:59:59.5Z</published><updated>1969-12-31T23:59:59.5Z</updated></entry></feed>"#;
        let feed = parse(xml, &Url::parse("https://old.example.com/atom").unwrap()).unwrap();
        assert_eq!(feed.items[0].published_at.as_deref(), Some("1969-12-31T23:59:59.500Z"));
    }

    /// feed-rs/feed-rs#295: markup inside an RSS title is cut at the first
    /// child element on 3.0.0; 3.1.0 keeps the whole text.
    #[test]
    fn unescaped_markup_in_rss_text_keeps_its_text() {
        let feed = parsed("unescaped-markup.xml", "https://loose.example.com/rss");
        assert_eq!(feed.items[0].title, "Hello world");
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
