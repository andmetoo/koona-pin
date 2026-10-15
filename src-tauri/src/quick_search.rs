//! The quick search of the browser extension (NP-082, Р-40): the popup sends
//! a query and a filter over native messaging, the app answers with the
//! matches and how many each filter has. The same search as the library's
//! list (FTS5, ё/е, never the trash); an empty query gives the latest saved.

use crate::db::{self, BookmarkQuery};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

/// At most this many rows go to the popup: a short list to choose from.
pub const LIMIT: u32 = 50;
/// A longer query is not a search someone types.
const MAX_QUERY: usize = 500;

/// The filter chips of sheet 37.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Filter {
    #[default]
    All,
    Inbox,
    Favorites,
    Collection {
        id: i64,
    },
}

pub fn search(conn: &Connection, query: &str, filter: &Filter) -> rusqlite::Result<Value> {
    let query: String = query.trim().chars().take(MAX_QUERY).collect();
    let search = (!query.is_empty()).then_some(query);
    let page = db::get_bookmarks(
        conn,
        &BookmarkQuery {
            search: search.clone(),
            only_inbox: *filter == Filter::Inbox,
            only_favorites: *filter == Filter::Favorites,
            collection_id: match filter {
                Filter::Collection { id } => Some(*id),
                _ => None,
            },
            limit: Some(LIMIT),
            ..Default::default()
        },
    )?;
    let counts = db::search_counts(conn, search.as_deref())?;
    // Every collection is a chip, the ones without matches show 0.
    let collections: Vec<Value> = db::get_collections(conn)?
        .into_iter()
        .map(|c| {
            let count = counts
                .collections
                .iter()
                .find(|(id, _)| *id == c.id)
                .map_or(0, |(_, n)| *n);
            json!({ "id": c.id, "name": c.name, "count": count })
        })
        .collect();
    let items: Vec<Value> = page
        .items
        .into_iter()
        .map(|b| {
            json!({
                "id": b.id,
                "url": b.url,
                "title": b.title,
                "domain": b.domain,
                "collection_id": b.collection_id,
                "inbox": b.triaged_at.is_none(),
                "favorite": b.is_favorite,
                "created_at": b.created_at,
            })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "items": items,
        "more": page.next.is_some(),
        "counts": {
            "all": counts.all,
            "inbox": counts.inbox,
            "favorites": counts.favorites,
            "collections": collections,
        },
    }))
}

/// Whether a page is already in the library (NP-083): the extension asks for
/// every page it loads, when the person turned that on. The address as a
/// capture compares it (`capture::save`), so the mark shows exactly where a
/// click would answer «already saved»; a bookmark in the trash is not there.
pub fn lookup(conn: &Connection, url: &str) -> rusqlite::Result<Value> {
    let saved = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM bookmarks WHERE url = ?1 AND deleted_at IS NULL)",
        [url.trim()],
        |r| r.get::<_, bool>(0),
    )?;
    Ok(json!({ "ok": true, "saved": saved }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        // The SQL functions the triggers call, as every connection of the app has.
        crate::db::register_functions(&c).unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    fn save(conn: &Connection, url: &str, title: &str, at: &str) -> i64 {
        conn.execute(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at, url_key)
             VALUES (?1, ?1, ?2, 'example.com', ?3, ?3, ?1)",
            rusqlite::params![url, title, at],
        )
        .unwrap();
        conn.last_insert_rowid()
    }
    fn ids(reply: &Value) -> Vec<i64> {
        reply["items"].as_array().unwrap().iter().map(|i| i["id"].as_i64().unwrap()).collect()
    }

    #[test]
    fn finds_by_words_counts_every_filter_and_never_the_trash() {
        let conn = library();
        let dev = db::create_collection(&conn, "Dev", None, None).unwrap().id;
        db::create_collection(&conn, "Reading", None, None).unwrap();
        let notes = save(&conn, "https://blog.rust-lang.org/1", "Rust release notes", "2026-10-01T00:00:00.000Z");
        let book = save(&conn, "https://doc.rust-lang.org/book", "The Rust book", "2026-10-02T00:00:00.000Z");
        let tokio = save(&conn, "https://tokio.rs", "Tokio for Rust", "2026-10-03T00:00:00.000Z");
        let gone = save(&conn, "https://example.com/gone", "Rust in the trash", "2026-10-04T00:00:00.000Z");
        save(&conn, "https://example.com/other", "Something else", "2026-10-05T00:00:00.000Z");
        conn.execute("UPDATE bookmarks SET collection_id = ?1 WHERE id IN (?2, ?3)", rusqlite::params![dev, notes, tokio]).unwrap();
        conn.execute("UPDATE bookmarks SET triaged_at = created_at WHERE id <> ?1", [tokio]).unwrap();
        conn.execute("UPDATE bookmarks SET is_favorite = 1 WHERE id = ?1", [book]).unwrap();
        conn.execute("UPDATE bookmarks SET deleted_at = '2026-10-05T00:00:00.000Z' WHERE id = ?1", [gone]).unwrap();

        let all = search(&conn, "  rust ", &Filter::All).unwrap();
        assert_eq!(ids(&all), vec![tokio, book, notes], "newest first, the trash left out");
        assert_eq!(all["counts"]["all"], 3);
        assert_eq!(all["counts"]["inbox"], 1);
        assert_eq!(all["counts"]["favorites"], 1);
        // Every collection is listed (a new library has its own three too), with 0 when nothing matches.
        let chips = all["counts"]["collections"].as_array().unwrap();
        let chip = |name: &str| chips.iter().find(|c| c["name"] == name).unwrap()["count"].clone();
        assert_eq!((chip("Dev"), chip("Reading")), (json!(2), json!(0)));
        assert_eq!(chips.len(), db::get_collections(&conn).unwrap().len());
        assert_eq!(all["items"][0]["inbox"], true);
        assert_eq!(all["items"][0]["collection_id"], dev);

        assert_eq!(ids(&search(&conn, "rust", &Filter::Inbox).unwrap()), vec![tokio]);
        assert_eq!(ids(&search(&conn, "rust", &Filter::Favorites).unwrap()), vec![book]);
        let in_dev = search(&conn, "rust", &Filter::Collection { id: dev }).unwrap();
        assert_eq!(ids(&in_dev), vec![tokio, notes]);
        assert_eq!(in_dev["counts"]["all"], 3, "counts ignore the chosen filter");
        assert!(ids(&search(&conn, "rustacean", &Filter::All).unwrap()).is_empty());
    }

    #[test]
    fn an_empty_query_gives_the_latest_saved_up_to_the_limit() {
        let conn = library();
        for i in 0..60 {
            save(&conn, &format!("https://example.com/{i}"), &format!("Page {i}"), &format!("2026-10-01T00:00:{i:02}.000Z"));
        }
        let recent = search(&conn, "", &Filter::All).unwrap();
        let ids = ids(&recent);
        assert_eq!(ids.len(), LIMIT as usize);
        assert_eq!(ids[0], 60, "the newest first");
        assert_eq!(recent["more"], true);
        assert_eq!(recent["counts"]["all"], 60);
    }

    #[test]
    fn lookup_answers_as_a_click_would_and_not_from_the_trash() {
        let conn = library();
        let saved = |url: &str| lookup(&conn, url).unwrap()["saved"].as_bool().unwrap();
        let click = |url: &str| {
            let request = crate::capture::CaptureRequest { request_id: None, url: url.into(), title: None, collection_id: None, tags: None, reading: false };
            crate::capture::save(&conn, &request, db::Source::Extension).unwrap().outcome
        };
        let page = "https://www.example.com/page/?utm_source=x";
        click(page);
        assert!(saved(page));
        assert_eq!(click(page), "existing", "the click agrees with the mark");
        // Another spelling is a new link to a click, so it gets no mark either.
        assert!(!saved("http://example.com/page"));
        assert!(!saved("https://example.com/other"));
        assert!(!saved("chrome://extensions/"));
        conn.execute("UPDATE bookmarks SET deleted_at = '2026-10-05T00:00:00.000Z'", []).unwrap();
        assert!(!saved(page), "the trash is not the library");
    }

    #[test]
    fn filters_come_from_the_extension_as_json() {
        let parse = |v: Value| serde_json::from_value::<Filter>(v).unwrap();
        assert_eq!(parse(json!({ "kind": "all" })), Filter::All);
        assert_eq!(parse(json!({ "kind": "inbox" })), Filter::Inbox);
        assert_eq!(parse(json!({ "kind": "collection", "id": 7 })), Filter::Collection { id: 7 });
        assert!(serde_json::from_value::<Filter>(json!({ "kind": "trash" })).is_err());
    }
}
