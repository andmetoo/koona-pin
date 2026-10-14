//! The text of a fetched page in its own encoding (NP-120). Read as UTF-8, a page
//! in windows-1251 or Shift_JIS turns into U+FFFD; its title is garbled too.
//!
//! The order is the HTML standard's, shortened: a byte order mark, then the
//! `charset` of the Content-Type header, then a `<meta>` near the start of the
//! page, then UTF-8 when the bytes are UTF-8 and windows-1252 when they are not.
use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};

/// How far into the page a `<meta charset>` is looked for. The standard says
/// 1024 bytes; real pages put scripts and styles first, so a little more.
const META_SCAN: usize = 16 * 1024;

/// The page as text and the encoding it was read in.
pub fn decode(body: &[u8], content_type: Option<&str>) -> (String, &'static Encoding) {
    let encoding = sniff(body, content_type);
    // `decode` strips a BOM that matches and replaces malformed sequences.
    let (text, used, _) = encoding.decode(body);
    (text.into_owned(), used)
}

/// The encoding [`decode`] reads `body` in.
pub fn sniff(body: &[u8], content_type: Option<&str>) -> &'static Encoding {
    if let Some((encoding, _)) = Encoding::for_bom(body) {
        return encoding;
    }
    if let Some(encoding) = content_type.and_then(header_charset).and_then(|label| Encoding::for_label(label.as_bytes())) {
        return encoding;
    }
    if let Some(encoding) = meta_charset(&body[..body.len().min(META_SCAN)]) {
        return encoding;
    }
    if std::str::from_utf8(body).is_ok() || utf8_cut_short(body) {
        UTF_8
    } else {
        WINDOWS_1252
    }
}

/// `text/html; charset="windows-1251"` → `windows-1251`.
fn header_charset(content_type: &str) -> Option<&str> {
    content_type.split(';').skip(1).find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim().eq_ignore_ascii_case("charset").then(|| value.trim().trim_matches(['"', '\'']).trim())
    })
}

/// A body cut at the size limit may end inside a UTF-8 sequence: valid up to the last three bytes.
fn utf8_cut_short(body: &[u8]) -> bool {
    matches!(std::str::from_utf8(body), Err(e) if e.error_len().is_none() && body.len() - e.valid_up_to() < 4)
}

/// The encoding a `<meta charset>` or `<meta http-equiv="Content-Type" content="…; charset=…">`
/// names. Labels are ASCII, so the bytes are searched as they are, before any decoding.
fn meta_charset(head: &[u8]) -> Option<&'static Encoding> {
    let lower = head.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = find(&lower[from..], b"<meta") {
        let start = from + at + 5;
        let end = find(&lower[start..], b">").map_or(lower.len(), |e| start + e);
        let tag = &lower[start..end];
        from = end;
        let Some(at) = find(tag, b"charset") else { continue };
        let rest = trim_start(&tag[at + 7..]);
        let Some(rest) = rest.strip_prefix(b"=") else { continue };
        let rest = trim_start(rest);
        let rest = rest.strip_prefix(b"\"").or_else(|| rest.strip_prefix(b"'")).unwrap_or(rest);
        let label_end = rest
            .iter()
            .position(|b| matches!(b, b'"' | b'\'' | b';' | b'/' | b'>') || b.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let Some(encoding) = Encoding::for_label(&rest[..label_end]) else { continue };
        // A page that says UTF-16 in its own bytes is not UTF-16: the standard reads it as UTF-8.
        return Some(if encoding == encoding_rs::UTF_16BE || encoding == encoding_rs::UTF_16LE {
            UTF_8
        } else if encoding == encoding_rs::X_USER_DEFINED {
            WINDOWS_1252
        } else {
            encoding
        });
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn trim_start(bytes: &[u8]) -> &[u8] {
    let skip = bytes.iter().take_while(|b| b.is_ascii_whitespace()).count();
    &bytes[skip..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cp1251(text: &str) -> Vec<u8> {
        encoding_rs::WINDOWS_1251.encode(text).0.into_owned()
    }

    #[test]
    fn the_header_names_the_encoding() {
        let body = cp1251("<title>Персистентность</title>");
        let (text, used) = decode(&body, Some("text/html; charset=windows-1251"));
        assert_eq!(used.name(), "windows-1251");
        assert!(text.contains("Персистентность"), "{text}");
        assert_eq!(sniff(&body, Some("text/html; Charset=\"CP1251\"")).name(), "windows-1251", "labels and quotes as browsers read them");
    }

    #[test]
    fn a_meta_tag_names_the_encoding_when_the_header_does_not() {
        let body = cp1251(r#"<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Привет</title>"#);
        let (text, used) = decode(&body, Some("text/html"));
        assert_eq!(used.name(), "windows-1251");
        assert!(text.contains("Привет"));
        let body = encoding_rs::SHIFT_JIS.encode("<meta charset='shift_jis'><title>日本語</title>").0.into_owned();
        let (text, used) = decode(&body, None);
        assert_eq!(used.name(), "Shift_JIS");
        assert!(text.contains("日本語"));
        let body = encoding_rs::KOI8_R.encode("<META CHARSET = koi8-r ><p>Ёлка</p>").0.into_owned();
        assert!(decode(&body, None).0.contains("Ёлка"));
    }

    #[test]
    fn the_header_wins_over_the_meta_tag_and_a_bom_over_both() {
        let body = cp1251(r#"<meta charset="utf-8"><p>Текст</p>"#);
        assert!(decode(&body, Some("text/html; charset=windows-1251")).0.contains("Текст"));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("<p>Текст</p>".as_bytes());
        let (text, used) = decode(&bom, Some("text/html; charset=windows-1251"));
        assert_eq!(used, UTF_8);
        assert_eq!(text, "<p>Текст</p>");
    }

    #[test]
    fn without_a_label_utf8_is_tried_first() {
        assert_eq!(decode("<p>Ünïcödé</p>".as_bytes(), Some("text/html")).1, UTF_8);
        assert_eq!(sniff(&cp1251("<p>Текст</p>"), None), WINDOWS_1252, "not UTF-8 and unlabelled: the web's default");
        let cut = &"<p>Текст</p>".as_bytes()[..6];
        assert_eq!(sniff(cut, None), UTF_8, "a body cut in the middle of a letter is still UTF-8");
    }

    #[test]
    fn odd_labels_are_read_as_the_standard_says() {
        assert_eq!(sniff(b"<meta charset=\"utf-16\">", None), UTF_8);
        assert_eq!(sniff(b"<meta charset=\"x-user-defined\">", None), WINDOWS_1252);
        assert_eq!(sniff(b"<meta charset=\"no-such-thing\"><meta charset=\"iso-8859-2\">", None).name(), "ISO-8859-2");
        assert_eq!(sniff(b"<meta name=\"description\" content=\"charset\">", None), UTF_8);
    }
}
