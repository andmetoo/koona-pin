//! The page reading mode shows (NP-120, Р-69): fetched with the guard of the
//! metadata request, decoded in its own encoding, handed to the reader window
//! as text. Extraction and cleaning happen there (`src/services/reader.ts`):
//! Defuddle needs a DOM.
use crate::charset;
use crate::metadata::{self, FetchError, Fetched, Limits};
use crate::net_guard;
use scraper::{Html, Selector};
use serde::Serialize;
use std::time::Duration;
use ts_rs::TS;
use url::Url;

/// What reading a page may do: the metadata request's rules with a longer
/// wait and the whole page, up to 5 MB.
pub const LIMITS: Limits = Limits {
    allow: net_guard::public_ip,
    connect_timeout: Duration::from_secs(6),
    timeout: Duration::from_secs(20),
    max_body: 5 * 1024 * 1024,
    max_redirects: 5,
};

/// A `<meta http-equiv="refresh">` that waits longer than this reloads a page
/// that has its content already (news front pages); it is not a redirect.
const REFRESH_WAIT: f64 = 10.0;

/// The answer of [`fetch_article_page`].
#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ReaderPage {
    /// A 2xx HTML page, decoded.
    Page {
        /// After redirects and a `<meta refresh>`: relative links resolve against it.
        url: String,
        status: u16,
        /// The encoding the page was read in, as the WHATWG names it.
        charset: String,
        html: String,
        /// Longer than 5 MB: the rest was not read.
        truncated: bool,
    },
    /// The site answered, but not with 2xx.
    Status { url: String, status: u16 },
    /// A 2xx answer that is not HTML: a PDF, a picture, JSON.
    NotHtml { url: String, content_type: String },
    /// A local or private address, directly or after a redirect: never requested.
    Refused,
    Timeout,
    /// No connection, a TLS failure, too many redirects.
    Failed,
}

/// The page at `url` for the reader.
pub async fn fetch_article_page(url: &str) -> ReaderPage {
    fetch_with(url, &LIMITS).await
}

/// The reader asks for a page when the person opens it (NP-120); never in the background.
#[tauri::command]
pub async fn fetch_reader_page(url: String) -> ReaderPage {
    fetch_article_page(&url).await
}

pub async fn fetch_with(url: &str, limits: &Limits) -> ReaderPage {
    let Ok(start) = Url::parse(url) else {
        return ReaderPage::Failed;
    };
    if let Err(error) = metadata::check_address(&start, limits.allow).await {
        return failed(error);
    }
    let Ok(client) = metadata::client(limits) else {
        return ReaderPage::Failed;
    };
    let page = match metadata::fetch_page(&client, &start, limits).await {
        Ok(page) => page,
        Err(error) => return failed(error),
    };
    let Some((html, charset)) = decoded(&page) else {
        return answer(page);
    };
    // One `<meta refresh>` is followed like a redirect, through the same guard.
    if let Some(next) = refresh_target(&html, &page.url).filter(|next| *next != page.url) {
        if !net_guard::allowed_url(&next, limits.allow) {
            return ReaderPage::Refused;
        }
        return match metadata::fetch_page(&client, &next, limits).await {
            Ok(next) => match decoded(&next) {
                Some((html, charset)) => page_of(&next, html, charset),
                None => answer(next),
            },
            Err(error) => failed(error),
        };
    }
    page_of(&page, html, charset)
}

fn decoded(page: &Fetched) -> Option<(String, &'static str)> {
    (page.is_success() && page.html).then(|| {
        let (html, encoding) = charset::decode(&page.body, page.content_type.as_deref());
        (html, encoding.name())
    })
}

fn page_of(page: &Fetched, html: String, charset: &str) -> ReaderPage {
    ReaderPage::Page {
        url: page.url.to_string(),
        status: page.status,
        charset: charset.to_string(),
        html,
        truncated: page.truncated,
    }
}

/// A page that is not a 2xx HTML one.
fn answer(page: Fetched) -> ReaderPage {
    if !page.is_success() {
        ReaderPage::Status { url: page.url.to_string(), status: page.status }
    } else {
        ReaderPage::NotHtml { url: page.url.to_string(), content_type: page.content_type.unwrap_or_default() }
    }
}

fn failed(error: FetchError) -> ReaderPage {
    match error {
        FetchError::Refused => ReaderPage::Refused,
        FetchError::Timeout => ReaderPage::Timeout,
        FetchError::Failed => ReaderPage::Failed,
    }
}

/// Where `<meta http-equiv="refresh" content="0; url=…">` sends the reader, if
/// it is a redirect: a target given, soon enough.
pub fn refresh_target(html: &str, base: &Url) -> Option<Url> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("meta[http-equiv][content]").ok()?;
    let content = document
        .select(&selector)
        .find(|el| el.value().attr("http-equiv").is_some_and(|v| v.trim().eq_ignore_ascii_case("refresh")))?
        .value()
        .attr("content")?;
    // `5; url=next.html`, `0;URL='next.html'`, `0, next.html`: the standard's forms.
    let content = content.trim();
    let digits = content.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(content.len());
    let wait: f64 = content[..digits].parse().ok()?;
    if wait > REFRESH_WAIT {
        return None;
    }
    let rest = content[digits..].trim_start().trim_start_matches([';', ',']).trim_start();
    let rest = match rest.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("url") => {
            let after = rest[3..].trim_start();
            after.strip_prefix('=').map(str::trim_start).unwrap_or(rest)
        }
        _ => rest,
    };
    let target = match rest.chars().next() {
        Some(quote @ ('"' | '\'')) => rest[1..].split(quote).next().unwrap_or(""),
        _ => rest,
    }
    .trim();
    if target.is_empty() {
        return None;
    }
    base.join(target).ok().filter(|url| matches!(url.scheme(), "http" | "https"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A one-address HTTP server that answers every request with `reply` and counts them.
    fn server(address: &str, reply: impl Fn(u16) -> Vec<u8> + Send + 'static) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind((address, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&reply(port));
            }
        });
        (port, hits)
    }

    fn answer(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        reply.extend_from_slice(body);
        reply
    }

    fn html(body: &str) -> Vec<u8> {
        answer("200 OK", "text/html; charset=utf-8", body.as_bytes())
    }

    fn redirect(location: String) -> Vec<u8> {
        format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    /// Tests reach 127.0.0.1 only; the rest of 127/8 stands for the local network.
    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    const TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_secs(4),
        max_body: 64 * 1024,
        max_redirects: 5,
    };

    fn page(result: ReaderPage) -> (String, String, String, bool) {
        match result {
            ReaderPage::Page { url, charset, html, truncated, .. } => (url, charset, html, truncated),
            other => panic!("not a page: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_page_comes_whole_with_its_final_address() {
        let (target, _) = server("127.0.0.1", |_| html("<article><p>Text</p></article>"));
        let (hop, _) = server("127.0.0.1", move |_| redirect(format!("http://127.0.0.1:{target}/article")));
        let (url, charset, text, truncated) = page(fetch_with(&format!("http://127.0.0.1:{hop}/"), &TEST).await);
        assert_eq!(url, format!("http://127.0.0.1:{target}/article"));
        assert_eq!(charset, "UTF-8");
        assert_eq!(text, "<article><p>Text</p></article>");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn a_page_over_the_limit_is_cut_and_says_so() {
        let body = format!("<p>{}</p>", "x".repeat(200 * 1024));
        let (port, _) = server("127.0.0.1", move |_| html(&body));
        let (_, _, text, truncated) = page(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await);
        assert_eq!(text.len(), TEST.max_body);
        assert!(truncated);
        // The app's own limit is 5 MB.
        assert_eq!(LIMITS.max_body, 5 * 1024 * 1024);
    }

    #[tokio::test]
    async fn windows_1251_and_shift_jis_pages_are_decoded() {
        let cyrillic = encoding_rs::WINDOWS_1251.encode("<title>Персистентность — Life-Prog</title><p>Текст</p>").0.into_owned();
        let (port, _) = server("127.0.0.1", move |_| answer("200 OK", "text/html; charset=windows-1251", &cyrillic));
        let (_, charset, text, _) = page(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await);
        assert_eq!(charset, "windows-1251");
        assert!(text.contains("Персистентность") && text.contains("Текст"), "{text}");

        // Named in the page only, as life-prog.ru does.
        let in_meta = encoding_rs::WINDOWS_1251.encode(r#"<meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><p>Привет</p>"#).0.into_owned();
        let (port, _) = server("127.0.0.1", move |_| answer("200 OK", "text/html", &in_meta));
        let (_, charset, text, _) = page(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await);
        assert_eq!(charset, "windows-1251");
        assert!(text.contains("Привет"));

        let japanese = encoding_rs::SHIFT_JIS.encode("<meta charset=\"Shift_JIS\"><p>日本語の記事</p>").0.into_owned();
        let (port, _) = server("127.0.0.1", move |_| answer("200 OK", "text/html", &japanese));
        let (_, charset, text, _) = page(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await);
        assert_eq!(charset, "Shift_JIS");
        assert!(text.contains("日本語の記事"));
    }

    #[tokio::test]
    async fn one_meta_refresh_is_followed() {
        let (target, _) = server("127.0.0.1", |_| html("<h1>Welcome</h1>"));
        let (start, _) = server("127.0.0.1", move |_| {
            html(&format!(r#"<html><head><meta http-equiv="refresh" content="0; url=http://127.0.0.1:{target}/welcome.html"></head><body>Redirecting...</body></html>"#))
        });
        let (url, _, text, _) = page(fetch_with(&format!("http://127.0.0.1:{start}/"), &TEST).await);
        assert_eq!(url, format!("http://127.0.0.1:{target}/welcome.html"));
        assert_eq!(text, "<h1>Welcome</h1>");

        // Only one: a second refresh is the page the reader gets.
        let (loop_port, hits) = server("127.0.0.1", |port| {
            html(&format!(r#"<meta http-equiv="Refresh" content="0;URL='http://127.0.0.1:{port}/again'">Again"#))
        });
        let (url, _, text, _) = page(fetch_with(&format!("http://127.0.0.1:{loop_port}/first"), &TEST).await);
        assert_eq!(url, format!("http://127.0.0.1:{loop_port}/again"));
        assert!(text.ends_with("Again"));
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // A refresh after the target's own redirect answers with that answer.
        let (gone, _) = server("127.0.0.1", |_| answer("404 Not Found", "text/html", b"gone"));
        let (start, _) = server("127.0.0.1", move |_| html(&format!(r#"<meta http-equiv="refresh" content="1;url=http://127.0.0.1:{gone}/">"#)));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{start}/"), &TEST).await, ReaderPage::Status { status: 404, .. }));
    }

    #[tokio::test]
    async fn a_page_on_a_local_address_is_never_requested() {
        let (inside, hits) = server("127.0.0.2", |_| html("<p>Router</p>"));
        // Directly, by address and by name, with the app's own limits.
        assert!(matches!(fetch_article_page(&format!("http://127.0.0.2:{inside}/")).await, ReaderPage::Refused));
        assert!(matches!(fetch_article_page(&format!("http://localhost:{inside}/")).await, ReaderPage::Refused));
        // After a redirect, by address and by name.
        let (hop, _) = server("127.0.0.1", move |_| redirect(format!("http://127.0.0.2:{inside}/")));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{hop}/"), &TEST).await, ReaderPage::Refused));
        let (named, _) = server("127.0.0.1", move |_| redirect(format!("http://localhost:{inside}/")));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{named}/"), &TEST).await, ReaderPage::Refused));
        // After a refresh, by address and by name.
        let (refresh, _) = server("127.0.0.1", move |_| html(&format!(r#"<meta http-equiv="refresh" content="0; url=http://127.0.0.2:{inside}/">"#)));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{refresh}/"), &TEST).await, ReaderPage::Refused));
        let (refresh, _) = server("127.0.0.1", move |_| html(&format!(r#"<meta http-equiv="refresh" content="0; url=http://localhost:{inside}/">"#)));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{refresh}/"), &TEST).await, ReaderPage::Refused));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the local address got no request");
    }

    #[tokio::test]
    async fn other_answers_say_what_they_are() {
        let (port, _) = server("127.0.0.1", |_| answer("403 Forbidden", "text/html", b"<p>No bots</p>"));
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await, ReaderPage::Status { status: 403, .. }));
        let (port, _) = server("127.0.0.1", |_| answer("200 OK", "application/pdf", b"%PDF-1.7"));
        match fetch_with(&format!("http://127.0.0.1:{port}/paper.pdf"), &TEST).await {
            ReaderPage::NotHtml { content_type, .. } => assert_eq!(content_type, "application/pdf"),
            other => panic!("{other:?}"),
        }
        // Nothing listens on this port any more. Windows retries a refused connection
        // for about two seconds, so it may end as the connect timeout.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert!(matches!(fetch_with(&format!("http://127.0.0.1:{closed}/"), &TEST).await, ReaderPage::Failed | ReaderPage::Timeout));
        assert!(matches!(fetch_with("not a url", &TEST).await, ReaderPage::Failed));
        // A dead domain is a failure, not a refusal: `.invalid` never resolves (RFC 6761).
        assert!(matches!(fetch_with("https://dead-domain.invalid/", &TEST).await, ReaderPage::Failed));
    }

    #[test]
    fn refresh_targets_in_the_forms_pages_write() {
        let base = Url::parse("https://google.github.io/comprehensive-rust/welcome.html").unwrap();
        let target = |content: &str| {
            refresh_target(&format!(r#"<html><head><meta http-equiv="refresh" content="{content}"></head></html>"#), &base).map(|u| u.to_string())
        };
        // Comprehensive Rust's own.
        assert_eq!(target("0; URL=./").as_deref(), Some("https://google.github.io/comprehensive-rust/"));
        assert_eq!(target("0;url=index.html").as_deref(), Some("https://google.github.io/comprehensive-rust/index.html"));
        assert_eq!(target("3, https://example.org/").as_deref(), Some("https://example.org/"));
        assert_eq!(target("0; url='/next?a=1'").as_deref(), Some("https://google.github.io/next?a=1"));
        assert_eq!(target("1.5;url=/x").as_deref(), Some("https://google.github.io/x"));
        assert_eq!(target("300; url=/same"), None, "a page that reloads itself later is not a redirect");
        assert_eq!(target("0"), None, "no target: a reload");
        assert_eq!(target("0; url=javascript:alert(1)"), None);
        assert_eq!(target("soon; url=/x"), None);
        assert_eq!(refresh_target(r#"<meta name="refresh" content="0; url=/x">"#, &base), None);
    }
}
