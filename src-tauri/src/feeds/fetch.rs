//! HTTP for feeds (NP-129, plan §4.3): the feed client (`gzip` on, an honest
//! User-Agent), conditional GET with ETag and Last-Modified, status handling
//! and `Retry-After`, every request through the network guard.
//!
//! One fetch gives a [`Fetch`]: what the site answered, read into what the
//! schedule writes to `feed_state` and what the cache stores.

use super::parse::{self, ParseError, ParsedFeed};
use crate::metadata::{self, Conditional, FetchError, Limits};
use chrono::{DateTime, Utc};
use url::Url;

/// The longest any site may ask the app to wait, and the longest a feed's own
/// `ttl` or `max-age` stretches its interval.
pub const MAX_WAIT_SECS: u64 = 24 * 60 * 60;

/// What a fetch came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// 200: the document, with the validators to send next time.
    Fetched { feed: ParsedFeed, validators: Conditional },
    /// 304: nothing new since the validators sent.
    NotModified { validators: Conditional },
    /// 410: the feed has ended; it is fetched no more.
    Gone,
    /// 429 or 503 with `Retry-After`: the site asks for a pause, capped at a day.
    RetryAfter { status: u16, seconds: u64 },
    Failed(Failure),
}

/// Why a fetch failed: the cache's `last_error` is [`Failure::reason`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// A local or private address, directly or after a redirect: never requested.
    Refused,
    Timeout,
    /// No connection, a name that does not resolve, a TLS failure, too many redirects.
    Connection,
    /// 403, or a bot check answered instead of the feed: «The site doesn't let the app in».
    Blocked,
    Status(u16),
    /// Not a feed, even after the repair.
    Parse,
    /// Over 4 MB: nothing is stored.
    TooLarge,
}

impl Failure {
    pub fn reason(self) -> String {
        match self {
            Failure::Refused => "refused".into(),
            Failure::Timeout => "timeout".into(),
            Failure::Connection => "connection".into(),
            Failure::Blocked => "blocked".into(),
            Failure::Status(status) => format!("status:{status}"),
            Failure::Parse => "parse".into(),
            Failure::TooLarge => "too_large".into(),
        }
    }

    /// No answer from the site at all: when every fetch of a tick ends so,
    /// the computer is offline and no feed is blamed (plan §4.5).
    pub fn is_connection(self) -> bool {
        matches!(self, Failure::Timeout | Failure::Connection)
    }
}

/// A fetch and the headers the schedule reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Fetch {
    pub outcome: Outcome,
    /// `Cache-Control: max-age`, in seconds, at most a day.
    pub max_age: Option<u64>,
    /// Every redirect on the way was permanent (301, 308): the new address.
    pub moved_to: Option<String>,
}

impl Fetch {
    fn failed(failure: Failure) -> Self {
        Fetch { outcome: Outcome::Failed(failure), max_age: None, moved_to: None }
    }
}

/// Fetches and parses the feed at `url`, sending `conditional`'s validators.
pub async fn fetch_feed(url: &Url, conditional: &Conditional, limits: &Limits) -> Fetch {
    match metadata::check_address(url, limits.allow).await {
        Ok(()) => {}
        Err(FetchError::Refused) => return Fetch::failed(Failure::Refused),
        Err(FetchError::Timeout) => return Fetch::failed(Failure::Timeout),
        Err(FetchError::Failed) => return Fetch::failed(Failure::Connection),
    }
    let Ok(client) = metadata::feed_client(limits) else {
        return Fetch::failed(Failure::Connection);
    };
    let answer = match metadata::fetch_bytes(&client, url, limits, conditional).await {
        Ok(answer) => answer,
        Err(FetchError::Refused) => return Fetch::failed(Failure::Refused),
        Err(FetchError::Timeout) => return Fetch::failed(Failure::Timeout),
        Err(FetchError::Failed) => return Fetch::failed(Failure::Connection),
    };
    let max_age = answer.cache_control.as_deref().and_then(max_age);
    let moved_to = answer.moved_to.as_ref().map(Url::to_string);
    let validators = Conditional { etag: answer.etag.clone(), last_modified: answer.last_modified.clone() };
    let outcome = match answer.status {
        304 => Outcome::NotModified {
            // A 304 need not repeat them: the ones sent stay good.
            validators: Conditional {
                etag: validators.etag.or_else(|| conditional.etag.clone()),
                last_modified: validators.last_modified.or_else(|| conditional.last_modified.clone()),
            },
        },
        410 => Outcome::Gone,
        status @ (429 | 503) => match answer.retry_after.as_deref().and_then(|v| retry_after(v, Utc::now())) {
            Some(seconds) => Outcome::RetryAfter { status, seconds },
            None => Outcome::Failed(Failure::Status(status)),
        },
        403 => Outcome::Failed(Failure::Blocked),
        200..=299 if answer.truncated => Outcome::Failed(Failure::TooLarge),
        200..=299 => {
            let (body, base) = (answer.body, answer.url.clone());
            // feed-rs on a 4 MB document is CPU work: off the async threads.
            let parsed = tokio::task::spawn_blocking(move || {
                let parsed = parse::parse(&body, &base);
                (parsed, body)
            })
            .await;
            match parsed {
                Ok((Ok(feed), _)) => Outcome::Fetched { feed, validators },
                Ok((Err(ParseError::TooLarge), _)) => Outcome::Failed(Failure::TooLarge),
                Ok((Err(ParseError::Invalid), body)) if bot_check(&body) => Outcome::Failed(Failure::Blocked),
                _ => Outcome::Failed(Failure::Parse),
            }
        }
        status => Outcome::Failed(Failure::Status(status)),
    };
    Fetch { outcome, max_age, moved_to }
}

/// `Retry-After` in seconds from `now`: a number, or an HTTP date; at most a day.
pub fn retry_after(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let value = value.trim();
    let seconds = match value.parse::<u64>() {
        Ok(seconds) => seconds,
        Err(_) => {
            let at = DateTime::parse_from_rfc2822(value).ok()?.with_timezone(&Utc);
            (at - now).num_seconds().max(0) as u64
        }
    };
    Some(seconds.min(MAX_WAIT_SECS))
}

/// `max-age` of a `Cache-Control`, unless the answer may not be kept at all; at most a day.
pub fn max_age(value: &str) -> Option<u64> {
    let directives: Vec<String> = value.split(',').map(|d| d.trim().to_ascii_lowercase()).collect();
    if directives.iter().any(|d| d == "no-store" || d == "no-cache") {
        return None;
    }
    directives
        .iter()
        .find_map(|d| d.strip_prefix("max-age=")?.trim_matches('"').parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_WAIT_SECS))
}

/// A page some bot protection answers with instead of the document.
fn bot_check(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(64 * 1024)]).to_ascii_lowercase();
    if !head.contains("<html") && !head.contains("<!doctype html") {
        return false;
    }
    [
        "just a moment...",
        "cf-chl",
        "challenge-platform",
        "attention required",
        "captcha",
        "are you a robot",
        "access denied",
        "px-captcha",
        "datadome",
        "ddos-guard",
    ]
    .iter()
    .any(|marker| head.contains(marker))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Tests reach 127.0.0.1 only; the rest of 127/8 stands for the local network.
    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    pub(crate) const TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_secs(4),
        max_body: 64 * 1024,
        max_redirects: 5,
    };

    /// The requests a test server saw, lower-cased, in order.
    pub(crate) type Seen = Arc<Mutex<Vec<String>>>;

    /// A local HTTP server: `reply` answers each request from its text and the port.
    pub(crate) fn server(reply: impl Fn(&str, u16) -> Vec<u8> + Send + 'static) -> (u16, Seen) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let kept = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
                kept.lock().unwrap().push(text.clone());
                let _ = stream.write_all(&reply(&text, port));
            }
        });
        (port, seen)
    }

    pub(crate) fn answer(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut reply = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        reply.extend_from_slice(body);
        reply
    }

    pub(crate) fn rss(title: &str) -> Vec<u8> {
        format!(r#"<?xml version="1.0"?><rss version="2.0"><channel><title>{title}</title><link>https://example.com/</link><item><guid>a</guid><title>First</title><pubDate>Fri, 16 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>"#).into_bytes()
    }

    fn at(port: u16, path: &str) -> Url {
        Url::parse(&format!("http://127.0.0.1:{port}{path}")).unwrap()
    }

    fn fetched(fetch: &Fetch) -> (&ParsedFeed, &Conditional) {
        match &fetch.outcome {
            Outcome::Fetched { feed, validators } => (feed, validators),
            other => panic!("not fetched: {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unchanged_feed_costs_a_304_the_second_time() {
        let (port, seen) = server(|request, _| {
            if request.contains("if-none-match: \"v1\"") {
                answer("304 Not Modified", "ETag: \"v1\"\r\n", b"")
            } else {
                answer("200 OK", "Content-Type: application/rss+xml\r\nETag: \"v1\"\r\nCache-Control: public, max-age=7200\r\n", &rss("Tagged"))
            }
        });
        let first = fetch_feed(&at(port, "/feed"), &Conditional::default(), &TEST).await;
        let (feed, validators) = fetched(&first);
        assert_eq!(feed.title.as_deref(), Some("Tagged"));
        assert_eq!(validators.etag.as_deref(), Some("\"v1\""));
        assert_eq!(first.max_age, Some(7200));
        let second = fetch_feed(&at(port, "/feed"), validators, &TEST).await;
        assert_eq!(second.outcome, Outcome::NotModified { validators: validators.clone() });

        // And by Last-Modified, with no ETag at all.
        let modified = "Fri, 16 Oct 2026 08:00:00 GMT";
        let (port, _) = server(move |request, _| {
            if request.contains(&format!("if-modified-since: {}", modified.to_ascii_lowercase())) {
                answer("304 Not Modified", "", b"")
            } else {
                answer("200 OK", &format!("Content-Type: text/xml\r\nLast-Modified: {modified}\r\n"), &rss("Dated"))
            }
        });
        let first = fetch_feed(&at(port, "/"), &Conditional::default(), &TEST).await;
        let (_, validators) = fetched(&first);
        assert_eq!(validators.last_modified.as_deref(), Some(modified));
        let second = fetch_feed(&at(port, "/"), validators, &TEST).await;
        assert!(matches!(second.outcome, Outcome::NotModified { .. }), "{second:?}");

        // The honest User-Agent, the feed Accept header, gzip asked for, no Referer.
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.contains(&format!("user-agent: koonapin/{} (+https://koona.app/pin)", env!("CARGO_PKG_VERSION"))), "{request}");
        assert!(request.contains("accept: application/rss+xml, application/atom+xml"), "{request}");
        assert!(request.contains("accept-encoding: gzip"), "{request}");
        assert!(!request.contains("referer"), "{request}");
        assert!(!request.contains("if-none-match"), "the first request has no validators");
    }

    #[tokio::test]
    async fn a_gzipped_feed_is_read() {
        use flate2::{write::GzEncoder, Compression};
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&rss("Packed")).unwrap();
        let packed = encoder.finish().unwrap();
        let (port, _) = server(move |_, _| answer("200 OK", "Content-Type: application/rss+xml\r\nContent-Encoding: gzip\r\n", &packed));
        let fetch = fetch_feed(&at(port, "/"), &Conditional::default(), &TEST).await;
        assert_eq!(fetched(&fetch).0.title.as_deref(), Some("Packed"));
    }

    #[tokio::test]
    async fn a_permanent_redirect_says_where_the_feed_moved() {
        let (target, _) = server(|_, _| answer("200 OK", "Content-Type: application/rss+xml\r\n", &rss("Moved")));
        let (start, _) = server(move |_, _| answer("301 Moved Permanently", &format!("Location: http://127.0.0.1:{target}/new\r\n"), b""));
        let fetch = fetch_feed(&at(start, "/old"), &Conditional::default(), &TEST).await;
        assert_eq!(fetched(&fetch).0.title.as_deref(), Some("Moved"));
        assert_eq!(fetch.moved_to, Some(format!("http://127.0.0.1:{target}/new")));
        // A temporary one on the way: not moved.
        let (hop, _) = server(move |_, _| answer("302 Found", &format!("Location: http://127.0.0.1:{start}/old\r\n"), b""));
        let fetch = fetch_feed(&at(hop, "/"), &Conditional::default(), &TEST).await;
        assert_eq!(fetch.moved_to, None);
        assert!(matches!(fetch.outcome, Outcome::Fetched { .. }));
    }

    #[tokio::test]
    async fn a_feed_or_redirect_to_a_local_address_is_never_requested() {
        // `localhost` reaches the same test server by name: the guard refuses it before asking.
        let (inside, hits) = server(|_, _| answer("200 OK", "Content-Type: application/rss+xml\r\n", &rss("Inside")));
        for location in [format!("http://localhost:{inside}/"), format!("http://127.0.0.2:{inside}/"), format!("http://192.168.1.1:{inside}/")] {
            let (outside, _) = server(move |_, _| answer("308 Permanent Redirect", &format!("Location: {location}\r\n"), b""));
            let fetch = fetch_feed(&at(outside, "/"), &Conditional::default(), &TEST).await;
            assert_eq!(fetch.outcome, Outcome::Failed(Failure::Refused));
        }
        let direct = fetch_feed(&Url::parse(&format!("http://localhost:{inside}/")).unwrap(), &Conditional::default(), &TEST).await;
        assert_eq!(direct.outcome, Outcome::Failed(Failure::Refused));
        // With the app's own limits, 127.0.0.1 itself is local.
        let app = fetch_feed(&at(inside, "/"), &Conditional::default(), &Limits::FEED).await;
        assert_eq!(app.outcome, Outcome::Failed(Failure::Refused));
        assert!(hits.lock().unwrap().is_empty(), "the local address got no request");
    }

    #[tokio::test]
    async fn statuses_become_gone_pauses_and_failures() {
        let (port, _) = server(|request, _| {
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            match path.as_str() {
                "/gone" => answer("410 Gone", "", b""),
                "/busy" => answer("429 Too Many Requests", "Retry-After: 120\r\n", b""),
                "/later" => answer("503 Service Unavailable", "Retry-After: 999999\r\n", b""),
                "/plain503" => answer("503 Service Unavailable", "", b""),
                "/forbidden" => answer("403 Forbidden", "Content-Type: text/html\r\n", b"<html>no</html>"),
                "/missing" => answer("404 Not Found", "", b""),
                "/challenge" => answer("200 OK", "Content-Type: text/html\r\n", b"<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"),
                "/page" => answer("200 OK", "Content-Type: text/html\r\n", b"<!DOCTYPE html><html><head><title>Home</title></head></html>"),
                _ => answer("200 OK", "Content-Type: application/rss+xml\r\n", &vec![b' '; 70 * 1024]),
            }
        });
        let outcome = |path: &'static str| async move { fetch_feed(&at(port, path), &Conditional::default(), &TEST).await.outcome };
        assert_eq!(outcome("/gone").await, Outcome::Gone);
        assert_eq!(outcome("/busy").await, Outcome::RetryAfter { status: 429, seconds: 120 });
        assert_eq!(outcome("/later").await, Outcome::RetryAfter { status: 503, seconds: MAX_WAIT_SECS });
        assert_eq!(outcome("/plain503").await, Outcome::Failed(Failure::Status(503)));
        assert_eq!(outcome("/forbidden").await, Outcome::Failed(Failure::Blocked));
        assert_eq!(outcome("/missing").await, Outcome::Failed(Failure::Status(404)));
        assert_eq!(outcome("/challenge").await, Outcome::Failed(Failure::Blocked));
        assert_eq!(outcome("/page").await, Outcome::Failed(Failure::Parse));
        assert_eq!(outcome("/huge").await, Outcome::Failed(Failure::TooLarge), "over the limit: nothing is parsed");
    }

    #[tokio::test]
    async fn no_connection_is_told_from_an_answer() {
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let fetch = fetch_feed(&at(closed, "/"), &Conditional::default(), &TEST).await;
        assert!(matches!(fetch.outcome, Outcome::Failed(f) if f.is_connection()), "{fetch:?}");
        let dead = fetch_feed(&Url::parse("https://dead-domain.invalid/feed").unwrap(), &Conditional::default(), &TEST).await;
        assert!(matches!(dead.outcome, Outcome::Failed(f) if f.is_connection()), "{dead:?}");
        assert!(!Failure::Status(500).is_connection() && !Failure::Blocked.is_connection());
    }

    #[test]
    fn retry_after_and_max_age_are_read_and_capped() {
        let now = DateTime::parse_from_rfc3339("2026-10-16T10:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(retry_after("120", now), Some(120));
        assert_eq!(retry_after("Fri, 16 Oct 2026 10:05:00 GMT", now), Some(300));
        assert_eq!(retry_after("Fri, 16 Oct 2026 09:00:00 GMT", now), Some(0));
        assert_eq!(retry_after("Sat, 31 Oct 2026 10:00:00 GMT", now), Some(MAX_WAIT_SECS));
        assert_eq!(retry_after("soon", now), None);
        assert_eq!(max_age("public, max-age=600"), Some(600));
        assert_eq!(max_age("max-age=9999999"), Some(MAX_WAIT_SECS));
        assert_eq!(max_age("no-cache, max-age=600"), None);
        assert_eq!(max_age("public"), None);
    }
}
