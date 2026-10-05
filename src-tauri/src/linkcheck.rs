//! Link check (NP-036, Р-38, sheet 35): which saved links no longer open.
//!
//! The person starts a check; nothing runs on its own and nothing is deleted.
//! Every address is requested once like a browser would (GET, headers only,
//! the body is not read), through the same guard as metadata (NP-019): only
//! HTTP(S) to public addresses, each redirect checked again. A site gets one
//! request at a time with a pause between them; a few sites are checked at
//! once.
//!
//! A link is broken only on a definite answer — 404 or 410. Timeouts, network
//! errors, 5xx and refusals are «Не удалось проверить»: they are tried once
//! more at the end of the run, and a run of network errors on different sites
//! means the connection is down — the check pauses and marks none of them.
//!
//! A result belongs to the address it was made for (`link_checks.url`): when
//! the address of the bookmark changes, the bookmark is unchecked again. After
//! «Заменить адрес» the bookmark holds the address the page moved to, which
//! counts as open; `Ctrl Z` puts the old address back and the result with it.

use crate::db::{self, Bookmark, DbState};
use crate::net_guard;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;
use tokio::task::JoinSet;
use ts_rs::TS;
use url::{Host, Url};

/// What the check found for one address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It opens (2xx), possibly after redirects.
    Ok,
    /// 404 or 410: the page is no longer there.
    Gone,
    /// Every redirect was permanent (301, 308) and the new address opens.
    Moved,
    /// No definite answer; see [`Reason`].
    Failed,
    /// On this computer or the local network, or not a web address: not requested.
    Local,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Gone => "gone",
            Outcome::Moved => "moved",
            Outcome::Failed => "failed",
            Outcome::Local => "local",
        }
    }
}

/// Why a link could not be checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "LinkFailure")]
pub enum Reason {
    /// No answer within the time limit.
    Timeout,
    /// The name of the site does not resolve.
    NoSite,
    /// The connection failed or broke.
    Network,
    /// The site answered with a status other than 2xx, 404, 410: see `status`.
    Status,
    /// Too many redirects, or a redirect to a local address.
    Redirects,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Timeout => "timeout",
            Reason::NoSite => "no_site",
            Reason::Network => "network",
            Reason::Status => "status",
            Reason::Redirects => "redirects",
        }
    }

    fn parse(text: &str) -> Option<Reason> {
        Some(match text {
            "timeout" => Reason::Timeout,
            "no_site" => Reason::NoSite,
            "network" => Reason::Network,
            "status" => Reason::Status,
            "redirects" => Reason::Redirects,
            _ => return None,
        })
    }
}

/// The result of one address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub id: i64,
    /// The address that was checked.
    pub url: String,
    pub outcome: Outcome,
    /// The status of the last answer, if there was one; of the first redirect for a move.
    pub status: Option<u16>,
    pub reason: Option<Reason>,
    /// Where the page moved to.
    pub target: Option<String>,
}

/// One bookmark to check.
#[derive(Debug, Clone)]
pub struct Item {
    pub id: i64,
    pub url: String,
}

/// What a check may do; [`Limits::PUBLIC`] in the app, local servers in tests.
#[derive(Clone)]
pub struct Limits {
    /// Addresses a request may connect to, after every resolution and redirect.
    pub allow: fn(IpAddr) -> bool,
    pub connect_timeout: Duration,
    /// One request, headers included.
    pub timeout: Duration,
    pub max_redirects: usize,
    /// Requests at once, to different sites.
    pub parallel: usize,
    /// The pause between two requests to the same site.
    pub per_site: Duration,
    /// The pause before the links that failed are tried again.
    pub retry_after: Duration,
    /// Network errors in a row, on at least three sites, that mean the
    /// connection is down.
    pub offline_after: usize,
}

impl Limits {
    pub const PUBLIC: Limits = Limits {
        allow: net_guard::public_ip,
        connect_timeout: Duration::from_secs(5),
        timeout: Duration::from_secs(10),
        max_redirects: 5,
        parallel: 8,
        per_site: Duration::from_secs(1),
        retry_after: Duration::from_secs(3),
        offline_after: 8,
    };
}

/// What one request ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Probe {
    /// irst is the status of the first redirect, if any.
    Answer { status: u16, last: Url, permanent: bool, first: Option<u16> },
    Local,
    NoSite,
    Timeout,
    Network,
    Redirects,
}

impl Probe {
    /// Says the connection itself may be down.
    fn network(&self) -> bool {
        matches!(self, Probe::NoSite | Probe::Timeout | Probe::Network)
    }

    /// Worth a second try at the end of the run.
    fn retry(&self) -> bool {
        match self {
            // Not 999: that is a refusal of automatic requests, it will not change.
            Probe::Answer { status, .. } => *status == 429 || (500..600).contains(status),
            other => other.network(),
        }
    }
}

fn client(limits: &Limits) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.timeout)
        // A proxy would resolve names where the guard cannot see them.
        .no_proxy()
        .dns_resolver(net_guard::resolver(limits.allow))
        // Followed by hand: each hop is checked and its status counted.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 NetamiPin/0.1")
        .build()
}

/// Requests `start` and follows its redirects.
async fn probe(client: &reqwest::Client, start: &Url, limits: &Limits) -> Probe {
    let mut url = start.clone();
    let mut permanent = true;
    let mut first = None;
    for hop in 0..=limits.max_redirects {
        if !net_guard::allowed_url(&url, limits.allow) {
            return if hop == 0 { Probe::Local } else { Probe::Redirects };
        }
        if let Some(Host::Domain(name)) = url.host() {
            match tokio::net::lookup_host((name, 0)).await {
                Err(_) => return Probe::NoSite,
                Ok(addresses) => {
                    let addresses: Vec<_> = addresses.collect();
                    if addresses.is_empty() {
                        return Probe::NoSite;
                    }
                    if !addresses.iter().any(|a| (limits.allow)(a.ip())) {
                        return if hop == 0 { Probe::Local } else { Probe::Redirects };
                    }
                }
            }
        }
        let response = match client.get(url.clone()).send().await {
            Ok(response) => response,
            Err(e) if e.is_timeout() => return Probe::Timeout,
            Err(_) => return Probe::Network,
        };
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| url.join(v).ok());
        // The body is not read: dropping the response closes the connection.
        drop(response);
        match location {
            Some(next) if (300..400).contains(&status) => {
                permanent &= matches!(status, 301 | 308);
                first.get_or_insert(status);
                url = next;
            }
            _ => return Probe::Answer { status, permanent: permanent && hop > 0, last: url, first },
        }
    }
    Probe::Redirects
}

/// What a request means for the bookmark.
fn verdict(item: &Item, probe: Probe) -> Checked {
    let checked = |outcome, status, reason, target| Checked { id: item.id, url: item.url.clone(), outcome, status, reason, target };
    match probe {
        Probe::Answer { status, last, permanent, first } => match status {
            200..=299 => {
                let moved = permanent && crate::dedupe::url_key(last.as_str()) != crate::dedupe::url_key(&item.url);
                if moved {
                    // «301 · Перемещена»: the redirect says how it moved.
                    checked(Outcome::Moved, first, None, Some(last.to_string()))
                } else {
                    checked(Outcome::Ok, Some(status), None, None)
                }
            }
            404 | 410 => checked(Outcome::Gone, Some(status), None, None),
            _ => checked(Outcome::Failed, Some(status), Some(Reason::Status), None),
        },
        Probe::Local => checked(Outcome::Local, None, None, None),
        Probe::NoSite => checked(Outcome::Failed, None, Some(Reason::NoSite), None),
        Probe::Timeout => checked(Outcome::Failed, None, Some(Reason::Timeout), None),
        Probe::Network => checked(Outcome::Failed, None, Some(Reason::Network), None),
        Probe::Redirects => checked(Outcome::Failed, None, Some(Reason::Redirects), None),
    }
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Done,
    /// «Остановить»: requests in flight were dropped.
    Stopped,
    /// The connection is down; the failures of that streak are not reported.
    Offline,
}

/// A run's progress: links done of all, in the first pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub done: usize,
    pub total: usize,
}

/// Checks `items` and reports each result to `report` as it comes; a link
/// tried again is reported after its second try. Returns at once when
/// `stop` turns true.
pub async fn run(
    items: Vec<Item>,
    limits: &Limits,
    mut stop: watch::Receiver<bool>,
    mut report: impl FnMut(Step, Option<Checked>),
) -> End {
    let total = items.len();
    let mut done = 0;
    let mut queue: VecDeque<(Item, Url, String)> = VecDeque::new();
    for item in items {
        match Url::parse(item.url.trim()) {
            Ok(url) if url.host_str().is_some() => {
                let site = url.host_str().unwrap_or_default().to_ascii_lowercase();
                queue.push_back((item, url, site));
            }
            // Not a web address: nothing to request.
            _ => {
                done += 1;
                let checked = verdict(&item, Probe::Local);
                report(Step { done, total }, Some(checked));
            }
        }
    }
    let Ok(client) = client(limits) else {
        return End::Stopped;
    };
    let client = Arc::new(client);
    let mut busy: HashSet<String> = HashSet::new();
    let mut next_at: HashMap<String, Instant> = HashMap::new();
    let mut flight: JoinSet<(Item, Url, String, Probe)> = JoinSet::new();
    let mut again: Vec<(Item, Url, String)> = Vec::new();
    let mut second = false;
    // Network errors in a row and the sites they came from.
    let mut streak = 0;
    let mut streak_sites: HashSet<String> = HashSet::new();

    loop {
        if *stop.borrow() {
            flight.abort_all();
            return End::Stopped;
        }
        // Start what may start: a free site whose pause is over.
        let now = Instant::now();
        let mut wake: Option<Instant> = None;
        while flight.len() < limits.parallel {
            let ready = queue.iter().position(|(_, _, site)| {
                !busy.contains(site) && next_at.get(site).is_none_or(|at| *at <= now)
            });
            let Some(index) = ready else { break };
            let (item, url, site) = queue.remove(index).expect("found above");
            busy.insert(site.clone());
            let (client, limits) = (client.clone(), limits.clone());
            flight.spawn(async move {
                let probe = probe(&client, &url, &limits).await;
                (item, url, site, probe)
            });
        }
        if flight.len() < limits.parallel {
            wake = queue
                .iter()
                .filter(|(_, _, site)| !busy.contains(site))
                .filter_map(|(_, _, site)| next_at.get(site).copied())
                .min();
        }
        if flight.is_empty() && queue.is_empty() {
            if second || again.is_empty() {
                return End::Done;
            }
            // The links that failed get one more try, after a pause.
            tokio::select! {
                _ = stop.wait_for(|stopped| *stopped) => {
                    return End::Stopped;
                }
                _ = tokio::time::sleep(limits.retry_after) => {}
            }
            second = true;
            queue.extend(again.drain(..));
            next_at.clear();
            continue;
        }
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {
                flight.abort_all();
                return End::Stopped;
            }
            Some(joined) = flight.join_next(), if !flight.is_empty() => {
                let Ok((item, url, site, probe)) = joined else { continue };
                busy.remove(&site);
                next_at.insert(site.clone(), Instant::now() + limits.per_site);
                if probe.network() {
                    streak += 1;
                    streak_sites.insert(format!("{site}:{}", url.port_or_known_default().unwrap_or(0)));
                    if streak >= limits.offline_after && streak_sites.len() >= 3 {
                        flight.abort_all();
                        return End::Offline;
                    }
                } else {
                    streak = 0;
                    streak_sites.clear();
                }
                if !second {
                    done += 1;
                }
                if !second && probe.retry() {
                    again.push((item, url, site));
                    report(Step { done, total }, None);
                } else {
                    report(Step { done, total }, Some(verdict(&item, probe)));
                }
            }
            _ = async { tokio::time::sleep_until(wake.expect("guarded").into()).await }, if wake.is_some() => {}
        }
    }
}

// ---- The library: results, the report, replacing addresses.

/// The result row still describes the bookmark: same address, or the address
/// the page moved to after «Заменить адрес».
const VALID: &str = "(l.url = b.url OR (l.outcome = 'moved' AND l.target = b.url))";
/// The outcome as it counts now: a replaced address opens.
const NOW: &str = "CASE WHEN l.url = b.url THEN l.outcome ELSE 'ok' END";

/// Writes results of bookmarks that still exist; a bookmark deleted for good
/// meanwhile is skipped.
pub fn save(conn: &Connection, results: &[Checked], at: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut write = tx.prepare(
            "INSERT INTO link_checks (bookmark_id, url, checked_at, outcome, status, reason, target)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM bookmarks WHERE id = ?1)
             ON CONFLICT(bookmark_id) DO UPDATE SET url = excluded.url, checked_at = excluded.checked_at,
                 outcome = excluded.outcome, status = excluded.status, reason = excluded.reason, target = excluded.target",
        )?;
        for r in results {
            write.execute(params![r.id, r.url, at, r.outcome.as_str(), r.status, r.reason.map(Reason::as_str), r.target])?;
        }
    }
    tx.commit()
}

/// Bookmarks that need a decision: they do not open, or they moved.
pub fn count(conn: &Connection) -> Result<i64> {
    conn.query_row(
        &format!(
            "SELECT count(*) FROM link_checks l JOIN bookmarks b ON b.id = l.bookmark_id
             WHERE b.deleted_at IS NULL AND {VALID} AND {NOW} IN ('gone', 'moved')"
        ),
        [],
        |r| r.get(0),
    )
}

/// Bookmarks the run started at `?1` has left to check.
const LEFT: &str = "FROM bookmarks b LEFT JOIN link_checks l ON l.bookmark_id = b.id
     WHERE b.deleted_at IS NULL AND NOT (l.bookmark_id IS NOT NULL AND (l.url = b.url OR (l.outcome = 'moved' AND l.target = b.url)) AND l.checked_at >= ?1)";

/// What the run started at `since` has left to check, those never checked first.
fn remaining(conn: &Connection, since: &str) -> Result<Vec<Item>> {
    conn.prepare(&format!("SELECT b.id, b.url {LEFT} ORDER BY l.checked_at IS NOT NULL, l.checked_at, b.id"))?
        .query_map([since], |r| Ok(Item { id: r.get(0)?, url: r.get(1)? }))?
        .collect()
}

fn left(conn: &Connection, since: &str) -> Result<i64> {
    conn.query_row(&format!("SELECT count(*) {LEFT}"), [since], |r| r.get(0))
}

/// Of `ids`, those outside the trash: «Проверить снова» on a group.
fn chosen(conn: &Connection, ids: &[i64]) -> Result<Vec<Item>> {
    let list = serde_json::to_string(ids).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.prepare("SELECT id, url FROM bookmarks WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL ORDER BY id")?
        .query_map([list], |r| Ok(Item { id: r.get(0)?, url: r.get(1)? }))?
        .collect()
}

/// A bookmark with its result (sheet 35).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CheckedLink {
    pub bookmark: Bookmark,
    pub status: Option<u16>,
    pub reason: Option<Reason>,
    /// Where the page moved to.
    pub target: Option<String>,
    /// The new address is already saved: «Заменить адрес» would make a twin.
    pub conflict: bool,
    pub checked_at: String,
}

/// Where the check is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "LinkCheckState")]
pub enum RunState {
    /// Nothing runs; the last check over the library, if any, is complete.
    Idle,
    Running,
    /// «Остановить», or closed before the end: «Продолжить» goes on.
    Stopped,
    /// The connection went down: «Повторить» goes on.
    Offline,
}

/// The section «Проверка ссылок».
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct LinkCheckReport {
    pub state: RunState,
    /// The run under way or stopped: links done of all.
    pub done: u32,
    pub total: u32,
    pub eta_seconds: Option<u32>,
    /// When the last complete check of the library ended.
    pub finished_at: Option<String>,
    /// Bookmarks outside the trash: «Проверить 1 248 ссылок».
    pub library: i64,
    /// Results that hold now.
    pub open: i64,
    pub local: i64,
    pub unchecked: i64,
    pub gone: Vec<CheckedLink>,
    pub moved: Vec<CheckedLink>,
    pub failed: Vec<CheckedLink>,
}

fn results(conn: &Connection, outcome: &str) -> Result<Vec<CheckedLink>> {
    let rows: Vec<(i64, Option<u16>, Option<String>, Option<String>, bool, String)> = conn
        .prepare(&format!(
            "SELECT b.id, l.status, l.reason, l.target,
                    l.target IS NOT NULL AND EXISTS (SELECT 1 FROM bookmarks t WHERE t.url = l.target),
                    l.checked_at
             FROM link_checks l JOIN bookmarks b ON b.id = l.bookmark_id
             WHERE b.deleted_at IS NULL AND l.url = b.url AND l.outcome = ?1
             ORDER BY l.checked_at DESC, b.id"
        ))?
        .query_map([outcome], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_>>()?;
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let mut bookmarks: HashMap<i64, Bookmark> = db::get_bookmarks_by_ids(conn, &ids)?.into_iter().map(|b| (b.id, b)).collect();
    Ok(rows
        .into_iter()
        .filter_map(|(id, status, reason, target, conflict, checked_at)| {
            Some(CheckedLink {
                bookmark: bookmarks.remove(&id)?,
                status,
                reason: reason.as_deref().and_then(Reason::parse),
                target,
                conflict,
                checked_at,
            })
        })
        .collect())
}

/// The report as stored; the state and progress of a run come from [`Checker`].
pub fn report(conn: &Connection) -> Result<LinkCheckReport> {
    let (library, open, local, checked): (i64, i64, i64, i64) = conn.query_row(
        &format!(
            "SELECT (SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL),
                    COALESCE(SUM({NOW} = 'ok'), 0), COALESCE(SUM({NOW} = 'local'), 0), count(*)
             FROM link_checks l JOIN bookmarks b ON b.id = l.bookmark_id
             WHERE b.deleted_at IS NULL AND {VALID}"
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let started = db::setting(conn, STARTED).optional()?;
    let (done, total) = match &started {
        Some(since) => ((library - left(conn, since)?).max(0) as u32, library as u32),
        None => (0, 0),
    };
    Ok(LinkCheckReport {
        state: if started.is_some() { RunState::Stopped } else { RunState::Idle },
        done,
        total,
        eta_seconds: None,
        finished_at: db::setting(conn, FINISHED).optional()?,
        library,
        open,
        local,
        unchecked: library - checked,
        gone: results(conn, "gone")?,
        moved: results(conn, "moved")?,
        failed: results(conn, "failed")?,
    })
}

/// When the check of the whole library under way, or stopped, began.
const STARTED: &str = "link_check_started";
/// When the last check of the whole library ended.
const FINISHED: &str = "link_check_finished";

/// «Заменить адрес»: each bookmark of `ids` that moved takes the address its
/// page moved to. One transaction; a bookmark whose result no longer holds,
/// or whose new address is already saved, is skipped. Returns the bookmarks
/// changed and how many were skipped.
pub fn replace(conn: &Connection, ids: &[i64]) -> Result<(Vec<Bookmark>, usize)> {
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let mut changed = Vec::new();
    let mut skipped = 0;
    for &id in ids {
        let target: Option<String> = tx
            .query_row(
                "SELECT l.target FROM link_checks l JOIN bookmarks b ON b.id = l.bookmark_id
                 WHERE b.id = ?1 AND b.deleted_at IS NULL AND l.url = b.url AND l.outcome = 'moved'
                   AND NOT EXISTS (SELECT 1 FROM bookmarks t WHERE t.url = l.target)",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(target) = target else {
            skipped += 1;
            continue;
        };
        tx.execute(
            "UPDATE bookmarks SET url = ?1, url_key = ?2, domain = ?3, updated_at = ?4, revision = revision + 1 WHERE id = ?5",
            params![target, crate::dedupe::url_key(&target), crate::metadata::extract_domain(&target), now, id],
        )?;
        changed.push(id);
    }
    let bookmarks = db::get_bookmarks_by_ids(&tx, &changed)?;
    tx.commit()?;
    Ok((bookmarks, skipped))
}

// ---- The run in the app.

/// Payload of `link-check`: the run moved on, or results were written.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct LinkCheckProgress {
    pub state: RunState,
    pub done: u32,
    pub total: u32,
    pub eta_seconds: Option<u32>,
    /// Results were written: the section reads them again.
    pub written: bool,
    /// A write failed and stopped the run.
    pub error: Option<String>,
}

/// The check under way, at most one (managed by Tauri).
#[derive(Default)]
pub struct Checker {
    /// Turns true to stop the run under way.
    run: Mutex<Option<watch::Sender<bool>>>,
    /// How the last run of this session ended, and its progress.
    last: Mutex<Option<LinkCheckProgress>>,
    /// The bookmarks of the last «Проверить снова» on a group: going on
    /// after a stop checks them, not the whole library.
    scope: Mutex<Option<Vec<i64>>>,
    /// The library was replaced: results not yet written belong to the old one.
    abandoned: AtomicBool,
}

impl Checker {
    /// «Остановить»: returns at once; requests in flight are dropped.
    pub fn stop(&self) {
        if let Some(stop) = self.run.lock().ok().and_then(|r| r.clone()) {
            let _ = stop.send(true);
        }
    }

    /// The library is about to be replaced (NP-033, NP-034): stop, and write nothing more.
    pub fn abandon(&self) {
        self.abandoned.store(true, Ordering::SeqCst);
        self.stop();
    }

    pub fn running(&self) -> bool {
        self.run.lock().is_ok_and(|r| r.is_some())
    }

    /// The report with the state of this session's run.
    pub fn report(&self, conn: &Connection) -> Result<LinkCheckReport> {
        let mut report = report(conn)?;
        if let Some(last) = self.last.lock().ok().and_then(|l| l.clone()) {
            if last.state != RunState::Idle || self.running() {
                report.state = last.state;
                report.done = last.done;
                report.total = last.total;
                report.eta_seconds = last.eta_seconds;
            }
        }
        Ok(report)
    }

    fn remember(&self, progress: &LinkCheckProgress) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(progress.clone());
        }
    }
}

/// What a run checks, and how many of the whole it had done before.
fn plan(conn: &Connection, ids: Option<&[i64]>, resume: bool) -> Result<(Vec<Item>, usize)> {
    if let Some(ids) = ids {
        return Ok((chosen(conn, ids)?, 0));
    }
    let since = match db::setting(conn, STARTED).optional()? {
        Some(since) if resume => since,
        _ => db::now(),
    };
    db::set_setting(conn, STARTED, &since)?;
    let library: i64 = conn.query_row("SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL", [], |r| r.get(0))?;
    let items = remaining(conn, &since)?;
    let before = (library as usize).saturating_sub(items.len());
    Ok((items, before))
}

/// Starts a check in the background: of `ids` («Проверить снова» on a
/// group), or of the whole library — anew, or going on with the one stopped.
/// Nothing happens while a check runs.
pub fn start(app: AppHandle, state: Arc<DbState>, ids: Option<Vec<i64>>, resume: bool) -> std::result::Result<(), String> {
    let checker = app.state::<Checker>();
    let (stop, stopped) = watch::channel(false);
    {
        let mut run = checker.run.lock().map_err(|e| e.to_string())?;
        if run.is_some() {
            return Ok(());
        }
        *run = Some(stop.clone());
        checker.abandoned.store(false, Ordering::SeqCst);
    }
    let ids = {
        let mut scope = checker.scope.lock().map_err(|e| e.to_string())?;
        match ids {
            Some(ids) => *scope = Some(ids),
            None if resume => {}
            None => *scope = None,
        }
        scope.clone()
    };
    let planned = state.conn.lock().map_err(|e| e.to_string()).and_then(|conn| plan(&conn, ids.as_deref(), resume).map_err(|e| e.to_string()));
    let (items, before) = match planned {
        Ok(planned) => planned,
        Err(error) => {
            if let Ok(mut run) = checker.run.lock() {
                *run = None;
            }
            return Err(error);
        }
    };
    let whole = ids.is_none();
    let total = before + items.len();
    tauri::async_runtime::spawn(async move {
        let checker = app.state::<Checker>();
        let started = Instant::now();
        let progress = |done: usize, state: RunState, written: bool, error: Option<String>| {
            let eta = (state == RunState::Running && done > before + 10 && done < total).then(|| {
                let per_link = started.elapsed().as_secs_f64() / (done - before) as f64;
                (per_link * (total - done) as f64).ceil() as u32
            });
            LinkCheckProgress { state, done: done as u32, total: total as u32, eta_seconds: eta, written, error }
        };
        let first = progress(before, RunState::Running, false, None);
        checker.remember(&first);
        emit(&app, &first);

        // Results are written in batches; a failed write stops the run.
        let mut pending: Vec<Checked> = Vec::new();
        let mut flushed = Instant::now();
        let mut shown = Instant::now();
        let mut failure: Option<String> = None;
        let mut done = before;
        let end = run(items, &Limits::PUBLIC, stopped, |step, checked| {
            done = before + step.done;
            pending.extend(checked);
            let flush = pending.len() >= 50 || (!pending.is_empty() && flushed.elapsed() > Duration::from_secs(1));
            if flush && failure.is_none() && !checker.abandoned.load(Ordering::SeqCst) {
                if let Err(e) = write(&state, &pending) {
                    failure = Some(e);
                    let _ = stop.send(true);
                }
                pending.clear();
                flushed = Instant::now();
            }
            if flush || shown.elapsed() > Duration::from_millis(250) {
                shown = Instant::now();
                let now = progress(done, RunState::Running, flush, None);
                checker.remember(&now);
                emit(&app, &now);
            }
        })
        .await;
        if failure.is_none() && !pending.is_empty() && !checker.abandoned.load(Ordering::SeqCst) {
            failure = write(&state, &pending).err();
        }
        if whole && end == End::Done && failure.is_none() {
            if let Ok(conn) = state.conn.lock() {
                let _ = db::set_setting(&conn, FINISHED, &db::now());
                let _ = conn.execute("DELETE FROM app_settings WHERE key = ?1", [STARTED]);
            }
        }
        let state = match (end, &failure) {
            (_, Some(_)) | (End::Stopped, _) => RunState::Stopped,
            (End::Done, _) => RunState::Idle,
            (End::Offline, _) => RunState::Offline,
        };
        if state == RunState::Idle {
            if let Ok(mut scope) = checker.scope.lock() {
                *scope = None;
            }
        }
        let finished = progress(done, state, true, failure);
        checker.remember(&finished);
        if let Ok(mut run) = checker.run.lock() {
            *run = None;
        }
        emit(&app, &finished);
    });
    Ok(())
}

fn emit(app: &AppHandle, progress: &LinkCheckProgress) {
    let _ = app.emit("link-check", progress);
}

fn write(state: &DbState, results: &[Checked]) -> std::result::Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    save(&conn, results, &db::now()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_or_update_bookmark, trash_bookmark, Source};
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::atomic::AtomicUsize;

    /// Tests reach 127.0.0.1 only; the rest of 127/8 stands for the local network.
    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    fn any_loopback(ip: IpAddr) -> bool {
        ip.is_loopback()
    }
    const TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_millis(800),
        max_redirects: 5,
        parallel: 8,
        per_site: Duration::ZERO,
        retry_after: Duration::from_millis(50),
        offline_after: 8,
    };

    /// A server on `address` that answers request number `n` (from 0) with `reply(n, port)`.
    fn server(address: &str, reply: impl Fn(usize, u16) -> String + Send + 'static) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind((address, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let n = counted.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(reply(n, port).as_bytes());
            }
        });
        (port, hits)
    }

    fn status(code: u16) -> String {
        format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }
    fn redirect(code: u16, to: &str) -> String {
        format!("HTTP/1.1 {code} X\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }

    async fn check(urls: &[String], limits: &Limits) -> (End, Vec<Checked>) {
        let items = urls.iter().enumerate().map(|(i, url)| Item { id: i as i64, url: url.clone() }).collect();
        let (_stop, stopped) = watch::channel(false);
        let mut found = Vec::new();
        let end = run(items, limits, stopped, |_, checked| found.extend(checked)).await;
        found.sort_by_key(|c| c.id);
        (end, found)
    }

    #[tokio::test]
    async fn answers_become_results() {
        // One server that answers by path.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..n]).lines().next().unwrap_or_default().to_string();
                let path = line.split(' ').nth(1).unwrap_or("/").to_string();
                let base = format!("http://127.0.0.1:{port}");
                let reply = match path.as_str() {
                    "/ok" => status(200),
                    "/missing" => status(404),
                    "/gone" => status(410),
                    "/old" => redirect(301, &format!("{base}/hop")),
                    "/hop" => redirect(308, &format!("{base}/new")),
                    "/new" => status(200),
                    "/slash" => redirect(301, &format!("{base}/slash/")),
                    "/slash/" => status(200),
                    "/login" => redirect(302, &format!("{base}/ok")),
                    "/mixed" => redirect(301, &format!("{base}/login")),
                    "/moved-away" => redirect(301, &format!("{base}/missing")),
                    "/refused" => status(403),
                    "/loop" => redirect(302, &format!("{base}/loop")),
                    "/inside" => redirect(301, "http://127.0.0.2/admin"),
                    _ => status(500),
                };
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        let url = |path: &str| format!("http://127.0.0.1:{port}{path}");
        let paths = ["/ok", "/missing", "/gone", "/old", "/slash", "/login", "/mixed", "/moved-away", "/refused", "/loop", "/inside"];
        let urls: Vec<String> = paths.iter().map(|p| url(p)).collect();
        let (end, found) = check(&urls, &TEST).await;
        assert_eq!(end, End::Done);
        let got: Vec<(Outcome, Option<u16>, Option<Reason>, Option<String>)> =
            found.iter().map(|c| (c.outcome, c.status, c.reason, c.target.clone())).collect();
        assert_eq!(
            got,
            [
                (Outcome::Ok, Some(200), None, None),
                (Outcome::Gone, Some(404), None, None),
                (Outcome::Gone, Some(410), None, None),
                (Outcome::Moved, Some(301), None, Some(url("/new"))),
                // http → the same page with a slash is not a move.
                (Outcome::Ok, Some(200), None, None),
                (Outcome::Ok, Some(200), None, None),
                // Permanent, then temporary: it opens, the address stays.
                (Outcome::Ok, Some(200), None, None),
                (Outcome::Gone, Some(404), None, None),
                (Outcome::Failed, Some(403), Some(Reason::Status), None),
                (Outcome::Failed, None, Some(Reason::Redirects), None),
                (Outcome::Failed, None, Some(Reason::Redirects), None),
            ]
        );
    }

    #[tokio::test]
    async fn local_addresses_and_non_web_links_are_not_requested() {
        let (port, hits) = server("127.0.0.1", |_, _| status(200));
        let urls = vec![
            format!("http://127.0.0.1:{port}/"),
            format!("http://localhost:{port}/"),
            "file:///C:/Windows/win.ini".to_string(),
            "not a url".to_string(),
        ];
        let (end, found) = check(&urls, &Limits { allow: net_guard::public_ip, ..TEST }).await;
        assert_eq!(end, End::Done);
        assert!(found.iter().all(|c| c.outcome == Outcome::Local), "{found:?}");
        assert_eq!(found.len(), 4);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    /// Acceptance 1: a temporary failure does not make a link broken.
    #[tokio::test]
    async fn a_temporary_failure_is_tried_again_and_never_broken() {
        // 503 first, then fine.
        let (flaky, flaky_hits) = server("127.0.0.1", |n, _| if n == 0 { status(503) } else { status(200) });
        // Always 503: tried twice, then «could not check», not broken.
        let (down, down_hits) = server("127.0.0.1", |_, _| status(503));
        // Refuses automatic requests: not tried again.
        let (refusing, refusing_hits) = server("127.0.0.1", |_, _| status(999));
        let urls = vec![
            format!("http://127.0.0.1:{flaky}/"),
            format!("http://127.0.0.1:{down}/"),
            format!("http://127.0.0.1:{refusing}/"),
        ];
        let (_, found) = check(&urls, &TEST).await;
        assert_eq!(found[0].outcome, Outcome::Ok);
        assert_eq!((found[1].outcome, found[1].status), (Outcome::Failed, Some(503)));
        assert_eq!(found[2].outcome, Outcome::Failed);
        assert_eq!(flaky_hits.load(Ordering::SeqCst), 2);
        assert_eq!(down_hits.load(Ordering::SeqCst), 2);
        assert_eq!(refusing_hits.load(Ordering::SeqCst), 1);
        assert!(found.iter().all(|c| c.outcome != Outcome::Gone));
    }

    #[tokio::test]
    async fn a_silent_site_times_out_and_is_not_broken() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(4).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let started = Instant::now();
        let (_, found) = check(&[format!("http://127.0.0.1:{port}/")], &TEST).await;
        assert_eq!((found[0].outcome, found[0].reason), (Outcome::Failed, Some(Reason::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
    }

    /// Acceptance 1: no connection marks nothing; the run pauses.
    #[tokio::test]
    async fn network_errors_on_many_sites_mean_offline_and_mark_nothing() {
        // Ports nobody listens on, on several local addresses: connections are refused.
        let closed: Vec<String> = (2..12)
            .map(|i| {
                let address = format!("127.0.0.{i}");
                let port = TcpListener::bind((address.as_str(), 0)).unwrap().local_addr().unwrap().port();
                format!("http://{address}:{port}/")
            })
            .collect();
        let limits = Limits { allow: any_loopback, connect_timeout: Duration::from_millis(500), ..TEST };
        let (end, found) = check(&closed, &limits).await;
        assert_eq!(end, End::Offline);
        assert!(found.is_empty(), "{found:?}");
    }

    /// Acceptance 2: «Остановить» returns at once and drops what is in flight.
    #[tokio::test]
    async fn stop_returns_at_once() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(50).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let items: Vec<Item> = (0..40).map(|i| Item { id: i, url: format!("http://127.0.0.1:{port}/{i}") }).collect();
        let (stop, stopped) = watch::channel(false);
        let limits = Limits { timeout: Duration::from_secs(20), ..TEST };
        let reported = Arc::new(AtomicUsize::new(0));
        let counted = reported.clone();
        let task = tokio::spawn(async move { run(items, &limits, stopped, move |_, c| { if c.is_some() { counted.fetch_add(1, Ordering::SeqCst); } }).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let asked = Instant::now();
        stop.send(true).unwrap();
        let end = task.await.unwrap();
        assert_eq!(end, End::Stopped);
        assert!(asked.elapsed() < Duration::from_millis(300), "{:?}", asked.elapsed());
        assert_eq!(reported.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn one_request_at_a_time_per_site_with_a_pause() {
        let times = Arc::new(Mutex::new(Vec::new()));
        let seen = times.clone();
        let (port, _) = server("127.0.0.1", move |_, _| {
            seen.lock().unwrap().push(Instant::now());
            status(200)
        });
        let urls: Vec<String> = (0..4).map(|i| format!("http://127.0.0.1:{port}/{i}")).collect();
        let limits = Limits { per_site: Duration::from_millis(150), ..TEST };
        let (_, found) = check(&urls, &limits).await;
        assert_eq!(found.len(), 4);
        let times = times.lock().unwrap();
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(140), "{:?}", pair[1] - pair[0]);
        }
    }

    /// Real sites, on demand: `cargo test --lib real_sites -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs the internet"]
    async fn real_sites() {
        let urls: Vec<String> = [
            "https://example.com/",
            "http://github.com/",
            "https://httpbin.org/status/404",
            "https://httpbin.org/status/410",
            "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.org%2F&status_code=301",
            "https://httpbin.org/status/503",
            "https://this-site-does-not-exist.invalid/",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (end, found) = check(&urls, &Limits::PUBLIC).await;
        for c in &found {
            println!("{:<80} {:?} {:?} {:?} {:?}", c.url, c.outcome, c.status, c.reason, c.target);
        }
        assert_eq!(end, End::Done);
        let outcomes: Vec<Outcome> = found.iter().map(|c| c.outcome).collect();
        assert_eq!(
            outcomes,
            [Outcome::Ok, Outcome::Ok, Outcome::Gone, Outcome::Gone, Outcome::Moved, Outcome::Failed, Outcome::Failed]
        );
    }

    // ---- The library.

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn saved(conn: &Connection, url: &str) -> Bookmark {
        insert_or_update_bookmark(conn, url, url, None, None, None, &crate::metadata::extract_domain(url), None, None, Source::Chrome).unwrap()
    }

    fn result(b: &Bookmark, outcome: Outcome, status: Option<u16>, target: Option<&str>) -> Checked {
        Checked { id: b.id, url: b.url.clone(), outcome, status, reason: (outcome == Outcome::Failed).then_some(Reason::Timeout), target: target.map(Into::into) }
    }

    #[test]
    fn the_report_groups_results_that_still_hold() {
        let conn = library();
        let gone = saved(&conn, "https://example.com/gone");
        let moved = saved(&conn, "http://orca.dev/");
        let twin = saved(&conn, "https://trezor.io/shop");
        saved(&conn, "https://trezor.io/");
        let failed = saved(&conn, "https://slow.example/");
        let fine = saved(&conn, "https://fine.example/");
        let local = saved(&conn, "http://192.168.1.1/");
        let trashed = saved(&conn, "https://example.com/trashed");
        saved(&conn, "https://never.example/");
        save(
            &conn,
            &[
                result(&gone, Outcome::Gone, Some(404), None),
                result(&moved, Outcome::Moved, Some(200), Some("https://onorca.dev/")),
                result(&twin, Outcome::Moved, Some(200), Some("https://trezor.io/")),
                result(&failed, Outcome::Failed, None, None),
                result(&fine, Outcome::Ok, Some(200), None),
                result(&local, Outcome::Local, None, None),
                result(&trashed, Outcome::Gone, Some(404), None),
                // Deleted for good meanwhile: skipped.
                Checked { id: 9_999, url: "https://x/".into(), outcome: Outcome::Ok, status: None, reason: None, target: None },
            ],
            "2026-10-05T12:00:00.000Z",
        )
        .unwrap();
        trash_bookmark(&conn, trashed.id).unwrap();
        let report = report(&conn).unwrap();
        assert_eq!(report.gone.iter().map(|l| l.bookmark.id).collect::<Vec<_>>(), [gone.id]);
        assert_eq!(report.moved.len(), 2);
        let conflict: Vec<bool> = report.moved.iter().map(|l| l.conflict).collect();
        assert_eq!(conflict.iter().filter(|c| **c).count(), 1, "trezor.io/ is already saved");
        assert_eq!(report.failed[0].reason, Some(Reason::Timeout));
        assert_eq!((report.library, report.open, report.local, report.unchecked), (8, 1, 1, 2));
        assert_eq!(count(&conn).unwrap(), 3);

        // A bookmark whose address changed is unchecked again.
        conn.execute("UPDATE bookmarks SET url = 'https://example.com/elsewhere' WHERE id = ?1", [gone.id]).unwrap();
        assert!(report_of(&conn).gone.is_empty());
        assert_eq!(count(&conn).unwrap(), 2);
    }

    fn report_of(conn: &Connection) -> LinkCheckReport {
        report(conn).unwrap()
    }

    #[test]
    fn replacing_an_address_is_one_command_undone_with_its_result() {
        let conn = library();
        let mut journal = crate::journal::Journal::default();
        let moved = saved(&conn, "http://orca.dev/");
        let twin = saved(&conn, "https://trezor.io/shop");
        saved(&conn, "https://trezor.io/");
        let fine = saved(&conn, "https://fine.example/");
        save(
            &conn,
            &[
                result(&moved, Outcome::Moved, Some(200), Some("https://onorca.dev/")),
                result(&twin, Outcome::Moved, Some(200), Some("https://trezor.io/")),
                result(&fine, Outcome::Ok, Some(200), None),
            ],
            "2026-10-05T12:00:00.000Z",
        )
        .unwrap();
        let ids = [moved.id, twin.id, fine.id];
        let mut skipped = 0;
        let (changed, command) = journal
            .record(&conn, crate::journal::Action::Replace, &ids, |conn| {
                replace(conn, &ids).map(|(changed, s)| {
                    skipped = s;
                    changed
                })
            })
            .unwrap();
        assert_eq!((changed.len(), skipped), (1, 2), "the twin and the open one stay");
        let now = db::get_bookmark_by_id(&conn, moved.id).unwrap();
        assert_eq!((now.url.as_str(), now.domain.as_str()), ("https://onorca.dev/", "onorca.dev"));
        let key: String = conn.query_row("SELECT url_key FROM bookmarks WHERE id = ?1", [moved.id], |r| r.get(0)).unwrap();
        assert_eq!(key, "onorca.dev");
        let report = report_of(&conn);
        assert_eq!(report.moved.len(), 1, "only the twin is left");
        assert_eq!(report.open, 2, "the replaced address counts as open");
        let search = db::BookmarkQuery { search: Some("onorca".into()), ..Default::default() };
        assert_eq!(db::get_bookmarks(&conn, &search).unwrap().items.len(), 1, "the search finds the new address");

        // Ctrl Z: the old address and its result come back.
        match journal.undo(&conn, command).unwrap() {
            crate::journal::Undo::Undone { bookmarks, .. } => assert_eq!(bookmarks[0].url, "http://orca.dev/"),
            other => panic!("{other:?}"),
        }
        let back = db::get_bookmark_by_id(&conn, moved.id).unwrap();
        assert_eq!(back.domain, "orca.dev");
        assert_eq!(report_of(&conn).moved.len(), 2);
    }

    #[test]
    fn undo_of_a_replace_does_not_take_an_address_saved_since() {
        let conn = library();
        let mut journal = crate::journal::Journal::default();
        let moved = saved(&conn, "http://orca.dev/");
        save(&conn, &[result(&moved, Outcome::Moved, Some(200), Some("https://onorca.dev/"))], "2026-10-05T12:00:00.000Z").unwrap();
        let (_, command) = journal
            .record(&conn, crate::journal::Action::Replace, &[moved.id], |conn| replace(conn, &[moved.id]).map(|(c, _)| c))
            .unwrap();
        // The old address is saved again from the browser.
        saved(&conn, "http://orca.dev/");
        assert!(matches!(journal.undo(&conn, command).unwrap(), crate::journal::Undo::Conflict { .. }));
        assert_eq!(db::get_bookmark_by_id(&conn, moved.id).unwrap().url, "https://onorca.dev/");
    }

    #[test]
    fn a_stopped_check_goes_on_with_what_is_left() {
        let conn = library();
        let a = saved(&conn, "https://a.example/");
        let b = saved(&conn, "https://b.example/");
        let c = saved(&conn, "https://c.example/");
        // Checked last week, then a new run began and did `b`.
        save(&conn, &[result(&a, Outcome::Ok, Some(200), None), result(&b, Outcome::Ok, Some(200), None)], "2026-09-28T00:00:00.000Z").unwrap();
        db::set_setting(&conn, STARTED, "2026-10-05T00:00:00.000Z").unwrap();
        save(&conn, &[result(&b, Outcome::Ok, Some(200), None)], "2026-10-05T01:00:00.000Z").unwrap();
        let left: Vec<i64> = remaining(&conn, "2026-10-05T00:00:00.000Z").unwrap().iter().map(|i| i.id).collect();
        assert_eq!(left, [c.id, a.id], "never checked first, then the oldest");
        let report = report_of(&conn);
        assert_eq!((report.state, report.done, report.total), (RunState::Stopped, 1, 3));
        assert_eq!(chosen(&conn, &[a.id, 9_999]).unwrap().len(), 1);
    }

    #[test]
    fn a_hundred_thousand_results_are_counted_quickly() {
        let conn = library();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at)
             SELECT 'u' || i, 'https://example.com/' || i, 'Запись ' || i, 'example.com', '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z' FROM n;
             INSERT INTO link_checks (bookmark_id, url, checked_at, outcome, status)
             SELECT id, url, '2026-10-05T12:00:00.000Z', CASE WHEN id % 100 = 0 THEN 'gone' ELSE 'ok' END, 200 FROM bookmarks;",
        )
        .unwrap();
        let started = Instant::now();
        assert_eq!(count(&conn).unwrap(), 1000);
        let counted = started.elapsed();
        let started = Instant::now();
        let report = report_of(&conn);
        println!("100 000 results: count {counted:?}, report {:?}", started.elapsed());
        assert_eq!((report.gone.len(), report.open), (1000, 99_000));
        assert!(counted.as_millis() < 300, "count took {counted:?}");
    }
}
