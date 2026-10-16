use crate::{charset, net_guard};
use reqwest::redirect;
use scraper::{Html, Selector};
use std::net::IpAddr;
use std::time::Duration;
use tokio::sync::Semaphore;
use url::Url;

#[derive(Debug, Default, Clone)]
pub struct PageMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    /// The site's own name ("Serious Eats"): og:site_name and its kin.
    pub site_name: Option<String>,
    pub domain: String,
}

pub fn extract_domain(raw_url: &str) -> String {
    if let Ok(parsed) = Url::parse(raw_url) {
        if let Some(host) = parsed.host_str() {
            let h = host.to_lowercase();
            return if h.starts_with("www.") {
                h[4..].to_string()
            } else {
                h
            };
        }
    }
    "unknown".to_string()
}

/// What a metadata request may do (NP-019).
pub struct Limits {
    /// Addresses the request may connect to, after every resolution and redirect.
    pub allow: fn(IpAddr) -> bool,
    pub connect_timeout: Duration,
    /// The whole request, body included.
    pub timeout: Duration,
    /// The page is read up to this size; metadata sits in the head.
    pub max_body: usize,
    pub max_redirects: usize,
}

impl Limits {
    pub const PUBLIC: Limits = Limits {
        allow: net_guard::public_ip,
        connect_timeout: Duration::from_secs(4),
        timeout: Duration::from_secs(8),
        max_body: 2 * 1024 * 1024,
        max_redirects: 5,
    };
}

/// At most this many pages are fetched at once, whatever was saved.
static PARALLEL: Semaphore = Semaphore::const_new(4);

pub async fn fetch_metadata(target_url: &str) -> PageMetadata {
    fetch_metadata_read(target_url).await.0
}

/// How reading a page for its metadata went: «Обновить превью» for many
/// bookmarks counts the pages it could not open and tells a dead connection
/// from a dead site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    /// The page answered with HTML and was read.
    Read,
    /// On this computer or the local network, or not a web address: not requested.
    Local,
    /// It answered, but not with a page: an error status or another type.
    NoPage,
    /// No answer; see [`FetchError`].
    Failed(FetchError),
}

impl Reading {
    /// No connection or no answer in time: what a dead network looks like.
    pub fn network(self) -> bool {
        matches!(self, Reading::Failed(FetchError::Failed | FetchError::Timeout))
    }
}

/// [`fetch_metadata`], and how the read went.
pub async fn fetch_metadata_read(target_url: &str) -> (PageMetadata, Reading) {
    let (mut meta, reading) = fetch_read(target_url, &Limits::PUBLIC).await;
    // The WebView loads these itself: they get the same check, with DNS.
    for field in [&mut meta.image_url, &mut meta.favicon_url] {
        if let Some(url) = field.as_deref() {
            if !net_guard::public_resource(url).await {
                *field = None;
            }
        }
    }
    (meta, reading)
}

pub async fn fetch_with(target_url: &str, limits: &Limits) -> PageMetadata {
    fetch_read(target_url, limits).await.0
}

/// [`fetch_with`], and how the read went.
pub async fn fetch_read(target_url: &str, limits: &Limits) -> (PageMetadata, Reading) {
    let domain = extract_domain(target_url);
    let mut meta = PageMetadata {
        domain: domain.clone(),
        favicon_url: Some(format!(
            "https://www.google.com/s2/favicons?domain={}&sz=128",
            domain
        )),
        ..Default::default()
    };
    let Ok(start) = Url::parse(target_url) else {
        return (meta, Reading::Local);
    };
    if is_local(&start, limits.allow).await {
        // A local page keeps its address only; Google is not told its name.
        meta.favicon_url = None;
        return (meta, Reading::Local);
    }
    let Ok(_permit) = PARALLEL.acquire().await else {
        return (meta, Reading::Failed(FetchError::Failed));
    };
    let Ok(client) = client(limits) else {
        return (meta, Reading::Failed(FetchError::Failed));
    };
    let page = match fetch_page(&client, &start, limits).await {
        Ok(page) => page,
        Err(e) => return (meta, Reading::Failed(e)),
    };
    if !page.is_success() || !page.html {
        return (meta, Reading::NoPage);
    }
    let (html, _) = charset::decode(&page.body, page.content_type.as_deref());
    // One `<meta refresh>` is followed like a redirect, as the reader does
    // (NP-120): «Redirecting...» is not the title of the page it leads to.
    // When the target cannot be read, the redirect page is what there is.
    if let Some(next) = refresh_target(&html, &page.url).filter(|next| *next != page.url) {
        if let Ok(next) = fetch_page(&client, &next, limits).await {
            if next.is_success() && next.html {
                let (html, _) = charset::decode(&next.body, next.content_type.as_deref());
                read_page(&html, &next.url, &mut meta);
                return (meta, Reading::Read);
            }
        }
    }
    read_page(&html, &page.url, &mut meta);
    (meta, Reading::Read)
}

/// A `<meta http-equiv="refresh">` that waits longer than this reloads a page
/// that has its content already (news front pages); it is not a redirect.
const REFRESH_WAIT: f64 = 10.0;

/// Where `<meta http-equiv="refresh" content="0; url=…">` sends the page, if
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

/// A page fetched under [`Limits`]: its status and final address, and the
/// body of a 2xx HTML answer (NP-019, the reader's fetch in NP-120).
pub struct Fetched {
    pub status: u16,
    /// After the redirects.
    pub url: Url,
    pub content_type: Option<String>,
    /// HTML, or a type not given.
    pub html: bool,
    /// Read for a 2xx HTML answer only, up to `max_body`.
    pub body: Vec<u8>,
    /// The page was longer than `max_body`.
    pub truncated: bool,
}

impl Fetched {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a page could not be fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// The address, or one it redirects to, is not a public one: nothing was sent there.
    Refused,
    Timeout,
    /// No connection, a TLS failure, too many redirects, a broken answer.
    Failed,
}

/// A redirect the guard refused (NP-120): told apart from a network failure.
#[derive(Debug)]
struct LocalRedirect;

impl std::fmt::Display for LocalRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("redirect to a local address")
    }
}

impl std::error::Error for LocalRedirect {}

/// An address the app must not request: not HTTP(S), a local name or IP, or a
/// name that resolves to no allowed address.
pub async fn is_local(url: &Url, allow: fn(IpAddr) -> bool) -> bool {
    check_address(url, allow).await.is_err()
}

/// Whether `url` may be requested: refused for a local address or a name of one,
/// failed for a name that does not resolve at all (a dead domain).
pub async fn check_address(url: &Url, allow: fn(IpAddr) -> bool) -> Result<(), FetchError> {
    if !net_guard::allowed_url(url, allow) {
        return Err(FetchError::Refused);
    }
    match url.host_str() {
        Some(host) if url.domain().is_some() => match net_guard::resolve(host, allow).await {
            Ok(_) => Ok(()),
            Err(e) if e.get_ref().is_some_and(|inner| inner.is::<net_guard::NotPublic>()) => Err(FetchError::Refused),
            Err(_) => Err(FetchError::Failed),
        },
        _ => Ok(()),
    }
}

/// The client every page request goes through: the guard resolves names,
/// checks each redirect, and no proxy or Referer is used.
pub fn client(limits: &Limits) -> reqwest::Result<reqwest::Client> {
    let (allow, max_redirects) = (limits.allow, limits.max_redirects);
    reqwest::Client::builder()
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.timeout)
        // A proxy would resolve names where the guard cannot see them.
        .no_proxy()
        .dns_resolver(net_guard::resolver(allow))
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > max_redirects {
                attempt.error("too many redirects")
            } else if !net_guard::allowed_url(attempt.url(), allow) {
                attempt.error(LocalRedirect)
            } else {
                attempt.follow()
            }
        }))
        // Otherwise each redirect tells the next site the previous address, query and all.
        .referer(false)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 KoonaPin/0.1")
        .build()
}

/// One request through [`client`]. The caller has checked the address with
/// [`is_local`]; an IP literal is checked here again, names when they resolve.
pub async fn fetch_page(client: &reqwest::Client, url: &Url, limits: &Limits) -> Result<Fetched, FetchError> {
    if !net_guard::allowed_url(url, limits.allow) {
        return Err(FetchError::Refused);
    }
    let mut response = client.get(url.clone()).send().await.map_err(|e| failure(&e))?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let html = content_type.as_deref().is_none_or(|v| {
        let v = v.trim_start().to_ascii_lowercase();
        v.starts_with("text/html") || v.starts_with("application/xhtml+xml")
    });
    let mut page = Fetched {
        status: response.status().as_u16(),
        url: response.url().clone(),
        content_type,
        html,
        body: Vec::new(),
        truncated: false,
    };
    if !page.is_success() || !page.html {
        return Ok(page);
    }
    // Read up to the limit and stop: the rest of a huge page is not needed.
    while page.body.len() <= limits.max_body {
        match response.chunk().await {
            Ok(Some(chunk)) => page.body.extend_from_slice(&chunk),
            Ok(None) => break,
            Err(_) if !page.body.is_empty() => break,
            Err(e) => return Err(failure(&e)),
        }
    }
    if page.body.len() > limits.max_body {
        page.body.truncate(limits.max_body);
        page.truncated = true;
    }
    Ok(page)
}

fn failure(error: &reqwest::Error) -> FetchError {
    if error.is_timeout() {
        return FetchError::Timeout;
    }
    // The redirect policy's and the resolver's refusals sit somewhere down the chain.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(e) = source {
        let inner = e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()).map(|inner| inner as &(dyn std::error::Error + 'static));
        if e.is::<LocalRedirect>() || e.is::<net_guard::NotPublic>() || inner.is_some_and(|i| i.is::<net_guard::NotPublic>()) {
            return FetchError::Refused;
        }
        source = e.source();
    }
    FetchError::Failed
}

/// The first non-empty value of `attr` among the elements `selector` matches.
fn first_attr(document: &Html, selector: &str, attr: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .filter_map(|el| el.value().attr(attr))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

/// An address the WebView may load as a picture: http(s), resolved against the page.
fn picture(base: &Url, raw: &str) -> Option<String> {
    let url = base.join(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// `image` of schema.org JSON-LD: a string, an object with `url`, or a list
/// of them, on the item itself or in its `@graph`.
fn json_ld_image(value: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    let of = |image: &Value| -> Option<String> {
        match image {
            Value::String(url) => Some(url.clone()),
            Value::Object(object) => object.get("url").or_else(|| object.get("contentUrl")).and_then(Value::as_str).map(str::to_string),
            Value::Array(list) => list.iter().find_map(|item| match item {
                Value::String(url) => Some(url.clone()),
                Value::Object(object) => object.get("url").and_then(Value::as_str).map(str::to_string),
                _ => None,
            }),
            _ => None,
        }
    };
    match value {
        Value::Array(items) => items.iter().find_map(json_ld_image),
        Value::Object(object) => object
            .get("image")
            .and_then(of)
            .or_else(|| object.get("@graph").and_then(json_ld_image)),
        _ => None,
    }
}

/// The longest site name kept; longer ones are a slogan or a title.
const SITE_NAME_MAX: usize = 60;

/// A site's name as the cover prints it: whitespace collapsed, not empty,
/// not too long. Also for names that come from a copy (`restore.rs`).
pub fn tidy_site_name(raw: &str) -> Option<String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(if name.chars().count() > SITE_NAME_MAX {
        let cut: String = name.chars().take(SITE_NAME_MAX).collect();
        format!("{}…", cut.trim_end())
    } else {
        name
    })
}

/// [`tidy_site_name`], and not the domain itself, which the card shows
/// without it.
fn site_name(raw: &str, base: &Url, domain: &str) -> Option<String> {
    let name = tidy_site_name(raw)?;
    let bare = |host: &str| host.trim_start_matches("www.").to_lowercase();
    let lower = name.to_lowercase();
    let is_domain = [Some(domain), base.host_str()]
        .into_iter()
        .flatten()
        .filter(|host| !host.is_empty())
        .any(|host| bare(host) == bare(&lower));
    (!is_domain).then_some(name)
}

/// How big an icon declares itself: `sizes` (its largest), or what its kind
/// usually is. The largest wins: covers show icons at 32–56 px (NP-087).
fn icon_size(rel: &str, sizes: Option<&str>, href: &str) -> u32 {
    let declared = sizes.and_then(|sizes| {
        sizes
            .split_whitespace()
            .map(|size| match size.to_ascii_lowercase().as_str() {
                "any" => Some(512),
                size => size.split('x').next()?.parse().ok(),
            })
            .max()
            .flatten()
    });
    declared.unwrap_or(if rel.contains("apple-touch-icon") {
        180
    } else if href.ends_with(".svg") {
        512
    } else {
        16
    })
}

/// Title, description, picture and icon of a page (NP-019, NP-087).
pub fn read_page(html: &str, base: &Url, meta: &mut PageMetadata) {
    let document = Html::parse_document(html);
    meta.title = first_attr(&document, "meta[property='og:title'], meta[name='twitter:title']", "content").or_else(|| {
        let selector = Selector::parse("title").ok()?;
        let text: String = document.select(&selector).next()?.text().collect();
        Some(text.trim().to_string()).filter(|t| !t.is_empty())
    });
    meta.description = first_attr(
        &document,
        "meta[property='og:description'], meta[name='description'], meta[name='twitter:description']",
        "content",
    );

    meta.site_name = ["meta[property='og:site_name']", "meta[name='application-name']", "meta[name='apple-mobile-web-app-title']"]
        .iter()
        .find_map(|selector| first_attr(&document, selector, "content").and_then(|raw| site_name(&raw, base, &meta.domain)));

    // The picture, from the most deliberate source to the least: the page's
    // own preview tags, then what schema.org markup names, then a large image
    // in the article itself (NP-087).
    // One selector each: a list of selectors matches in document order.
    let tagged = [
        ("meta[property='og:image:secure_url']", "content"),
        ("meta[property='og:image'], meta[property='og:image:url']", "content"),
        ("meta[name='twitter:image'], meta[name='twitter:image:src'], meta[property='twitter:image']", "content"),
        ("link[rel='image_src']", "href"),
        ("meta[itemprop='image']", "content"),
        ("link[itemprop='image']", "href"),
        ("img[itemprop='image']", "src"),
    ];
    meta.image_url = tagged
        .iter()
        .find_map(|(selector, attr)| first_attr(&document, selector, attr).and_then(|raw| picture(base, &raw)))
        .or_else(|| {
            let selector = Selector::parse("script[type='application/ld+json']").ok()?;
            document.select(&selector).find_map(|el| {
                let json: serde_json::Value = serde_json::from_str(&el.text().collect::<String>()).ok()?;
                picture(base, &json_ld_image(&json)?)
            })
        })
        .or_else(|| {
            // Width declared and large enough: icons, avatars and spacers are not previews.
            let selector = Selector::parse("article img[src], main img[src]").ok()?;
            document.select(&selector).find_map(|el| {
                let width: u32 = el.value().attr("width")?.trim().trim_end_matches("px").parse().ok()?;
                (width >= 300).then(|| picture(base, el.value().attr("src")?)).flatten()
            })
        });

    // The largest icon the page offers; the first of equal ones.
    if let Ok(selector) = Selector::parse("link[rel~='icon'], link[rel='shortcut icon'], link[rel~='apple-touch-icon'], link[rel='apple-touch-icon-precomposed']") {
        let mut best: Option<(u32, String)> = None;
        for el in document.select(&selector) {
            let (Some(href), rel) = (el.value().attr("href"), el.value().attr("rel").unwrap_or("").to_ascii_lowercase()) else {
                continue;
            };
            let Some(url) = picture(base, href).filter(|_| !href.trim().is_empty()) else {
                continue;
            };
            let size = icon_size(&rel, el.value().attr("sizes"), href.trim());
            if best.as_ref().is_none_or(|(largest, _)| size > *largest) {
                best = Some((size, url));
            }
        }
        // A bare favicon.ico is usually 16 px: Google's 128 px icon, already
        // set, serves a cover better unless the page declares a larger one.
        if let Some((size, url)) = best {
            if size >= 32 || meta.favicon_url.is_none() {
                meta.favicon_url = Some(url);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_domain() {
        assert_eq!(
            extract_domain("https://www.google.com/search"),
            "google.com"
        );
        assert_eq!(
            extract_domain("https://github.com/tauri-apps/tauri"),
            "github.com"
        );
        assert_eq!(extract_domain("http://habr.com/ru/post/123"), "habr.com");
        assert_eq!(extract_domain("not_a_valid_url"), "unknown");
    }

    fn page(head: &str, body: &str) -> PageMetadata {
        let mut meta = PageMetadata::default();
        let base = Url::parse("https://example.org/articles/one").unwrap();
        read_page(&format!("<html><head>{head}</head><body>{body}</body></html>"), &base, &mut meta);
        meta
    }

    #[test]
    fn the_picture_comes_from_the_most_deliberate_source() {
        // Preview tags first, the secure address of og:image before the plain one.
        let meta = page(
            r#"<meta property="og:image" content="http://cdn.example.org/a.jpg"><meta property="og:image:secure_url" content="https://cdn.example.org/a.jpg"><link rel="image_src" href="/b.jpg">"#,
            "",
        );
        assert_eq!(meta.image_url.as_deref(), Some("https://cdn.example.org/a.jpg"));
        assert_eq!(page(r#"<link rel="image_src" href="/b.jpg">"#, "").image_url.as_deref(), Some("https://example.org/b.jpg"));
        assert_eq!(page(r#"<meta itemprop="image" content="c.png">"#, "").image_url.as_deref(), Some("https://example.org/articles/c.png"));
        assert_eq!(page("", r#"<img itemprop="image" src="/d.webp">"#).image_url.as_deref(), Some("https://example.org/d.webp"));
    }

    #[test]
    fn json_ld_names_the_picture_in_any_of_its_shapes() {
        let ld = |json: &str| page(&format!(r#"<script type="application/ld+json">{json}</script>"#), "").image_url;
        assert_eq!(ld(r#"{"@type":"Article","image":"https://example.org/e.jpg"}"#).as_deref(), Some("https://example.org/e.jpg"));
        assert_eq!(ld(r#"{"image":{"@type":"ImageObject","url":"/f.jpg"}}"#).as_deref(), Some("https://example.org/f.jpg"));
        assert_eq!(ld(r#"{"image":["/g.jpg","/h.jpg"]}"#).as_deref(), Some("https://example.org/g.jpg"));
        assert_eq!(ld(r#"{"@graph":[{"@type":"WebSite"},{"@type":"NewsArticle","image":[{"url":"/i.jpg"}]}]}"#).as_deref(), Some("https://example.org/i.jpg"));
        assert_eq!(ld(r#"[{"@type":"Person"},{"image":"/j.jpg"}]"#).as_deref(), Some("https://example.org/j.jpg"));
        assert_eq!(ld("{ not json"), None);
        assert_eq!(ld(r#"{"image":"data:image/png;base64,AAAA"}"#), None, "data: addresses are not stored");
    }

    #[test]
    fn a_large_article_image_is_the_last_resort() {
        let body = r#"<header><img src="/logo.png" width="400"></header><article><img src="/avatar.png" width="48"><img src="/hero.jpg" width="1200" height="630"></article>"#;
        assert_eq!(page("", body).image_url.as_deref(), Some("https://example.org/hero.jpg"));
        assert_eq!(page("", r#"<article><img src="/no-width.jpg"></article>"#).image_url, None, "a width says it is a picture");
        assert_eq!(page("", r#"<img src="/outside.jpg" width="800">"#).image_url, None, "only inside the article");
        assert_eq!(page("", "").image_url, None);
    }

    #[test]
    fn the_largest_icon_wins() {
        let icons = r#"<link rel="icon" href="/favicon.ico"><link rel="icon" sizes="32x32" href="/32.png"><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" sizes="16x16 96x96" href="/96.png">"#;
        assert_eq!(page(icons, "").favicon_url.as_deref(), Some("https://example.org/touch.png"));
        assert_eq!(page(r#"<link rel="icon" href="/favicon.ico"><link rel="icon" type="image/svg+xml" href="/icon.svg">"#, "").favicon_url.as_deref(), Some("https://example.org/icon.svg"));
        assert_eq!(page(r#"<link rel="shortcut icon" href="/a.ico"><link rel="icon" href="/b.ico">"#, "").favicon_url.as_deref(), Some("https://example.org/a.ico"), "the first of equal ones");
        assert_eq!(page(r#"<link rel="icon" href="">"#, "").favicon_url, None);
    }

    #[test]
    fn a_bare_favicon_does_not_replace_a_larger_default() {
        let base = Url::parse("https://example.org/").unwrap();
        let google = "https://www.google.com/s2/favicons?domain=example.org&sz=128";
        let read = |head: &str| {
            let mut meta = PageMetadata { favicon_url: Some(google.into()), ..Default::default() };
            read_page(&format!("<head>{head}</head>"), &base, &mut meta);
            meta.favicon_url.unwrap()
        };
        assert_eq!(read(r#"<link rel="icon" href="/favicon.ico">"#), google);
        assert_eq!(read(r#"<link rel="icon" sizes="16x16" href="/16.png">"#), google);
        assert_eq!(read(r#"<link rel="icon" sizes="32x32" href="/32.png">"#), "https://example.org/32.png");
        assert_eq!(read(r#"<link rel="apple-touch-icon" href="/touch.png">"#), "https://example.org/touch.png");
        assert_eq!(read(""), google);
    }

    #[test]
    fn the_site_name_comes_from_og_site_name_then_its_kin() {
        let name = |head: &str| page(head, "").site_name;
        assert_eq!(name(r#"<meta property="og:site_name" content="Serious Eats"><meta name="application-name" content="SE">"#).as_deref(), Some("Serious Eats"));
        assert_eq!(name(r#"<meta name="application-name" content="The Verge"><meta name="apple-mobile-web-app-title" content="Verge">"#).as_deref(), Some("The Verge"));
        assert_eq!(name(r#"<meta name="apple-mobile-web-app-title" content="Condé Nast Traveler">"#).as_deref(), Some("Condé Nast Traveler"));
        assert_eq!(name(r#"<meta property="og:site_name" content="  "><meta name="application-name" content="Next">"#).as_deref(), Some("Next"), "an empty one is skipped");
        assert_eq!(name(""), None);
    }

    #[test]
    fn the_site_name_is_tidied_and_not_the_domain() {
        let name = |head: &str| page(head, "").site_name;
        assert_eq!(name("<meta property=\"og:site_name\" content=\"  The\n  Verge \">").as_deref(), Some("The Verge"));
        let long = "A".repeat(80);
        let kept = name(&format!(r#"<meta property="og:site_name" content="{long}">"#)).unwrap();
        assert_eq!(kept.chars().count(), SITE_NAME_MAX + 1, "{kept}");
        assert!(kept.ends_with('…'));
        // The card shows the domain when there is no name; the same twice is not kept.
        assert_eq!(name(r#"<meta property="og:site_name" content="Example.org">"#), None);
        assert_eq!(name(r#"<meta property="og:site_name" content="www.example.org">"#), None);
        let mut meta = PageMetadata { domain: "theverge.com".into(), ..Default::default() };
        read_page(r#"<meta property="og:site_name" content="TheVerge.com">"#, &Url::parse("https://www.theverge.com/").unwrap(), &mut meta);
        assert_eq!(meta.site_name, None);
        assert_eq!(name(r#"<meta property="og:site_name" content="example.org blog">"#).as_deref(), Some("example.org blog"));
    }

    #[test]
    fn title_and_description_are_read_as_before() {
        let meta = page(r#"<title> Page </title><meta name="description" content=" About "><meta property="og:title" content="Shared">"#, "");
        assert_eq!(meta.title.as_deref(), Some("Shared"));
        assert_eq!(meta.description.as_deref(), Some("About"));
        assert_eq!(page("<title> Only </title>", "").title.as_deref(), Some("Only"));
        assert_eq!(page("<title>  </title>", "").title, None);
    }

    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

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

    fn html(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    /// Tests reach 127.0.0.1 only; the rest of 127/8 stands for the local network.
    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    const TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_secs(2),
        max_body: 64 * 1024,
        max_redirects: 5,
    };

    #[tokio::test]
    async fn a_page_on_this_computer_is_not_requested() {
        let (port, hits) = server("127.0.0.1", |_| html("<title>Router</title>"));
        let meta = fetch_metadata(&format!("http://127.0.0.1:{port}/")).await;
        assert_eq!(meta.title, None);
        assert_eq!(meta.favicon_url, None, "Google is not told about a local address");
        let meta = fetch_metadata(&format!("http://localhost:{port}/")).await;
        assert_eq!(meta.title, None);
        assert_eq!(meta.favicon_url, None);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_allowed_page_gives_its_title() {
        let (port, _) = server("127.0.0.1", |_| html("<html><head><title> Allowed </title></head></html>"));
        let meta = fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await;
        assert_eq!(meta.title.as_deref(), Some("Allowed"));
    }

    #[tokio::test]
    async fn a_redirect_to_the_local_network_is_not_followed() {
        let (inside, hits) = server("127.0.0.2", |_| html("<title>Inside</title>"));
        let (outside, _) = server("127.0.0.1", move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.2:{inside}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        });
        let meta = fetch_with(&format!("http://127.0.0.1:{outside}/"), &TEST).await;
        assert_eq!(meta.title, None);
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the local address got no request");
        // The control: a redirect to an allowed address is followed.
        let (target, _) = server("127.0.0.1", |_| html("<title>Followed</title>"));
        let (hop, _) = server("127.0.0.1", move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        });
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{hop}/"), &TEST).await.title.as_deref(), Some("Followed"));
        // Through a name, too: localhost resolves to blocked addresses.
        let (named, _) = server("127.0.0.1", move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{inside}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        });
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{named}/"), &TEST).await.title, None);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_redirect_does_not_tell_the_next_site_the_saved_address() {
        // The next site keeps what it was asked.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let next = listener.local_addr().unwrap().port();
        let asked = Arc::new(std::sync::Mutex::new(String::new()));
        let kept = asked.clone();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap_or(0);
            *kept.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            let _ = stream.write_all(&html("<title>Next</title>"));
        });
        let (first, _) = server("127.0.0.1", move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{next}/landing\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        });
        let meta = fetch_with(&format!("http://127.0.0.1:{first}/private?token=synthetic"), &TEST).await;
        assert_eq!(meta.title.as_deref(), Some("Next"));
        let asked = asked.lock().unwrap();
        assert!(asked.starts_with("get /landing "), "{asked}");
        assert!(!asked.contains("referer"), "{asked}");
        assert!(!asked.contains("synthetic"), "{asked}");
    }

    #[tokio::test]
    async fn a_meta_refresh_gives_the_target_page() {
        // Comprehensive Rust's welcome.html: «Redirecting...» is not the title (#319).
        let (target, _) = server("127.0.0.1", |_| {
            html(r#"<head><title>Welcome - Comprehensive Rust</title><meta name="description" content="A course"><meta property="og:image" content="/cover.png"><link rel="icon" sizes="64x64" href="/icon.png"></head>"#)
        });
        let (start, _) = server("127.0.0.1", move |_| {
            html(&format!(r#"<html><head><title>Redirecting...</title><meta http-equiv="refresh" content="0; url=http://127.0.0.1:{target}/index.html"></head></html>"#))
        });
        let meta = fetch_with(&format!("http://127.0.0.1:{start}/welcome.html"), &TEST).await;
        assert_eq!(meta.title.as_deref(), Some("Welcome - Comprehensive Rust"));
        assert_eq!(meta.description.as_deref(), Some("A course"));
        assert_eq!(meta.image_url, Some(format!("http://127.0.0.1:{target}/cover.png")));
        assert_eq!(meta.favicon_url, Some(format!("http://127.0.0.1:{target}/icon.png")));
        assert_eq!(meta.domain, "127.0.0.1", "the saved address stays");
        // Only one: a second refresh is the page the title comes from.
        let (twice, _) = server("127.0.0.1", move |_| {
            html(&format!(r#"<title>Second</title><meta http-equiv="refresh" content="0; url=http://127.0.0.1:{start}/">"#))
        });
        let (first, _) = server("127.0.0.1", move |_| html(&format!(r#"<title>First</title><meta http-equiv="refresh" content="0; url=http://127.0.0.1:{twice}/">"#)));
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{first}/"), &TEST).await.title.as_deref(), Some("Second"));
        // A refresh that waits long is a reload, not a redirect.
        let (reload, _) = server("127.0.0.1", move |_| html(&format!(r#"<title>News</title><meta http-equiv="refresh" content="300; url=http://127.0.0.1:{target}/">"#)));
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{reload}/"), &TEST).await.title.as_deref(), Some("News"));
    }

    #[tokio::test]
    async fn a_meta_refresh_to_the_local_network_is_not_followed() {
        let (inside, hits) = server("127.0.0.2", |_| html("<title>Inside</title>"));
        for host in ["127.0.0.2", "localhost"] {
            let (refresh, _) = server("127.0.0.1", move |_| {
                html(&format!(r#"<title>Redirecting...</title><meta http-equiv="refresh" content="0; url=http://{host}:{inside}/">"#))
            });
            // The redirect page is what there is.
            assert_eq!(fetch_with(&format!("http://127.0.0.1:{refresh}/"), &TEST).await.title.as_deref(), Some("Redirecting..."));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the local address got no request");
    }

    #[tokio::test]
    async fn a_huge_page_is_read_only_up_to_the_limit() {
        let padding = "x".repeat(200 * 1024);
        let (port, _) = server("127.0.0.1", move |_| html(&format!("<html><body>{padding}<title>Late</title></body></html>")));
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await.title, None);
    }

    #[tokio::test]
    async fn a_title_in_windows_1251_is_not_garbled() {
        // life-prog.ru names its encoding in a <meta>, not in the header (NP-120).
        let page = encoding_rs::WINDOWS_1251
            .encode(r#"<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Персистентность — Life-Prog</title></head></html>"#)
            .0
            .into_owned();
        let (port, _) = server("127.0.0.1", move |_| {
            let mut reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", page.len()).into_bytes();
            reply.extend_from_slice(&page);
            reply
        });
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await.title.as_deref(), Some("Персистентность — Life-Prog"));
    }

    #[tokio::test]
    async fn only_html_is_parsed() {
        let (port, _) = server("127.0.0.1", |_| {
            b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 20\r\nConnection: close\r\n\r\n<title>Binary</title>"
                .to_vec()
        });
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await.title, None);
    }

    #[tokio::test]
    async fn a_silent_server_does_not_hold_the_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(3).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let started = Instant::now();
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await.title, None);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn previews_and_icons_on_local_addresses_are_dropped() {
        let (port, _) = server("127.0.0.1", |_| {
            html(r#"<head><title>T</title><meta property="og:image" content="http://192.168.1.1/cam.jpg"><link rel="icon" sizes="64x64" href="/favicon.png"></head>"#)
        });
        // The page itself is allowed in the test; what it points the WebView to is not.
        let mut meta = fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await;
        assert_eq!(meta.image_url.as_deref(), Some("http://192.168.1.1/cam.jpg"));
        for field in [&mut meta.image_url, &mut meta.favicon_url] {
            if !net_guard::public_resource(field.as_deref().unwrap()).await {
                *field = None;
            }
        }
        assert_eq!(meta.image_url, None);
        assert_eq!(meta.favicon_url, None);
    }

    #[tokio::test]
    async fn a_read_tells_a_page_an_error_and_no_connection_apart() {
        let (port, _) = server("127.0.0.1", |_| html("<title>Page</title>"));
        let (meta, reading) = fetch_read(&format!("http://127.0.0.1:{port}/"), &TEST).await;
        assert_eq!((meta.title.as_deref(), reading), (Some("Page"), Reading::Read));
        let (port, _) = server("127.0.0.1", |_| b"HTTP/1.1 404 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        assert_eq!(fetch_read(&format!("http://127.0.0.1:{port}/"), &TEST).await.1, Reading::NoPage);
        // A port nobody listens on: what a dead connection looks like.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let reading = fetch_read(&format!("http://127.0.0.1:{closed}/"), &TEST).await.1;
        assert!(reading.network(), "{reading:?}");
        assert_eq!(fetch_read("http://192.168.1.1/", &TEST).await.1, Reading::Local);
    }
}
