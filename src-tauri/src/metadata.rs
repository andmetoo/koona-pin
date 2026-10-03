use scraper::{Html, Selector};
use std::time::Duration;
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

pub async fn fetch_metadata(target_url: &str) -> PageMetadata {
    let domain = extract_domain(target_url);
    let mut meta = PageMetadata {
        domain: domain.clone(),
        favicon_url: Some(format!(
            "https://www.google.com/s2/favicons?domain={}&sz=128",
            domain
        )),
        ..Default::default()
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 NetamiPin/0.1")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return meta,
    };

    let response = match client.get(target_url).send().await {
        Ok(r) => r,
        Err(_) => return meta,
    };

    let final_url = response.url().clone();
    let body = match response.text().await {
        Ok(b) => b,
        Err(_) => return meta,
    };

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
}
