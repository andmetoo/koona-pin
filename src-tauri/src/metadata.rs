use crate::net_guard;
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
    let mut meta = fetch_with(target_url, &Limits::PUBLIC).await;
    // The WebView loads these itself: they get the same check, with DNS.
    for field in [&mut meta.image_url, &mut meta.favicon_url] {
        if let Some(url) = field.as_deref() {
            if !net_guard::public_resource(url).await {
                *field = None;
            }
        }
    }
    meta
}

pub async fn fetch_with(target_url: &str, limits: &Limits) -> PageMetadata {
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
        return meta;
    };
    let local = !net_guard::allowed_url(&start, limits.allow)
        || match start.host_str() {
            Some(host) if start.domain().is_some() => net_guard::resolve(host, limits.allow).await.is_err(),
            _ => false,
        };
    if local {
        // A local page keeps its address only; Google is not told its name.
        meta.favicon_url = None;
        return meta;
    }
    let Ok(_permit) = PARALLEL.acquire().await else {
        return meta;
    };

    let (allow, max_redirects) = (limits.allow, limits.max_redirects);
    let client = reqwest::Client::builder()
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.timeout)
        // A proxy would resolve names where the guard cannot see them.
        .no_proxy()
        .dns_resolver(net_guard::resolver(allow))
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > max_redirects {
                attempt.error("too many redirects")
            } else if !net_guard::allowed_url(attempt.url(), allow) {
                attempt.error("redirect to a local address")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 NetamiPin/0.1")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return meta,
    };

    let mut response = match client.get(start).send().await {
        Ok(r) => r,
        Err(_) => return meta,
    };
    let is_html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v = v.to_ascii_lowercase();
            v.starts_with("text/html") || v.starts_with("application/xhtml+xml")
        })
        .unwrap_or(true);
    if !response.status().is_success() || !is_html {
        return meta;
    }

    let final_url = response.url().clone();
    let mut body = Vec::new();
    // Read up to the limit and stop: the rest of a huge page is not needed.
    while body.len() < limits.max_body {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            Ok(None) => break,
            Err(_) if !body.is_empty() => break,
            Err(_) => return meta,
        }
    }
    body.truncate(limits.max_body);
    read_page(&String::from_utf8_lossy(&body), &final_url, &mut meta);
    meta
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
    async fn a_huge_page_is_read_only_up_to_the_limit() {
        let padding = "x".repeat(200 * 1024);
        let (port, _) = server("127.0.0.1", move |_| html(&format!("<html><body>{padding}<title>Late</title></body></html>")));
        assert_eq!(fetch_with(&format!("http://127.0.0.1:{port}/"), &TEST).await.title, None);
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
}
