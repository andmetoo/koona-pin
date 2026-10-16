//! A fetched document into posts (NP-129, plan §4.1): feed-rs 3.0.0 with a
//! base URI, then our own layer (keys, excerpts, thumbnails, the item-level
//! `media:thumbnail` pass, limits, one repair retry).
//!
//! Empty until NP-129, but for the test that pins feed-rs on the app's
//! toolchain (NP-128). NP-129 adds its fixture tests beside it.

#[cfg(test)]
mod tests {
    use feed_rs::model::FeedType;

    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feeds").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// The three formats into one model: what the cache will key, link and date by.
    #[test]
    fn feed_rs_reads_rss_atom_and_json_feed() {
        let parser = |base: &str| feed_rs::parser::Builder::new().base_uri(Some(base)).build();

        let rss = parser("https://kitchen.example.com/feed").parse(fixture("rss2.xml").as_slice()).unwrap();
        assert_eq!(rss.feed_type, FeedType::RSS2);
        assert_eq!(rss.title.unwrap().content, "Example Kitchen");
        assert_eq!(rss.entries.len(), 2);
        let first = &rss.entries[0];
        assert_eq!(first.id, "kitchen-0002", "the guid is the key");
        assert_eq!(first.links[0].href, "https://kitchen.example.com/posts/roast-potatoes");
        assert_eq!(first.authors[0].name.as_deref(), Some("Ann Example"));
        assert_eq!(first.published.unwrap().to_rfc3339(), "2026-10-15T09:12:00+00:00");
        assert!(first.summary.as_ref().unwrap().content.contains("<em>rough up</em>"));

        let atom = parser("https://notes.example.org/atom.xml").parse(fixture("atom.xml").as_slice()).unwrap();
        assert_eq!(atom.feed_type, FeedType::Atom);
        let entry = &atom.entries[0];
        assert_eq!(entry.id, "tag:notes.example.org,2026:small-tools");
        assert_eq!(entry.links[0].href, "https://notes.example.org/2026/small-tools");
        assert_eq!(entry.authors[0].name.as_deref(), Some("Ben Example"));
        assert!(entry.content.as_ref().unwrap().body.as_deref().unwrap().contains("<b>little</b>"));

        let json = parser("https://links.example.net/feed.json").parse(fixture("feed.json").as_slice()).unwrap();
        assert_eq!(json.feed_type, FeedType::JSON);
        assert_eq!(json.entries.len(), 2);
        assert_eq!(json.entries[0].id, "links-0042");
        assert_eq!(json.entries[0].title.as_ref().unwrap().content, "Maps drawn by hand");
        assert!(json.entries[1].title.is_none(), "a JSON item may have no title");
    }
}
