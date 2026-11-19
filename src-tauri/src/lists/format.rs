//! Reading a `.kpin` text (NP-136, Р-71): the envelope, the version and the
//! payload of `pin` / `list`, mapped from `serde_json::Value` into what the
//! preview and the import need. Text is cleaned and capped here, addresses
//! are checked here, and a repeat inside the file is merged here, so the
//! preview and the import count the same things.

use super::{ListError, ListMeta};
use crate::import::SkipReason;
use serde_json::{Map, Value};
use icu_properties::props::{ExtendedPictographic, Script};
use icu_properties::{CodePointMapData, CodePointSetData};
use std::borrow::Cow;
use std::collections::HashMap;
use url::Url;

/// A file is at most 2 MB, checked before it is parsed.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Items across all sections and the top level; more is refused, not cut.
pub const MAX_ITEMS: usize = 5_000;
/// The version this reader knows: 1.0.
pub const READER_MAJOR: u32 = 1;
pub const READER_MINOR: u32 = 0;

pub(crate) const TITLE_LEN: usize = 120;
pub(crate) const SECTION_LEN: usize = 120;
pub(crate) const ITEM_TITLE_LEN: usize = 500;
pub(crate) const DESCRIPTION_LEN: usize = 2_000;
pub(crate) const AUTHOR_LEN: usize = 120;
const LICENSE_LEN: usize = 64;
const GENERATOR_LEN: usize = 80;
pub(crate) const ID_LEN: usize = 64;
/// The schema's `httpUrl`.
const URL_LEN: usize = 2_048;
pub const TAG_LEN: usize = 64;
/// Tags per link, the sections' names among them when they become tags.
pub const TAGS_PER_ITEM: usize = 20;
/// The schema's `maxItems` of `sections`; more is refused, as too many items are.
pub const MAX_SECTIONS: usize = 200;

const ENVELOPE_KEYS: &[&str] = &[
    "$schema", "format", "app", "kind", "version", "generator", "id", "title", "description", "author",
    "license", "language", "updated", "homepage", "sections", "items",
];
const AUTHOR_KEYS: &[&str] = &["name", "url"];
const SECTION_KEYS: &[&str] = &["name", "items"];
const LINK_KEYS: &[&str] = &["type", "url", "title", "description", "tags"];
const FEED_KEYS: &[&str] = &["type", "url", "site", "title"];

/// A link of the list. A repeat of its address later in the file is merged
/// into it: its tags and its section join this one's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListLink {
    /// As it will be saved: the file's address, trimmed.
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// Lowercased, at most 64 characters each, without repeats, at most
    /// [`TAGS_PER_ITEM`] with those of its repeats.
    pub tags: Vec<String>,
    /// The names of the sections it is in, the first one first.
    pub sections: Vec<String>,
    /// Its place among the links and feeds read, in the file's order.
    pub at: usize,
}

impl ListLink {
    /// Its tags as the import gives them: the sections' names first when
    /// `sections_as_tags`, then its own, without repeats, at most
    /// [`TAGS_PER_ITEM`] in all.
    pub fn tags_with(&self, sections_as_tags: bool) -> Vec<String> {
        let mut tags: Vec<String> = Vec::new();
        let sections = self.sections.iter().filter(|_| sections_as_tags).filter_map(|s| tag(s));
        for name in sections.chain(self.tags.iter().cloned()) {
            if tags.len() == TAGS_PER_ITEM {
                break;
            }
            if !tags.contains(&name) {
                tags.push(name);
            }
        }
        tags
    }
}

/// A feed of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListFeed {
    /// As `feeds::feed_url` gives it, the form the `feeds` table holds.
    pub url: String,
    pub title: Option<String>,
    pub site: Option<String>,
    pub section: Option<String>,
    /// Its place among the links and feeds read, in the file's order.
    pub at: usize,
}

/// A list read and checked; what it skipped is counted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedList {
    pub meta: ListMeta,
    /// The file's MINOR is newer than this reader's.
    pub newer: bool,
    pub sections: u32,
    pub links: Vec<ListLink>,
    pub feeds: Vec<ListFeed>,
    /// Links and feeds whose address came earlier in the file, in one count:
    /// links compared by `url_key`, feeds by their address.
    pub repeated: u32,
    pub not_web: u32,
    pub invalid: u32,
    /// Items of a type this reader does not know, or not items at all.
    pub skipped_items: u32,
    /// Fields this reader does not know, counted only in a newer MINOR.
    pub skipped_details: u32,
}

/// One line of text: control and invisible characters dropped, white
/// space collapsed, at most `max` characters. Empty: none.
pub fn line(raw: &str, max: usize) -> Option<String> {
    // Most text is already a line (every title and tag of an import goes through
    // here): nothing the marks would change, so it is not marked at all.
    if is_a_line(raw) {
        return capped(raw, max);
    }
    let kept: String = line_marks(raw)
        .into_iter()
        .filter_map(|(c, mark)| match mark {
            Mark::Kept => Some(c),
            Mark::Space => Some(' '),
            Mark::Dropped => None,
        })
        .collect();
    capped(&kept, max)
}

/// Text that [`line_marks`] keeps whole: no invisible character, control or
/// white space other than single plain spaces between words.
fn is_a_line(raw: &str) -> bool {
    let mut space_before = true;
    for c in raw.chars() {
        if c == ' ' {
            if space_before {
                return false;
            }
            space_before = true;
        } else if c.is_whitespace() || c.is_control() || is_invisible(c) {
            return false;
        } else {
            space_before = false;
        }
    }
    !space_before || raw.is_empty()
}

/// What [`line`] does with one character of the text it is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    Kept,
    /// White space other than the plain space, alone between two words: it becomes the plain space.
    Space,
    /// An [`is_invisible`] character that is not seen, a control, or white space
    /// at either end or more than one between two words.
    Dropped,
}

/// Each character of `raw` and what [`line`] does with it; [`line`] is built
/// from this, so what Settings shows as taken out of a tag's name is exactly
/// what was. Between two words one character of the white space stays: the
/// first plain space, or else the first of them, as a plain space.
pub(crate) fn line_marks(raw: &str) -> Vec<(char, Mark)> {
    let mut marks: Vec<(char, Mark)> =
        seen_marks(raw).into_iter().map(|(c, seen)| (c, if seen { Mark::Kept } else { Mark::Dropped })).collect();
    let mut run: Vec<usize> = Vec::new();
    let mut word_before = false;
    for i in 0..marks.len() {
        let (c, mark) = marks[i];
        if mark == Mark::Dropped {
            continue;
        }
        if c.is_whitespace() {
            marks[i].1 = Mark::Dropped;
            run.push(i);
        } else if c.is_control() {
            marks[i].1 = Mark::Dropped;
        } else {
            if word_before && !run.is_empty() {
                match run.iter().find(|&&j| marks[j].0 == ' ') {
                    Some(&j) => marks[j].1 = Mark::Kept,
                    None => marks[run[0]].1 = Mark::Space,
                }
            }
            run.clear();
            word_before = true;
        }
    }
    marks
}

/// Each character of `raw` and whether it is seen: an [`is_invisible`] one is
/// not, except the tags of the three subdivision [`FLAGS`], kept whole, and a
/// zero width joiner or non-joiner where it changes what is drawn
/// ([`joiner_stays`]). [`without_invisible`] keeps those that are.
fn seen_marks(raw: &str) -> Vec<(char, bool)> {
    if !raw.chars().any(is_invisible) {
        return raw.chars().map(|c| (c, true)).collect();
    }
    // The flags whole, everything but the joiners, then the joiners judged by what stands around them.
    let mut marks: Vec<(char, bool)> = Vec::new();
    let mut rest = raw;
    while let Some(c) = rest.chars().next() {
        if let Some(flag) = FLAGS.iter().find(|flag| rest.starts_with(**flag)) {
            marks.extend(flag.chars().map(|c| (c, true)));
            rest = &rest[flag.len()..];
            continue;
        }
        marks.push((c, c == ZWJ || c == ZWNJ || !is_invisible(c)));
        rest = &rest[c.len_utf8()..];
    }
    // A joiner is judged by its neighbours once what goes in every field is gone: the other
    // invisible characters, and the control characters that are not white space. A white space
    // control (a tab, a line break) stays a neighbour: a one-line field turns it into a space, and
    // a joiner beside a space joins nothing.
    let kept: Vec<usize> = (0..marks.len()).filter(|&i| marks[i].1 && !(marks[i].0.is_control() && !marks[i].0.is_whitespace())).collect();
    let judged: Vec<(usize, bool)> = kept
        .iter()
        .enumerate()
        .filter(|&(_, &i)| marks[i].0 == ZWJ || marks[i].0 == ZWNJ)
        .map(|(at, &i)| {
            let before = at.checked_sub(1).map(|b| marks[kept[b]].0);
            let after = kept.get(at + 1).map(|&a| marks[a].0);
            (i, joiner_stays(marks[i].0, before, after))
        })
        .collect();
    for (i, stays) in judged {
        marks[i].1 = stays;
    }
    marks
}

/// A description: as [`line`], but its line breaks stay.
pub(crate) fn paragraph(raw: &str, max: usize) -> Option<String> {
    let kept: String = without_invisible(&raw.replace("\r\n", "\n")).chars().filter(|&c| c == '\n' || !c.is_control()).collect();
    capped(kept.trim(), max)
}

/// At most `max` characters, the end trimmed; empty: none. A cut through a
/// flag leaves its tags without their end, and they go too.
fn capped(text: &str, max: usize) -> Option<String> {
    let cut: String = text.chars().take(max).collect();
    let cut = if cut.len() < text.len() { without_invisible(&cut).into_owned() } else { cut };
    let cut = cut.trim_end();
    (!cut.is_empty()).then(|| cut.to_owned())
}

/// The three subdivision flags Unicode recommends for general interchange
/// (England, Scotland, Wales): U+1F3F4, the tags of `gbeng`, `gbsct` or
/// `gbwls`, then CANCEL TAG. Only these keep their tag characters: any form
/// a reader would accept beyond a fixed few could carry hidden text a few
/// characters at a time, one black flag after another.
const FLAGS: [&str; 3] = [
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
];

const ZWNJ: char = '\u{200C}';
const ZWJ: char = '\u{200D}';

/// The text without its [`is_invisible`] characters, except those that are
/// seen: the tags of the three subdivision [`FLAGS`], kept whole, and a zero
/// width joiner or non-joiner where it changes what is drawn ([`joiner_stays`]).
/// Text without any is returned as it is.
pub(crate) fn without_invisible(raw: &str) -> Cow<'_, str> {
    if !raw.chars().any(is_invisible) {
        return Cow::Borrowed(raw);
    }
    Cow::Owned(seen_marks(raw).into_iter().filter(|&(_, seen)| seen).map(|(c, _)| c).collect())
}

/// The scripts where a zero width joiner or non-joiner changes how letters
/// are drawn and spelled: the joining scripts (Persian `می` U+200C `خواهم` keeps its
/// non-joiner) and the Brahmic ones of India and Sri Lanka (Sinhala `ශ්` U+200D `රී` keeps its joiner).
/// keeps its joiner). In Latin, Cyrillic, Greek and the rest they draw
/// nothing and only make one word pass for another, so they go.
const JOINING_SCRIPTS: [Script; 18] = [
    Script::Arabic,
    Script::Syriac,
    Script::Nko,
    Script::Mongolian,
    Script::Mandaic,
    Script::Manichaean,
    Script::Adlam,
    Script::HanifiRohingya,
    Script::Devanagari,
    Script::Bengali,
    Script::Gurmukhi,
    Script::Gujarati,
    Script::Oriya,
    Script::Tamil,
    Script::Telugu,
    Script::Kannada,
    Script::Malayalam,
    Script::Sinhala,
];

/// Whether a zero width joiner or non-joiner stays between `before` and
/// `after` (judged once the other invisible characters are gone):
/// - either between two characters of one of the [`JOINING_SCRIPTS`];
/// - or, a joiner, between two emoji, as in 👩‍💻 or 🏳️‍🌈: after an
///   Extended_Pictographic character, U+FE0F or a skin tone
///   (U+1F3FB–U+1F3FF), and before an Extended_Pictographic character.
///
/// Anywhere else it goes. Two in a row are never between two such
/// characters, so none of them carries anything a person does not see.
fn joiner_stays(joiner: char, before: Option<char>, after: Option<char>) -> bool {
    let (Some(before), Some(after)) = (before, after) else { return false };
    let script = |c: char| CodePointMapData::<Script>::new().get(c);
    if script(before) == script(after) && JOINING_SCRIPTS.contains(&script(before)) {
        return true;
    }
    let pictographic = |c: char| CodePointSetData::new::<ExtendedPictographic>().contains(c);
    let joins_after = pictographic(before) || before == '\u{FE0F}' || ('\u{1F3FB}'..='\u{1F3FF}').contains(&before);
    joiner == ZWJ && joins_after && pictographic(after)
}

/// Characters that are not seen but hide, reorder or join the text around
/// them, the invisible format characters (Unicode Cf) of the spec's Text: the
/// soft hyphen, zero-width ones, bidi marks, embeddings, overrides and
/// isolates, word joiners and invisible operators, the deprecated shaping
/// controls, a byte order mark anywhere, interlinear annotation marks and tag
/// characters (which can carry a whole hidden sentence). A title or a tag
/// could hide what it says, or pass for another. The Cf characters that show
/// a sign of their own (Arabic and Syriac number signs, Kaithi, Egyptian and
/// musical controls) stay. Text is cleaned by [`without_invisible`] (the
/// suggested file name too), which keeps three uses of these that are seen:
/// the tags of the three subdivision [`FLAGS`], and a zero width joiner or
/// non-joiner inside an emoji or a word of a joining or Brahmic script
/// ([`joiner_stays`]). Filter with this set alone and those break.
pub(crate) fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// A tag as the library keeps it: one line, lowercased, at most 64 characters.
pub fn tag(raw: &str) -> Option<String> {
    line(&raw.to_lowercase(), TAG_LEN)
}

/// A link's address as it will be saved, or why it is not: the rule of the
/// bookmarks import (`import::classify`), and the schema's 2 048 characters.
/// An address with spaces or control characters in it is saved as the URL
/// parser writes it, so the library never holds a line break in an address.
/// A user name or password (`user:pass@host`) is dropped: no credentials enter
/// the library from a list, and the builder writes addresses through this same
/// rule, so an exported list imports to the same addresses.
pub fn link_url(raw: &str) -> Result<String, SkipReason> {
    let href = raw.trim();
    if href.len() > URL_LEN {
        return Err(SkipReason::Invalid);
    }
    match Url::parse(href) {
        Ok(url) if !matches!(url.scheme(), "http" | "https") => Err(SkipReason::NotWeb),
        Ok(mut url) if url.host_str().is_some_and(|h| !h.is_empty()) => {
            if without_credentials(&mut url) || href.chars().any(|c| c.is_whitespace() || c.is_control()) {
                Ok(url.to_string())
            } else {
                Ok(href.to_owned())
            }
        }
        _ => Err(SkipReason::Invalid),
    }
}

/// Drops a user name and password from an address; `true` when there were any.
fn without_credentials(url: &mut Url) -> bool {
    if url.username().is_empty() && url.password().is_none() {
        return false;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    true
}

/// A feed's address through the guard `subscribe_feed` uses: a local one is invalid.
pub fn feed_url(raw: &str) -> Result<Url, SkipReason> {
    if raw.trim().len() > URL_LEN {
        return Err(SkipReason::Invalid);
    }
    let mut url = crate::feeds::feed_url(raw).map_err(|_| match Url::parse(raw.trim()) {
        Ok(url) if !matches!(url.scheme(), "http" | "https") => SkipReason::NotWeb,
        _ => SkipReason::Invalid,
    })?;
    // As for a link: no credentials are followed or kept.
    without_credentials(&mut url);
    Ok(url)
}

/// An optional address of the metadata: http(s) with a host, else none.
fn web_address(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    link_url(raw).ok()
}

fn text_of(object: &Map<String, Value>, key: &str, max: usize) -> Option<String> {
    object.get(key).and_then(Value::as_str).and_then(|s| line(s, max))
}

/// `[a-z][a-z0-9-]{0,31}`: what the schema allows for `app` and `kind`.
fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A version this reader opens, `(1, MINOR)`, as the schema writes it:
/// `^1\.(0|[1-9][0-9]{0,3})$`. Another MAJOR that looks like `N.M` (plain
/// numbers without a leading zero) needs a newer reader; anything else is
/// not a list.
fn version(raw: &str) -> Result<(u32, u32), ListError> {
    let number = |s: &str, digits: usize| {
        let plain = !s.is_empty()
            && s.len() <= digits
            && s.chars().all(|c| c.is_ascii_digit())
            && (s == "0" || !s.starts_with('0'));
        plain.then(|| s.parse::<u32>().ok()).flatten()
    };
    // A plain number of any length, as a later MAJOR or its MINOR may be.
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    let (major, minor) = raw.split_once('.').ok_or(ListError::NotAList)?;
    if !plain(major) || !plain(minor) {
        return Err(ListError::NotAList);
    }
    match number(major, 9) {
        Some(READER_MAJOR) => number(minor, 4).map(|minor| (READER_MAJOR, minor)).ok_or(ListError::NotAList),
        // There is no MAJOR 0.
        Some(0) => Err(ListError::NotAList),
        // Any other plain MAJOR is a later one, however long.
        _ => Err(ListError::NeedsNewerApp),
    }
}

/// `[a-z0-9][a-z0-9-]{0,63}`, the list's slug.
fn slug(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    let ok = raw.len() <= ID_LEN
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then(|| raw.to_owned())
}

/// A BCP 47 tag, loosely: letters, digits and dashes, starting with 2–3 letters.
pub(crate) fn language(raw: &str) -> Option<String> {
    let mut parts = raw.split('-');
    let first = parts.next()?;
    let ok = (2..=3).contains(&first.len())
        && first.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()));
    ok.then(|| raw.to_owned())
}

/// `YYYY-MM-DD` exactly (four digits, two, two), a real date. The parser
/// alone would also take `2026-1-5`, a sign or white space before a number.
pub(crate) fn date(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    let shaped = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shaped {
        return None;
    }
    chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok().map(|d| d.format("%Y-%m-%d").to_string())
}

fn unknown_keys(object: &Map<String, Value>, known: &[&str]) -> u32 {
    object.keys().filter(|k| !known.contains(&k.as_str())).count() as u32
}

/// How deep arrays and objects may nest, the file's object the first level (reader rules 2026-11).
/// serde_json's own recursion limit refuses a 128th level while parsing, a level under a repeated
/// key included; `deeper_than` states the rule here too, so the parsed value keeps it if that limit
/// is ever lifted (a dependency turns on serde_json's `unbounded_depth`, which lifts it for a parser
/// that calls `disable_recursion_limit`); a repeated key's dropped values would then go unchecked.
const MAX_DEPTH: usize = 127;

/// Whether arrays and objects in `value` nest more than `max` levels, `value` itself the first.
/// Without recursion, so a value parsed without serde_json's limit cannot overflow the stack here.
fn deeper_than(value: &Value, max: usize) -> bool {
    // Only arrays and objects go on the stack: scalars cannot nest.
    let nests = |value: &&Value| matches!(value, Value::Array(_) | Value::Object(_));
    if !nests(&value) {
        return false;
    }
    let mut stack = vec![(value, 1)];
    while let Some((value, depth)) = stack.pop() {
        if depth > max {
            return true;
        }
        match value {
            Value::Array(items) => stack.extend(items.iter().filter(nests).map(|child| (child, depth + 1))),
            Value::Object(fields) => stack.extend(fields.values().filter(nests).map(|child| (child, depth + 1))),
            _ => {}
        }
    }
    false
}

/// Reads a list. The checks go in this order, so each file gets one answer:
/// size, JSON, `format`, `app`, `kind`, `version`, `title`, structure,
/// the number of items.
pub fn parse(text: &str) -> Result<ParsedList, ListError> {
    if text.len() > MAX_BYTES {
        return Err(ListError::TooBig);
    }
    // Reader rules 2026-11: a number out of a double's range (with serde_json's `float_roundtrip`) or
    // nesting past MAX_DEPTH levels makes the file not a list. serde_json refuses both while parsing,
    // so a value under a repeated key counts too; `deeper_than` sees only the parsed value, the last
    // of a repeated key, and backs the depth rule up only for what is left.
    let value: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).map_err(|_| ListError::NotAList)?;
    if deeper_than(&value, MAX_DEPTH) {
        return Err(ListError::NotAList);
    }
    let Value::Object(root) = value else {
        return Err(ListError::NotAList);
    };
    if root.get("format").and_then(Value::as_str) != Some("koona") {
        return Err(ListError::NotAList);
    }
    let app = root.get("app").and_then(Value::as_str).filter(|a| is_name(a)).ok_or(ListError::NotAList)?;
    if app != "pin" {
        return Err(ListError::OtherApp(app.to_owned()));
    }
    let kind = root.get("kind").and_then(Value::as_str).filter(|k| is_name(k)).ok_or(ListError::NotAList)?;
    if kind != "list" {
        return Err(ListError::NeedsNewerApp);
    }
    let raw_version = root.get("version").and_then(Value::as_str).ok_or(ListError::NotAList)?;
    let (major, minor) = version(raw_version)?;
    let newer = minor > READER_MINOR;
    let title = text_of(&root, "title", TITLE_LEN).ok_or(ListError::NotAList)?;

    // The structure: arrays of objects where the format has them.
    let sections: Vec<&Map<String, Value>> = match root.get("sections") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list.iter().map(|s| s.as_object().ok_or(ListError::NotAList)).collect::<Result<_, _>>()?,
        Some(_) => return Err(ListError::NotAList),
    };
    fn items_of(object: &Map<String, Value>) -> Result<&[Value], ListError> {
        match object.get("items") {
            None | Some(Value::Null) => Ok(&[]),
            Some(Value::Array(items)) => Ok(items.as_slice()),
            Some(_) => Err(ListError::NotAList),
        }
    }
    if sections.len() > MAX_SECTIONS {
        return Err(ListError::TooBig);
    }
    let mut groups: Vec<(Option<String>, &[Value])> = Vec::with_capacity(sections.len() + 1);
    for section in &sections {
        groups.push((text_of(section, "name", SECTION_LEN), items_of(section)?));
    }
    groups.push((None, items_of(&root)?));
    let total: usize = groups.iter().map(|(_, items)| items.len()).sum();
    if total > MAX_ITEMS {
        return Err(ListError::TooBig);
    }
    if total == 0 {
        return Err(ListError::Empty);
    }

    let author = root.get("author").and_then(Value::as_object);
    let mut list = ParsedList {
        meta: ListMeta {
            title,
            description: root.get("description").and_then(Value::as_str).and_then(|s| paragraph(s, DESCRIPTION_LEN)),
            author_name: author.and_then(|a| text_of(a, "name", AUTHOR_LEN)),
            author_url: author.and_then(|a| web_address(a.get("url"))),
            license: text_of(&root, "license", LICENSE_LEN),
            language: root.get("language").and_then(Value::as_str).and_then(language),
            updated: root.get("updated").and_then(Value::as_str).and_then(date),
            homepage: web_address(root.get("homepage")),
            id: root.get("id").and_then(Value::as_str).and_then(slug),
            generator: text_of(&root, "generator", GENERATOR_LEN),
            version: format!("{major}.{minor}"),
        },
        newer,
        // Only a section with a name is one: the items of a nameless one are at the top level.
        sections: groups.iter().filter(|(name, _)| name.is_some()).count() as u32,
        ..Default::default()
    };
    if newer {
        list.skipped_details += unknown_keys(&root, ENVELOPE_KEYS);
        list.skipped_details += author.map_or(0, |a| unknown_keys(a, AUTHOR_KEYS));
        list.skipped_details += sections.iter().map(|s| unknown_keys(s, SECTION_KEYS)).sum::<u32>();
    }

    let mut link_at: HashMap<String, usize> = HashMap::new();
    let mut feed_at: HashMap<String, usize> = HashMap::new();
    for (section, items) in groups {
        for item in items {
            let Some(object) = item.as_object() else {
                list.skipped_items += 1;
                continue;
            };
            match object.get("type").and_then(Value::as_str) {
                Some("link") => {
                    if newer {
                        list.skipped_details += unknown_keys(object, LINK_KEYS);
                    }
                    read_link(&mut list, &mut link_at, object, section.as_deref());
                }
                Some("feed") => {
                    if newer {
                        list.skipped_details += unknown_keys(object, FEED_KEYS);
                    }
                    read_feed(&mut list, &mut feed_at, object, section.as_deref());
                }
                _ => list.skipped_items += 1,
            }
        }
    }
    Ok(list)
}

fn skip(list: &mut ParsedList, reason: SkipReason) {
    match reason {
        SkipReason::NotWeb => list.not_web += 1,
        SkipReason::Invalid => list.invalid += 1,
        SkipReason::Repeated => list.repeated += 1,
    }
}

fn read_link(list: &mut ParsedList, seen: &mut HashMap<String, usize>, object: &Map<String, Value>, section: Option<&str>) {
    let url = match object.get("url").and_then(Value::as_str).map(link_url) {
        Some(Ok(url)) => url,
        Some(Err(reason)) => return skip(list, reason),
        None => return skip(list, SkipReason::Invalid),
    };
    let mut tags: Vec<String> = Vec::new();
    if let Some(Value::Array(raw)) = object.get("tags") {
        for name in raw.iter().filter_map(Value::as_str).filter_map(tag) {
            if !tags.contains(&name) && tags.len() < TAGS_PER_ITEM {
                tags.push(name);
            }
        }
    }
    // `link_url` admits only http(s) with a host, which always has a key.
    let key = crate::dedupe::url_key(&url).unwrap_or_else(|| url.clone());
    if let Some(&first) = seen.get(&key) {
        let first = &mut list.links[first];
        for name in tags {
            if first.tags.len() == TAGS_PER_ITEM {
                break;
            }
            if !first.tags.contains(&name) {
                first.tags.push(name);
            }
        }
        if let Some(section) = section {
            if !first.sections.iter().any(|s| s == section) {
                first.sections.push(section.to_owned());
            }
        }
        list.repeated += 1;
        return;
    }
    seen.insert(key, list.links.len());
    list.links.push(ListLink {
        url,
        title: text_of(object, "title", ITEM_TITLE_LEN),
        description: object.get("description").and_then(Value::as_str).and_then(|s| paragraph(s, DESCRIPTION_LEN)),
        tags,
        sections: section.map(str::to_owned).into_iter().collect(),
        at: list.links.len() + list.feeds.len(),
    });
}

fn read_feed(list: &mut ParsedList, seen: &mut HashMap<String, usize>, object: &Map<String, Value>, section: Option<&str>) {
    let url = match object.get("url").and_then(Value::as_str).map(feed_url) {
        Some(Ok(url)) => url.to_string(),
        Some(Err(reason)) => return skip(list, reason),
        None => return skip(list, SkipReason::Invalid),
    };
    if seen.contains_key(&url) {
        list.repeated += 1;
        return;
    }
    seen.insert(url.clone(), list.feeds.len());
    list.feeds.push(ListFeed {
        url,
        title: text_of(object, "title", ITEM_TITLE_LEN),
        site: web_address(object.get("site")),
        section: section.map(str::to_owned),
        at: list.links.len() + list.feeds.len(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::conformance::{self as suite, case_text, padded};
    use serde_json::json;

    /// `line` gives the lines written out here (what it gave before it was built
    /// from `line_marks`), its fast path agrees with the marks, and the marks
    /// say what went, what stayed and which white space became the plain space.
    #[test]
    fn line_marks_say_what_line_takes_out() {
        let flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
        let samples: [(&str, Option<&str>); 18] = [
            ("co\u{AD}op", Some("coop")),
            (" coop ", Some("coop")),
            ("to  read\tlater", Some("to read later")),
            ("to\t read", Some("to read")),
            ("to\tread", Some("to read")),
            ("\u{200B}", None),
            ("  ", None),
            ("", None),
            ("\u{1F4DA}\u{200D}", Some("\u{1F4DA}")),
            ("\u{1F469}\u{200D}\u{1F4BB}", Some("\u{1F469}\u{200D}\u{1F4BB}")),
            ("\u{DCB}\u{DCA}\u{200D}\u{DBB}\u{DD3}", Some("\u{DCB}\u{DCA}\u{200D}\u{DBB}\u{DD3}")),
            ("a\u{200D}b", Some("ab")),
            ("x\u{202E}y\u{E0041}", Some("xy")),
            ("\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F} wales", Some("\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F} wales")),
            ("a \u{200B} b", Some("a b")),
            ("a\u{1} b", Some("a b")),
            ("to read\u{A0}later", Some("to read later")),
            ("to read later", Some("to read later")),
        ];
        assert!(samples[13].0.starts_with(flag));
        for (raw, wanted) in samples {
            let marks = line_marks(raw);
            assert_eq!(marks.iter().map(|m| m.0).collect::<String>(), raw);
            assert_eq!(line(raw, usize::MAX).as_deref(), wanted, "{raw:?}");
            // What the fast path takes as a line is one the marks leave whole.
            if is_a_line(raw) {
                assert!(marks.iter().all(|m| m.1 == Mark::Kept), "{raw:?}");
            }
        }
        assert!(is_a_line("to read later") && !is_a_line(" coop") && !is_a_line("coop ") && !is_a_line("to  read") && !is_a_line("co\u{AD}op"));
        let marked = |raw: &str, wanted: Mark| line_marks(raw).into_iter().filter(|m| m.1 == wanted).map(|m| m.0).collect::<String>();
        assert_eq!(marked("\u{1F4DA}\u{200D}", Mark::Dropped), "\u{200D}", "a joiner after an emoji and before nothing goes");
        assert_eq!(marked("\u{1F469}\u{200D}\u{1F4BB}", Mark::Dropped), "", "one between two emoji stays");
        assert_eq!(marked("\u{DCB}\u{DCA}\u{200D}\u{DBB}\u{DD3}", Mark::Dropped), "", "a Sinhala joiner stays");
        assert_eq!(marked(" coop ", Mark::Dropped), "  ");
        assert_eq!(marked("to  read", Mark::Dropped), " ");
        // The plain space of a run stays wherever it stands; without one, the first becomes it.
        assert_eq!((marked("to\t read", Mark::Dropped), marked("to\t read", Mark::Space)), ("\t".into(), String::new()));
        assert_eq!((marked("to\tread", Mark::Dropped), marked("to\tread", Mark::Space)), (String::new(), "\t".into()));
    }

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../../../docs/kpin/conformance/lists/", $name))
        };
    }

    /// What the reader read, in the suite's words (`list` of a case).
    fn as_suite(list: &ParsedList) -> Value {
        let meta = &list.meta;
        let author = (meta.author_name.is_some() || meta.author_url.is_some()).then(|| json!({ "name": meta.author_name, "url": meta.author_url }));
        json!({
            "title": meta.title,
            "version": meta.version,
            "newer": list.newer,
            "sections": list.sections,
            "meta": {
                "description": meta.description, "author": author, "license": meta.license, "language": meta.language,
                "updated": meta.updated, "homepage": meta.homepage, "id": meta.id, "generator": meta.generator,
            },
            "counts": {
                "links": list.links.len(), "feeds": list.feeds.len(), "repeated": list.repeated, "not_web": list.not_web,
                "invalid": list.invalid, "skipped_items": list.skipped_items, "skipped_details": list.skipped_details,
            },
            "links": list.links.iter().map(|l| json!({ "url": l.url, "title": l.title, "description": l.description, "tags": l.tags, "sections": l.sections })).collect::<Vec<_>>(),
            "feeds": list.feeds.iter().map(|f| json!({ "url": f.url, "title": f.title, "site": f.site, "section": f.section })).collect::<Vec<_>>(),
        })
    }

    fn skip_reason(name: &str) -> SkipReason {
        match name {
            "invalid" => SkipReason::Invalid,
            "not_web" => SkipReason::NotWeb,
            other => panic!("no skip reason {other}"),
        }
    }

    fn outcome(result: &Result<ParsedList, ListError>) -> &'static str {
        match result {
            Ok(_) => "ready",
            Err(ListError::NotAList) => "not_a_list",
            Err(ListError::NeedsNewerApp) => "needs_newer_app",
            Err(ListError::OtherApp(_)) => "other_app",
            Err(ListError::TooBig) => "too_big",
            Err(ListError::Empty) => "empty",
            Err(ListError::Unreadable) => "unreadable",
        }
    }

    fn parsed(name: &str) -> ParsedList {
        parse(&suite::text(&format!("lists/{name}"))).unwrap()
    }

    #[test]
    fn nesting_is_counted_from_the_files_object() {
        let nested = |levels: usize| (1..levels).fold(json!({}), |inner, _| json!([inner]));
        assert!(!deeper_than(&nested(MAX_DEPTH), MAX_DEPTH));
        assert!(deeper_than(&nested(MAX_DEPTH + 1), MAX_DEPTH));
        assert!(!deeper_than(&json!({ "a": [1, "b", null] }), 2));
        assert!(deeper_than(&json!({ "a": [[]] }), 2));
    }

    #[test]
    fn a_number_out_of_range_is_refused_even_under_a_repeated_key() {
        let list = |x: &str| format!(r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T",{x}"items":[{{"type":"link","url":"https://example.com/"}}]}}"#);
        assert!(matches!(parse(&list(r#""x":1e400,"x":1,"#)), Err(ListError::NotAList)));
        assert!(parse(&list(r#""x":1.7976931348623158e308,"#)).is_ok());
    }

    /// `cases.json` of the suite says, for every file, whether the public
    /// schema accepts it (checked by Vitest with a JSON Schema 2020-12
    /// validator, `kpinSchema.test.ts`), what a reader answers and what it
    /// reads out of it. A schema-valid file is never refused for its content,
    /// only for what it is (another app, an unknown kind) or for its size,
    /// unless the case names what the schema cannot see (`schema_cannot_see`);
    /// a schema-invalid one may still be read, its bad items skipped and counted.
    #[test]
    fn the_reader_answers_every_case_of_the_conformance_suite() {
        let doc: Value = serde_json::from_str(&suite::text("cases.json")).unwrap();
        let cases = doc["cases"].as_array().unwrap();
        for case in cases {
            let name = case["file"].as_str().or(case["name"].as_str()).unwrap();
            let result = parse(&case_text(case));
            assert_eq!(outcome(&result), case["reader"], "{name}");
            if let Err(ListError::OtherApp(app)) = &result {
                assert_eq!(case["app"], app.as_str(), "{name}");
            }
            if case["schema_valid"] == true && case["schema_cannot_see"].is_null() {
                assert!(
                    matches!(result, Ok(_) | Err(ListError::OtherApp(_) | ListError::NeedsNewerApp | ListError::TooBig)),
                    "{name}: a valid file is refused only for its app, its kind or its size"
                );
            }
            if let Some(expected) = case["list"].as_object() {
                let read = as_suite(result.as_ref().unwrap());
                for (key, want) in expected {
                    assert_eq!(&read[key], want, "{name}: {key}");
                }
            }
        }
        // Every file of the suite has its case.
        for file in suite::list_files() {
            assert!(cases.iter().any(|c| c["file"] == file.as_str()), "no case for {file}");
        }
    }

    #[test]
    fn text_is_cleaned_as_the_conformance_suite_says() {
        for v in suite::vectors("text.json") {
            let (input, max) = (v["in"].as_str().unwrap(), v["max"].as_u64().unwrap() as usize);
            let out = match v["rule"].as_str().unwrap() {
                "line" => line(input, max),
                "description" => paragraph(input, max),
                "tag" => {
                    assert_eq!(max, TAG_LEN);
                    tag(input)
                }
                other => panic!("no rule {other}"),
            };
            assert_eq!(json!(out), v["out"], "{v}");
        }
    }

    #[test]
    fn addresses_are_taken_as_the_conformance_suite_says() {
        for v in suite::vectors("addresses.json") {
            let input = padded(v["in"].as_str().unwrap(), &v["pad"]);
            let result = match v["rule"].as_str().unwrap() {
                "link" => link_url(&input),
                "feed" => feed_url(&input).map(|u| u.to_string()),
                "web" => {
                    assert_eq!(json!(link_url(&input).ok()), v["out"], "{v}");
                    continue;
                }
                other => panic!("no rule {other}"),
            };
            match (v["out"].as_str(), v["skip"].as_str(), v["ok"].as_bool()) {
                (Some(out), _, _) => assert_eq!(result.as_deref(), Ok(out), "{v}"),
                (_, Some(skip), _) => assert_eq!(result, Err(skip_reason(skip)), "{v}"),
                (_, _, Some(ok)) => assert_eq!(result.is_ok(), ok, "{v}"),
                _ => panic!("{v}: no out, skip or ok"),
            }
        }
    }

    #[test]
    fn repeats_are_found_as_the_conformance_suite_says() {
        let key = |raw: &str| crate::dedupe::url_key(&link_url(raw).unwrap());
        for v in suite::vectors("same-page.json") {
            let (a, b) = (v["a"].as_str().unwrap(), v["b"].as_str().unwrap());
            assert_eq!(key(a) == key(b), v["same"] == true, "{v}");
        }
    }

    /// The examples of the public spec (`docs/kpin/examples`) read as it says they do.
    #[test]
    fn the_examples_of_the_spec_read_as_it_says() {
        let minimal = parse(include_str!("../../../docs/kpin/examples/minimal.kpin")).unwrap();
        assert_eq!((minimal.links.len(), minimal.feeds.len(), minimal.sections, minimal.newer), (3, 0, 0, false));
        let sections = parse(include_str!("../../../docs/kpin/examples/sections-and-feeds.kpin")).unwrap();
        assert_eq!((sections.links.len(), sections.feeds.len(), sections.sections), (3, 2, 2));
        assert_eq!(sections.meta.description.as_deref(), Some("Personal sites and their feeds.\nChecked by hand in October 2026."));
        assert_eq!((sections.meta.id.as_deref(), sections.meta.homepage.is_some()), (Some("small-web-starter"), true));
        let newer = parse(include_str!("../../../docs/kpin/examples/newer-minor-1.1.kpin")).unwrap();
        assert!(newer.newer);
        assert_eq!((newer.links.len(), newer.feeds.len()), (1, 1));
        // `cover`, the link's `rating`, the feed's `color`; the `note` is an item.
        assert_eq!((newer.skipped_details, newer.skipped_items), (3, 1));
    }

    #[test]
    fn a_section_without_a_name_is_none_and_its_links_are_at_the_top() {
        let text = r#"{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T",
            "sections":[{"name":"  ","items":[{"type":"link","url":"https://a.example/"}]},
                        {"name":"Tools","items":[{"type":"link","url":"https://b.example/"}]}]}"#;
        let list = parse(text).unwrap();
        assert_eq!(list.sections, 1);
        assert!(list.links[0].sections.is_empty());
        assert_eq!(list.links[1].sections, ["Tools"]);
    }

    #[test]
    fn a_valid_list_has_its_metadata_sections_links_and_feeds() {
        let list = parsed("valid.kpin");
        assert_eq!(list.meta.title, "Rust blogs worth following");
        assert_eq!(list.meta.author_name.as_deref(), Some("Koona"));
        assert_eq!(list.meta.author_url.as_deref(), Some("https://koona.app"));
        assert_eq!(list.meta.license.as_deref(), Some("CC0-1.0"));
        assert_eq!(list.meta.updated.as_deref(), Some("2026-10-18"));
        assert_eq!(list.meta.id.as_deref(), Some("rust-blogs"));
        assert_eq!(list.meta.version, "1.0");
        assert!(!list.newer);
        assert_eq!(list.sections, 2);
        let links: Vec<(&str, Vec<&str>, Vec<&str>)> = list
            .links
            .iter()
            .map(|l| (l.url.as_str(), l.tags.iter().map(String::as_str).collect(), l.sections.iter().map(String::as_str).collect()))
            .collect();
        assert_eq!(
            links,
            vec![
                ("https://doc.rust-lang.org/nomicon/", vec!["unsafe", "book"], vec!["Compiler and language"]),
                ("https://tokio.rs/", vec!["runtime"], vec!["Async"]),
                ("https://this-week-in-rust.org/", vec![], vec![]),
            ]
        );
        assert_eq!(list.links[0].description.as_deref(), Some("The dark arts of unsafe Rust."));
        let feeds: Vec<(&str, Option<&str>, Option<&str>)> =
            list.feeds.iter().map(|f| (f.url.as_str(), f.site.as_deref(), f.section.as_deref())).collect();
        assert_eq!(
            feeds,
            vec![
                ("https://blog.rust-lang.org/feed.xml", Some("https://blog.rust-lang.org"), Some("Compiler and language")),
                ("https://without.boats/index.xml", None, Some("Async")),
            ]
        );
        assert_eq!((list.repeated, list.not_web, list.invalid, list.skipped_items, list.skipped_details), (0, 0, 0, 0, 0));
    }

    #[test]
    fn a_newer_minor_skips_unknown_types_and_counts_unknown_details() {
        let list = parsed("unknown-type.kpin");
        assert!(list.newer);
        assert_eq!(list.meta.version, "1.1");
        assert_eq!((list.links.len(), list.feeds.len()), (1, 1));
        assert_eq!(list.skipped_items, 1, "the note");
        // `cover`, `author.mastodon`, the link's `rating`, the feed's `color`.
        assert_eq!(list.skipped_details, 4);
        // In 1.0 the same unknown fields are ignored without a word; an unknown type is still skipped.
        let older = parse(&fixture!("unknown-type.kpin").replace("\"1.1\"", "\"1.0\"")).unwrap();
        assert_eq!((older.newer, older.skipped_details, older.skipped_items), (false, 0, 1));
        // `version` is text: 1.10 is not 1.1.
        assert_eq!(parse(&fixture!("valid.kpin").replace("\"1.0\"", "\"1.10\"")).unwrap().meta.version, "1.10");
    }

    #[test]
    fn addresses_without_a_host_or_off_the_web_are_skipped_and_counted() {
        let no_host = parsed("url-without-host.kpin");
        assert_eq!((no_host.links.len(), no_host.invalid, no_host.not_web), (1, 1, 0));
        let ftp = parsed("ftp.kpin");
        assert_eq!((ftp.links.len(), ftp.invalid, ftp.not_web), (1, 0, 1));
        assert_eq!(ftp.links[0].url, "https://example.com/kept");
        for (raw, reason) in [
            ("javascript:alert(1)", SkipReason::NotWeb),
            ("file:///etc/passwd", SkipReason::NotWeb),
            ("data:text/html,hi", SkipReason::NotWeb),
            ("example.com", SkipReason::Invalid),
            ("https://", SkipReason::Invalid),
        ] {
            assert_eq!(link_url(raw), Err(reason), "{raw}");
        }
        assert_eq!(link_url(&format!("https://example.com/{}", "a".repeat(URL_LEN))), Err(SkipReason::Invalid));
        assert_eq!(link_url("  https://example.com/x  ").as_deref(), Ok("https://example.com/x"));
        assert_eq!(link_url("https://example.com/a b\n").as_deref(), Ok("https://example.com/a%20b"));
        // A feed on this computer is not followed.
        assert_eq!(feed_url("http://127.0.0.1/feed.xml").unwrap_err(), SkipReason::Invalid);
        assert_eq!(feed_url("ftp://example.com/feed.xml").unwrap_err(), SkipReason::NotWeb);
    }

    #[test]
    fn a_title_of_spaces_is_not_a_list_and_an_items_title_of_spaces_is_none() {
        assert_eq!(parse(fixture!("title-of-spaces.kpin")), Err(ListError::NotAList));
        let text = fixture!("ftp.kpin").replace(r#""url": "https://example.com/kept""#, r#""url": "https://example.com/kept", "title": " \t ""#);
        assert_eq!(parse(&text).unwrap().links[0].title, None);
    }

    #[test]
    fn tags_are_trimmed_lowercased_cut_and_not_repeated() {
        assert_eq!(parsed("repeated-tags.kpin").links[0].tags, ["rust"]);
        let long = "Ж".repeat(80);
        let many: Vec<String> = (0..30).map(|i| format!("\"t{i}\"")).collect();
        let text = format!(
            r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T","items":[{{"type":"link","url":"https://example.com/","tags":["{long}",{}]}}]}}"#,
            many.join(",")
        );
        let tags = &parse(&text).unwrap().links[0].tags;
        assert_eq!(tags.len(), TAGS_PER_ITEM);
        assert_eq!(tags[0], "ж".repeat(TAG_LEN));
    }

    #[test]
    fn text_loses_control_characters_and_is_capped() {
        assert_eq!(line("  Rust\u{0}\u{7}  blogs\n\tand\u{202e}more\u{0}, now ", 120).as_deref(), Some("Rust blogs andmore, now"));
        assert_eq!(line(&"x".repeat(200), 120).map(|s| s.chars().count()), Some(120));
        assert_eq!(line("\u{1}\u{2}", 10), None);
        assert_eq!(paragraph("First\r\nsecond\u{0}\n", 100).as_deref(), Some("First\nsecond"));
        let title = format!(r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"{}","items":[{{"type":"x"}}]}}"#, "t".repeat(300));
        assert_eq!(parse(&title).unwrap().meta.title.len(), TITLE_LEN);
    }

    #[test]
    fn a_repeat_inside_the_file_is_merged_into_the_first() {
        let list = parsed("repeats.kpin");
        assert_eq!(list.links.len(), 1);
        let first = &list.links[0];
        assert_eq!((first.url.as_str(), first.title.as_deref()), ("https://doc.rust-lang.org/book/", Some("The Book")));
        assert_eq!(first.tags, ["book", "beginner"]);
        assert_eq!(first.sections, ["Books", "Learning"]);
        assert_eq!(first.tags_with(true), ["books", "learning", "book", "beginner"]);
        assert_eq!(first.tags_with(false), ["book", "beginner"]);
        assert_eq!(list.feeds.len(), 1);
        assert_eq!(list.repeated, 2, "a link and a feed");
    }

    #[test]
    fn the_envelope_decides_first() {
        assert_eq!(parse(fixture!("no-items.kpin")), Err(ListError::Empty));
        assert_eq!(parse(r#"{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T","sections":[{"name":"S","items":[]}]}"#), Err(ListError::Empty));
        assert_eq!(parse(fixture!("version-2.kpin")), Err(ListError::NeedsNewerApp));
        assert_eq!(parse(fixture!("unknown-kind.kpin")), Err(ListError::NeedsNewerApp));
        assert_eq!(parse(fixture!("other-app.kpin")), Err(ListError::OtherApp("note".into())));
        assert_eq!(parse(fixture!("wrong-format.kpin")), Err(ListError::NotAList));
        assert_eq!(parse(fixture!("cut-off.kpin")), Err(ListError::NotAList));
        // An unknown kind of another app is that app's business.
        assert_eq!(parse(&fixture!("other-app.kpin").replace("\"list\"", "\"template\"")), Err(ListError::OtherApp("note".into())));
        for version in ["\"1\"", "\"one\"", "1.0", "\"0.9\"", "\"1.x\"", "\"+1.0\""] {
            let text = fixture!("valid.kpin").replace("\"1.0\"", version);
            assert_eq!(parse(&text), Err(ListError::NotAList), "{version}");
        }
        assert_eq!(parse("[]"), Err(ListError::NotAList));
        assert_eq!(parse(&fixture!("valid.kpin").replace("\"sections\": [", "\"sections\": 5, \"x\": [")), Err(ListError::NotAList));
        assert_eq!(parse(&fixture!("other-app.kpin").replace("\"note\"", "\"<b>Note</b>\"")), Err(ListError::NotAList));
        // A byte order mark is not a reason to refuse.
        assert!(parse(&format!("\u{feff}{}", fixture!("valid.kpin"))).is_ok());
    }

    #[test]
    fn more_than_two_megabytes_or_five_thousand_items_is_too_big() {
        let padded = format!("{}{}", fixture!("valid.kpin"), " ".repeat(MAX_BYTES));
        assert_eq!(parse(&padded), Err(ListError::TooBig));
        let items = |n: usize| {
            let items: Vec<String> = (0..n).map(|i| format!(r#"{{"type":"link","url":"https://example.com/{i}"}}"#)).collect();
            // Split between a section and the top level: the limit counts both.
            let (a, b) = items.split_at(n / 2);
            format!(
                r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T","sections":[{{"name":"S","items":[{}]}}],"items":[{}]}}"#,
                a.join(","),
                b.join(",")
            )
        };
        assert_eq!(parse(&items(MAX_ITEMS)).unwrap().links.len(), MAX_ITEMS);
        assert_eq!(parse(&items(MAX_ITEMS + 1)), Err(ListError::TooBig));
    }

    #[test]
    fn the_version_is_read_as_the_schema_writes_it() {
        let with = |version: &str| parse(&fixture!("valid.kpin").replace("\"1.0\"", &format!("\"{version}\"")));
        for ok in ["1.0", "1.1", "1.10", "1.9999"] {
            assert_eq!(with(ok).unwrap().meta.version, ok);
        }
        // Another MAJOR's MINOR is its own business, as long as it is a plain number.
        for newer in ["2.0", "3.15", "10.0", "2.123456"] {
            assert_eq!(with(newer).map(|_| ()), Err(ListError::NeedsNewerApp), "{newer}");
        }
        for broken in ["1.01", "1.00", "1.10000", "01.0", "1.", ".1", "1.0.1", "2.x", "2.01", "1.-1", "1 .0", "02.0"] {
            assert_eq!(with(broken).map(|_| ()), Err(ListError::NotAList), "{broken}");
        }
    }

    #[test]
    fn invisible_characters_are_dropped() {
        let hidden = "a\u{061c}b\u{200b}c\u{200c}d\u{200d}e\u{2060}f\u{feff}g\u{202e}h\u{2066}i";
        assert_eq!(line(hidden, 100).as_deref(), Some("abcdefghi"));
        assert_eq!(tag("\u{200b}rust\u{feff}").as_deref(), Some("rust"));
        assert_eq!(tag("\u{200b}\u{feff}"), None);
        assert_eq!(paragraph("one\u{200d}\ntwo\u{061c}", 100).as_deref(), Some("one\ntwo"));
    }

    #[test]
    fn repeats_cannot_grow_a_link_past_twenty_tags() {
        let items: Vec<String> = (0..1_000)
            .map(|i| {
                let tags: Vec<String> = (0..20).map(|t| format!("\"t{i}-{t}\"")).collect();
                format!(r#"{{"type":"link","url":"https://example.com/same","tags":[{}]}}"#, tags.join(","))
            })
            .collect();
        let text = format!(
            r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T","sections":[{{"name":"One","items":[{}]}},{{"name":"Two","items":[{}]}}]}}"#,
            items[..500].join(","),
            items[500..].join(",")
        );
        let list = parse(&text).unwrap();
        assert_eq!((list.links.len(), list.repeated), (1, 999));
        let link = &list.links[0];
        assert_eq!(link.tags.len(), TAGS_PER_ITEM);
        assert_eq!(link.tags[0], "t0-0", "the first item's tags win");
        // Sections first, then tags, 20 in all.
        let tags = link.tags_with(true);
        assert_eq!(tags.len(), TAGS_PER_ITEM);
        assert_eq!(&tags[..3], ["one", "two", "t0-0"]);
        assert_eq!(link.tags_with(false), link.tags);
    }

    #[test]
    fn more_than_two_hundred_sections_is_too_big() {
        let sections = |n: usize| {
            let list: Vec<String> = (0..n).map(|i| format!(r#"{{"name":"S{i}","items":[{{"type":"link","url":"https://example.com/{i}"}}]}}"#)).collect();
            format!(r#"{{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T","sections":[{}]}}"#, list.join(","))
        };
        assert_eq!(parse(&sections(MAX_SECTIONS)).unwrap().sections as usize, MAX_SECTIONS);
        assert_eq!(parse(&sections(MAX_SECTIONS + 1)), Err(ListError::TooBig));
    }

    #[test]
    fn no_user_name_or_password_comes_in_from_a_list() {
        let list = parse(
            r#"{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"Secrets",
                "author":{"name":"A","url":"https://me:pw@koona.app/"},"homepage":"https://me@koona.app/lists",
                "items":[
                  {"type":"link","url":"https://user:secret@example.com/page"},
                  {"type":"link","url":"https://example.com/page"},
                  {"type":"feed","url":"https://user:secret@example.com/feed.xml","site":"https://user@example.com/"}
                ]}"#,
        )
        .unwrap();
        assert_eq!(list.links.len(), 1, "the two addresses are one once the credentials go");
        assert_eq!(list.links[0].url, "https://example.com/page");
        assert_eq!(list.repeated, 1);
        assert_eq!(list.feeds[0].url, "https://example.com/feed.xml");
        assert_eq!(list.feeds[0].site.as_deref(), Some("https://example.com/"));
        assert_eq!(list.meta.author_url.as_deref(), Some("https://koona.app/"));
        assert_eq!(list.meta.homepage.as_deref(), Some("https://koona.app/lists"));
        // What the builder writes (through this rule) reads back as the same address.
        assert_eq!(link_url(&link_url("https://a:b@example.org/x").unwrap()).unwrap(), "https://example.org/x");
        assert_eq!(link_url("https://example.org/x").unwrap(), "https://example.org/x");
    }
}
