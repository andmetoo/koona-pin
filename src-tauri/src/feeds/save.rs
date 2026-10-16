//! A post into a bookmark (NP-131, plan §4.6–4.7): S, R, F and the Inbox,
//! through the journal, `source = 'feed'`; and «Sort them like Inbox», which
//! saves a feed's new posts into the Inbox by itself.
//!
//! Lock order, always: the library, then the cache, never both at once here:
//! the library is written first, so a crash between the two leaves the post
//! «unsaved» beside its bookmark, and the next save of it finds that bookmark.

use super::{
    cache::{self, FeedCache, PostToSave},
    Feed, SavePlace,
};
use crate::{
    capture::{self, CaptureResult},
    db::{self, Bookmark, DbState, Source},
    error::{CommandError, ErrorCode, ErrorDetail},
    journal::{Action, Journal},
    metadata,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{collections::HashMap, sync::Arc};
use tauri::AppHandle;

/// New posts a feed set to «Sort them like Inbox» saves per check.
pub const INBOX_PER_CHECK: usize = 20;

/// The name a saved post is «from»: the person's name for the feed, else
/// its own title, else its address's host.
pub fn feed_name(feed: &Feed) -> String {
    feed.title
        .clone()
        .or_else(|| feed.feed_title.clone())
        .filter(|name| !name.trim().is_empty())
        .or_else(|| url::Url::parse(&feed.url).ok().and_then(|u| u.host_str().map(str::to_string)))
        .unwrap_or_else(|| feed.url.clone())
}

/// The bookmarks of `uids` out of the Trash, by uid: one lookup per page of
/// posts (plan §3.2). A bookmark in the Trash or gone shows the post unsaved.
pub fn saved_ids(library: &Connection, uids: &[String]) -> rusqlite::Result<HashMap<String, i64>> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    let uids = serde_json::to_string(uids).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    library
        .prepare("SELECT uid, id FROM bookmarks WHERE uid IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL")?
        .query_map([uids], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

fn no_link() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::InvalidUrl, "This post has no link to save")
}

/// What a save did: the bookmark, whether this save made it, and its place
/// in the journal.
#[derive(Debug)]
pub struct Saved {
    pub bookmark: Bookmark,
    /// The bookmark's uid, for the cache's link back.
    pub uid: String,
    pub created: bool,
    /// Brought back from the Trash by this save.
    pub restored: bool,
    pub command: Option<i64>,
}

/// The library half of S, R and F (plan §4.6), in one transaction. A link
/// already in the library out of the Trash is returned as it is: saving
/// never overwrites what the person set. One in the Trash comes back to the
/// place asked, as a capture brings a link back from the Trash (NP-131).
///
/// The journal undoes changes of bookmarks that exist (NP-024), and a save
/// makes one; so the bookmark is made in the Trash first and the recorded
/// command brings it out where the person asked. ⌘Z puts it back in the
/// Trash, as any undo leaves the bookmark there rather than deleting it.
pub fn save_post(
    library: &Connection,
    journal: &mut Journal,
    post: &PostToSave,
    feed: &Feed,
    place: SavePlace,
    favorite: bool,
) -> Result<Saved, CommandError> {
    let url = post.url.clone().ok_or_else(no_link)?;
    let tx = library.unchecked_transaction()?;
    let existing = tx
        .query_row("SELECT id, deleted_at IS NOT NULL FROM bookmarks WHERE url = ?1", [&url], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?))
        })
        .optional()?;
    let (id, created) = match existing {
        Some((id, false)) => {
            let bookmark = db::get_bookmark_by_id(&tx, id)?;
            let uid = uid_of(&tx, id)?;
            return Ok(Saved { bookmark, uid, created: false, restored: false, command: None });
        }
        Some((id, true)) => (id, false),
        None => {
            let made = insert(&tx, post, &url, &feed_name(feed))?;
            tx.execute("UPDATE bookmarks SET deleted_at = created_at WHERE id = ?1", [made.id])?;
            (made.id, true)
        }
    };
    let action = match (favorite, place) {
        (true, _) => Action::Favorite,
        (false, SavePlace::Library) => Action::Keep,
        (false, SavePlace::Reading) => Action::ToReading,
        (false, SavePlace::Inbox) => Action::Edit,
    };
    // Out of the Trash to the place asked: the Inbox waits for a decision anew,
    // a star or a Reading place it had stays.
    let (mut bookmarks, command) = journal.record(&tx, action, &[id], |conn| {
        let now = db::now();
        conn.execute(
            "UPDATE bookmarks SET deleted_at = NULL,
                triaged_at = CASE ?2 WHEN 'library' THEN ?4 WHEN 'inbox' THEN NULL ELSE triaged_at END,
                reading_at = CASE WHEN ?3 THEN COALESCE(reading_at, ?4) ELSE reading_at END,
                is_favorite = CASE WHEN ?5 THEN 1 ELSE is_favorite END, updated_at = ?4, revision = revision + 1
             WHERE id = ?1",
            params![id, place_name(place), place == SavePlace::Reading, now, favorite],
        )?;
        db::get_bookmark_by_id(conn, id).map(|b| vec![b])
    })?;
    let uid = uid_of(&tx, id)?;
    tx.commit()?;
    Ok(Saved { bookmark: bookmarks.remove(0), uid, created, restored: !created, command })
}

fn place_name(place: SavePlace) -> &'static str {
    match place {
        SavePlace::Library => "library",
        SavePlace::Reading => "reading",
        SavePlace::Inbox => "inbox",
    }
}

/// A new bookmark of the post, `source = 'feed'` and the feed's name.
fn insert(tx: &Connection, post: &PostToSave, url: &str, name: &str) -> rusqlite::Result<Bookmark> {
    let title = Some(post.title.trim()).filter(|t| !t.is_empty()).unwrap_or(url);
    let description = Some(post.excerpt.trim()).filter(|d| !d.is_empty());
    let made = db::insert_or_update_bookmark(
        tx,
        url,
        title,
        description,
        post.thumbnail_url.as_deref(),
        None,
        &metadata::extract_domain(url),
        None,
        None,
        Source::Feed,
    )?;
    db::set_source_name(tx, made.id, name)?;
    db::get_bookmark_by_id(tx, made.id)
}

/// S, R and F, whole: the post from the cache, the bookmark through the
/// journal, then the cache's `bookmark_uid` and read mark. The caller starts
/// the enrich ([`announce`]).
pub fn save_feed_item(
    db: &DbState,
    cache: &FeedCache,
    id: i64,
    place: SavePlace,
    favorite: bool,
) -> Result<Saved, CommandError> {
    let post = {
        let conn = cache.conn.lock().map_err(CommandError::internal)?;
        cache::posts(&conn, &[id])?.pop().ok_or(rusqlite::Error::QueryReturnedNoRows)?
    };
    let saved = {
        let conn = db.conn.lock().map_err(CommandError::internal)?;
        let mut journal = db.journal.lock().map_err(CommandError::internal)?;
        let feed = feed_of(&conn, cache, &post.feed_uid)?;
        save_post(&conn, &mut journal, &post, &feed, place, favorite)?
    };
    let conn = cache.conn.lock().map_err(CommandError::internal)?;
    cache::mark_saved(&conn, id, &saved.uid, &db::now())?;
    Ok(saved)
}

/// The subscription of a post with the cache's title; a post whose feed was
/// unfollowed meanwhile still saves, named by its address.
fn feed_of(library: &Connection, cache: &FeedCache, feed_uid: &str) -> Result<Feed, CommandError> {
    let followed = super::feed(library, feed_uid).optional()?;
    // The library is held: the cache comes after it, as the lock order asks.
    let conn = cache.conn.lock().map_err(CommandError::internal)?;
    let mut feed = match followed {
        Some(feed) => feed,
        // Unfollowed while its post was open (sync, another window): the post still
        // saves, named by what the cache knows of the feed.
        None => {
            let site: Option<String> = conn
                .query_row("SELECT site_url FROM feed_state WHERE feed_uid = ?1", [feed_uid], |r| r.get(0))
                .optional()?
                .flatten();
            Feed {
                uid: feed_uid.to_string(),
                url: site.clone().unwrap_or_default(),
                title: None,
                feed_title: None,
                site_url: site,
                icon_url: None,
                destination: super::FeedDestination::Feeds,
                unread: 0,
                total: 0,
                fetched_at: None,
                newest_at: None,
                health: super::FeedHealth::Ok,
            }
        }
    };
    if feed.title.is_none() {
        feed.feed_title = cache::feed_title(&conn, feed_uid)?;
    }
    Ok(feed)
}

fn uid_of(library: &Connection, id: i64) -> rusqlite::Result<String> {
    library.query_row("SELECT uid FROM bookmarks WHERE id = ?1", [id], |r| r.get(0))
}

/// Tells the library a bookmark arrived, as a capture does: `Created` for
/// the Inbox count and its notification, then the normal metadata enrich.
pub fn announce(app: &AppHandle, db: Arc<DbState>, bookmark: Bookmark) {
    capture::after_save(
        app,
        db,
        &CaptureResult {
            bookmark_id: bookmark.id,
            outcome: "created".into(),
            bookmark: Some(bookmark),
            newly_created: true,
            restored: false,
            reading: false,
            reading_changed: false,
        },
    );
}

/// «Sort them like Inbox», the library half: up to [`INBOX_PER_CHECK`] of
/// `posts` (newest first) into the Inbox, outside the journal: background
/// writes are nothing the person did. A link already in the library, Trash
/// included, by `url_key` as dedupe compares, is skipped and nothing comes
/// back from the Trash. Returns the post ids with their new bookmarks and uids.
pub fn save_to_inbox(library: &Connection, feed: &Feed, posts: &[PostToSave]) -> rusqlite::Result<Vec<(i64, Bookmark, String)>> {
    let name = feed_name(feed);
    let tx = library.unchecked_transaction()?;
    let mut saved = Vec::new();
    for post in posts.iter().filter(|p| p.bookmark_uid.is_none()).take(INBOX_PER_CHECK) {
        let Some(url) = post.url.as_deref() else {
            continue;
        };
        // The key's index leaves the Trash out, so the Trash is asked apart.
        let key = crate::dedupe::url_key(url);
        let there: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM bookmarks WHERE url = ?1)
                OR EXISTS (SELECT 1 FROM bookmarks WHERE url_key = ?2 AND deleted_at IS NULL)
                OR EXISTS (SELECT 1 FROM bookmarks WHERE url_key = ?2 AND deleted_at IS NOT NULL)",
            params![url, key],
            |r| r.get(0),
        )?;
        if !there {
            let bookmark = insert(&tx, post, url, &name)?;
            let uid = uid_of(&tx, bookmark.id)?;
            saved.push((post.id, bookmark, uid));
        }
    }
    tx.commit()?;
    Ok(saved)
}

/// The Inbox saves of one fetch, whole, and the cache's links back. Called
/// holding neither lock. Returns the new bookmarks.
fn inbox_saves(db: &DbState, cache: &FeedCache, feed: &Feed, new_ids: &[i64]) -> Result<Vec<Bookmark>, CommandError> {
    if feed.destination != super::FeedDestination::Inbox || new_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut feed = feed.clone();
    let posts = {
        let conn = cache.conn.lock().map_err(CommandError::internal)?;
        if feed.title.is_none() && feed.feed_title.is_none() {
            feed.feed_title = cache::feed_title(&conn, &feed.uid)?;
        }
        cache::posts(&conn, &new_ids[..new_ids.len().min(INBOX_PER_CHECK)])?
    };
    let saved = {
        let conn = db.conn.lock().map_err(CommandError::internal)?;
        save_to_inbox(&conn, &feed, &posts)?
    };
    let conn = cache.conn.lock().map_err(CommandError::internal)?;
    let now = db::now();
    for (post, _, uid) in &saved {
        cache::mark_saved(&conn, *post, uid, &now)?;
    }
    Ok(saved.into_iter().map(|(_, b, _)| b).collect())
}

/// After a fetch stored new posts (NP-129 calls it): for a feed whose
/// destination is `inbox`, save up to 20 of `new_ids` (newest first) into the
/// Inbox (plan §4.7). Returns how many were saved. Without an `AppHandle` it
/// tells no one: the app calls [`after_fetch_in_app`].
pub fn after_fetch(
    db: &crate::db::DbState,
    cache: &super::cache::FeedCache,
    feed: &super::Feed,
    new_ids: &[i64],
) -> Result<usize, crate::error::CommandError> {
    inbox_saves(db, cache, feed, new_ids).map(|saved| saved.len())
}

/// [`after_fetch`] in the app: each new bookmark is announced as a capture's
/// is (the Inbox count and notification), and enriched.
pub fn after_fetch_in_app(
    app: &AppHandle,
    db: &Arc<DbState>,
    cache: &FeedCache,
    feed: &Feed,
    new_ids: &[i64],
) -> Result<usize, CommandError> {
    let saved = inbox_saves(db, cache, feed, new_ids)?;
    let count = saved.len();
    for bookmark in saved {
        announce(app, db.clone(), bookmark);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        feeds::{
            parse::{ParsedFeed, ParsedItem},
            subscribe, update, FeedDestination,
        },
        journal::Undo,
        library,
    };
    use std::sync::Mutex;

    const NOW: &str = "2026-10-16T10:00:00.000Z";

    struct World {
        db: DbState,
        cache: FeedCache,
        feed: Feed,
    }

    fn world(destination: FeedDestination) -> World {
        let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("feed-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let conn = library::open(&library::Paths::new(folder.join("koonapin.db"))).unwrap().conn;
        let url = crate::feeds::feed_url("https://arstechnica.example.com/feed").unwrap();
        let feed = subscribe(&conn, &url, None, destination).unwrap();
        let cache = FeedCache { conn: Mutex::new(cache::open_in_memory().unwrap()), path: folder.join(cache::FILE) };
        World { db: DbState::new(conn), cache, feed }
    }

    fn post(key: &str, url: Option<&str>, minutes: i64) -> ParsedItem {
        ParsedItem {
            key: key.into(),
            url: url.map(str::to_string),
            title: format!("Post {key}"),
            excerpt: format!("About {key}"),
            thumbnail_url: Some(format!("https://cdn.example.com/{key}.jpg")),
            published_at: Some(db::stamp(chrono::Utc::now() - chrono::Duration::minutes(minutes))),
            ..Default::default()
        }
    }

    impl World {
        fn fetch(&self, items: Vec<ParsedItem>) -> Vec<i64> {
            let feed = ParsedFeed { title: Some("Ars Technica".into()), items, ..Default::default() };
            let conn = self.cache.conn.lock().unwrap();
            cache::store_fetch(&conn, &self.feed.uid, &feed, NOW).unwrap().new_ids
        }

        fn library(&self) -> std::sync::MutexGuard<'_, Connection> {
            self.db.conn.lock().unwrap()
        }

        fn link_back(&self, id: i64) -> (Option<String>, bool) {
            self.cache
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT bookmark_uid, read_at IS NOT NULL FROM feed_items WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
        }

        fn saved(&self, id: i64) -> Option<i64> {
            let uid = self.link_back(id).0?;
            saved_ids(&self.library(), std::slice::from_ref(&uid)).unwrap().get(&uid).copied()
        }
    }

    /// A post whose feed was unfollowed while it was open still saves (sync or
    /// another window took the subscription away first).
    #[test]
    fn a_post_of_a_feed_just_unfollowed_still_saves() {
        let w = world(FeedDestination::Feeds);
        let ids = w.fetch(vec![post("u", Some("https://example.com/u"), 1)]);
        w.library().execute("DELETE FROM feeds WHERE uid = ?1", [&w.feed.uid]).unwrap();
        let saved = save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Library, false).unwrap();
        assert_eq!(saved.bookmark.url, "https://example.com/u");
        assert_eq!(saved.bookmark.source_name.as_deref(), Some("Ars Technica"), "named by the cache's title");
        assert!(w.saved(ids[0]).is_some());
    }

    #[test]
    fn s_r_f_and_inbox_make_the_right_bookmark() {
        let w = world(FeedDestination::Feeds);
        let ids = w.fetch(vec![
            post("s", Some("https://example.com/s"), 1),
            post("r", Some("https://example.com/r"), 2),
            post("f", Some("https://example.com/f"), 3),
            post("i", Some("https://example.com/i"), 4),
        ]);
        let save = |n: usize, place, favorite| save_feed_item(&w.db, &w.cache, ids[n], place, favorite).unwrap();

        let s = save(0, SavePlace::Library, false);
        assert!(s.created && s.command.is_some());
        let b = &s.bookmark;
        assert!(b.triaged_at.is_some() && b.reading_at.is_none() && !b.is_favorite && b.deleted_at.is_none());
        assert_eq!((b.url.as_str(), b.title.as_str(), b.description.as_deref()), ("https://example.com/s", "Post s", Some("About s")));
        assert_eq!(b.image_url.as_deref(), Some("https://cdn.example.com/s.jpg"));
        assert_eq!((b.source.as_deref(), b.source_name.as_deref()), (Some("feed"), Some("Ars Technica")), "the feed's own title");
        assert_eq!(b.domain, "example.com");

        let r = save(1, SavePlace::Reading, false).bookmark;
        assert!(r.reading_at.is_some() && r.triaged_at.is_none());
        let f = save(2, SavePlace::Library, true).bookmark;
        assert!(f.is_favorite && f.triaged_at.is_some());
        // The person's name for the feed wins.
        update(&w.library(), &w.feed.uid, Some("Ars".into()), None).unwrap();
        let i = save(3, SavePlace::Inbox, false).bookmark;
        assert!(i.triaged_at.is_none() && i.reading_at.is_none() && !i.is_favorite);
        assert_eq!(i.source_name.as_deref(), Some("Ars"));

        for (n, bookmark) in [s.bookmark.id, r.id, f.id, i.id].into_iter().enumerate() {
            assert!(w.link_back(ids[n]).1, "read once saved");
            assert_eq!(w.saved(ids[n]), Some(bookmark), "shown saved");
        }
    }

    #[test]
    fn a_link_already_saved_comes_back_untouched() {
        let w = world(FeedDestination::Feeds);
        let mine = db::insert_or_update_bookmark(&w.library(), "https://example.com/a", "Mine", None, None, None, "example.com", None, None, Source::App).unwrap();
        let ids = w.fetch(vec![post("a", Some("https://example.com/a"), 1)]);
        let saved = save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Library, true).unwrap();
        assert!(!saved.created && !saved.restored && saved.command.is_none());
        assert!(w.link_back(ids[0]).1, "read: shown saved like any save");
        let now = db::get_bookmark_by_id(&w.library(), mine.id).unwrap();
        assert_eq!(
            (now.title.as_str(), now.source.as_deref(), now.is_favorite, now.triaged_at.clone(), now.revision),
            ("Mine", Some("app"), false, None, mine.revision)
        );
        assert_eq!(w.saved(ids[0]), Some(mine.id));
    }

    #[test]
    fn undo_takes_a_saved_post_back() {
        let w = world(FeedDestination::Feeds);
        let ids = w.fetch(vec![post("a", Some("https://example.com/a"), 1)]);
        let saved = save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Reading, true).unwrap();
        let outcome = w.db.journal.lock().unwrap().undo(&w.library(), None).unwrap();
        let Undo::Undone { bookmarks, .. } = outcome else {
            panic!("not undone: {outcome:?}");
        };
        let back = &bookmarks[0];
        assert_eq!(back.id, saved.bookmark.id);
        assert!(back.deleted_at.is_some() && back.reading_at.is_none() && !back.is_favorite, "back in the Trash, as it came");
        assert_eq!(w.saved(ids[0]), None, "the post shows unsaved again");
        // Saved again: out of the Trash to the place asked, and undoable again.
        let again = save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Library, false).unwrap();
        assert!(!again.created && again.restored && again.command.is_some());
        assert_eq!(again.bookmark.id, saved.bookmark.id);
        assert!(again.bookmark.deleted_at.is_none() && again.bookmark.triaged_at.is_some());
        assert_eq!(w.saved(ids[0]), Some(saved.bookmark.id));
        let outcome = w.db.journal.lock().unwrap().undo(&w.library(), None).unwrap();
        let Undo::Undone { bookmarks, .. } = outcome else {
            panic!("not undone: {outcome:?}");
        };
        assert!(bookmarks[0].deleted_at.is_some() && bookmarks[0].triaged_at.is_none());
    }

    #[test]
    fn a_link_trashed_earlier_comes_back_where_asked() {
        let w = world(FeedDestination::Feeds);
        let old = {
            let library = w.library();
            let old = db::insert_or_update_bookmark(&library, "https://example.com/a", "Mine", None, None, None, "example.com", None, Some(&["kept".to_string()]), Source::App).unwrap();
            library.execute("UPDATE bookmarks SET triaged_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1", [old.id]).unwrap();
            db::trash_bookmark(&library, old.id).unwrap()
        };
        let ids = w.fetch(vec![post("a", Some("https://example.com/a"), 1), post("b", Some("https://example.com/b"), 2)]);
        let saved = save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Inbox, true).unwrap();
        assert!(saved.restored && !saved.created && saved.command.is_some());
        let b = &saved.bookmark;
        assert_eq!(b.id, old.id);
        assert!(b.deleted_at.is_none() && b.triaged_at.is_none() && b.is_favorite, "in the Inbox anew, starred");
        assert_eq!((b.title.as_str(), b.source.as_deref(), b.tags.clone()), ("Mine", Some("app"), Some(vec!["kept".to_string()])));
        assert_eq!(w.link_back(ids[0]).1, true);
        assert_eq!(w.saved(ids[0]), Some(old.id));
        // Reading: in Reading, its decision kept.
        let other = {
            let library = w.library();
            let other = db::insert_or_update_bookmark(&library, "https://example.com/b", "B", None, None, None, "example.com", None, None, Source::App).unwrap();
            db::trash_bookmark(&library, other.id).unwrap()
        };
        let b = save_feed_item(&w.db, &w.cache, ids[1], SavePlace::Reading, false).unwrap().bookmark;
        assert_eq!(b.id, other.id);
        assert!(b.deleted_at.is_none() && b.reading_at.is_some() && !b.is_favorite);
    }

    #[test]
    fn a_post_without_a_link_or_gone_from_the_cache_is_not_saved() {
        let w = world(FeedDestination::Feeds);
        let ids = w.fetch(vec![post("a", None, 1)]);
        assert_eq!(save_feed_item(&w.db, &w.cache, ids[0], SavePlace::Library, false).unwrap_err().code, ErrorCode::InvalidRequest);
        assert_eq!(save_feed_item(&w.db, &w.cache, 9999, SavePlace::Library, false).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn sort_them_like_inbox_saves_twenty_new_posts_and_never_a_duplicate() {
        let w = world(FeedDestination::Inbox);
        {
            let library = w.library();
            // In the Trash under another spelling: never revived.
            let trashed = db::insert_or_update_bookmark(&library, "https://www.example.com/p01/?utm_source=x", "Old", None, None, None, "example.com", None, None, Source::App).unwrap();
            db::trash_bookmark(&library, trashed.id).unwrap();
            db::insert_or_update_bookmark(&library, "https://example.com/p02", "Mine", None, None, None, "example.com", None, None, Source::Chrome).unwrap();
        }
        let items: Vec<ParsedItem> = (0..25).map(|n| post(&format!("p{n:02}"), Some(&format!("https://example.com/p{n:02}")), n)).collect();
        let ids = w.fetch(items);
        assert_eq!(ids.len(), 20, "the first load's cap");
        let saved = after_fetch(&w.db, &w.cache, &w.feed, &ids).unwrap();
        assert_eq!(saved, 18, "the 20 newest, less the one in the Trash and the one in the library");

        let library = w.library();
        let feed_saves: i64 = library.query_row("SELECT count(*) FROM bookmarks WHERE source = 'feed'", [], |r| r.get(0)).unwrap();
        assert_eq!(feed_saves, 18);
        let (title, trashed): (String, bool) = library
            .query_row("SELECT title, deleted_at IS NOT NULL FROM bookmarks WHERE url LIKE '%www.example.com/p01%'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((title.as_str(), trashed), ("Old", true));
        let first: (Option<String>, Option<String>, Option<String>) = library
            .query_row("SELECT triaged_at, source_name, reading_at FROM bookmarks WHERE url = 'https://example.com/p00'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(first, (None, Some("Ars Technica".into()), None), "in the Inbox, from the feed");
        drop(library);
        assert!(w.saved(ids[0]).is_some(), "shown saved in the feed");
        assert_eq!(w.link_back(ids[1]).0, None, "the one in the Trash stays a post");
        assert!(matches!(w.db.journal.lock().unwrap().undo(&w.library(), None).unwrap(), Undo::Nothing), "outside the journal");

        // The same posts again: nothing twice.
        assert_eq!(after_fetch(&w.db, &w.cache, &w.feed, &ids).unwrap(), 0);
        // More than 20 new at once: the 20 newest.
        let items: Vec<ParsedItem> = (0..30).map(|n| post(&format!("q{n:02}"), Some(&format!("https://example.com/q{n:02}")), n)).collect();
        let ids = w.fetch(items);
        assert_eq!(ids.len(), 30);
        assert_eq!(after_fetch(&w.db, &w.cache, &w.feed, &ids).unwrap(), 20);
        assert!(w.saved(ids[19]).is_some() && w.saved(ids[20]).is_none());
    }

    #[test]
    fn other_destinations_save_nothing_by_themselves() {
        for destination in [FeedDestination::Feeds, FeedDestination::Notify] {
            let w = world(destination);
            let ids = w.fetch(vec![post("a", Some("https://example.com/a"), 1)]);
            assert_eq!(after_fetch(&w.db, &w.cache, &w.feed, &ids).unwrap(), 0);
        }
    }
}
