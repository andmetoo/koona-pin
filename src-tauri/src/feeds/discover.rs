//! The `<link rel="alternate">` discovery and the link preview of «New link»
//! (NP-129, plan §4.2): one head-only request to the pasted page.
//!
//! The answer is kept for 10 minutes by address, and the save path takes the
//! page's metadata from here ([`metadata_for_save`]) instead of downloading
//! the page again. No `/feed` or `/rss.xml` is guessed: each guess would be a
//! request to a page the person did not name.

use super::{
    fetch::{self, Failure, Outcome},
    parse, FeedCandidate, FeedPreview, LinkPreview,
};
use crate::{
    charset,
    metadata::{self, Conditional, FetchError, Limits, PageMetadata},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use scraper::{Html, Selector};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use url::Url;

/// The metadata request's rules, reading at most 512 KB of the head.
pub const LIMITS: Limits = Limits { max_body: 512 * 1024, ..Limits::PUBLIC };
/// How long an answer is kept for Save.
pub const KEEP: Duration = Duration::from_secs(10 * 60);

/// Answers by address (the pasted one and the final one), with when they came.
static PREVIEWS: LazyLock<Mutex<HashMap<String, (Instant, LinkPreview)>>> = LazyLock::new(Mutex::default);

/// The address as the cache knows it: parsed, without its fragment.
fn key(url: &str) -> Option<String> {
    let mut url = Url::parse(url.trim()).ok()?;
    url.set_fragment(None);
    Some(url.to_string())
}

/// Keeps an answer under the pasted address and the final one; the expired go.
pub fn remember(asked: &str, preview: &LinkPreview, now: Instant) {
    let Ok(mut previews) = PREVIEWS.lock() else { return };
    previews.retain(|_, (at, _)| now.duration_since(*at) < KEEP);
    for url in [asked, preview.url.as_str()] {
        if let Some(key) = key(url) {
            previews.insert(key, (now, preview.clone()));
        }
    }
}

/// An answer kept for `url` less than 10 minutes ago.
pub fn recall(url: &str, now: Instant) -> Option<LinkPreview> {
    let key = key(url)?;
    let previews = PREVIEWS.lock().ok()?;
    let (at, preview) = previews.get(&key)?;
    (now.duration_since(*at) < KEEP).then(|| preview.clone())
}

/// The metadata of a page being saved (capture's enrich): the link preview's
/// when the person pasted it in the last 10 minutes, else the page is read.
pub async fn metadata_for_save(url: &str) -> PageMetadata {
    match recall(url, Instant::now()).filter(|preview| !preview.is_feed) {
        Some(preview) => preview.metadata,
        None => metadata::fetch_metadata(url).await,
    }
}

/// `rss`, `atom` or `json` of a `<link type>` that names a feed.
fn kind_of(media_type: &str) -> Option<&'static str> {
    match media_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "application/rss+xml" => Some("rss"),
        "application/atom+xml" => Some("atom"),
        "application/feed+json" | "application/json" => Some("json"),
        _ => None,
    }
}

/// Every `<link rel="alternate">` feed in a page's head, absolute against
/// `base`, public only, once each, in page order.
pub fn alternates(html: &str, base: &Url) -> Vec<FeedCandidate> {
    let document = Html::parse_document(html);
    let Ok(selector) = Selector::parse("head link[rel][href][type]") else {
        return Vec::new();
    };
    let mut found: Vec<FeedCandidate> = Vec::new();
    for link in document.select(&selector) {
        let el = link.value();
        let alternate = el.attr("rel").is_some_and(|rel| rel.split_ascii_whitespace().any(|r| r.eq_ignore_ascii_case("alternate")));
        let Some(kind) = el.attr("type").and_then(kind_of).filter(|_| alternate) else {
            continue;
        };
        let Some(url) = el.attr("href").and_then(|href| base.join(href.trim()).ok()) else {
            continue;
        };
        if !crate::net_guard::allowed_url(&url, crate::net_guard::public_ip) || found.iter().any(|f| f.url == url.as_str()) {
            continue;
        }
        let title = el.attr("title").map(parse::text_of).filter(|t| !t.is_empty());
        found.push(FeedCandidate { url: url.to_string(), title, kind: kind.to_string() });
    }
    found
}

/// The kind of a document that is a feed itself.
fn own_kind(body: &[u8], content_type: Option<&str>) -> &'static str {
    let head = String::from_utf8_lossy(&body[..body.len().min(4096)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('{') || content_type.is_some_and(|t| t.to_ascii_lowercase().contains("json")) {
        "json"
    } else if head.contains("<feed") && !head.contains("<rss") {
        "atom"
    } else {
        "rss"
    }
}

/// The one request for a pasted link: the page's metadata and the feeds it
/// names, or the feed it is. `subscribed_uid` is the caller's to fill.
pub async fn link(raw: &str, limits: &Limits) -> Result<LinkPreview, FetchError> {
    let start = Url::parse(raw.trim()).map_err(|_| FetchError::Refused)?;
    metadata::check_address(&start, limits.allow).await?;
    let client = metadata::client(limits).map_err(|_| FetchError::Failed)?;
    let mut page = metadata::fetch_head(&client, &start, limits).await?;
    if !page.is_success() || page.body.is_empty() {
        return Err(FetchError::Failed);
    }
    let mut meta = metadata::base_metadata(start.as_str());

    if !page.html || parse::looks_like_feed(&page.body) {
        if !parse::looks_like_feed(&page.body) {
            return Err(FetchError::Failed);
        }
        // The title from the same bytes; a feed cut at 512 KB may not parse, and is still one.
        let parsed = parse::parse(&page.body, &page.url).ok();
        meta.title = parsed.as_ref().and_then(|f| f.title.clone());
        meta.description = parsed.as_ref().and_then(|f| f.description.clone());
        let candidate = FeedCandidate {
            url: page.url.to_string(),
            title: meta.title.clone(),
            kind: own_kind(&page.body, page.content_type.as_deref()).to_string(),
        };
        return Ok(LinkPreview { url: page.url.to_string(), metadata: meta, feeds: vec![candidate], is_feed: true, subscribed_uid: None });
    }

    let (mut html, _) = charset::decode(&page.body, page.content_type.as_deref());
    // One `<meta refresh>` is followed, as the save path's metadata does.
    if let Some(next) = metadata::refresh_target(&html, &page.url).filter(|next| *next != page.url) {
        if let Ok(target) = metadata::fetch_head(&client, &next, limits).await {
            if target.is_success() && target.html {
                html = charset::decode(&target.body, target.content_type.as_deref()).0;
                page = target;
            }
        }
    }
    metadata::read_page(&html, &page.url, &mut meta);
    metadata::guard_pictures(&mut meta).await;
    let feeds = alternates(&html, &page.url);
    Ok(LinkPreview { url: page.url.to_string(), metadata: meta, feeds, is_feed: false, subscribed_uid: None })
}

/// The subscription of the first of `urls` already followed.
pub fn subscribed(conn: &Connection, urls: &[&str]) -> Option<String> {
    urls.iter().find_map(|url| {
        conn.query_row("SELECT uid FROM feeds WHERE url = ?1", [url], |r| r.get(0)).optional().ok().flatten()
    })
}

/// About how many posts a day, from the dates of a document's posts: one
/// post more than the gaps between them, over the days they span, at least
/// one day. None with fewer than two dates.
pub fn posts_per_day(dates: &[DateTime<Utc>]) -> Option<f32> {
    let (first, last) = (dates.iter().min()?, dates.iter().max()?);
    if dates.len() < 2 {
        return None;
    }
    let days = ((*last - *first).num_seconds() as f64 / 86_400.0).max(1.0);
    Some(((dates.len() - 1) as f64 / days) as f32)
}

/// The feed fetched once the «Follow» toggle is on: is it one, how often it posts.
pub async fn feed(url: &Url, limits: &Limits) -> Result<FeedPreview, Failure> {
    let fetched = fetch::fetch_feed(url, &Conditional::default(), limits).await;
    let feed = match fetched.outcome {
        Outcome::Fetched { feed, .. } => feed,
        Outcome::Failed(failure) => return Err(failure),
        Outcome::Gone => return Err(Failure::Status(410)),
        Outcome::RetryAfter { status, .. } => return Err(Failure::Status(status)),
        Outcome::NotModified { .. } => return Err(Failure::Parse),
    };
    let dates: Vec<DateTime<Utc>> = feed
        .items
        .iter()
        .filter_map(|item| item.published_at.as_deref())
        .filter_map(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
        .collect();
    Ok(FeedPreview {
        title: feed.title,
        site_url: feed.site_url,
        icon_url: feed.icon_url,
        posts_per_day: posts_per_day(&dates),
        last_post_at: dates.iter().max().map(|t| crate::db::stamp(*t)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::fetch::tests::{answer, rss, server, TEST};

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feeds").join(name)).unwrap()
    }

    #[test]
    fn alternate_links_of_the_head_are_the_feeds() {
        let base = Url::parse("https://kitchen.example.com/recipes/").unwrap();
        let found = alternates(&fixture("page.html"), &base);
        let urls: Vec<(&str, &str, Option<&str>)> = found.iter().map(|f| (f.url.as_str(), f.kind.as_str(), f.title.as_deref())).collect();
        assert_eq!(
            urls,
            [
                ("https://kitchen.example.com/feed.xml", "rss", Some("Posts")),
                ("https://kitchen.example.com/comments.atom", "atom", Some("Comments")),
                ("https://kitchen.example.com/recipes/feed.json", "json", None),
                ("https://kitchen.example.com/wp-json/", "json", None),
            ],
            "case, relative addresses, once each; no hreflang page, no local address, nothing from the body"
        );
    }

    #[test]
    fn posts_a_day_over_the_span_of_the_dates() {
        let at = |h: i64| DateTime::parse_from_rfc3339("2026-10-16T00:00:00Z").unwrap().with_timezone(&Utc) + chrono::TimeDelta::hours(h);
        assert_eq!(posts_per_day(&[]), None);
        assert_eq!(posts_per_day(&[at(0)]), None);
        assert_eq!(posts_per_day(&[at(0), at(1)]), Some(1.0), "a day at least");
        assert_eq!(posts_per_day(&[at(0), at(24), at(48), at(72), at(96)]), Some(1.0));
        assert_eq!(posts_per_day(&[at(0), at(6), at(12), at(18), at(24), at(30), at(36), at(42), at(48)]), Some(4.0));
    }

    fn preview(url: &str, title: &str) -> LinkPreview {
        LinkPreview {
            url: url.into(),
            metadata: PageMetadata { title: Some(title.into()), domain: "example.invalid".into(), ..Default::default() },
            feeds: Vec::new(),
            is_feed: false,
            subscribed_uid: None,
        }
    }

    #[test]
    fn an_answer_is_kept_ten_minutes_under_both_addresses() {
        let start = Instant::now();
        remember("https://keep.example.invalid/a#top", &preview("https://keep.example.invalid/b", "Kept"), start);
        assert!(recall("https://keep.example.invalid/a", start + Duration::from_secs(60)).is_some());
        assert!(recall("https://keep.example.invalid/b", start + Duration::from_secs(599)).is_some());
        assert!(recall("https://keep.example.invalid/a", start + KEEP).is_none());
        assert!(recall("https://other.example.invalid/", start).is_none());
    }

    /// The save path takes the preview's metadata: `.invalid` never resolves,
    /// so a title can only come from the kept answer.
    #[tokio::test]
    async fn saving_a_previewed_link_does_not_read_the_page_again() {
        remember("https://saved.example.invalid/post", &preview("https://saved.example.invalid/post", "From the preview"), Instant::now());
        assert_eq!(metadata_for_save("https://saved.example.invalid/post").await.title.as_deref(), Some("From the preview"));
        assert_eq!(metadata_for_save("https://unseen.example.invalid/post").await.title, None);
        // A pasted feed saves no bookmark: its answer is not page metadata.
        let mut feed = preview("https://feed.example.invalid/rss", "A feed");
        feed.is_feed = true;
        remember("https://feed.example.invalid/rss", &feed, Instant::now());
        assert_eq!(metadata_for_save("https://feed.example.invalid/rss").await.title, None);
    }

    #[tokio::test]
    async fn the_preview_reads_the_head_and_its_feeds() {
        let head = r#"<html><head><title>Garden</title><meta property="og:image" content="/c.jpg"><link rel="alternate" type="application/rss+xml" title="Posts" href="/rss"></head><body>"#;
        let tail = format!("{}</body></html>", "<p>long</p>".repeat(100_000));
        let page = format!("{head}{tail}");
        let (port, _) = server(move |_, _| answer("200 OK", "Content-Type: text/html; charset=utf-8\r\n", page.as_bytes()));
        let got = link(&format!("http://127.0.0.1:{port}/"), &TEST).await.unwrap();
        assert_eq!(got.metadata.title.as_deref(), Some("Garden"));
        assert!(!got.is_feed);
        // The test server's address is not public: the candidate is dropped like any local one.
        assert!(got.feeds.is_empty());
        let base = Url::parse("https://garden.example.com/").unwrap();
        assert_eq!(alternates(head, &base)[0].url, "https://garden.example.com/rss");
    }

    #[tokio::test]
    async fn a_pasted_feed_is_recognised_as_one() {
        let (port, _) = server(|_, _| answer("200 OK", "Content-Type: text/html\r\n", &rss("Served as HTML")));
        let got = link(&format!("http://127.0.0.1:{port}/feed"), &TEST).await.unwrap();
        assert!(got.is_feed);
        assert_eq!(got.metadata.title.as_deref(), Some("Served as HTML"));
        assert_eq!(got.feeds[0].kind, "rss");
        assert_eq!(got.feeds[0].url, format!("http://127.0.0.1:{port}/feed"));
        // And refused before asking when local with the app's limits.
        assert!(matches!(link(&format!("http://127.0.0.1:{port}/feed"), &LIMITS).await, Err(FetchError::Refused)));
    }

    #[tokio::test]
    async fn the_feed_preview_counts_posts() {
        let (port, _) = server(|_, _| answer("200 OK", "Content-Type: application/rss+xml\r\n", fixture("rss2.xml").as_bytes()));
        let got = feed(&Url::parse(&format!("http://127.0.0.1:{port}/rss")).unwrap(), &TEST).await.unwrap();
        assert_eq!(got.title.as_deref(), Some("Example Kitchen"));
        assert_eq!(got.last_post_at.as_deref(), Some("2026-10-15T09:12:00.000Z"));
        assert!(got.posts_per_day.unwrap() > 0.2 && got.posts_per_day.unwrap() < 0.4, "{:?}", got.posts_per_day);
        let (page, _) = server(|_, _| answer("200 OK", "Content-Type: text/html\r\n", b"<html><head><title>x</title></head></html>"));
        assert_eq!(feed(&Url::parse(&format!("http://127.0.0.1:{page}/")).unwrap(), &TEST).await.err(), Some(Failure::Parse));
    }
}
