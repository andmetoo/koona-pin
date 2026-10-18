//! The refresh loop (NP-129, plan §4.4–4.5): ticks, intervals, backoff, the
//! offline tick, and `feeds-refresh`.
//!
//! The first pass comes 30 s after the start, then a tick every 5 minutes
//! fetches the feeds that are due. When a feed is next due is decided by the
//! pure functions at the top, over a clock they are given; the loop below
//! only reads the clock and does what they say.
//!
//! Each fetch writes the fetch state columns of `feed_state` itself (the
//! validators, times, failures, `last_error`, `moved_to`); the document goes
//! to [`cache::store_fetch`], then, for a feed that sorts into the Inbox, to
//! [`save::after_fetch_in_app`]. Locks: the library, then the cache, never both
//! across a network wait.

use super::{
    cache::{self, FeedCache},
    fetch::{self, Failure, Fetch, Outcome},
    save, Feed, FeedDestination, FeedsRefresh,
};
use crate::{
    db::{self, DbState},
    error::CommandError,
    metadata::{Conditional, Limits},
};
use chrono::{DateTime, TimeDelta, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

/// Not in the way of the start: the library opens and the window shows first.
pub const FIRST_PASS: Duration = Duration::from_secs(30);
/// How often due feeds are looked for.
pub const TICK: TimeDelta = TimeDelta::minutes(5);
/// How often the wall clock is looked at: a sleeping computer does not move a
/// timer forward, the wall clock does.
const LOOK: Duration = Duration::from_secs(30);
/// A tick this long after the last look is a wake from sleep.
pub const WAKE_GAP: TimeDelta = TimeDelta::minutes(15);
/// After a wake the network takes a moment to come back.
const WAKE_SETTLE: Duration = Duration::from_secs(10);
/// An offline tick tries again this soon, blaming no feed.
pub const OFFLINE_RETRY: TimeDelta = TimeDelta::minutes(5);
/// The longest wait between two fetches of a feed that is not failing.
pub const MAX_DELAY: TimeDelta = TimeDelta::hours(24);
/// A feed without a post this long is quiet: fetched at most every 12 hours.
pub const QUIET_AFTER: TimeDelta = TimeDelta::days(30);
pub const QUIET_INTERVAL: TimeDelta = TimeDelta::hours(12);
/// Failing this long, a feed shows «not updating» and is tried once a day.
pub const FAILING_AFTER: TimeDelta = TimeDelta::days(7);
/// ±10 %, so feeds added together do not stay in step.
const JITTER: f64 = 0.10;
/// Fetches at once, overall; one per host, this far apart. A phone fetches two at a time
/// (NP-151): its radio and memory are shared with everything else on it.
const PARALLEL: usize = if cfg!(mobile) { 2 } else { 4 };
const HOST_SPACING: Duration = Duration::from_secs(1);
/// «Only when I refresh» still counts its backoff from an hour.
const MANUAL_BASE_MINUTES: u32 = super::DEFAULT_REFRESH_MINUTES;

// --- What is due, and when next: pure, over a given clock (NP-129). ---

/// A feed's fetch state as `feed_state` has it; none before its first fetch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchState {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub succeeded_at: Option<DateTime<Utc>>,
    pub next_fetch_at: Option<DateTime<Utc>>,
    pub failures: u32,
    pub failing_since: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    /// The feed's `<ttl>` from its last document, for the 304s after it.
    pub ttl_minutes: Option<u32>,
    /// Its `Cache-Control: max-age` from the last answer, in seconds.
    pub max_age_secs: Option<u64>,
}

impl FetchState {
    fn gone(&self) -> bool {
        self.last_error.as_deref() == Some("gone")
    }

    /// The site asked for a pause (`Retry-After`) that has not passed.
    fn paused(&self, now: DateTime<Utc>) -> bool {
        matches!(self.last_error.as_deref(), Some("status:429" | "status:503"))
            && self.next_fetch_at.is_some_and(|next| next > now)
    }
}

/// Why a refresh runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// The loop: only what is due.
    Tick,
    /// ↻ and ⌘R: one feed or all of them now, but never against a site's
    /// `Retry-After`; an ended feed only when it is the one asked for.
    Now { feed_uid: Option<String> },
}

/// Whether a feed is fetched in this run. `interval` is the setting in
/// minutes, 0 for «Only when I refresh».
pub fn is_due(state: Option<&FetchState>, now: DateTime<Utc>, interval: u32, mode: &Mode, uid: &str) -> bool {
    match mode {
        Mode::Now { feed_uid } => {
            let asked = feed_uid.as_deref().is_none_or(|one| one == uid);
            let state = state.cloned().unwrap_or_default();
            asked && !state.paused(now) && (!state.gone() || feed_uid.is_some())
        }
        Mode::Tick => match state {
            // Never fetched: the first fetch of a new subscription, whatever the interval.
            None => true,
            Some(state) if state.gone() => false,
            // «Only when I refresh»: the first fetch is the one the loop makes. A feed
            // that answered once, even with an error, waits for ↻; one never reached
            // (offline) is tried again.
            Some(state) if interval == 0 && (state.succeeded_at.is_some() || state.fetched_at.is_some()) => false,
            Some(state) => state.next_fetch_at.is_none_or(|next| next <= now),
        },
    }
}

/// `jitter` in [-1, 1] stretches or shortens `delay` by up to 10 %.
fn jittered(delay: TimeDelta, jitter: f64) -> TimeDelta {
    let factor = 1.0 + JITTER * jitter.clamp(-1.0, 1.0);
    TimeDelta::milliseconds((delay.num_milliseconds() as f64 * factor) as i64)
}

fn base_interval(interval: u32) -> TimeDelta {
    TimeDelta::minutes(i64::from(if interval == 0 { MANUAL_BASE_MINUTES } else { interval }))
}

/// After a fetch that worked: `max(interval, ttl or max-age up to a day)`,
/// at least 12 hours for a quiet feed, ± jitter.
pub fn next_after_success(
    now: DateTime<Utc>,
    interval: u32,
    ttl_minutes: Option<u32>,
    max_age_secs: Option<u64>,
    last_post: Option<DateTime<Utc>>,
    jitter: f64,
) -> DateTime<Utc> {
    let mut delay = base_interval(interval);
    let asked = [
        ttl_minutes.map(|m| TimeDelta::minutes(i64::from(m))),
        max_age_secs.map(|s| TimeDelta::seconds(s.min(fetch::MAX_WAIT_SECS) as i64)),
    ];
    for wait in asked.into_iter().flatten() {
        delay = delay.max(wait.min(MAX_DELAY));
    }
    if last_post.is_some_and(|post| now - post > QUIET_AFTER) {
        delay = delay.max(QUIET_INTERVAL);
    }
    now + jittered(delay, jitter)
}

/// After a failure, with `failures` counting this one: `interval × 2^failures`
/// up to a day, and a day once the feed has failed for 7 days.
pub fn next_after_failure(
    now: DateTime<Utc>,
    interval: u32,
    failures: u32,
    failing_since: Option<DateTime<Utc>>,
    jitter: f64,
) -> DateTime<Utc> {
    if failing_since.is_some_and(|since| now - since >= FAILING_AFTER) {
        return now + jittered(MAX_DELAY, jitter);
    }
    let factor = 1i64 << failures.min(16);
    let delay = base_interval(interval).checked_mul(factor as i32).unwrap_or(MAX_DELAY).min(MAX_DELAY);
    now + jittered(delay, jitter)
}

/// After `Retry-After`: what the site asked, but no sooner than the interval.
pub fn next_after_pause(now: DateTime<Utc>, interval: u32, seconds: u64, jitter: f64) -> DateTime<Utc> {
    let asked = TimeDelta::seconds(seconds.min(fetch::MAX_WAIT_SECS) as i64);
    now + asked.max(jittered(base_interval(interval), jitter))
}

/// A tick that tried at least two hosts and got no answer from any (each
/// fetch, `(host, failure)`, failed below HTTP): the computer is offline, not
/// the feeds broken (plan §4.5). One host alone is no evidence: a dead
/// domain fails like any feed and backs off to «not updating» (NP-129).
pub fn tick_offline(attempts: &[(String, Option<Failure>)]) -> bool {
    let hosts: std::collections::HashSet<&str> = attempts.iter().map(|(host, _)| host.as_str()).collect();
    hosts.len() >= 2 && attempts.iter().all(|(_, f)| f.is_some_and(Failure::is_connection))
}

/// A look at the clock this long after the one before: the computer slept.
pub fn is_wake(last_look: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - last_look > WAKE_GAP
}

/// A tick is due 5 minutes after the last one.
pub fn tick_due(last_tick: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    last_tick.is_none_or(|last| now - last >= TICK)
}

/// Three fetches in a row landing on the same new address make it «moved»
/// (plan §4.3): what the count becomes, and the `moved_to` to store.
pub fn track_move(seen: Option<(String, u8)>, moved: Option<&str>) -> (Option<(String, u8)>, Option<String>) {
    let Some(moved) = moved else {
        return (None, None);
    };
    let count = match seen {
        Some((url, count)) if url == moved => count.saturating_add(1),
        _ => 1,
    };
    (Some((moved.to_string(), count)), (count >= 3).then(|| moved.to_string()))
}

/// A number in [-1, 1] for the jitter.
fn jitter() -> f64 {
    (uuid::Uuid::new_v4().as_u128() % 2001) as f64 / 1000.0 - 1.0
}

// --- The fetch state in `feeds.db` (the columns NP-129 owns). ---

fn time(raw: Option<String>) -> Option<DateTime<Utc>> {
    raw.and_then(|t| DateTime::parse_from_rfc3339(&t).ok()).map(|t| t.with_timezone(&Utc))
}

pub fn states(conn: &Connection) -> rusqlite::Result<HashMap<String, FetchState>> {
    conn.prepare(
        "SELECT feed_uid, etag, last_modified, fetched_at, succeeded_at, next_fetch_at, failures, failing_since, last_error,
            ttl_minutes, max_age_secs
         FROM feed_state",
    )?
    .query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            FetchState {
                etag: r.get(1)?,
                last_modified: r.get(2)?,
                fetched_at: time(r.get(3)?),
                succeeded_at: time(r.get(4)?),
                next_fetch_at: time(r.get(5)?),
                failures: r.get(6)?,
                failing_since: time(r.get(7)?),
                last_error: r.get(8)?,
                ttl_minutes: r.get(9)?,
                max_age_secs: r.get(10)?,
            },
        ))
    })?
    .collect()
}

/// A fetch that got the document or a 304.
fn write_success(
    conn: &Connection,
    uid: &str,
    validators: &Conditional,
    now: DateTime<Utc>,
    next: DateTime<Utc>,
    moved_to: Option<&str>,
    ttl: Option<Option<u32>>,
    max_age: Option<u64>,
) -> rusqlite::Result<()> {
    let now = db::stamp(now);
    // `ttl`: a document's own (possibly none), or `None` for a 304, which keeps the last.
    // `max_age` comes with every answer, a 304 too: this one's.
    let (write_ttl, ttl) = (ttl.is_some(), ttl.flatten());
    conn.execute(
        "INSERT INTO feed_state (feed_uid, etag, last_modified, fetched_at, succeeded_at, next_fetch_at, failures, failing_since, last_error, moved_to, ttl_minutes, max_age_secs)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, 0, NULL, NULL, ?6, ?7, ?9)
         ON CONFLICT (feed_uid) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
             fetched_at = excluded.fetched_at, succeeded_at = excluded.succeeded_at, next_fetch_at = excluded.next_fetch_at,
             failures = 0, failing_since = NULL, last_error = NULL, moved_to = excluded.moved_to,
             ttl_minutes = CASE WHEN ?8 THEN excluded.ttl_minutes ELSE ttl_minutes END,
             max_age_secs = excluded.max_age_secs",
        params![uid, validators.etag, validators.last_modified, now, db::stamp(next), moved_to, ttl, write_ttl, max_age.map(|s| s as i64)],
    )?;
    Ok(())
}

/// A fetch that failed, the site's pause included; `failures` counts this one.
fn write_failure(
    conn: &Connection,
    uid: &str,
    reason: &str,
    now: DateTime<Utc>,
    next: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let now = db::stamp(now);
    conn.execute(
        "INSERT INTO feed_state (feed_uid, fetched_at, next_fetch_at, failures, failing_since, last_error)
         VALUES (?1, ?2, ?3, 1, ?2, ?4)
         ON CONFLICT (feed_uid) DO UPDATE SET fetched_at = excluded.fetched_at, next_fetch_at = excluded.next_fetch_at,
             failures = failures + 1, failing_since = COALESCE(failing_since, excluded.failing_since), last_error = excluded.last_error",
        params![uid, now, db::stamp(next), reason],
    )?;
    Ok(())
}

/// 410: fetched no more, until the person refreshes this one feed.
fn write_gone(conn: &Connection, uid: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO feed_state (feed_uid, fetched_at, next_fetch_at, last_error) VALUES (?1, ?2, NULL, 'gone')
         ON CONFLICT (feed_uid) DO UPDATE SET fetched_at = excluded.fetched_at, next_fetch_at = NULL, last_error = 'gone'",
        params![uid, db::stamp(now)],
    )?;
    Ok(())
}

/// No connection at all this tick: the feed is not blamed, its count stays.
fn write_offline(conn: &Connection, uid: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO feed_state (feed_uid, next_fetch_at, last_error) VALUES (?1, ?2, 'offline')
         ON CONFLICT (feed_uid) DO UPDATE SET next_fetch_at = excluded.next_fetch_at, last_error = 'offline'",
        params![uid, db::stamp(now + OFFLINE_RETRY)],
    )?;
    Ok(())
}

/// The newest post the cache has of a feed: whether it is quiet, after a 304.
fn last_post(conn: &Connection, uid: &str) -> Option<DateTime<Utc>> {
    let newest: Option<String> = conn
        .query_row("SELECT max(published_at) FROM feed_items WHERE feed_uid = ?1", [uid], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .flatten();
    time(newest)
}

// --- A run: fetch what is due, store it, tell the interface. ---

/// One feed to fetch.
#[derive(Debug, Clone)]
pub struct Job {
    pub feed: Feed,
    pub state: Option<FetchState>,
}

/// The feeds a run fetches, from the library's subscriptions and the cache's state.
pub fn plan(feeds: Vec<Feed>, states: &HashMap<String, FetchState>, now: DateTime<Utc>, interval: u32, mode: &Mode) -> Vec<Job> {
    feeds
        .into_iter()
        .filter(|feed| is_due(states.get(&feed.uid), now, interval, mode, &feed.uid))
        .map(|feed| Job { state: states.get(&feed.uid).cloned(), feed })
        .collect()
}

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub total: u32,
    /// Every fetch found no connection.
    pub offline: bool,
    /// Posts new to the cache, over all feeds.
    pub new_posts: usize,
}

/// Where a run's three moves are counted (`track_move`): this run of the app only.
static MOVES: LazyLock<Mutex<HashMap<String, (String, u8)>>> = LazyLock::new(Mutex::default);
/// One run at a time: the loop's tick and ↻ do not fetch the same feed twice at once.
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn host_of(feed: &Feed) -> String {
    url::Url::parse(&feed.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

/// What a run does with a feed's new posts once stored: in the app,
/// `save::after_fetch_in_app`, which announces what it saved into the Inbox.
pub type Inbox = Arc<dyn Fn(&Arc<DbState>, &FeedCache, &Feed, &[i64]) -> Result<usize, CommandError> + Send + Sync>;

/// Fetches `jobs`, 4 at once and one per host 1 s apart, and stores each
/// answer as it comes. `progress(done, total)` after each.
pub async fn run(
    db: Arc<DbState>,
    cache: Arc<FeedCache>,
    jobs: Vec<Job>,
    interval: u32,
    limits: &'static Limits,
    inbox: Inbox,
    progress: impl Fn(u32, u32),
) -> Report {
    let total = jobs.len() as u32;
    let mut report = Report { total, ..Default::default() };
    if jobs.is_empty() {
        return report;
    }
    let mut by_host: HashMap<String, Vec<Job>> = HashMap::new();
    for job in jobs {
        by_host.entry(host_of(&job.feed)).or_default().push(job);
    }
    let permits = Arc::new(Semaphore::new(PARALLEL));
    let (sender, mut answers) = tokio::sync::mpsc::unbounded_channel::<(Job, Fetch)>();
    for (_, queue) in by_host {
        let (permits, sender) = (permits.clone(), sender.clone());
        tokio::spawn(async move {
            for (index, job) in queue.into_iter().enumerate() {
                if index > 0 {
                    tokio::time::sleep(HOST_SPACING).await;
                }
                let Ok(_permit) = permits.acquire().await else { return };
                let validators = job
                    .state
                    .as_ref()
                    .map(|s| Conditional { etag: s.etag.clone(), last_modified: s.last_modified.clone() })
                    .unwrap_or_default();
                let fetched = match url::Url::parse(&job.feed.url) {
                    Ok(url) => fetch::fetch_feed(&url, &validators, limits).await,
                    Err(_) => Fetch { outcome: Outcome::Failed(Failure::Refused), max_age: None, moved_to: None },
                };
                if sender.send((job, fetched)).is_err() {
                    return;
                }
            }
        });
    }
    drop(sender);

    let mut done = 0;
    let mut failures = Vec::new();
    // Connection failures wait for the end of the run: offline, or each to blame.
    let mut unreachable = Vec::new();
    while let Some((job, fetched)) = answers.recv().await {
        done += 1;
        let failure = match &fetched.outcome {
            Outcome::Failed(failure) => Some(*failure),
            _ => None,
        };
        failures.push((host_of(&job.feed), failure));
        if failure.is_some_and(Failure::is_connection) {
            unreachable.push((job, failure.unwrap_or(Failure::Connection)));
        } else {
            let (db, cache, inbox) = (db.clone(), cache.clone(), inbox.clone());
            let stored = tokio::task::spawn_blocking(move || store(&db, &cache, &inbox, &job, fetched, interval, Utc::now())).await;
            match stored {
                Ok(Ok(new)) => report.new_posts += new,
                Ok(Err(error)) => eprintln!("Storing a feed's fetch failed: {}", error.message),
                Err(_) => {}
            }
        }
        progress(done, total);
    }

    report.offline = tick_offline(&failures);
    let offline = report.offline;
    let written = tokio::task::spawn_blocking(move || -> rusqlite::Result<()> {
        let conn = cache.conn.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        let now = Utc::now();
        for (job, failure) in unreachable {
            if offline {
                write_offline(&conn, &job.feed.uid, now)?;
            } else {
                let state = job.state.unwrap_or_default();
                let since = state.failing_since.or(Some(now));
                let next = next_after_failure(now, interval, state.failures + 1, since, jitter());
                write_failure(&conn, &job.feed.uid, &failure.reason(), now, next)?;
            }
        }
        Ok(())
    })
    .await;
    if let Ok(Err(error)) = written {
        eprintln!("Storing the feeds' fetch state failed: {error}");
    }
    report
}

/// One answer into the cache: the document through NP-131's `store_fetch`,
/// the fetch state here, then the Inbox for a feed that sorts into it. How
/// many posts were new.
fn store(
    db: &Arc<DbState>,
    cache: &FeedCache,
    inbox: &Inbox,
    job: &Job,
    fetched: Fetch,
    interval: u32,
    now: DateTime<Utc>,
) -> Result<usize, CommandError> {
    let uid = job.feed.uid.as_str();
    let state = job.state.clone().unwrap_or_default();
    let moved_to = {
        let mut moves = MOVES.lock().map_err(|_| CommandError::internal("moves"))?;
        let (seen, moved_to) = track_move(moves.remove(uid), fetched.moved_to.as_deref());
        if let Some(seen) = seen {
            moves.insert(uid.to_string(), seen);
        }
        moved_to
    };
    let new_ids = {
        let conn = cache.conn.lock().map_err(|_| CommandError::internal("the feed cache lock"))?;
        match fetched.outcome {
            Outcome::Fetched { feed, validators } => {
                let stored = cache::store_fetch(&conn, uid, &feed, &db::stamp(now))?;
                let newest = feed
                    .items
                    .iter()
                    .filter_map(|item| time(item.published_at.clone()))
                    .max()
                    .or_else(|| last_post(&conn, uid));
                let next = next_after_success(now, interval, feed.ttl_minutes, fetched.max_age, newest, jitter());
                write_success(&conn, uid, &validators, now, next, moved_to.as_deref(), Some(feed.ttl_minutes), fetched.max_age)?;
                stored.new_ids
            }
            Outcome::NotModified { validators } => {
                // The feed asked for its `<ttl>` in the last document; a 304 keeps to it.
                let next = next_after_success(now, interval, state.ttl_minutes, fetched.max_age, last_post(&conn, uid), jitter());
                write_success(&conn, uid, &validators, now, next, moved_to.as_deref(), None, fetched.max_age)?;
                Vec::new()
            }
            Outcome::Gone => {
                write_gone(&conn, uid, now)?;
                Vec::new()
            }
            Outcome::RetryAfter { status, seconds } => {
                write_failure(&conn, uid, &Failure::Status(status).reason(), now, next_after_pause(now, interval, seconds, jitter()))?;
                Vec::new()
            }
            Outcome::Failed(failure) => {
                let since = state.failing_since.or(Some(now));
                let next = next_after_failure(now, interval, state.failures + 1, since, jitter());
                write_failure(&conn, uid, &failure.reason(), now, next)?;
                Vec::new()
            }
        }
    };
    // The cache's lock is let go first: `after_fetch` takes the library's, then the cache's.
    if job.feed.destination == FeedDestination::Inbox && !new_ids.is_empty() {
        inbox(db, cache, &job.feed, &new_ids)?;
    }
    Ok(new_ids.len())
}

/// The library's subscriptions and interval, and the cache's state: each lock
/// on its own, the library's first.
fn read_plan(db: &DbState, cache: &FeedCache, mode: &Mode, now: DateTime<Utc>) -> Result<(Vec<Job>, u32), CommandError> {
    let (feeds, interval) = {
        let conn = db.conn.lock().map_err(|_| CommandError::internal("the library lock"))?;
        (super::feeds(&conn)?, super::refresh_minutes(&conn))
    };
    let states = {
        let conn = cache.conn.lock().map_err(|_| CommandError::internal("the feed cache lock"))?;
        states(&conn)?
    };
    Ok((plan(feeds, &states, now, interval, mode), interval))
}

/// A run in the app: fetches what `mode` says, with `feeds-refresh` while it
/// goes and `feeds-changed` after. Without an open library there is nothing to do.
pub async fn refresh(app: &AppHandle, mode: Mode) -> Result<Report, CommandError> {
    let (Some(db), Some(cache)) = (app.try_state::<Arc<DbState>>(), app.try_state::<Arc<FeedCache>>()) else {
        return Ok(Report::default());
    };
    let (db, cache) = (db.inner().clone(), cache.inner().clone());
    let _running = RUNNING.lock().await;
    let (plan_db, plan_cache, plan_mode) = (db.clone(), cache.clone(), mode.clone());
    let (jobs, interval) = tokio::task::spawn_blocking(move || read_plan(&plan_db, &plan_cache, &plan_mode, Utc::now()))
        .await
        .map_err(CommandError::internal)??;
    // A tick with nothing due stays quiet; ↻ always answers.
    let tell = !jobs.is_empty() || matches!(mode, Mode::Now { .. });
    let total = jobs.len() as u32;
    let emit = |running: bool, done: u32| {
        if tell {
            let _ = app.emit(super::REFRESH_EVENT, FeedsRefresh { running, done, total });
        }
    };
    emit(true, 0);
    let saver = app.clone();
    let inbox: Inbox = Arc::new(move |db, cache, feed, new_ids| save::after_fetch_in_app(&saver, db, cache, feed, new_ids));
    let report = run(db.clone(), cache.clone(), jobs, interval, &Limits::FEED, inbox, |done, _| emit(done < total, done)).await;
    emit(false, total);
    if tell {
        if let Ok(Ok(list)) = tokio::task::spawn_blocking(move || feeds_with_state(&db, &cache)).await {
            super::emit_changed(app, list);
        }
    }
    Ok(report)
}

/// A fetch without waiting for the next tick (NP-129): a feed just followed or
/// moved (`Some`, fetched now), or what an import or sync brought (`None`: what
/// is due, which a feed never fetched always is). In the background.
pub fn fetch_soon(app: &AppHandle, feed_uid: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mode = match feed_uid {
            Some(uid) => Mode::Now { feed_uid: Some(uid) },
            None => Mode::Tick,
        };
        if let Err(error) = refresh(&app, mode).await {
            eprintln!("Fetching new feeds failed: {}", error.message);
        }
    });
}

/// A shorter interval takes effect now, not after each feed's old wait: a
/// feed due later than it would be with the new interval is due then, as
/// [`next_after_success`] would set it from now: its own `<ttl>` and the
/// quiet rule still count, each with its own jitter, so they don't all come
/// due at once. Failing and paused feeds keep their backoff. How many moved.
pub fn shorten_waits(conn: &Connection, now: DateTime<Utc>, interval: u32) -> rusqlite::Result<usize> {
    shorten_waits_with(conn, now, interval, jitter)
}

fn shorten_waits_with(conn: &Connection, now: DateTime<Utc>, interval: u32, mut jitter: impl FnMut() -> f64) -> rusqlite::Result<usize> {
    if interval == 0 {
        return Ok(0);
    }
    let waiting: Vec<(String, Option<String>, Option<u32>, Option<i64>)> = conn
        .prepare("SELECT feed_uid, next_fetch_at, ttl_minutes, max_age_secs FROM feed_state WHERE failures = 0 AND last_error IS NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // One commit for them all, not one per feed.
    let tx = conn.unchecked_transaction()?;
    let mut moved = 0;
    for (uid, next, ttl, max_age) in waiting {
        let Some(next) = time(next) else { continue };
        let max_age = max_age.and_then(|s| u64::try_from(s).ok());
        let sooner = next_after_success(now, interval, ttl, max_age, last_post(&tx, &uid), jitter());
        if sooner < next {
            tx.execute("UPDATE feed_state SET next_fetch_at = ?1 WHERE feed_uid = ?2", params![db::stamp(sooner), uid])?;
            moved += 1;
        }
    }
    tx.commit()?;
    Ok(moved)
}

/// Every subscription with the cache's counts and health (NP-131's
/// `merge_state`): the library read and let go, then the cache.
fn feeds_with_state(db: &DbState, cache: &FeedCache) -> Result<Vec<Feed>, CommandError> {
    let mut list = {
        let conn = db.conn.lock().map_err(|_| CommandError::internal("the library lock"))?;
        super::feeds(&conn)?
    };
    let conn = cache.conn.lock().map_err(|_| CommandError::internal("the feed cache lock"))?;
    cache::merge_state(&conn, &mut list, Utc::now())?;
    Ok(list)
}

/// The daily sweep of the cache (NP-131's `sweep`; the start's runs in
/// `cache::start`): the followed uids read and the library let go, then the cache.
fn sweep(app: &AppHandle) -> Result<(), CommandError> {
    let (Some(db), Some(cache)) = (app.try_state::<Arc<DbState>>(), app.try_state::<Arc<FeedCache>>()) else {
        return Ok(());
    };
    let known = {
        let conn = db.conn.lock().map_err(|_| CommandError::internal("the library lock"))?;
        cache::known_uids(&conn)?
    };
    let conn = cache.conn.lock().map_err(|_| CommandError::internal("the feed cache lock"))?;
    cache::sweep(&conn, &known, Utc::now())?;
    Ok(())
}

/// How often the cache is swept while the app runs.
const SWEEP_EVERY: TimeDelta = TimeDelta::hours(24);

/// Starts the loop; called once from `setup`. It waits for the library.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let mut foreground = crate::lifecycle::foreground(&app);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_PASS).await;
        let mut last_tick: Option<DateTime<Utc>> = None;
        let mut last_look = Utc::now();
        let mut last_sweep = Utc::now();
        loop {
            // Behind a phone's screen nothing is fetched (NP-151); coming back counts as a wake.
            foreground.wait().await;
            let now = Utc::now();
            if is_wake(last_look, now) {
                tokio::time::sleep(WAKE_SETTLE).await;
                last_tick = None;
            }
            if tick_due(last_tick, Utc::now()) {
                if let Err(error) = refresh(&app, Mode::Tick).await {
                    eprintln!("Checking feeds failed: {}", error.message);
                }
                last_tick = Some(Utc::now());
            }
            // The start's sweep ran in `cache::start`; then one a day.
            if Utc::now() - last_sweep >= SWEEP_EVERY {
                let swept = app.clone();
                match tokio::task::spawn_blocking(move || sweep(&swept)).await {
                    Ok(Err(error)) => eprintln!("Sweeping the feed cache failed: {}", error.message),
                    _ => last_sweep = Utc::now(),
                }
            }
            last_look = Utc::now();
            tokio::time::sleep(LOOK).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::{self, fetch::tests::{answer, rss, server, TEST}};
    use std::path::PathBuf;

    fn clock(at: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&Utc)
    }

    const NOW: &str = "2026-10-16T12:00:00Z";

    fn minutes(from: DateTime<Utc>, to: DateTime<Utc>) -> i64 {
        (to - from).num_minutes()
    }

    #[test]
    fn the_next_fetch_is_the_interval_or_the_feeds_ttl_with_jitter() {
        let now = clock(NOW);
        let recent = Some(now - TimeDelta::hours(2));
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, recent, 0.0)), 60);
        // Jitter stays within ±10 %.
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, recent, 1.0)), 66);
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, recent, -1.0)), 54);
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, recent, 7.0)), 66, "clamped");
        // A longer ttl or max-age wins; a shorter one does not; a day at most.
        assert_eq!(minutes(now, next_after_success(now, 60, Some(180), None, recent, 0.0)), 180);
        assert_eq!(minutes(now, next_after_success(now, 60, Some(15), None, recent, 0.0)), 60);
        assert_eq!(minutes(now, next_after_success(now, 60, None, Some(7200), recent, 0.0)), 120);
        assert_eq!(minutes(now, next_after_success(now, 60, Some(10_000), Some(u64::MAX), recent, 0.0)), 24 * 60);
        // Quiet for 30 days: every 12 hours at most often.
        let quiet = Some(now - TimeDelta::days(31));
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, quiet, 0.0)), 12 * 60);
        assert_eq!(minutes(now, next_after_success(now, 24 * 60, None, None, quiet, 0.0)), 24 * 60);
        assert_eq!(minutes(now, next_after_success(now, 60, None, None, None, 0.0)), 60, "no dates: not quiet");
        // «Only when I refresh» keeps an hour for when the setting changes.
        assert_eq!(minutes(now, next_after_success(now, 0, None, None, recent, 0.0)), 60);
    }

    #[test]
    fn failures_back_off_to_a_day_and_daily_after_a_week() {
        let now = clock(NOW);
        let since = Some(now - TimeDelta::hours(1));
        let backoff: Vec<i64> = (1..=6).map(|f| minutes(now, next_after_failure(now, 60, f, since, 0.0))).collect();
        assert_eq!(backoff, [120, 240, 480, 960, 1440, 1440]);
        assert_eq!(minutes(now, next_after_failure(now, 30, 1, since, 0.0)), 60);
        assert_eq!(minutes(now, next_after_failure(now, 60, 40, since, 0.0)), 1440, "no overflow");
        // Seven days failing: once a day, «not updating».
        let week = Some(now - TimeDelta::days(7));
        assert_eq!(minutes(now, next_after_failure(now, 30, 1, week, 0.0)), 1440);
        // A site's pause: what it asked, no sooner than the interval.
        assert_eq!(minutes(now, next_after_pause(now, 60, 7200, 0.0)), 120);
        assert_eq!(minutes(now, next_after_pause(now, 60, 60, 0.0)), 60);
        assert_eq!(minutes(now, next_after_pause(now, 60, u64::MAX, 0.0)), 1440);
    }

    /// A shorter interval holds at once, each feed with its own jitter and
    /// `<ttl>`; failing feeds keep their backoff (NP-129).
    #[test]
    fn a_shorter_interval_brings_the_waits_forward() {
        let conn = cache::open_in_memory().unwrap();
        let now = clock(NOW);
        let far = db::stamp(now + TimeDelta::hours(12));
        conn.execute("INSERT INTO feed_state (feed_uid, next_fetch_at) VALUES ('a', ?1), ('b', ?1)", [&far]).unwrap();
        conn.execute("INSERT INTO feed_state (feed_uid, next_fetch_at, ttl_minutes) VALUES ('slow', ?1, 180)", [&far]).unwrap();
        conn.execute("INSERT INTO feed_state (feed_uid, next_fetch_at, max_age_secs) VALUES ('cached', ?1, 21600)", [&far]).unwrap();
        conn.execute("INSERT INTO feed_state (feed_uid, next_fetch_at, failures, last_error) VALUES ('bad', ?1, 3, 'timeout')", [&far]).unwrap();
        let mut jitters = [-1.0, 1.0, 0.0, 0.0].into_iter();
        assert_eq!(shorten_waits_with(&conn, now, 30, || jitters.next().unwrap_or(0.0)).unwrap(), 4);
        let next = |uid: &str| -> String { conn.query_row("SELECT next_fetch_at FROM feed_state WHERE feed_uid = ?1", [uid], |r| r.get(0)).unwrap() };
        let (a, b) = (next("a"), next("b"));
        assert_ne!(a, b, "each its own jitter: not all due at once");
        for at in [&a, &b] {
            let minutes = (clock(at) - now).num_minutes();
            assert!((27..=33).contains(&minutes), "{minutes}");
        }
        assert_eq!((clock(&next("slow")) - now).num_minutes(), 180, "its <ttl> still counts");
        assert_eq!((clock(&next("cached")) - now).num_minutes(), 360, "and its max-age");
        assert_eq!(next("bad"), far, "backoff stays");
        assert_eq!(shorten_waits(&conn, now, 0).unwrap(), 0, "«Only when I refresh» brings nothing forward");
    }

    #[test]
    fn what_is_due_and_what_waits() {
        let now = clock(NOW);
        let tick = Mode::Tick;
        let state = |next: i64, error: Option<&str>| FetchState {
            succeeded_at: Some(now - TimeDelta::hours(1)),
            next_fetch_at: Some(now + TimeDelta::minutes(next)),
            last_error: error.map(Into::into),
            ..Default::default()
        };
        assert!(is_due(None, now, 60, &tick, "a"), "a new subscription is fetched at once");
        assert!(is_due(None, now, 0, &tick, "a"), "even with «Only when I refresh»");
        assert!(is_due(Some(&state(-1, None)), now, 60, &tick, "a"));
        assert!(!is_due(Some(&state(10, None)), now, 60, &tick, "a"));
        assert!(!is_due(Some(&state(-1, None)), now, 0, &tick, "a"), "manual: the loop leaves it");
        let failed_once = FetchState {
            fetched_at: Some(now - TimeDelta::hours(1)),
            next_fetch_at: Some(now - TimeDelta::minutes(1)),
            failures: 1,
            last_error: Some("timeout".into()),
            ..Default::default()
        };
        assert!(!is_due(Some(&failed_once), now, 0, &tick, "a"), "manual: a feed that failed waits for ↻ too");
        let never_reached = FetchState { next_fetch_at: Some(now - TimeDelta::minutes(1)), last_error: Some("offline".into()), ..Default::default() };
        assert!(is_due(Some(&never_reached), now, 0, &tick, "a"), "manual: a first fetch cut off by being offline is tried again");
        assert!(!is_due(Some(&state(-1, Some("gone"))), now, 60, &tick, "a"));

        let all = Mode::Now { feed_uid: None };
        let one = Mode::Now { feed_uid: Some("a".into()) };
        assert!(is_due(Some(&state(30, None)), now, 60, &all, "a"), "↻ ignores the schedule");
        assert!(is_due(Some(&state(30, None)), now, 0, &all, "a"));
        assert!(!is_due(Some(&state(30, None)), now, 60, &one, "b"), "only the one asked for");
        assert!(!is_due(Some(&state(30, Some("status:429"))), now, 60, &all, "a"), "but not against Retry-After");
        assert!(is_due(Some(&state(-1, Some("status:429"))), now, 60, &all, "a"), "a pause that passed");
        assert!(!is_due(Some(&state(30, Some("gone"))), now, 60, &all, "a"));
        assert!(is_due(Some(&state(30, Some("gone"))), now, 60, &one, "a"), "an ended feed when asked by name");
    }

    #[test]
    fn a_tick_without_any_answer_is_offline() {
        let at = |host: &str, failure: Option<Failure>| (host.to_string(), failure);
        assert!(tick_offline(&[at("a.example", Some(Failure::Connection)), at("b.example", Some(Failure::Timeout))]));
        assert!(!tick_offline(&[at("a.example", Some(Failure::Connection)), at("b.example", None)]), "one feed answered");
        assert!(!tick_offline(&[at("a.example", Some(Failure::Connection)), at("b.example", Some(Failure::Status(500)))]), "a site answered");
        assert!(!tick_offline(&[at("a.example", Some(Failure::Connection))]), "one host is no evidence");
        assert!(
            !tick_offline(&[at("a.example", Some(Failure::Connection)), at("a.example", Some(Failure::Timeout))]),
            "nor two feeds on one host"
        );
        assert!(!tick_offline(&[]));
    }

    #[test]
    fn ticks_and_wakes_over_the_clock() {
        let now = clock(NOW);
        assert!(tick_due(None, now));
        assert!(!tick_due(Some(now - TimeDelta::minutes(4)), now));
        assert!(tick_due(Some(now - TimeDelta::minutes(5)), now));
        assert!(!is_wake(now - TimeDelta::seconds(30), now));
        assert!(!is_wake(now - TimeDelta::minutes(15), now));
        assert!(is_wake(now - TimeDelta::minutes(16), now));
    }

    #[test]
    fn three_fetches_on_the_same_new_address_make_it_moved() {
        let (seen, moved) = track_move(None, Some("https://new.example.com/feed"));
        assert_eq!(moved, None);
        let (seen, moved) = track_move(seen, Some("https://new.example.com/feed"));
        assert_eq!(moved, None);
        let (seen, moved) = track_move(seen, Some("https://new.example.com/feed"));
        assert_eq!(moved.as_deref(), Some("https://new.example.com/feed"));
        let (again, moved) = track_move(seen.clone(), Some("https://other.example.com/feed"));
        assert_eq!((again.unwrap().1, moved), (1, None), "another address starts over");
        assert_eq!(track_move(seen, None), (None, None), "no redirect: not moved");
    }

    // --- A run against local servers, with a real library and cache. ---

    fn library() -> Arc<DbState> {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.test-data").join(format!("feeds-run-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let conn = crate::library::open(&crate::library::Paths::new(folder.join("koonapin.db"))).unwrap().conn;
        Arc::new(DbState::new(conn))
    }

    fn cache() -> Arc<FeedCache> {
        Arc::new(FeedCache { conn: Mutex::new(cache::open_in_memory().unwrap()), path: PathBuf::new() })
    }

    fn follow(db: &DbState, url: &str) -> Feed {
        let conn = db.conn.lock().unwrap();
        feeds::subscribe(&conn, &url::Url::parse(url).unwrap(), None, FeedDestination::Feeds).unwrap()
    }

    async fn tick(db: &Arc<DbState>, cache: &Arc<FeedCache>, mode: Mode) -> Report {
        let (jobs, interval) = read_plan(db, cache, &mode, Utc::now()).unwrap();
        let inbox: Inbox = Arc::new(|db, cache, feed, ids| save::after_fetch(db, cache, feed, ids));
        run(db.clone(), cache.clone(), jobs, interval, &TEST, inbox, |_, _| {}).await
    }

    fn row(cache: &FeedCache, uid: &str) -> (Option<String>, u32, Option<String>, Option<String>) {
        cache
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT etag, failures, last_error, next_fetch_at FROM feed_state WHERE feed_uid = ?1", [uid], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
    }

    #[tokio::test]
    async fn a_run_stores_the_validators_and_the_next_check_costs_a_304() {
        let (port, seen) = server(|request, _| {
            if request.contains("if-none-match: \"v7\"") {
                answer("304 Not Modified", "", b"")
            } else {
                answer("200 OK", "Content-Type: application/rss+xml\r\nETag: \"v7\"\r\n", &rss("Run"))
            }
        });
        let (db, cache) = (library(), cache());
        let feed = follow(&db, &format!("http://127.0.0.1:{port}/feed"));
        let report = tick(&db, &cache, Mode::Tick).await;
        assert_eq!((report.total, report.offline), (1, false));
        let (etag, failures, error, next) = row(&cache, &feed.uid);
        assert_eq!((etag.as_deref(), failures, error), (Some("\"v7\""), 0, None));
        assert!(next.unwrap() > db::now(), "next check is in the future");
        let posts: i64 = cache.conn.lock().unwrap().query_row("SELECT count(*) FROM feed_items", [], |r| r.get(0)).unwrap();
        assert_eq!(posts, 1, "the document went to the cache");
        let listed = feeds_with_state(&db, &cache).unwrap();
        assert_eq!((listed[0].feed_title.as_deref(), &listed[0].health), (Some("Run"), &feeds::FeedHealth::Ok));
        // Not due again in this tick; ↻ fetches now and sends the validator.
        assert_eq!(tick(&db, &cache, Mode::Tick).await.total, 0);
        assert_eq!(tick(&db, &cache, Mode::Now { feed_uid: None }).await.total, 1);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].contains("if-none-match: \"v7\""), "{}", requests[1]);
        assert_eq!(row(&cache, &feed.uid).0.as_deref(), Some("\"v7\""), "a 304 keeps the validator");
    }

    /// A feed's `<ttl>` holds after a 304, which carries no document (NP-129).
    #[tokio::test]
    async fn a_304_keeps_to_the_feeds_ttl() {
        let body = br#"<?xml version="1.0"?><rss version="2.0"><channel><title>Slow</title><ttl>180</ttl>
<item><title>One</title><link>https://slow.example.com/1</link><guid>s1</guid></item></channel></rss>"#;
        let (port, _) = server(move |request, _| {
            if request.contains("if-none-match") {
                answer("304 Not Modified", "", b"")
            } else {
                answer("200 OK", "Content-Type: application/rss+xml\r\nETag: \"t1\"\r\n", body)
            }
        });
        let (db, cache) = (library(), cache());
        let feed = follow(&db, &format!("http://127.0.0.1:{port}/feed"));
        let minutes_ahead = |cache: &FeedCache| (clock(&row(cache, &feed.uid).3.unwrap()) - Utc::now()).num_minutes();
        tick(&db, &cache, Mode::Tick).await;
        assert!(minutes_ahead(&cache) >= 160, "the document's ttl: about 3 h, not the hour");
        tick(&db, &cache, Mode::Now { feed_uid: None }).await;
        assert!(minutes_ahead(&cache) >= 160, "and the 304 after it keeps to it");
    }

    #[tokio::test]
    async fn with_the_network_off_nothing_is_marked_failing() {
        let (db, cache) = (library(), cache());
        let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let a = follow(&db, &format!("http://127.0.0.1:{closed}/a"));
        let b = follow(&db, "https://dead-domain.invalid/b");
        let report = tick(&db, &cache, Mode::Tick).await;
        assert!(report.offline);
        for uid in [&a.uid, &b.uid] {
            let (_, failures, error, next) = row(&cache, uid);
            assert_eq!((failures, error.as_deref()), (0, Some("offline")));
            let next = clock(&next.unwrap());
            assert!((next - Utc::now()).num_minutes() <= 5, "tried again in 5 minutes");
        }
        assert!(feeds_with_state(&db, &cache).unwrap().iter().all(|f| f.health == feeds::FeedHealth::Offline), "the header says offline");

        // One feed answering: the unreachable one is a failure of its own.
        let (port, _) = server(|_, _| answer("200 OK", "Content-Type: application/rss+xml\r\n", &rss("Up")));
        let up = follow(&db, &format!("http://127.0.0.1:{port}/up"));
        let report = tick(&db, &cache, Mode::Now { feed_uid: None }).await;
        assert!(!report.offline);
        assert_eq!(row(&cache, &up.uid).1, 0);
        for dead in [&a.uid, &b.uid] {
            let (_, failures, error, _) = row(&cache, dead);
            // Windows retries a refused connect until the timeout, so the closed port may time out.
            assert_eq!(failures, 1);
            assert!(matches!(error.as_deref(), Some("connection" | "timeout")), "{error:?}");
        }
    }

    #[tokio::test]
    async fn a_lone_dead_host_fails_and_backs_off() {
        let (db, cache) = (library(), cache());
        let dead = follow(&db, "https://dead-domain.invalid/feed");
        let report = tick(&db, &cache, Mode::Tick).await;
        assert!(!report.offline, "one host is no evidence of being offline");
        let (_, failures, error, next) = row(&cache, &dead.uid);
        assert_eq!((failures, error.as_deref()), (1, Some("connection")));
        assert!((clock(&next.unwrap()) - Utc::now()).num_minutes() >= 100, "interval × 2, not 5 minutes");
        tick(&db, &cache, Mode::Now { feed_uid: None }).await;
        assert_eq!(row(&cache, &dead.uid).1, 2, "counted again");
        let failing_since: Option<String> = cache
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT failing_since FROM feed_state WHERE feed_uid = ?1", [&dead.uid], |r| r.get(0))
            .unwrap();
        assert!(failing_since.is_some());
    }

    #[tokio::test]
    async fn statuses_are_written_as_the_schedule_reads_them() {
        let (port, _) = server(|request, _| {
            if request.starts_with("get /gone") {
                answer("410 Gone", "", b"")
            } else if request.starts_with("get /busy") {
                answer("429 Too Many Requests", "Retry-After: 7200\r\n", b"")
            } else {
                answer("403 Forbidden", "", b"")
            }
        });
        let (db, cache) = (library(), cache());
        let gone = follow(&db, &format!("http://127.0.0.1:{port}/gone"));
        let busy = follow(&db, &format!("http://127.0.0.1:{port}/busy"));
        let blocked = follow(&db, &format!("http://127.0.0.1:{port}/blocked"));
        tick(&db, &cache, Mode::Tick).await;
        assert_eq!(row(&cache, &gone.uid).2.as_deref(), Some("gone"));
        let (_, failures, error, next) = row(&cache, &busy.uid);
        assert_eq!((failures, error.as_deref()), (1, Some("status:429")));
        assert!((clock(&next.unwrap()) - Utc::now()).num_minutes() >= 119);
        assert_eq!(row(&cache, &blocked.uid).2.as_deref(), Some("blocked"));
        // ↻ of all feeds: not the ended one, not against Retry-After.
        let report = tick(&db, &cache, Mode::Now { feed_uid: None }).await;
        assert_eq!(report.total, 1, "only the blocked one");
    }
}
