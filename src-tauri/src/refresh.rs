//! «Обновить превью» for many bookmarks at once: in Settings → Library for
//! the whole library or for the bookmarks without a picture or site name,
//! and in the selection bar for the bookmarks selected.
//!
//! Each page is read again the way the bookmark's own «Обновить превью»
//! reads it ([`metadata::fetch_metadata`], its guard and timeouts) and
//! written the same way ([`db::refresh_preview`]): the picture, the icon and
//! the site name are filled, the person's title, description, note and tags
//! stay. A bookmark nothing changed in keeps its revision.
//!
//! A few pages are read at once, never two of one site. «Остановить» lets
//! the pages under way finish. Network failures on several sites in a row
//! mean the connection is down: the run stops as «Нет сети» and those
//! bookmarks are not counted as failed.

use crate::capture::{self, ChangeKind};
use crate::db::{self, Bookmark, DbState};
use crate::metadata::{self, FetchError, PageMetadata, Reading};
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use ts_rs::TS;

/// Which bookmarks a run reads again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "PreviewScope")]
pub enum Scope {
    /// Without a picture or without a site name.
    Missing,
    All,
}

/// What a run is given: a scope, or the bookmarks selected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Scope(Scope),
    Ids(Vec<i64>),
}

/// A bookmark to read again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: i64,
    pub url: String,
}

const MISSING: &str = "(coalesce(image_url, '') = '' OR coalesce(site_name, '') = '')";

/// The bookmarks of `target` outside the trash, newest first; selected ones
/// in the order given.
pub fn select(conn: &Connection, target: &Target) -> Result<Vec<Item>> {
    let row = |r: &rusqlite::Row| Ok(Item { id: r.get(0)?, url: r.get(1)? });
    match target {
        Target::Scope(scope) => {
            let filter = match scope {
                Scope::Missing => MISSING,
                Scope::All => "1",
            };
            conn.prepare(&format!("SELECT id, url FROM bookmarks WHERE deleted_at IS NULL AND {filter} ORDER BY id DESC"))?
                .query_map([], row)?
                .collect()
        }
        Target::Ids(ids) => {
            let mut seen = HashSet::new();
            let ids: Vec<i64> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
            conn.prepare(
                "SELECT b.id, b.url FROM json_each(?1) j JOIN bookmarks b ON b.id = j.value
                 WHERE b.deleted_at IS NULL ORDER BY j.key",
            )?
            .query_map(params![db::id_list(&ids)?], row)?
            .collect()
        }
    }
}

/// The counts the choice in Settings shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "PreviewCounts")]
pub struct Counts {
    /// Without a picture or site name.
    pub missing: u32,
    /// Every bookmark outside the trash.
    pub all: u32,
}

pub fn counts(conn: &Connection) -> Result<Counts> {
    conn.query_row(
        &format!("SELECT count(*), coalesce(sum({MISSING}), 0) FROM bookmarks WHERE deleted_at IS NULL"),
        [],
        |r| Ok(Counts { all: r.get(0)?, missing: r.get(1)? }),
    )
}

/// What the preview shows: the fields a refresh may change.
fn preview(b: &Bookmark) -> (&str, Option<&str>, Option<&str>, Option<&str>, Option<&str>) {
    (&b.title, b.description.as_deref(), b.image_url.as_deref(), b.favicon_url.as_deref(), b.site_name.as_deref())
}

/// Writes what the page gave, as the bookmark's «Обновить превью» does. The
/// bookmark when something changed; none when nothing did — then nothing is
/// written, its revision stays — or when it is in the trash or gone, or no
/// longer at `url`, the address the page was read from.
pub fn apply(conn: &Connection, id: i64, url: &str, meta: &PageMetadata) -> Result<Option<Bookmark>> {
    let before = match db::get_bookmark_by_id(conn, id) {
        Ok(b) if b.deleted_at.is_none() => b,
        Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e),
    };
    let tx = conn.unchecked_transaction()?;
    let after = db::refresh_preview(&tx, id, url, meta)?;
    if preview(&after) == preview(&before) {
        // Dropped: rolled back, the revision and the time stay.
        return Ok(None);
    }
    tx.commit()?;
    Ok(Some(after))
}

/// How one bookmark went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Done {
    /// Its picture, icon, site name, title or description changed.
    Updated,
    /// Read, nothing new; or on a local address, not requested.
    Unchanged,
    /// The page answered with an error, or not with a page.
    Failed,
    /// No connection or no answer in time.
    Network,
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum End {
    Done,
    /// «Остановить»: the pages under way finished first.
    Stopped,
    /// The connection is down.
    Offline,
}

/// What the run has done so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub done: u32,
    pub total: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub failed: u32,
}

pub struct Limits {
    /// Pages read at once; one site never has two.
    pub parallel: usize,
    /// Network failures in a row, on this many sites at least, that make the
    /// connection suspect.
    pub offline_after: usize,
    pub offline_sites: usize,
}

impl Limits {
    pub const APP: Limits = Limits { parallel: 3, offline_after: 5, offline_sites: 3 };
}

/// The site a bookmark's page is on: its pages are read one at a time.
fn site(item: &Item) -> String {
    url::Url::parse(item.url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase()))
        .unwrap_or_else(|| format!("#{}", item.id))
}

/// Bookmarks waiting by site, and the sites free to start, in turn.
#[derive(Default)]
struct Queue {
    waiting: HashMap<String, VecDeque<Item>>,
    ready: VecDeque<String>,
    /// Every bookmark the run was given: one added again is not read twice.
    seen: HashSet<i64>,
}

impl Queue {
    /// Adds what is new; how many were.
    fn add(&mut self, items: Vec<Item>) -> u32 {
        let mut added = 0;
        for item in items {
            if !self.seen.insert(item.id) {
                continue;
            }
            added += 1;
            let site = site(&item);
            let queue = self.waiting.entry(site.clone()).or_default();
            if queue.is_empty() {
                self.ready.push_back(site);
            }
            queue.push_back(item);
        }
        added
    }
}

/// How a run ended, and the bookmarks whose pages could not be opened: the
/// link check looks at them next. None after «no network».
pub struct Ended {
    pub end: End,
    pub failed: Vec<i64>,
}

/// Reads `items` again with `work`, a few at once and one per site, and
/// tells `progress` after each. Bookmarks sent to `more` join the run (an
/// import while one is under way); ones it has already are skipped. When
/// the connection looks down, `online` is asked with the address of a page
/// that opened in this run; with none, or when that page does not open
/// either, the run ends [`End::Offline`]. After `stop` turns true no page
/// starts; the ones under way finish.
pub async fn run<W, WF, O, OF>(
    items: Vec<Item>,
    limits: &Limits,
    work: W,
    online: O,
    mut stop: watch::Receiver<bool>,
    more: &mut Option<mpsc::UnboundedReceiver<Vec<Item>>>,
    mut progress: impl FnMut(&Tally),
) -> Ended
where
    W: Fn(Item) -> WF,
    WF: Future<Output = Done> + Send + 'static,
    O: Fn(String) -> OF,
    OF: Future<Output = bool>,
{
    let mut queue = Queue::default();
    let mut tally = Tally { total: queue.add(items), ..Tally::default() };
    let mut flight: JoinSet<(i64, String, String, Done)> = JoinSet::new();
    let mut end: Option<End> = None;
    // The sender is gone: nobody can stop the run any more.
    let mut unstoppable = false;
    let mut failed: Vec<i64> = Vec::new();
    // Network failures in a row, their sites, and a page that opened.
    let mut streak = 0u32;
    let mut streak_sites: HashSet<String> = HashSet::new();
    let mut witness: Option<String> = None;
    loop {
        if end.is_none() && *stop.borrow() {
            end = Some(End::Stopped);
        }
        if end.is_none() {
            // What was added meanwhile.
            while let Some(items) = more.as_mut().and_then(|m| m.try_recv().ok()) {
                let added = queue.add(items);
                if added > 0 {
                    tally.total += added;
                    progress(&tally);
                }
            }
            while flight.len() < limits.parallel {
                let Some(site) = queue.ready.pop_front() else { break };
                let Some(item) = queue.waiting.get_mut(&site).and_then(VecDeque::pop_front) else { continue };
                let (id, url) = (item.id, item.url.clone());
                let job = work(item);
                flight.spawn(async move { (id, site, url, job.await) });
            }
        }
        if flight.is_empty() {
            return Ended { end: end.unwrap_or(End::Done), failed };
        }
        let joined = tokio::select! {
            joined = flight.join_next() => joined,
            stopped = stop.wait_for(|stopped| *stopped), if end.is_none() && !unstoppable => {
                unstoppable = stopped.is_err();
                continue;
            }
            items = async { more.as_mut().expect("guarded").recv().await }, if end.is_none() && more.is_some() => {
                match items {
                    Some(items) => {
                        let added = queue.add(items);
                        if added > 0 {
                            tally.total += added;
                            progress(&tally);
                        }
                    }
                    None => *more = None,
                }
                continue;
            }
        };
        let Some(Ok((id, site, url, done))) = joined else { continue };
        if queue.waiting.get(&site).is_some_and(|q| !q.is_empty()) {
            queue.ready.push_back(site.clone());
        }
        tally.done += 1;
        match done {
            Done::Updated => tally.updated += 1,
            Done::Unchanged => tally.unchanged += 1,
            Done::Failed | Done::Network => {
                tally.failed += 1;
                failed.push(id);
            }
        }
        if done == Done::Network {
            streak += 1;
            streak_sites.insert(site);
        } else {
            streak = 0;
            streak_sites.clear();
            if matches!(done, Done::Updated | Done::Unchanged) && url.starts_with("http") {
                witness = Some(url);
            }
        }
        if end.is_none() && streak as usize >= limits.offline_after && streak_sites.len() >= limits.offline_sites {
            let alive = match &witness {
                Some(url) => online(url.clone()).await,
                None => false,
            };
            if !alive {
                // The pages under way say nothing new, and the streak was
                // the connection, not the sites.
                flight.abort_all();
                tally.failed -= streak;
                progress(&tally);
                return Ended { end: End::Offline, failed: Vec::new() };
            }
            streak = 0;
            streak_sites.clear();
        }
        progress(&tally);
    }
}

// ---- The run in the app.

/// Where the run of this session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "PreviewRefreshState")]
pub enum RunState {
    /// No run in this session.
    Idle,
    Running,
    /// Every bookmark was read.
    Done,
    /// «Остановить».
    Stopped,
    /// The connection went down.
    Offline,
}

/// Payload of `preview-refresh` and the answer of the commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PreviewRefresh {
    /// When the run began: the notification tells runs apart by it. None while idle.
    pub started_at: Option<String>,
    pub state: RunState,
    pub done: u32,
    pub total: u32,
    pub updated: u32,
    pub unchanged: u32,
    /// Pages that could not be opened.
    pub failed: u32,
    /// Once it is done: the bookmarks it could not open, handed to the link
    /// check (NP-036), which tells a dead page from a bad moment.
    pub check_ids: Vec<i64>,
}

impl PreviewRefresh {
    fn idle() -> PreviewRefresh {
        PreviewRefresh { started_at: None, state: RunState::Idle, done: 0, total: 0, updated: 0, unchanged: 0, failed: 0, check_ids: Vec::new() }
    }

    fn with(&self, tally: &Tally) -> PreviewRefresh {
        PreviewRefresh {
            done: tally.done,
            total: tally.total,
            updated: tally.updated,
            unchanged: tally.unchanged,
            failed: tally.failed,
            ..self.clone()
        }
    }
}

/// The run under way: its stop, and the way in for bookmarks an import adds.
struct Running {
    stop: watch::Sender<bool>,
    more: mpsc::UnboundedSender<Vec<Item>>,
}

/// The run under way, at most one (managed by Tauri).
pub struct Refresher {
    running: Mutex<Option<Running>>,
    last: Mutex<PreviewRefresh>,
    /// The library was replaced: the bookmarks of the run belong to the old one.
    abandoned: AtomicBool,
}

impl Default for Refresher {
    fn default() -> Self {
        Refresher { running: Mutex::new(None), last: Mutex::new(PreviewRefresh::idle()), abandoned: AtomicBool::new(false) }
    }
}

impl Refresher {
    pub fn state(&self) -> PreviewRefresh {
        self.last.lock().map(|l| l.clone()).unwrap_or_else(|_| PreviewRefresh::idle())
    }

    /// «Остановить»: no page starts; the ones under way finish.
    pub fn stop(&self) {
        if let Ok(running) = self.running.lock() {
            if let Some(running) = running.as_ref() {
                let _ = running.stop.send(true);
            }
        }
    }

    /// The library was just replaced; the caller holds its connection. The
    /// run writes nothing more and is forgotten.
    pub fn abandon(&self) {
        self.abandoned.store(true, Ordering::SeqCst);
        self.stop();
        if let Ok(mut last) = self.last.lock() {
            *last = PreviewRefresh::idle();
        }
    }

    fn remember(&self, progress: &PreviewRefresh) {
        if let Ok(mut last) = self.last.lock() {
            *last = progress.clone();
        }
    }
}

fn emit(app: &AppHandle, progress: &PreviewRefresh) {
    let _ = app.emit("preview-refresh", progress);
}

/// Reads one bookmark's page and writes what it gave.
async fn refresh_one(app: AppHandle, state: Arc<DbState>, item: Item) -> Done {
    let (meta, reading) = metadata::fetch_metadata_read(&item.url).await;
    match reading {
        Reading::Read => {}
        Reading::Local => return Done::Unchanged,
        Reading::NoPage | Reading::Failed(FetchError::Refused) => return Done::Failed,
        Reading::Failed(_) => return Done::Network,
    }
    let written = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().map_err(|_| ())?;
        // Checked under the lock: a library replaced meanwhile gets nothing.
        if app.state::<Refresher>().abandoned.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let changed = apply(&conn, item.id, &item.url, &meta).map_err(|_| ())?;
        if let Some(bookmark) = &changed {
            capture::emit(&app, ChangeKind::Updated, bookmark);
        }
        Ok::<_, ()>(changed)
    })
    .await;
    match written {
        Ok(Ok(Some(_))) => Done::Updated,
        Ok(Ok(None)) => Done::Unchanged,
        _ => Done::Failed,
    }
}

/// Starts a run in the background and returns its state. While one runs,
/// returns that one's state; with `append` (an import's new bookmarks) the
/// bookmarks of `target` join it first. Reports through `preview-refresh`.
pub fn start(app: AppHandle, state: Arc<DbState>, target: Target, append: bool) -> std::result::Result<PreviewRefresh, String> {
    let refresher = app.state::<Refresher>();
    let (stop, stopped) = watch::channel(false);
    let (more, more_rx) = mpsc::unbounded_channel();
    {
        let mut running = refresher.running.lock().map_err(|e| e.to_string())?;
        if let Some(under_way) = running.as_ref() {
            if append {
                let items = state.conn.lock().map_err(|e| e.to_string()).and_then(|conn| select(&conn, &target).map_err(|e| e.to_string()))?;
                let _ = under_way.more.send(items);
            }
            return Ok(refresher.state());
        }
        *running = Some(Running { stop, more });
        refresher.abandoned.store(false, Ordering::SeqCst);
    }
    let items = match state.conn.lock().map_err(|e| e.to_string()).and_then(|conn| select(&conn, &target).map_err(|e| e.to_string())) {
        Ok(items) => items,
        Err(error) => {
            if let Ok(mut running) = refresher.running.lock() {
                *running = None;
            }
            return Err(error);
        }
    };
    let first = PreviewRefresh {
        started_at: Some(db::now()),
        state: RunState::Running,
        total: items.len() as u32,
        ..PreviewRefresh::idle()
    };
    refresher.remember(&first);
    emit(&app, &first);
    let handle = app.clone();
    let base = first.clone();
    tauri::async_runtime::spawn(async move {
        let refresher = handle.state::<Refresher>();
        let work = |item: Item| refresh_one(handle.clone(), state.clone(), item);
        let online = |url: String| async move { !metadata::fetch_metadata_read(&url).await.1.network() };
        let mut last = Tally { total: base.total, ..Tally::default() };
        let mut more_rx = Some(more_rx);
        let ended = run(items, &Limits::APP, work, online, stopped, &mut more_rx, |tally| {
            last = *tally;
            let now = base.with(tally);
            if !refresher.abandoned.load(Ordering::SeqCst) {
                refresher.remember(&now);
                emit(&handle, &now);
            }
        })
        .await;
        // Bookmarks an import added as the run ended get a run of their own.
        let mut late: Vec<i64> = Vec::new();
        if let Ok(mut running) = refresher.running.lock() {
            *running = None;
            while let Some(items) = more_rx.as_mut().and_then(|m| m.try_recv().ok()) {
                late.extend(items.iter().map(|i| i.id));
            }
        };
        let abandoned = refresher.abandoned.load(Ordering::SeqCst);
        let check_ids = if ended.end == End::Done && !abandoned { ended.failed } else { Vec::new() };
        let finished = PreviewRefresh {
            state: match ended.end {
                End::Done => RunState::Done,
                End::Stopped => RunState::Stopped,
                End::Offline => RunState::Offline,
            },
            check_ids: check_ids.clone(),
            ..base.with(&last)
        };
        if !abandoned {
            refresher.remember(&finished);
            emit(&handle, &finished);
        }
        if !check_ids.is_empty() {
            check_later(handle.clone(), state.clone(), check_ids);
        }
        if !late.is_empty() && !abandoned {
            let _ = start(handle.clone(), state, Target::Ids(late), true);
        }
    });
    Ok(first)
}

/// Pages the run could not open go to the link check, which tries them
/// again by its own rules and shows the dead ones on its page. It has no
/// way to take more links while it runs: these wait until it ends.
fn check_later(app: AppHandle, state: Arc<DbState>, ids: Vec<i64>) {
    tauri::async_runtime::spawn(async move {
        while app.state::<crate::linkcheck::Checker>().running() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || crate::linkcheck::start(app, state, Some(ids), false)).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_or_update_bookmark, trash_bookmark, Source};
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn saved(conn: &Connection, url: &str, image: Option<&str>, site: Option<&str>) -> Bookmark {
        let b = insert_or_update_bookmark(conn, url, url, None, image, None, &metadata::extract_domain(url), None, None, Source::Chrome).unwrap();
        conn.execute("UPDATE bookmarks SET site_name = ?1 WHERE id = ?2", params![site, b.id]).unwrap();
        db::get_bookmark_by_id(conn, b.id).unwrap()
    }

    fn ids(items: &[Item]) -> Vec<i64> {
        items.iter().map(|i| i.id).collect()
    }

    #[test]
    fn the_scope_chooses_the_bookmarks_and_never_the_trash() {
        let conn = library();
        let whole = saved(&conn, "https://a.example/1", Some("https://a.example/i.png"), Some("A"));
        let no_picture = saved(&conn, "https://b.example/1", None, Some("B"));
        let no_name = saved(&conn, "https://c.example/1", Some("https://c.example/i.png"), Some(""));
        let trashed = saved(&conn, "https://d.example/1", None, None);
        trash_bookmark(&conn, trashed.id).unwrap();

        assert_eq!(ids(&select(&conn, &Target::Scope(Scope::Missing)).unwrap()), vec![no_name.id, no_picture.id]);
        assert_eq!(ids(&select(&conn, &Target::Scope(Scope::All)).unwrap()), vec![no_name.id, no_picture.id, whole.id]);
        assert_eq!(
            ids(&select(&conn, &Target::Ids(vec![whole.id, trashed.id, no_name.id, whole.id, 9999])).unwrap()),
            vec![whole.id, no_name.id],
            "the selected ones in their order, once, without the trash or the missing"
        );
        assert_eq!(counts(&conn).unwrap(), Counts { missing: 2, all: 3 });
    }

    #[test]
    fn only_a_change_is_written() {
        let conn = library();
        let b = saved(&conn, "https://a.example/1", None, None);
        let meta = PageMetadata { image_url: Some("https://a.example/i.png".into()), site_name: Some("A".into()), ..Default::default() };
        let changed = apply(&conn, b.id, &b.url, &meta).unwrap().expect("a picture and a name are new");
        assert_eq!(changed.image_url.as_deref(), Some("https://a.example/i.png"));
        assert_eq!(changed.site_name.as_deref(), Some("A"));
        assert_eq!(changed.revision, b.revision + 1);
        assert!(apply(&conn, b.id, &b.url, &meta).unwrap().is_none(), "the same page again changes nothing");
        assert_eq!(db::get_bookmark_by_id(&conn, b.id).unwrap().revision, changed.revision, "and keeps the revision");
        trash_bookmark(&conn, b.id).unwrap();
        let other = PageMetadata { image_url: Some("https://a.example/new.png".into()), ..Default::default() };
        assert!(apply(&conn, b.id, &b.url, &other).unwrap().is_none(), "the trash is not touched");
    }

    fn items(urls: &[&str]) -> Vec<Item> {
        urls.iter().enumerate().map(|(i, url)| Item { id: i as i64, url: url.to_string() }).collect()
    }

    async fn never(_: String) -> bool {
        false
    }

    #[tokio::test]
    async fn three_pages_at_once_and_one_per_site() {
        let urls: Vec<String> = (0..24).map(|i| format!("https://site{}.example/{i}", i % 4)).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let active: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let (most, most_per_site) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let work = |item: Item| {
            let (active, most, most_per_site) = (active.clone(), most.clone(), most_per_site.clone());
            async move {
                let host = site(&item);
                {
                    let mut active = active.lock().unwrap();
                    *active.entry(host.clone()).or_default() += 1;
                    most.fetch_max(active.values().sum(), Ordering::SeqCst);
                    most_per_site.fetch_max(active[&host], Ordering::SeqCst);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
                *active.lock().unwrap().get_mut(&host).unwrap() -= 1;
                Done::Updated
            }
        };
        let (_stop, stopped) = watch::channel(false);
        let mut seen = Vec::new();
        let end = run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |t| seen.push(*t)).await.end;
        assert_eq!(end, End::Done);
        assert_eq!(most.load(Ordering::SeqCst), 3, "three at once");
        assert_eq!(most_per_site.load(Ordering::SeqCst), 1, "never two of one site");
        assert_eq!(seen.len(), 24, "progress after each bookmark");
        assert_eq!(*seen.last().unwrap(), Tally { done: 24, total: 24, updated: 24, unchanged: 0, failed: 0 });
    }

    #[tokio::test]
    async fn one_site_alone_goes_one_by_one() {
        let urls: Vec<String> = (0..5).map(|i| format!("https://www.one.example/{i}")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let (now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let work = |_item: Item| {
            let (now, most) = (now.clone(), most.clone());
            async move {
                most.fetch_max(now.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                now.fetch_sub(1, Ordering::SeqCst);
                Done::Unchanged
            }
        };
        let (_stop, stopped) = watch::channel(false);
        assert_eq!(run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |_| {}).await.end, End::Done);
        assert_eq!(most.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_lets_the_pages_under_way_finish() {
        let urls: Vec<String> = (0..30).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let (started, finished) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let work = |_item: Item| {
            let (started, finished) = (started.clone(), finished.clone());
            started.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                finished.fetch_add(1, Ordering::SeqCst);
                Done::Updated
            }
        };
        let (stop, stopped) = watch::channel(false);
        let mut last = Tally::default();
        let end = run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |t| {
            last = *t;
            if t.done == 4 {
                let _ = stop.send(true);
            }
        })
        .await
        .end;
        assert_eq!(end, End::Stopped);
        let (started, finished) = (started.load(Ordering::SeqCst), finished.load(Ordering::SeqCst));
        assert!(started < 10, "nothing starts after the stop: {started}");
        assert_eq!(started, finished, "the pages under way finished");
        assert_eq!(last.done as usize, finished, "and were counted");
        assert_eq!(last.total, 30);
    }

    #[tokio::test]
    async fn no_network_stops_the_run_and_marks_nothing_failed() {
        let urls: Vec<String> = (0..40).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let tried = Arc::new(AtomicUsize::new(0));
        let work = |item: Item| {
            let tried = tried.clone();
            async move {
                tried.fetch_add(1, Ordering::SeqCst);
                // The first page opens, then the connection goes.
                if item.id == 0 {
                    return Done::Updated;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
                Done::Network
            }
        };
        let asked = Arc::new(AtomicUsize::new(0));
        let online = |_url: String| {
            let asked = asked.clone();
            async move {
                asked.fetch_add(1, Ordering::SeqCst);
                false
            }
        };
        let (_stop, stopped) = watch::channel(false);
        let mut last = Tally::default();
        let end = run(items(&urls), &Limits::APP, work, online, stopped, &mut None, |t| last = *t).await.end;
        assert_eq!(end, End::Offline);
        assert_eq!(asked.load(Ordering::SeqCst), 1, "the page that opened was asked");
        assert!(tried.load(Ordering::SeqCst) < 12, "the run did not go through the library");
        assert_eq!((last.updated, last.failed), (1, 0));
    }

    #[tokio::test]
    async fn dead_sites_with_the_network_up_are_failures() {
        let urls: Vec<String> = (0..12).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let work = |item: Item| async move {
            if item.id == 0 {
                return Done::Unchanged;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
            Done::Network
        };
        let online = |url: String| async move {
            assert_eq!(url, "https://site0.example/");
            true
        };
        let (_stop, stopped) = watch::channel(false);
        let mut last = Tally::default();
        let end = run(items(&urls), &Limits::APP, work, online, stopped, &mut None, |t| last = *t).await.end;
        assert_eq!(end, End::Done);
        assert_eq!(last, Tally { done: 12, total: 12, updated: 0, unchanged: 1, failed: 11 });
    }

    #[tokio::test]
    async fn with_nothing_opened_a_run_of_network_failures_is_no_network() {
        let urls: Vec<String> = (0..20).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let work = |_item: Item| async move { Done::Network };
        let (_stop, stopped) = watch::channel(false);
        let mut last = Tally::default();
        assert_eq!(run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |t| last = *t).await.end, End::Offline);
        assert_eq!(last.failed, 0);
        assert!(last.done < 10);
    }

    #[tokio::test]
    async fn an_empty_run_is_done() {
        let (_stop, stopped) = watch::channel(false);
        let work = |_item: Item| async move { Done::Updated };
        assert_eq!(run(Vec::new(), &Limits::APP, work, never, stopped, &mut None, |_| {}).await.end, End::Done);
    }

    #[tokio::test]
    async fn bookmarks_added_while_it_runs_join_it_once() {
        let urls: Vec<String> = (0..6).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let all = items(&urls);
        let read: Arc<Mutex<Vec<i64>>> = Arc::default();
        let work = |item: Item| {
            let read = read.clone();
            async move {
                read.lock().unwrap().push(item.id);
                tokio::time::sleep(Duration::from_millis(5)).await;
                Done::Updated
            }
        };
        let (_stop, stopped) = watch::channel(false);
        let (more, rx) = mpsc::unbounded_channel();
        // An import adds two new ones and one the run has already.
        more.send(vec![all[4].clone(), all[5].clone(), all[0].clone()]).unwrap();
        let mut rx = Some(rx);
        let mut last = Tally::default();
        let ended = run(all[..4].to_vec(), &Limits::APP, work, never, stopped, &mut rx, |t| last = *t).await;
        assert_eq!(ended.end, End::Done);
        let mut read = read.lock().unwrap().clone();
        read.sort();
        assert_eq!(read, vec![0, 1, 2, 3, 4, 5], "each read once");
        assert_eq!((last.done, last.total), (6, 6));
    }

    #[tokio::test]
    async fn the_pages_it_could_not_open_go_to_the_link_check() {
        let urls: Vec<String> = (0..8).map(|i| format!("https://site{i}.example/")).collect();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let work = |item: Item| async move {
            match item.id {
                2 | 5 => Done::Failed,
                6 => Done::Network,
                _ => Done::Unchanged,
            }
        };
        let (_stop, stopped) = watch::channel(false);
        let ended = run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |_| {}).await;
        let mut failed = ended.failed;
        failed.sort();
        assert_eq!((ended.end, failed), (End::Done, vec![2, 5, 6]));

        let work = |_item: Item| async move { Done::Network };
        let (_stop, stopped) = watch::channel(false);
        let ended = run(items(&urls), &Limits::APP, work, never, stopped, &mut None, |_| {}).await;
        assert_eq!((ended.end, ended.failed), (End::Offline, vec![]), "no network checks nothing");
    }
}
