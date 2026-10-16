//! Feeds (Р-71): RSS, Atom and JSON Feed the app fetches itself, from the
//! person's computer, and shows as posts until one is saved as a bookmark.
//!
//! What lives where:
//!
//! - the subscriptions: the library's `feeds` table (schema 14), backed up,
//!   exported and synced like the rest of the library;
//! - the posts, read marks and fetch state: the cache file `feeds.db` beside
//!   the library ([`cache`]), never backed up, exported or synced. It is
//!   disposable: damaged or missing, it is made again and refetched;
//! - a saved post: an ordinary bookmark with `source = 'feed'`.
//!
//! This file is the IPC contract, fixed first (NP-128) so the tasks after it
//! work on files of their own. Who owns what:
//!
//! - `mod.rs`: types, commands, events (NP-128); each task fills the bodies
//!   of its own commands here;
//! - [`cache`]: the `feeds.db` connection and its schema (NP-128), its sweep
//!   and queries (NP-131);
//! - [`fetch`], [`parse`], [`discover`], [`schedule`]: HTTP, feed-rs, the
//!   `<link rel=alternate>` preview, the refresh loop (NP-129);
//! - [`save`], [`opml`]: a post into a bookmark, OPML import and export (NP-131);
//! - the sync entity `feed`: `commercial/koona-sync` (NP-130).
//!
//! The commands of the later tasks answer `not_implemented` until they land.

pub mod cache;
pub mod discover;
pub mod fetch;
pub mod opml;
pub mod parse;
pub mod save;
pub mod schedule;

use crate::{
    commands::blocking,
    db::{self, Bookmark, DbState},
    error::{CommandError, ErrorCode, ErrorDetail},
    metadata::PageMetadata,
    net_guard,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;
use url::Url;

/// After any fetch, read mark, save or subscription change that changes
/// counts or health: `FeedsChanged`.
pub const CHANGED_EVENT: &str = "feeds-changed";
/// A refresh under way and when it ends: `FeedsRefresh`.
pub const REFRESH_EVENT: &str = "feeds-refresh";

/// `AppSettings::feeds_refresh_minutes`: how often the loop checks a feed.
pub const REFRESH_SETTING: &str = "feeds_refresh_minutes";
/// One hour (plan §4.4); 0 means only when the person refreshes.
pub const DEFAULT_REFRESH_MINUTES: u32 = 60;

/// Where a feed's new posts go. Stored as text that any value may take
/// (schema 14): a newer device may sync one this build does not know, which
/// reads as `Feeds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeedDestination {
    /// Only in Feeds.
    Feeds,
    /// «Sort them like Inbox»: new posts are saved into the Inbox (plan §4.7).
    Inbox,
    /// Also a notification.
    Notify,
}

impl FeedDestination {
    pub fn as_str(self) -> &'static str {
        match self {
            FeedDestination::Feeds => "feeds",
            FeedDestination::Inbox => "inbox",
            FeedDestination::Notify => "notify",
        }
    }

    /// The stored text; an unknown one is `Feeds`.
    pub fn parse(stored: &str) -> Self {
        match stored {
            "inbox" => FeedDestination::Inbox,
            "notify" => FeedDestination::Notify,
            _ => FeedDestination::Feeds,
        }
    }
}

/// How fetching a feed goes, from the cache's fetch state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum FeedHealth {
    Ok,
    /// The last check found no connection at all; nothing is counted against the feed.
    Offline,
    /// Failing continuously since `since` (shown after 7 days); `reason` is the
    /// cache's `last_error`: `timeout`, `status:404`, `parse`, `refused`, `blocked`…
    Failing { since: String, reason: String },
    /// The site answered 410: the feed has ended and is no longer fetched.
    Gone,
    /// Three fetches in a row landed on this address: offer to update it.
    Moved { to: String },
}

/// A subscription with what the cache knows of it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Feed {
    pub uid: String,
    /// The feed document's address, not the site's.
    pub url: String,
    /// The person's own name for it; none: `feed_title`.
    pub title: Option<String>,
    /// From the cache: the feed's own title, site and icon. None before the first fetch.
    pub feed_title: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub destination: FeedDestination,
    pub unread: u32,
    pub total: u32,
    pub fetched_at: Option<String>,
    pub health: FeedHealth,
}

/// A post in the list.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedItem {
    pub id: i64,
    pub feed_uid: String,
    pub url: Option<String>,
    pub title: String,
    pub author: Option<String>,
    /// Plain text, up to 600 characters.
    pub excerpt: String,
    pub thumbnail_url: Option<String>,
    pub published_at: Option<String>,
    pub fetched_at: String,
    pub read: bool,
    /// The bookmark it was saved as, while that bookmark is out of the trash.
    pub bookmark_id: Option<i64>,
    /// The content looks like the whole article (≥ 150 words).
    pub full: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedItemPage {
    pub items: Vec<FeedItem>,
    /// The cursor of the next page, `published_at|id`; none on the last.
    pub next: Option<String>,
}

/// Which posts to list, newest first.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct FeedItemQuery {
    /// One feed; none: All feeds.
    #[ts(optional)]
    pub feed_uid: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
    /// Matches title and excerpt, on the Feeds page only.
    #[ts(optional)]
    pub search: Option<String>,
    /// `FeedItemPage::next` of the page before; none for the first.
    #[ts(optional)]
    pub after: Option<String>,
    pub limit: u32,
}

/// A post to read in the article sheet.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedArticle {
    pub id: i64,
    pub url: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub published_at: Option<String>,
    /// As the feed sent it, unsanitised: the interface sanitises it at render.
    pub html: String,
    pub full: bool,
}

/// A feed a page names with `<link rel="alternate">`, or the pasted address itself.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedCandidate {
    pub url: String,
    pub title: Option<String>,
    /// `rss`, `atom` or `json`.
    pub kind: String,
}

/// The one request when a link is pasted into «New link» (plan §4.2).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct LinkPreview {
    /// The final address, after redirects.
    pub url: String,
    pub metadata: PageMetadata,
    pub feeds: Vec<FeedCandidate>,
    /// The pasted address is a feed itself: the sheet offers to follow it and saves no bookmark.
    pub is_feed: bool,
    /// Already followed: the subscription of the first candidate (or of the address).
    pub subscribed_uid: Option<String>,
}

/// The feed fetched once the «Follow» toggle is on.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedPreview {
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    /// «About 4 new posts a day».
    pub posts_per_day: Option<f32>,
    pub last_post_at: Option<String>,
}

/// Where a saved post goes: S, R, or the Inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SavePlace {
    Library,
    Reading,
    Inbox,
}

/// Why an outline of an OPML file was not followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OpmlSkipReason {
    /// Not an http(s) address.
    InvalidUrl,
    /// An address on this computer or the local network.
    Refused,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OpmlSkip {
    pub title: String,
    pub url: String,
    pub reason: OpmlSkipReason,
}

/// The report of an OPML import.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OpmlImport {
    pub added: u32,
    /// Already followed.
    pub existing: u32,
    pub skipped: Vec<OpmlSkip>,
}

/// Payload of `feeds-changed`: every subscription, as `list_feeds` answers.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedsChanged {
    pub feeds: Vec<Feed>,
}

/// Payload of `feeds-refresh`: feeds checked of those due.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedsRefresh {
    pub running: bool,
    pub done: u32,
    pub total: u32,
}

fn not_implemented(command: &str) -> CommandError {
    CommandError::new(ErrorCode::NotImplemented, format!("{command} is not implemented yet"))
}

/// «Check for new posts» of Settings → Feeds, in minutes; 0: only when the person refreshes.
pub fn refresh_minutes(conn: &Connection) -> u32 {
    db::setting(conn, REFRESH_SETTING)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_REFRESH_MINUTES)
}

const FEED_COLUMNS: &str = "uid, url, title, destination";

/// A subscription as the library has it; what the cache knows comes later (NP-131).
fn feed_of(row: &rusqlite::Row) -> rusqlite::Result<Feed> {
    Ok(Feed {
        uid: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        feed_title: None,
        site_url: None,
        icon_url: None,
        destination: FeedDestination::parse(&row.get::<_, String>(3)?),
        unread: 0,
        total: 0,
        fetched_at: None,
        health: FeedHealth::Ok,
    })
}

/// Every subscription, by its name (the person's, else the address) in the
/// order SQLite compares text; the interface sorts as it shows them.
pub fn feeds(conn: &Connection) -> rusqlite::Result<Vec<Feed>> {
    conn.prepare(&format!("SELECT {FEED_COLUMNS} FROM feeds ORDER BY COALESCE(title, url), id"))?
        .query_map([], feed_of)?
        .collect()
}

pub fn feed(conn: &Connection, uid: &str) -> rusqlite::Result<Feed> {
    conn.query_row(&format!("SELECT {FEED_COLUMNS} FROM feeds WHERE uid = ?1"), [uid], feed_of)
}

/// A name the person typed: trimmed, none when empty.
fn name(title: Option<String>) -> Option<String> {
    title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// A feed address the app may follow: http(s), not on this computer or the
/// local network (its host is checked again when it resolves).
pub fn feed_url(raw: &str) -> Result<Url, CommandError> {
    let url = Url::parse(raw.trim())
        .map_err(|_| CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::InvalidUrl, "Not a valid link"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CommandError::detailed(
            ErrorCode::InvalidRequest,
            ErrorDetail::UnsupportedUrl,
            "Only HTTP and HTTPS feeds are followed",
        ));
    }
    if !net_guard::allowed_url(&url, net_guard::public_ip) {
        return Err(CommandError::detailed(
            ErrorCode::InvalidRequest,
            ErrorDetail::UnsupportedUrl,
            "Feeds on this computer or the local network are not followed",
        ));
    }
    Ok(url)
}

/// Follows `url`; an address already followed answers its subscription as it is.
pub fn subscribe(
    conn: &Connection,
    url: &Url,
    title: Option<String>,
    destination: FeedDestination,
) -> rusqlite::Result<Feed> {
    let now = db::now();
    conn.execute(
        "INSERT INTO feeds (uid, url, title, destination, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (url) DO NOTHING",
        params![db::new_uid(), url.as_str(), name(title), destination.as_str(), now],
    )?;
    conn.query_row(&format!("SELECT {FEED_COLUMNS} FROM feeds WHERE url = ?1"), [url.as_str()], feed_of)
}

/// Renames (an empty title goes back to the feed's own) and moves where new
/// posts go; `None` keeps what there is.
pub fn update(
    conn: &Connection,
    uid: &str,
    title: Option<String>,
    destination: Option<FeedDestination>,
) -> rusqlite::Result<Feed> {
    let current = feed(conn, uid)?;
    let title = match title {
        Some(title) => name(Some(title)),
        None => current.title.clone(),
    };
    // An unchanged field is not written: with sync on, each write is a change to send.
    conn.execute(
        "UPDATE feeds SET title = ?1, destination = COALESCE(?2, destination), updated_at = ?3
         WHERE uid = ?4 AND (title IS NOT ?1 OR destination IS NOT COALESCE(?2, destination))",
        params![title, destination.map(FeedDestination::as_str), db::now(), uid],
    )?;
    feed(conn, uid)
}

/// The row goes and a `feed` tombstone stays, as for a deleted collection,
/// so sync deletes it on the other devices. The feed's posts in the cache
/// go with it. Unknown: `NotFound`.
pub fn unsubscribe(conn: &Connection, uid: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let found = tx
        .query_row("SELECT 1 FROM feeds WHERE uid = ?1", [uid], |_| Ok(()))
        .optional()?;
    if found.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.execute(
        "INSERT OR REPLACE INTO tombstones (uid, kind, deleted_at, purged_at) VALUES (?1, 'feed', ?2, ?2)",
        params![uid, now],
    )?;
    tx.execute("DELETE FROM feeds WHERE uid = ?1", [uid])?;
    tx.commit()
}

/// Tells the interface: every subscription, as `list_feeds` answers.
pub fn emit_changed(app: &AppHandle, feeds: Vec<Feed>) {
    let _ = app.emit(CHANGED_EVENT, FeedsChanged { feeds });
}

async fn changed(app: &AppHandle, state: &State<'_, Arc<DbState>>) {
    if let Ok(list) = all_feeds(app, state).await {
        emit_changed(app, list);
    }
}

/// Every subscription with what the cache knows of it (NP-131): the library
/// is read and let go, then the cache. Without a cache, as the library has them.
async fn all_feeds(app: &AppHandle, state: &State<'_, Arc<DbState>>) -> Result<Vec<Feed>, CommandError> {
    let mut list = blocking(state, |conn| feeds(conn).map_err(CommandError::from)).await?;
    let Some(feed_cache) = app.try_state::<Arc<cache::FeedCache>>() else {
        return Ok(list);
    };
    cache::blocking(&feed_cache, move |conn| {
        cache::merge_state(conn, &mut list, chrono::Utc::now())?;
        Ok(list)
    })
    .await
}

#[tauri::command]
pub async fn list_feeds(app: AppHandle, state: State<'_, Arc<DbState>>) -> Result<Vec<Feed>, CommandError> {
    all_feeds(&app, &state).await
}

/// Follows a feed; its first fetch comes from the refresh loop (NP-129).
#[tauri::command]
pub async fn subscribe_feed(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    url: String,
    title: Option<String>,
    destination: FeedDestination,
) -> Result<Feed, CommandError> {
    let url = feed_url(&url)?;
    let feed = blocking(&state, move |conn| subscribe(conn, &url, title, destination).map_err(CommandError::from)).await?;
    changed(&app, &state).await;
    Ok(feed)
}

/// Rename (an empty `title` goes back to the feed's own) and «Where new posts go».
#[tauri::command]
pub async fn update_feed(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    uid: String,
    title: Option<String>,
    destination: Option<FeedDestination>,
) -> Result<Feed, CommandError> {
    let feed = blocking(&state, move |conn| update(conn, &uid, title, destination).map_err(CommandError::from)).await?;
    changed(&app, &state).await;
    Ok(feed)
}

#[tauri::command]
pub async fn unsubscribe_feed(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    uid: String,
) -> Result<(), CommandError> {
    let gone = uid.clone();
    blocking(&state, move |conn| unsubscribe(conn, &gone).map_err(CommandError::from)).await?;
    cache::forget_feed(&app, &uid);
    changed(&app, &state).await;
    Ok(())
}

/// The pasted page's head: its metadata and the feeds it names (NP-129).
#[tauri::command]
pub async fn preview_link(url: String) -> Result<LinkPreview, CommandError> {
    let _ = url;
    Err(not_implemented("preview_link"))
}

/// The feed itself, once the «Follow» toggle is on (NP-129).
#[tauri::command]
pub async fn preview_feed(url: String) -> Result<FeedPreview, CommandError> {
    let _ = url;
    Err(not_implemented("preview_feed"))
}

/// A page of posts (NP-131).
#[tauri::command]
pub async fn list_feed_items(
    state: State<'_, Arc<DbState>>,
    feed_cache: State<'_, Arc<cache::FeedCache>>,
    query: FeedItemQuery,
) -> Result<FeedItemPage, CommandError> {
    let (rows, next) = cache::blocking(&feed_cache, move |conn| Ok(cache::list_items(conn, &query)?)).await?;
    // «Saved» is one lookup of the page's bookmarks, out of the Trash (plan §3.2).
    let uids: Vec<String> = rows.iter().filter_map(|(_, uid)| uid.clone()).collect();
    let saved = blocking(&state, move |conn| Ok(save::saved_ids(conn, &uids)?)).await?;
    let items = rows
        .into_iter()
        .map(|(mut item, uid)| {
            item.bookmark_id = uid.and_then(|uid| saved.get(&uid).copied());
            item
        })
        .collect();
    Ok(FeedItemPage { items, next })
}

/// One post to read (NP-131).
#[tauri::command]
pub async fn get_feed_article(feed_cache: State<'_, Arc<cache::FeedCache>>, id: i64) -> Result<FeedArticle, CommandError> {
    cache::blocking(&feed_cache, move |conn| Ok(cache::article(conn, id)?)).await
}

/// Marks posts read or unread (NP-131).
#[tauri::command]
pub async fn set_feed_items_read(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    feed_cache: State<'_, Arc<cache::FeedCache>>,
    ids: Vec<i64>,
    read: bool,
) -> Result<(), CommandError> {
    let marked = cache::blocking(&feed_cache, move |conn| Ok(cache::set_read(conn, &ids, read, &db::now())?)).await?;
    if marked > 0 {
        changed(&app, &state).await;
    }
    Ok(())
}

/// «Mark all read» of one feed (none: all feeds), up to a fetch time so a
/// post that arrived meanwhile stays new; how many were marked (NP-131).
#[tauri::command]
pub async fn mark_feed_read(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    feed_cache: State<'_, Arc<cache::FeedCache>>,
    feed_uid: Option<String>,
    up_to: Option<String>,
) -> Result<u32, CommandError> {
    let marked = cache::blocking(&feed_cache, move |conn| {
        Ok(cache::mark_all_read(conn, feed_uid.as_deref(), up_to.as_deref(), &db::now())?)
    })
    .await?;
    if marked > 0 {
        changed(&app, &state).await;
    }
    Ok(marked as u32)
}

/// S, R and F: the post as an ordinary bookmark, through the journal (NP-131);
/// ⌘Z (`undo` with no command) takes the last one back. A link already in
/// the library is answered as it is.
#[tauri::command]
pub async fn save_feed_item(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    feed_cache: State<'_, Arc<cache::FeedCache>>,
    id: i64,
    place: SavePlace,
    favorite: bool,
) -> Result<Bookmark, CommandError> {
    let (db, feed_cache) = (state.inner().clone(), feed_cache.inner().clone());
    let library = db.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || save::save_feed_item(&library, &feed_cache, id, place, favorite))
        .await
        .map_err(CommandError::internal)??;
    if saved.created {
        save::announce(&app, db, saved.bookmark.clone());
    } else if saved.restored {
        // Back from the Trash it arrives like a new one; its metadata is there.
        crate::capture::emit(&app, crate::capture::ChangeKind::Created, &saved.bookmark);
    }
    changed(&app, &state).await;
    Ok(saved.bookmark)
}

/// ↻ and ⌘R: one feed or all of them now (NP-129).
#[tauri::command]
pub async fn refresh_feeds(feed_uid: Option<String>) -> Result<(), CommandError> {
    let _ = feed_uid;
    Err(not_implemented("refresh_feeds"))
}

/// «Clear feed cache»: the posts and fetch state go, and every feed is fetched again (NP-131).
#[tauri::command]
pub async fn clear_feed_cache(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    feed_cache: State<'_, Arc<cache::FeedCache>>,
) -> Result<(), CommandError> {
    cache::blocking(&feed_cache, |conn| Ok(cache::clear(conn)?)).await?;
    changed(&app, &state).await;
    Ok(())
}

/// Follows the feeds of an OPML file (NP-131).
#[tauri::command]
pub async fn import_opml(app: AppHandle, state: State<'_, Arc<DbState>>, path: String) -> Result<OpmlImport, CommandError> {
    // Reading needs no database, so the library stays available meanwhile.
    let outlines = tauri::async_runtime::spawn_blocking(move || {
        opml::read(std::path::Path::new(&path)).and_then(|text| opml::parse(&text))
    })
    .await
    .map_err(CommandError::internal)??;
    let progress = app.clone();
    let report = blocking(&state, move |conn| {
        Ok(opml::import(conn, &outlines, |done, total| {
            let _ = progress.emit(
                "import-progress",
                crate::commands::ImportProgress { done: done as u32, total: total as u32 },
            );
        })?)
    })
    .await?;
    changed(&app, &state).await;
    Ok(report)
}

/// Writes every subscription as OPML 2.0; how many (NP-131).
#[tauri::command]
pub async fn export_opml(app: AppHandle, state: State<'_, Arc<DbState>>, path: String) -> Result<u32, CommandError> {
    let list = opml::exported(&all_feeds(&app, &state).await?);
    let count = list.len() as u32;
    tauri::async_runtime::spawn_blocking(move || opml::save(std::path::Path::new(&path), &list))
        .await
        .map_err(CommandError::internal)??;
    Ok(count)
}

/// «Check for new posts» of Settings → Feeds: 0 (only on refresh) or 5 minutes to a day.
#[tauri::command]
pub async fn set_feeds_refresh_minutes(state: State<'_, Arc<DbState>>, minutes: u32) -> Result<(), CommandError> {
    if minutes != 0 && !(5..=24 * 60).contains(&minutes) {
        return Err(CommandError::invalid("Check feeds every 5 minutes to once a day, or only on refresh"));
    }
    blocking(&state, move |conn| {
        db::set_setting(conn, REFRESH_SETTING, &minutes.to_string()).map_err(CommandError::from)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library;

    fn library() -> Connection {
        let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("feeds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        library::open(&library::Paths::new(folder.join("koonapin.db"))).unwrap().conn
    }

    #[test]
    fn subscribe_rename_move_and_unsubscribe() {
        let conn = library();
        let url = feed_url("https://example.com/feed.xml").unwrap();
        let feed = subscribe(&conn, &url, Some("  ".into()), FeedDestination::Feeds).unwrap();
        assert_eq!((feed.title.as_deref(), feed.destination), (None, FeedDestination::Feeds));
        // The same address again is the same subscription, untouched.
        let again = subscribe(&conn, &url, Some("Other".into()), FeedDestination::Inbox).unwrap();
        assert_eq!((again.uid.as_str(), again.title.as_deref()), (feed.uid.as_str(), None));

        let renamed = update(&conn, &feed.uid, Some(" Example ".into()), None).unwrap();
        assert_eq!((renamed.title.as_deref(), renamed.destination), (Some("Example"), FeedDestination::Feeds));
        let moved = update(&conn, &feed.uid, None, Some(FeedDestination::Notify)).unwrap();
        assert_eq!((moved.title.as_deref(), moved.destination), (Some("Example"), FeedDestination::Notify));
        let unnamed = update(&conn, &feed.uid, Some(String::new()), None).unwrap();
        assert_eq!(unnamed.title, None);
        assert_eq!(feeds(&conn).unwrap().len(), 1);

        unsubscribe(&conn, &feed.uid).unwrap();
        assert!(feeds(&conn).unwrap().is_empty());
        let kind: String = conn
            .query_row("SELECT kind FROM tombstones WHERE uid = ?1", [&feed.uid], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "feed");
        assert!(matches!(unsubscribe(&conn, &feed.uid), Err(rusqlite::Error::QueryReturnedNoRows)));
        assert!(matches!(update(&conn, &feed.uid, None, None), Err(rusqlite::Error::QueryReturnedNoRows)));
    }

    #[test]
    fn a_destination_from_a_newer_device_reads_as_feeds() {
        let conn = library();
        conn.execute(
            "INSERT INTO feeds (uid, url, destination, created_at, updated_at) VALUES ('u', 'https://example.com/rss', 'digest', 'x', 'x')",
            [],
        )
        .unwrap();
        assert_eq!(feed(&conn, "u").unwrap().destination, FeedDestination::Feeds);
        // Kept as stored until the person changes it.
        update(&conn, "u", Some("Named".into()), None).unwrap();
        let stored: String = conn.query_row("SELECT destination FROM feeds WHERE uid = 'u'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "digest");
    }

    #[test]
    fn only_public_web_addresses_are_followed() {
        assert!(feed_url("https://example.com/feed").is_ok());
        for refused in ["ftp://example.com/feed", "file:///etc/feed.xml", "http://localhost/feed", "http://192.168.1.2/rss", "not a link"] {
            assert!(feed_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_refresh_interval_is_an_hour_until_chosen() {
        let conn = library();
        assert_eq!(refresh_minutes(&conn), 60);
        db::set_setting(&conn, REFRESH_SETTING, "0").unwrap();
        assert_eq!(refresh_minutes(&conn), 0);
    }
}
