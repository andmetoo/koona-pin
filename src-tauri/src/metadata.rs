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
    let body = String::from_utf8_lossy(&body);

    let document = Html::parse_document(&body);

    // Title
    if let Ok(og_title_sel) =
        Selector::parse("meta[property='og:title'], meta[name='twitter:title']")
    {
        for el in document.select(&og_title_sel) {
            if let Some(content) = el.value().attr("content") {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    meta.title = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    if meta.title.is_none() {
        if let Ok(title_sel) = Selector::parse("title") {
            if let Some(el) = document.select(&title_sel).next() {
                let text: String = el.text().collect();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    meta.title = Some(trimmed.to_string());
                }
            }
        }
    }

    // Description
    if let Ok(desc_sel) = Selector::parse("meta[property='og:description'], meta[name='description'], meta[name='twitter:description']") {
        for el in document.select(&desc_sel) {
            if let Some(content) = el.value().attr("content") {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    meta.description = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    // Image
    if let Ok(img_sel) = Selector::parse(
        "meta[property='og:image'], meta[name='twitter:image'], meta[name='twitter:image:src']",
    ) {
        for el in document.select(&img_sel) {
            if let Some(content) = el.value().attr("content") {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    if let Ok(resolved) = final_url.join(trimmed) {
                        meta.image_url = Some(resolved.to_string());
                        break;
                    }
                }
            }
        }
    }

    // Favicon
    if let Ok(fav_sel) = Selector::parse(
        "link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']",
    ) {
        for el in document.select(&fav_sel) {
            if let Some(href) = el.value().attr("href") {
                let trimmed = href.trim();
                if !trimmed.is_empty() {
                    if let Ok(resolved) = final_url.join(trimmed) {
                        meta.favicon_url = Some(resolved.to_string());
                        break;
                    }
                }
            }
        }
    }

    meta
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
            html(r#"<head><title>T</title><meta property="og:image" content="http://192.168.1.1/cam.jpg"><link rel="icon" href="/favicon.ico"></head>"#)
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
