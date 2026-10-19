//! Answers of «New link» without the web, for the screenshots of koona.app/pin
//! (scripts/site-screenshots.mjs on Windows, scripts/site-screenshots-macos.mjs on a Mac): they
//! paste a page of the sample library, whose sites do not exist. With
//! KOONAPIN_SHOTS_PREVIEWS=<path> the link preview and the feed preview take their answers from
//! that JSON file, `{ "links": { address: LinkPreview }, "feeds": { address: FeedPreview } }`, as
//! requests would have given them (`feeds::discover` asks here first). Never in an installer build
//! (`public-release`), and off without the variable.

use crate::feeds::{discover, FeedPreview, LinkPreview};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

pub const SHOTS_ENV: &str = "KOONAPIN_SHOTS_PREVIEWS";

#[derive(Default, Deserialize)]
struct Seeded {
    #[serde(default)]
    links: HashMap<String, LinkPreview>,
    #[serde(default)]
    feeds: HashMap<String, FeedPreview>,
}

/// The answers of [`SHOTS_ENV`]'s file, read once; none without the variable.
static SEEDED: LazyLock<Seeded> = LazyLock::new(|| std::env::var_os(SHOTS_ENV).map(|path| read(Path::new(&path))).unwrap_or_default());

/// The answers of the file at `path`, by address as the preview cache keys it; none from a file
/// that is missing or not such JSON.
fn read(path: &Path) -> Seeded {
    let seeded: Seeded = match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(seeded) => seeded,
        Err(error) => {
            eprintln!("{SHOTS_ENV}: {error}");
            return Seeded::default();
        }
    };
    fn by_key<T>(map: HashMap<String, T>) -> HashMap<String, T> {
        map.into_iter().filter_map(|(url, v)| Some((discover::key(&url)?, v))).collect()
    }
    Seeded { links: by_key(seeded.links), feeds: by_key(seeded.feeds) }
}

/// The page's answer for an address as `discover::key` writes it.
pub fn link(key: &str) -> Option<LinkPreview> {
    SEEDED.links.get(key).cloned()
}

/// The feed's answer for an address as `discover::key` writes it.
pub fn feed(key: &str) -> Option<FeedPreview> {
    SEEDED.feeds.get(key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, text: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("koonapin-shot-previews-{}-{name}.json", std::process::id()));
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn answers_by_the_address_the_cache_keys() {
        let path = file(
            "good",
            r##"{
              "links": { "https://EarlyTrail.org/coastal-walks#top": {
                "url": "https://earlytrail.org/coastal-walks",
                "metadata": { "title": "Coastal walks", "description": null, "image_url": null, "favicon_url": null, "site_name": "Early Trail", "domain": "earlytrail.org" },
                "feeds": [{ "url": "https://earlytrail.org/feed.xml", "title": "Early Trail", "kind": "rss" }],
                "is_feed": false, "subscribed_uid": null } },
              "feeds": { "https://earlytrail.org/feed.xml": {
                "title": "Early Trail", "site_url": "https://earlytrail.org/", "icon_url": null, "posts_per_day": 0.3, "last_post_at": null } }
            }"##,
        );
        let seeded = read(&path);
        std::fs::remove_file(&path).ok();
        let page = seeded.links.get(&discover::key("https://earlytrail.org/coastal-walks").unwrap()).expect("the page");
        assert_eq!(page.metadata.title.as_deref(), Some("Coastal walks"));
        assert_eq!(page.feeds[0].url, "https://earlytrail.org/feed.xml");
        let feed = seeded.feeds.get(&discover::key("https://earlytrail.org/feed.xml").unwrap()).expect("the feed");
        assert_eq!(feed.posts_per_day, Some(0.3));
        assert!(!seeded.links.contains_key("https://earlytrail.org/other"));
    }

    #[test]
    fn a_missing_or_broken_file_answers_nothing() {
        let missing = read(&std::env::temp_dir().join("koonapin-shot-previews-none.json"));
        assert!(missing.links.is_empty() && missing.feeds.is_empty());
        let path = file("broken", r#"{ "links": { "https://earlytrail.org/": { "url": 1 } } }"#);
        let broken = read(&path);
        std::fs::remove_file(&path).ok();
        assert!(broken.links.is_empty() && broken.feeds.is_empty());
    }
}
