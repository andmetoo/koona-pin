//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Sync between a Supporter's computers (NP-059, NP-060, NP-063, Р-68): the app's side of the
//! `koona-sync` engine and its relay client. Sync runs while the person turned it on here AND
//! this computer has Supporter; the relay checks the plan again on its own (`PROTOCOL.md` 2.1).
//!
//! - `identity.rs`: this device's id, key and name, in `sync-device.json` next to `account.json`.
//! - `worker.rs`: the client over the open library, its events, local changes pushed.
//! - `status.rs`: what the interface shows, from the client's events.
//!
//! `sync.json` next to the library keeps whether sync is on and when it last synced. Turning sync
//! off keeps the library a replica and the device registered: turning it on again goes on where
//! it stopped. `sync-notices.json` keeps the notices until the person dismisses them. `sync.log`
//! keeps what sync did, in ids and states (`log.rs`), for the report; turning sync off keeps it.

pub mod identity;
pub mod log;
pub mod status;
pub mod worker;

use crate::billing;
use crate::db::DbState;
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, Utc};
use identity::Identity;
use koona_sync::net::{Event, Stop};
use koona_sync::session::Action;
use serde::{Deserialize, Serialize};
use status::{Context, Model, Notices, Peers, Reaction, SyncAccount, SyncProblem, SyncStatus};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use uuid::Uuid;
use worker::Running;

pub use status::{PairingPrompt, PairingRole, PausedReason, SyncDevice, SyncDeviceStatus, SyncPhase, UnavailableReason};

pub const EVENT: &str = "sync-status";
const FILE: &str = "sync.json";
const NOTICES_FILE: &str = "sync-notices.json";
/// What is known of the other devices from syncing with them (`status::Peers`).
const PEERS_FILE: &str = "sync-devices.json";
/// How long a start-over sign-in is kept for a client yet to start: the relay takes one at most
/// 10 minutes old, and the client still has to connect and be welcomed.
const START_OVER_KEPT: Duration = Duration::from_secs(9 * 60);
/// The supervisor looks again this often without being woken: a plan that ran out offline, a
/// start that found no token.
const RECHECK: Duration = Duration::from_secs(5 * 60);
const RETRY_START: Duration = Duration::from_secs(60);

/// The relay, `wss://…/v1/sync`, from `.env` at build time (build.rs), as billing's service is.
const URL: Option<&str> = option_env!("KOONAPIN_SYNC_URL");

/// The relay of this build; none, and there is no sync. A development build also takes it from
/// the environment at run time, to test against a local relay.
pub fn sync_url() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("KOONAPIN_SYNC_URL").ok().filter(|u| !u.trim().is_empty()) {
        return Some(url.trim().to_string());
    }
    URL.map(str::trim).filter(|u| !u.is_empty()).map(str::to_string)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    last_sync_at: Option<DateTime<Utc>>,
    /// «Join…» chosen and the new key not in yet: kept across a restart (`Model::rejoining`).
    #[serde(default)]
    rejoining: bool,
}

pub struct SyncState {
    path: PathBuf,
    identity_path: PathBuf,
    /// The library key, beside the identity (`identity::KEY_FILE`).
    key_path: PathBuf,
    notices_path: PathBuf,
    /// Held while `sync-notices.json` is written, so writes land in order.
    notices_file: Mutex<()>,
    peers_path: PathBuf,
    /// Held while `sync-devices.json` is written.
    peers_file: Mutex<()>,
    /// The live bookmarks last counted, with the connection's writes and the file's version then
    /// (`bookmarks_key`): counted again only once either moved.
    bookmarks: Mutex<Option<((u64, i64), u64)>>,
    stored: Mutex<Stored>,
    /// This device; `saved` once it is in its file. Shown before sync is ever turned on without
    /// writing anything.
    identity: Mutex<Option<(Identity, bool)>>,
    model: Mutex<Model>,
    run: Mutex<Option<Running>>,
    /// Of the current client: events of one being replaced are dropped.
    generation: AtomicU64,
    /// The last supervisor pass found the library open and a replica.
    library_ready: AtomicBool,
    /// A start-over sign-in waiting for the client the supervisor starts (`start_over`).
    start_over: Mutex<KeptToken>,
    wake: tokio::sync::Notify,
    /// `sync.log`, which the model writes to as well.
    log: log::SyncLog,
    /// What the supervisor last decided, noted only when it changes (it looks every few minutes).
    decided: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl SyncState {
    fn load(folder: PathBuf) -> SyncState {
        let path = folder.join(FILE);
        let stored: Stored = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let notices_path = folder.join(NOTICES_FILE);
        let mut model = Model::default();
        model.last_sync_at = stored.last_sync_at;
        model.rejoining = stored.rejoining;
        model.notices = fs::read_to_string(&notices_path).ok().and_then(|t| serde_json::from_str::<Notices>(&t).ok()).unwrap_or_default();
        let peers_path = folder.join(PEERS_FILE);
        model.peers = fs::read_to_string(&peers_path).ok().and_then(|t| serde_json::from_str::<Peers>(&t).ok()).unwrap_or_default();
        let log = log::SyncLog::new(&folder);
        model.sink = Some(log.clone());
        SyncState {
            path,
            identity_path: folder.join(identity::FILE),
            key_path: folder.join(identity::KEY_FILE),
            notices_path,
            notices_file: Mutex::new(()),
            peers_path,
            peers_file: Mutex::new(()),
            bookmarks: Mutex::new(None),
            stored: Mutex::new(stored),
            identity: Mutex::new(None),
            model: Mutex::new(model),
            run: Mutex::new(None),
            generation: AtomicU64::new(0),
            library_ready: AtomicBool::new(false),
            start_over: Mutex::new(KeptToken::default()),
            wake: tokio::sync::Notify::new(),
            log,
            decided: Mutex::new(None),
        }
    }

    /// A line of the log from outside the model: the supervisor, the commands, the client's
    /// credentials. Ids and states only (`log.rs`).
    pub(crate) fn note(&self, line: &str) {
        self.log.line(Utc::now(), line);
    }

    /// What a supervisor pass decided, noted when it differs from the last.
    fn decide(&self, line: &str) {
        let mut decided = lock(&self.decided);
        if decided.as_deref() != Some(line) {
            *decided = Some(line.to_string());
            drop(decided);
            self.note(&format!("supervisor: {line}"));
        }
    }

    fn stored(&self) -> Stored {
        lock(&self.stored).clone()
    }

    /// Changes and writes `sync.json` under one lock, through a temporary file, as billing.rs does.
    fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<(), CommandError> {
        let mut stored = lock(&self.stored);
        let mut next = stored.clone();
        change(&mut next);
        if let Some(folder) = self.path.parent() {
            fs::create_dir_all(folder).map_err(CommandError::internal)?;
        }
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_string_pretty(&next).map_err(CommandError::internal)?).map_err(CommandError::internal)?;
        fs::rename(&temporary, &self.path).map_err(CommandError::internal)?;
        *stored = next;
        Ok(())
    }

    /// This device as shown: the saved one, or one made in memory until sync is turned on.
    fn shown_identity(&self) -> Identity {
        let mut slot = lock(&self.identity);
        if let Some((identity, _)) = &*slot {
            return identity.clone();
        }
        let entry = if crate::secrets::exists(&self.identity_path) {
            match Identity::load_or_create(&self.identity_path) {
                Ok(identity) => (identity, true),
                // There but unreadable now (the iPhone's Keychain before the first unlock): shown
                // for this once, not kept, so the next look reads the real one.
                Err(_) => return Identity::new(""),
            }
        } else {
            (Identity::new(""), false)
        };
        let identity = entry.0.clone();
        *slot = Some(entry);
        identity
    }

    /// This device, written to its file if it is not yet.
    fn saved_identity(&self) -> Result<Identity, CommandError> {
        let mut slot = lock(&self.identity);
        if let Some((identity, true)) = &*slot {
            return Ok(identity.clone());
        }
        let identity = match slot.take() {
            // The one shown so far, unless a file appeared meanwhile.
            Some((shown, false)) if !crate::secrets::exists(&self.identity_path) => {
                shown.save(&self.identity_path).map_err(CommandError::internal)?;
                shown
            }
            _ => Identity::load_or_create(&self.identity_path).map_err(CommandError::internal)?,
        };
        *slot = Some((identity.clone(), true));
        Ok(identity)
    }

    fn set_identity(&self, identity: Identity) -> Result<(), CommandError> {
        identity.save(&self.identity_path).map_err(CommandError::internal)?;
        *lock(&self.identity) = Some((identity, true));
        Ok(())
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn on_event(&self, event: Event) -> Vec<Reaction> {
        lock(&self.model).on_event(event, Utc::now())
    }

    fn keep_last_sync(&self) {
        let (at, rejoining) = {
            let model = lock(&self.model);
            (model.last_sync_at, model.rejoining)
        };
        let _ = self.update(|s| {
            s.last_sync_at = at;
            s.rejoining = rejoining;
        });
    }

    /// Writes the notices as the model has them now, through a temporary file.
    fn keep_notices(&self) -> Result<(), CommandError> {
        let _one = lock(&self.notices_file);
        let notices = lock(&self.model).notices.clone();
        if let Some(folder) = self.notices_path.parent() {
            fs::create_dir_all(folder).map_err(CommandError::internal)?;
        }
        let temporary = self.notices_path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_string_pretty(&notices).map_err(CommandError::internal)?).map_err(CommandError::internal)?;
        fs::rename(&temporary, &self.notices_path).map_err(CommandError::internal)
    }

    /// Writes what is known of the other devices, through a temporary file.
    fn keep_peers(&self) -> Result<(), CommandError> {
        let _one = lock(&self.peers_file);
        let peers = lock(&self.model).peers.clone();
        if let Some(folder) = self.peers_path.parent() {
            fs::create_dir_all(folder).map_err(CommandError::internal)?;
        }
        let temporary = self.peers_path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_string_pretty(&peers).map_err(CommandError::internal)?).map_err(CommandError::internal)?;
        fs::rename(&temporary, &self.peers_path).map_err(CommandError::internal)
    }

    /// Live bookmarks in the open library, counted again only after a write: the count is shown
    /// with every status, many a second while syncing. Never waits for the library: one busy
    /// shows the last count.
    fn bookmarks(&self, app: &AppHandle) -> Option<u64> {
        let db = app.try_state::<Arc<DbState>>()?;
        let mut cached = lock(&self.bookmarks);
        let Ok(conn) = db.conn.try_lock() else {
            return cached.map(|(_, count)| count);
        };
        let key = bookmarks_key(&conn).ok()?;
        if let Some((at, count)) = *cached {
            if at == key {
                return Some(count);
            }
        }
        let count = live_bookmarks(&conn).ok()?;
        *cached = Some((key, count));
        Some(count)
    }

    /// Changes the notices and keeps them if they changed.
    fn change_notices(&self, change: impl FnOnce(&mut Notices) -> bool) -> Result<(), CommandError> {
        let changed = change(&mut lock(&self.model).notices);
        if changed {
            self.keep_notices()?;
        }
        Ok(())
    }

    /// The key file was set aside: shown until a key comes again.
    fn key_lost(&self, app: &AppHandle) {
        {
            let mut model = lock(&self.model);
            model.note(Utc::now(), "key file set aside: waiting for the key".into());
            model.error = Some(SyncProblem::KeyLost);
        }
        self.emit(app);
    }

    /// The client of `generation` found another library in place of its own.
    fn library_replaced(&self, generation: u64) {
        let mut run = lock(&self.run);
        if run.as_ref().is_some_and(|r| r.generation == generation) {
            *run = None;
            self.note(&format!("client {generation} stopped: the library was replaced"));
            let mut model = lock(&self.model);
            model.restart();
            model.error = Some(SyncProblem::LibraryReplaced);
        }
    }

    /// The client of `generation` gave up (a close code no retry cures): it is not restarted
    /// until the person acts or the plan changes.
    fn finished(&self, generation: u64) {
        let mut run = lock(&self.run);
        if run.as_ref().is_some_and(|r| r.generation == generation) {
            *run = None;
            self.note(&format!("client {generation} finished"));
        }
    }

    fn context<'a>(&self, app: &AppHandle, identity: &'a Identity) -> Context<'a> {
        Context {
            enabled: self.stored().enabled,
            service: sync_url().is_some(),
            plan: billing::has_plan(app),
            library_ready: self.library_ready.load(Ordering::SeqCst),
            identity,
            app: app.package_info().version.to_string(),
            bookmarks: self.bookmarks(app),
        }
    }

    fn status(&self, app: &AppHandle) -> SyncStatus {
        let identity = self.shown_identity();
        let context = self.context(app, &identity);
        lock(&self.model).status(&context)
    }

    fn emit(&self, app: &AppHandle) -> SyncStatus {
        let status = self.status(app);
        let _ = app.emit(EVENT, status.clone());
        status
    }

    fn handle(&self) -> Option<koona_sync::net::Handle> {
        lock(&self.run).as_ref().filter(|r| !r.finished()).map(|r| r.handle.clone())
    }

    /// Gives a kept start-over sign-in to the running client, if both are there. Taken under one
    /// lock, so `start_over` and the supervisor never both send it.
    /// A kept one grown too old for the relay is dropped, and the person is told as the relay would
    /// tell them (`StaleSignIn`, whose banner offers to start over again): the command already
    /// answered that it was under way.
    fn hand_over_start_over(&self, app: &AppHandle) {
        let expired = expire_kept(&mut lock(&self.start_over), &mut lock(&self.model), Instant::now());
        if expired {
            self.emit(app);
            return;
        }
        let Some(handle) = self.handle() else { return };
        let Some(token) = lock(&self.start_over).take() else { return };
        // The session holds it until the relay's `welcome`.
        if handle.act(Action::StartOver { token }) {
            self.note("start over: the sign-in went to the client");
        } else {
            self.note("start over: the client stopped before it got the sign-in");
        }
    }

    /// Whether a supervisor pass may still start a client, asked under the `run` lock right before
    /// it does: what it decided on at its start (sync on, the plan, no stop) may have changed while
    /// it waited for the library and the token. `disable_sync` turns `enabled` off before it takes
    /// `run`, so a client started after this said yes is one it then stops.
    fn may_start(&self, plan: bool) -> bool {
        self.stored().enabled && plan && lock(&self.model).stop.is_none()
    }

    fn clear_stop(&self) {
        let mut model = lock(&self.model);
        model.stop = None;
        model.error = None;
    }
}

/// Wakes the supervisor: the person acted, the plan or the library changed.
pub(crate) fn wake(app: &AppHandle) {
    if let Some(state) = app.try_state::<SyncState>() {
        state.wake.notify_one();
    }
}

/// Called in `setup` after `billing::start`: the supervisor starts the client when everything it
/// needs is there and stops it when something goes, woken by the plan, the library and the
/// person's commands.
pub fn start(app: &AppHandle) {
    app.manage(SyncState::load(app.state::<std::sync::Arc<crate::library_state::Library>>().paths.folder()));
    {
        let state = app.state::<SyncState>();
        let on = if state.stored().enabled { "on" } else { "off" };
        state.note(&format!("app {} on {} started, sync {on}", app.package_info().version, koona_sync::protocol::platform()));
    }
    for event in [billing::EVENT, "library-status", "library-invalidated"] {
        let handle = app.clone();
        app.listen_any(event, move |_| {
            if event == billing::EVENT {
                // A plan back, or a new sign-in: a client stopped by the relay for either may
                // try again.
                if let Some(state) = handle.try_state::<SyncState>() {
                    let mut model = lock(&state.model);
                    if matches!(model.stop, Some(Stop::Plan(_) | Stop::Auth)) {
                        model.stop = None;
                    }
                }
            } else if let Some(state) = handle.try_state::<SyncState>() {
                // Another library, or one restored over this: its own count.
                *lock(&state.bookmarks) = None;
            }
            wake(&handle);
        });
    }
    let app = app.clone();
    let mut foreground = crate::lifecycle::foreground(&app);
    tauri::async_runtime::spawn(async move {
        loop {
            // Behind a phone's screen the supervisor waits (NP-151); closing the session there is
            // NP-153.
            foreground.wait().await;
            let wait = supervise(&app).await;
            let state = app.state::<SyncState>();
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = state.wake.notified() => {}
                _ = foreground.suspended() => {}
            }
        }
    });
}

/// The library's replica, made one if sync is on and it is not yet (turned on, or restored
/// from a copy made before sync), with `worker::start_counter` read before any client starts;
/// None when the library is not open or has no sync tables.
async fn replica(app: &AppHandle) -> Option<(Arc<DbState>, Uuid, Option<i64>)> {
    let db = app.try_state::<Arc<DbState>>()?.inner().clone();
    let state = db.clone();
    let app_for_log = app.clone();
    let (replica, counter) = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().ok()?;
        match worker::prepare_library(&conn) {
            Ok(replica) => Some((replica, worker::start_counter(&conn))),
            Err(error) => {
                eprintln!("Sync cannot use the library: {error}");
                if let Some(state) = app_for_log.try_state::<SyncState>() {
                    state.note(if matches!(error, koona_sync::Error::NoSyncSchema) { "library has no sync tables" } else { "library could not be prepared" });
                }
                None
            }
        }
    })
    .await
    .ok()
    .flatten()?;
    Some((db, replica, counter))
}

/// One pass: starts, keeps or stops the client. Returns when to look again.
async fn supervise(app: &AppHandle) -> Duration {
    let state = app.state::<SyncState>();
    let enabled = state.stored().enabled;
    let url = sync_url();
    let plan = billing::has_plan(app);
    let library = if enabled && url.is_some() && plan { replica(app).await } else { None };
    state.library_ready.store(library.is_some() || !enabled, Ordering::SeqCst);
    let stopped = lock(&state.model).stop.is_some();
    let why = if !enabled {
        "sync off"
    } else if url.is_none() {
        "no relay in this build"
    } else if !plan {
        "no plan"
    } else if library.is_none() {
        "no library ready"
    } else if stopped {
        "stopped until the person acts"
    } else {
        ""
    };
    let (Some(url), Some((db, replica, counter)), false) = (url, library, stopped) else {
        state.decide(why);
        // A stop stays shown (and keeps the client from starting again) until the person acts.
        if let Some(old) = lock(&state.run).take() {
            state.note(&format!("client {} stopped: {why}", old.generation));
            if !stopped {
                lock(&state.model).restart();
            }
        }
        state.emit(app);
        return RECHECK;
    };
    // The account, from its token: the relay `hello` signs it.
    let sub = billing::sync_credentials(app, false).await.ok().flatten().and_then(|(token, _)| worker::jwt_sub(&token));
    let Some(sub) = sub else {
        // Signed out (the plan check stops the client then), or the token wants a refresh and the
        // account service is away: a running client goes on with what it has, and a start waits.
        state.decide("no account token");
        state.emit(app);
        return RETRY_START;
    };
    {
        let mut run = lock(&state.run);
        let keep = run.as_ref().is_some_and(|r| r.sub == sub && r.replica == replica && !r.finished() && !r.abandoned());
        if !keep && !state.may_start(billing::has_plan(app)) {
            // Turned off, the plan gone or a stop while this pass waited for the library and the
            // token: nothing starts, and the next pass, at once, settles the rest.
            drop(run);
            state.decide("not started: changed while waiting");
            state.emit(app);
            return Duration::ZERO;
        }
        if keep {
            state.decide("running");
        } else {
            let identity = match state.saved_identity() {
                Ok(identity) => identity,
                Err(error) => {
                    eprintln!("Sync cannot keep this device's identity: {}", error.message);
                    state.decide("this device's identity can't be kept");
                    return RETRY_START;
                }
            };
            // The old client stops as it is dropped.
            if let Some(old) = run.take() {
                let why = if old.sub != sub {
                    "another account"
                } else if old.replica != replica {
                    "another library"
                } else if old.abandoned() {
                    "library replaced"
                } else {
                    "it had finished"
                };
                state.note(&format!("client {} stopped: {why}", old.generation));
            }
            let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.decide("running");
            state.note(&format!("client {generation} started for device {}", log::short(&identity.device)));
            {
                let mut model = lock(&state.model);
                model.restart();
                model.me = Some(identity.device);
            }
            *run = Some(worker::spawn(app, worker::Start { url, key_file: state.key_path.clone(), db, replica, identity, sub, generation, counter }));
        }
    }
    state.hand_over_start_over(app);
    state.emit(app);
    RECHECK
}

/// A start-over sign-in kept for a client that isn't up yet: the email code is spent once it
/// signed in, so the token waits for the client instead of being thrown away. Dropped once too
/// old for the relay.
#[derive(Default)]
struct KeptToken {
    kept: Option<(String, Instant)>,
}

impl KeptToken {
    fn keep(&mut self, token: String, now: Instant) {
        self.kept = Some((token, now));
    }

    /// The token, if one is kept; [`KeptToken::expire`] first drops one too old.
    fn take(&mut self) -> Option<String> {
        self.kept.take().map(|(token, _)| token)
    }

    /// Drops a token too old to send. Whether one went.
    fn expire(&mut self, now: Instant) -> bool {
        let old = self.kept.as_ref().is_some_and(|(_, at)| now.saturating_duration_since(*at) > START_OVER_KEPT);
        if old {
            self.kept = None;
        }
        old
    }

    fn clear(&mut self) {
        self.kept = None;
    }
}

/// Drops a kept start-over sign-in that grew too old and shows it as the relay's refusal would.
/// Whether it did.
fn expire_kept(kept: &mut KeptToken, model: &mut Model, now: Instant) -> bool {
    if !kept.expire(now) {
        return false;
    }
    model.note(Utc::now(), "start over: the sign-in grew too old before sync connected".into());
    model.error = Some(SyncProblem::StaleSignIn);
    true
}

/// The guards of turning sync on: a relay in this build, then Supporter.
pub fn need_sync(service: bool, plan: bool) -> Result<(), CommandError> {
    if !service {
        return Err(CommandError::new(ErrorCode::InvalidRequest, "This build has no sync service"));
    }
    if !plan {
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::NotSupporter, "Sync is for Supporters"));
    }
    Ok(())
}

/// What the bookmark count was taken at: this connection's writes and the file's version, which
/// moves when another process (the MCP server) commits.
fn bookmarks_key(conn: &rusqlite::Connection) -> rusqlite::Result<(u64, i64)> {
    Ok((conn.total_changes(), conn.query_row("PRAGMA data_version", [], |r| r.get(0))?))
}

/// Bookmarks not in the trash.
fn live_bookmarks(conn: &rusqlite::Connection) -> rusqlite::Result<u64> {
    conn.query_row("SELECT COUNT(*) FROM bookmarks WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0)).map(|n| n.max(0) as u64)
}

fn device_id(text: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(text).map_err(|_| CommandError::invalid("Not a device id"))
}

/// An action of the person for the running session.
fn act(app: &AppHandle, action: Action) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    let handle = state.handle().ok_or_else(|| CommandError::invalid("Sync is not running"))?;
    lock(&state.model).error = None;
    if !handle.act(action) {
        return Err(CommandError::invalid("Sync is not running"));
    }
    Ok(state.emit(app))
}

/// This device after a removal: the relay never lets its id in again (4003), so turning sync on
/// later is a new device, paired anew.
fn forget_revoked(state: &SyncState) -> Result<(), CommandError> {
    if matches!(lock(&state.model).stop, Some(Stop::Revoked)) {
        let name = state.shown_identity().name;
        state.set_identity(Identity::new(&name))?;
    }
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_sync_status(app: AppHandle) -> SyncStatus {
    app.state::<SyncState>().status(&app)
}

/// «Turn on sync», with this computer's name (the computer's own when empty). The first device
/// of the account becomes the hub; another one waits to be paired from the hub, its bookmarks
/// merged with the account's once it is (NP-061).
#[tauri::command]
pub async fn enable_sync(app: AppHandle, name: Option<String>) -> Result<SyncStatus, CommandError> {
    need_sync(sync_url().is_some(), billing::has_plan(&app))?;
    let state = app.state::<SyncState>();
    let db = app
        .try_state::<Arc<DbState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| CommandError::detailed(ErrorCode::DatabaseBusy, ErrorDetail::LibraryOpening, "The library is still opening"))?;
    forget_revoked(&state)?;
    let mut identity = state.saved_identity()?;
    if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
        identity.name = koona_sync::session::device_name(name.trim());
        state.set_identity(identity)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().map_err(CommandError::internal)?;
        worker::prepare_library(&conn).map_err(|e| match e {
            koona_sync::Error::Sql(e) => CommandError::from(e),
            other => CommandError::new(ErrorCode::DatabaseError, other.to_string()),
        })
    })
    .await
    .map_err(CommandError::internal)??;
    state.update(|s| {
        s.enabled = true;
        s.rejoining = false;
    })?;
    state.note("sync turned on");
    lock(&state.model).rejoining = false;
    // The first directory after turning sync on tells of no device added.
    state.change_notices(|n| n.known.take().is_some())?;
    state.clear_stop();
    wake(&app);
    Ok(state.emit(&app))
}

/// «Turn off sync»: the client stops; the library and the device's place on the account stay.
#[tauri::command]
pub fn disable_sync(app: AppHandle) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    // A «Join…» under way ends with sync off: no new key is coming.
    state.update(|s| {
        s.enabled = false;
        s.rejoining = false;
    })?;
    state.note("sync turned off");
    lock(&state.run).take();
    // A start over asked for while the client was down isn't wanted with sync off.
    lock(&state.start_over).clear();
    {
        let mut model = lock(&state.model);
        model.restart();
        model.error = None;
        model.rejoining = false;
    }
    wake(&app);
    Ok(state.emit(&app))
}

/// On the hub, after the person compared the six digits.
#[tauri::command]
pub fn approve_device(app: AppHandle, device: String) -> Result<SyncStatus, CommandError> {
    act(&app, Action::ApprovePairing { device: device_id(&device)? })
}

#[tauri::command]
pub fn reject_device(app: AppHandle, device: String) -> Result<SyncStatus, CommandError> {
    act(&app, Action::RejectPairing { device: device_id(&device)? })
}

/// On the hub: the device is removed and the library key rotated, so it reads nothing after.
#[tauri::command]
pub fn remove_device(app: AppHandle, device: String) -> Result<SyncStatus, CommandError> {
    act(&app, Action::RemoveDevice { device: device_id(&device)? })
}

/// «Make main» on a device that isn't the hub: asks the hub, which shows Allow / Deny. An offline
/// hub makes this fail with `HubOffline`; the person may then start over from here.
#[tauri::command]
pub fn request_main(app: AppHandle) -> Result<SyncStatus, CommandError> {
    act(&app, Action::RequestHub)
}

/// On the hub: the answer to `request_main`. Allow hands the hub over to the asking device.
#[tauri::command]
pub fn answer_main_request(app: AppHandle, allow: bool) -> Result<SyncStatus, CommandError> {
    act(&app, Action::AnswerHubRequest { allow })
}

/// «Start over from this computer», step one: a code is emailed to the account's address,
/// which is returned for the dialog to show.
#[tauri::command]
pub async fn send_start_over_code(app: AppHandle) -> Result<String, CommandError> {
    billing::send_code_to_signed_in(&app).await
}

/// Step two: the code signs in afresh and the relay starts the account over from this device:
/// every other device is disconnected, this one becomes the main computer with a new key. A
/// sign-in too old for the relay comes back as `StaleSignIn` in the status. With the client
/// stopped, the sign-in is kept for the client the supervisor starts (`KeptToken`).
#[tauri::command]
pub async fn start_over(app: AppHandle, code: String) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    if !state.stored().enabled {
        return Err(CommandError::invalid("Sync is off"));
    }
    match state.handle() {
        // Running: the code is checked only now, so it isn't spent on a client that can't send it.
        Some(handle) => {
            let token = billing::sign_in_again(&app, &code).await?;
            lock(&state.model).error = None;
            // The session sends it once the relay welcomed it, now if it already did.
            if !handle.act(Action::StartOver { token }) {
                return Err(CommandError::invalid("Sync is not running"));
            }
            state.note("start over: signed in again, sent to the running client");
        }
        None => {
            // Stopped. Starting over can't cure another process on this device, the plan or an
            // old app: those stops stay, and no code is spent.
            let stop = lock(&state.model).stop.clone();
            if !matches!(stop, None | Some(Stop::Revoked | Stop::Auth | Stop::Shutdown)) {
                return Err(CommandError::invalid("Sync is paused for a reason starting over doesn't change"));
            }
            // The code before anything changes: a wrong one leaves the stop and the identity.
            let token = billing::sign_in_again(&app, &code).await?;
            // A removed device comes back as a new one (its old id stays refused), started to send it.
            forget_revoked(&state)?;
            // Kept before the supervisor is woken, so the client it starts finds it; one started
            // meanwhile gets it here.
            lock(&state.start_over).keep(token, Instant::now());
            state.note(&format!("start over: signed in again, kept for the next client (stop {})", stop.as_ref().map_or("none".to_string(), |s| format!("{s:?}"))));
            state.clear_stop();
            lock(&state.model).error = None;
            wake(&app);
            state.hand_over_start_over(&app);
            // No client may come in time (no token, the library not open): it is told then.
            let later = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(START_OVER_KEPT + Duration::from_secs(1)).await;
                later.state::<SyncState>().hand_over_start_over(&later);
            });
        }
    }
    Ok(state.emit(&app))
}

/// «Join…» after sync was started over elsewhere: pairs this device with the new main computer;
/// its bookmarks merge back.
#[tauri::command]
pub fn join_sync_again(app: AppHandle) -> Result<SyncStatus, CommandError> {
    act(&app, Action::JoinAgain)?;
    let state = app.state::<SyncState>();
    // Its last sync is forgotten once the new key is in (the model, on the epoch), not now: a
    // pairing rejected leaves it as it was.
    lock(&state.model).rejoining = true;
    state.note("join again: asked to pair with the main computer");
    state.keep_last_sync();
    state.change_notices(|n| n.joined())?;
    Ok(state.emit(&app))
}

/// Before turning sync on: asks the relay whether the account already has a main computer, without
/// registering this one. Fails like the connection would (no plan, signed out, offline).
#[tauri::command]
pub async fn get_sync_account(app: AppHandle) -> Result<SyncAccount, CommandError> {
    let url = sync_url();
    need_sync(url.is_some(), billing::has_plan(&app))?;
    let url = url.as_deref().and_then(account_url).ok_or_else(|| CommandError::internal("The sync service's address is not ws:// or wss://"))?;
    let client = billing::client(&app)?;
    // A token the relay refuses is refreshed once, as the connection does after 4001.
    let mut refresh = false;
    loop {
        // Offline or the account service away is that error, not being signed out.
        let (token, lease) = billing::sync_credentials(&app, refresh).await?.ok_or_else(signed_out)?;
        let response = client
            .get(&url)
            .bearer_auth(token)
            .header("X-Koona-Lease", lease)
            .header("X-Koona-Proto", koona_sync::protocol::PROTO.to_string())
            .send()
            .await
            .map_err(billing::offline)?;
        let status = response.status().as_u16();
        if status == 401 && !refresh {
            refresh = true;
            continue;
        }
        let body = response.text().await.map_err(billing::offline)?;
        return account_answer(status, &body, app.state::<SyncState>().shown_identity().device);
    }
}

fn signed_out() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::SignedOut, "Not signed in")
}

/// `GET /v1/account` beside the relay's socket (`PROTOCOL.md` 2.7): `wss://host/v1/sync` asks
/// `https://host/v1/account`, `ws://` asks `http://`, under the same path prefix if any.
pub fn account_url(sync_url: &str) -> Option<String> {
    let mut url = url::Url::parse(sync_url.trim()).ok()?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return None,
    };
    url.set_scheme(scheme).ok()?;
    let path = url.path().trim_end_matches('/');
    let prefix = path.strip_suffix("/v1/sync").unwrap_or("").to_string();
    url.set_path(&format!("{prefix}/v1/account"));
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

#[derive(Deserialize)]
struct AccountAnswer {
    hub: Option<AccountHub>,
}

#[derive(Deserialize)]
struct AccountHub {
    id: Uuid,
    name: String,
    /// Relays before stage 3 of the sync fixes send neither.
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    last_seen: Option<u64>,
}

/// The relay's answer to `GET /v1/account` as the command's: its refusals as the connection's
/// close codes would be shown (426 for 4004, 401 for 4001, 403 for 4002). A hub that is this
/// device `me` (a former main computer turning sync on again) is no other main to join.
pub fn account_answer(status: u16, body: &str, me: Uuid) -> Result<SyncAccount, CommandError> {
    // `{"code": 4002, "reason": "not_in_beta"}`, for the log.
    let reason = || {
        serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
            .unwrap_or_default()
    };
    match status {
        200 => serde_json::from_str::<AccountAnswer>(body)
            .map(|answer| match answer.hub.filter(|hub| hub.id != me) {
                Some(hub) => SyncAccount { main_name: Some(hub.name), main_online: hub.online, main_last_seen: hub.last_seen },
                None => SyncAccount { main_name: None, main_online: None, main_last_seen: None },
            })
            .map_err(|e| CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("The sync service answered {e}"))),
        401 => Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::SignedOut, "The sync service refused the sign-in")),
        403 => Err(CommandError::detailed(
            ErrorCode::InvalidRequest,
            ErrorDetail::NotSupporter,
            format!("The sync service says the plan has no sync: {}", reason()),
        )),
        426 => Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::UpdateNeeded, "The sync service needs a newer Koona Pin")),
        429 => Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "The sync service asks to wait")),
        other => Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("The sync service answered {other}"))),
    }
}

/// The notice of that id goes; one already gone is no error.
#[tauri::command]
pub fn dismiss_sync_notice(app: AppHandle, id: String) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    state.change_notices(|n| n.dismiss(&id))?;
    Ok(state.emit(&app))
}

/// Any active device renames any device; this one's name is kept here too, for its next `hello`.
#[tauri::command]
pub fn rename_device(app: AppHandle, device: String, name: String) -> Result<SyncStatus, CommandError> {
    let id = device_id(&device)?;
    let name = koona_sync::session::device_name(name.trim());
    if name.is_empty() {
        return Err(CommandError::invalid("A device needs a name"));
    }
    let state = app.state::<SyncState>();
    let mut identity = state.shown_identity();
    if id == identity.device {
        identity.name = name.clone();
        state.set_identity(identity)?;
    }
    match state.handle() {
        Some(_) => act(&app, Action::Rename { device: id, name }),
        None if id == state.shown_identity().device => Ok(state.emit(&app)),
        None => Err(CommandError::invalid("Sync is not running")),
    }
}

/// «Sync now»: a full exchange with every peer; on a device waiting to be paired, the offer
/// again. After a stop (removed, replaced, the plan) it starts the client again.
#[tauri::command]
pub fn sync_now(app: AppHandle) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    if !state.stored().enabled {
        return Err(CommandError::invalid("Sync is off"));
    }
    let pending = matches!(lock(&state.model).phase, Some(koona_sync::session::Phase::Pending));
    match state.handle() {
        Some(_) => act(&app, if pending { Action::StartPairing } else { Action::SyncNow }),
        None => {
            forget_revoked(&state)?;
            state.clear_stop();
            wake(&app);
            Ok(state.emit(&app))
        }
    }
}

/// What support needs to see why sync does what it does: states, ids, every device the relay
/// lists (removed ones too: an earlier identity of this computer is one), the key's generation
/// and whose its file is, and the tail of `sync.log`. No device name (one can be a person's name
/// or an address: Details promises none), no email, no account id, no bookmark, collection or
/// tag, and no key: a device is told apart by its short id, system and version.
///
/// On the blocking pool, not the main thread a plain command runs on: it waits for the log to be
/// written (half a second at most) and reads both files. No lock is held meanwhile; the model's is
/// taken last, for the lines made from it.
#[tauri::command]
pub async fn copy_sync_report(app: AppHandle) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || sync_report(&app)).await.map_err(CommandError::internal)
}

fn sync_report(app: &AppHandle) -> String {
    let state = app.state::<SyncState>();
    let status = state.status(app);
    let account = lock(&state.run).as_ref().map(|r| r.sub.clone());
    let facts = ReportFacts {
        version: app.package_info().version.to_string(),
        platform: koona_sync::protocol::platform().to_string(),
        relay: sync_url().as_deref().and_then(relay_host),
        enabled: state.stored().enabled,
        key: identity::key_file_state(&state.key_path, account.as_deref()),
        set_aside: set_aside_files(&state),
        log: state.log.tail(REPORT_LOG_LINES),
    };
    let model = lock(&state.model);
    report(&status, &model, &facts)
}

/// Lines of `sync.log` the report ends with.
const REPORT_LOG_LINES: usize = 200;

/// `sync.log` in the file manager, from Details. A log not written yet shows its folder. On the
/// blocking pool, as it waits for the log to be written.
#[cfg(desktop)]
#[tauri::command]
pub async fn reveal_sync_log(app: AppHandle) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || reveal_log(&app)).await.map_err(CommandError::internal)?
}

#[cfg(desktop)]
fn reveal_log(app: &AppHandle) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    let state = app.state::<SyncState>();
    state.log.flush(Duration::from_millis(500));
    let path = state.log.path().to_path_buf();
    if path.exists() {
        return app.opener().reveal_item_in_dir(path).map_err(CommandError::internal);
    }
    let folder = path.parent().map(std::path::Path::to_path_buf).ok_or_else(|| CommandError::internal("the sync log has no folder"))?;
    fs::create_dir_all(&folder).map_err(CommandError::internal)?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(CommandError::internal)
}

/// What the report says besides the status and the model.
struct ReportFacts {
    version: String,
    platform: String,
    /// The relay's host (and port), never the whole address.
    relay: Option<String>,
    enabled: bool,
    key: identity::KeyFileState,
    /// Files set aside because they didn't read, with when, newest last.
    set_aside: Vec<(String, Option<DateTime<Utc>>)>,
    log: Vec<String>,
}

/// `sync.example.com` of `wss://sync.example.com/v1/sync?x=1`, with its port if it has one.
fn relay_host(url: &str) -> Option<String> {
    let url = url::Url::parse(url.trim()).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

/// The sync secrets set aside as damaged: an identity there means this computer had another id
/// before, which the relay lists as another device.
fn set_aside_files(state: &SyncState) -> Vec<(String, Option<DateTime<Utc>>)> {
    [&state.identity_path, &state.key_path]
        .into_iter()
        .map(|path| path.with_extension("json.damaged"))
        .filter(|path| crate::secrets::exists(path))
        .map(|path| {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // On an iPhone it is a Keychain item, which has no time here.
            let at = fs::metadata(&path).and_then(|m| m.modified()).ok().map(DateTime::<Utc>::from);
            (name, at)
        })
        .collect()
}

/// A version as a peer said it, if it looks like one (`2.22.3`, `2.23.0-beta.1`); else `other`.
fn version_word(text: &str) -> &str {
    let ok = !text.is_empty() && text.len() <= 32 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if ok {
        text
    } else {
        "other"
    }
}

fn report(status: &SyncStatus, model: &Model, facts: &ReportFacts) -> String {
    let time = |at: Option<DateTime<Utc>>| at.map_or("never".to_string(), |t| log::stamp(t));
    let ms = |ms: Option<u64>| ms.and_then(|ms| i64::try_from(ms).ok()).and_then(DateTime::from_timestamp_millis).map_or("-".to_string(), log::stamp);
    let short = |id: &str| Uuid::parse_str(id).map_or_else(|_| "?".to_string(), |id| log::short(&id));
    let close = match &model.last_close {
        None => "none".to_string(),
        Some((code, reason)) => format!("{} {reason}", code.map_or("none".to_string(), |c| c.to_string())).trim_end().to_string(),
    };
    let key = match &facts.key {
        identity::KeyFileState::Missing => "no file".to_string(),
        identity::KeyFileState::Unreadable => "file there, can't be read now".to_string(),
        identity::KeyFileState::Damaged => "file there, doesn't read".to_string(),
        identity::KeyFileState::Present { epoch, owner } => format!(
            "file of epoch {epoch}, {}",
            match owner {
                Some(true) => "of the signed-in account",
                Some(false) => "of another account",
                None => "account not known (sync not running)",
            }
        ),
    };
    let mut lines = vec![
        "Koona Pin sync report".to_string(),
        format!("app: {} on {}", facts.version, facts.platform),
        format!("relay: {}", facts.relay.as_deref().unwrap_or("none")),
        format!("service: {}", if status.available { "yes" } else { "no" }),
        format!("enabled: {}", facts.enabled),
        format!("phase: {:?}", status.phase),
        format!("stop: {}", model.stop.as_ref().map_or("none".to_string(), |s| match s {
            koona_sync::net::Stop::Plan(reason) => format!("Plan {}", reason.as_deref().map_or("", log::word)).trim_end().to_string(),
            other => format!("{other:?}"),
        })),
        format!("error: {:?}", status.error),
        format!("last close: {close}"),
        format!("rejoining: {}", model.rejoining),
        format!("seq: {}", status.seq),
        format!("this device: {} ({:?})", short(&status.device.id), status.device.status),
        format!("hub: {} (this device: {})", status.hub.as_deref().map_or("none".to_string(), short), status.is_hub),
        format!("key: epoch {}, {key}", model.epoch().map_or("none".to_string(), |e| e.to_string())),
        format!("last sync: {}", time(status.last_sync_at)),
        format!("pairing: {:?}", status.pairing.as_ref().map(|p| p.role)),
        format!("hub change: {:?}", status.hub_change.as_ref().map(|h| h.role)),
        format!("notices: {}", status.notices.len()),
    ];
    if !facts.set_aside.is_empty() {
        lines.push("set aside (did not read):".to_string());
        for (name, at) in &facts.set_aside {
            lines.push(format!("  {name} {}", at.map_or("time unknown".to_string(), log::stamp)));
        }
    }
    let devices = model.every_device();
    lines.push(format!("devices: {} (removed ones too)", devices.len()));
    for device in &devices {
        let mut marks = vec![format!("{:?}", device.status).to_lowercase()];
        if device.id == status.device.id {
            marks.push("this device".into());
        }
        if device.is_hub {
            marks.push("hub".into());
        }
        marks.push(if device.online { "online".into() } else { "offline".into() });
        // What it said in its last sync `hello` (this device: what it runs), as far as that looks
        // like a system and a version: the words are the peer's.
        let own = device.id == status.device.id;
        let (platform, app) = if own { (&status.device.platform, &status.device.app) } else { (&device.platform, &device.app) };
        let runs = match (platform.as_deref().map(log::word), app.as_deref().map(version_word)) {
            (None, None) => "runs: not known yet".to_string(),
            (platform, app) => format!("runs {} {}", platform.unwrap_or("?"), app.unwrap_or("?")),
        };
        lines.push(format!("  {} - {}, {runs}, last seen {}", short(&device.id), marks.join(", "), ms(device.last_seen)));
    }
    lines.push(format!("log (last {} lines):", facts.log.len()));
    lines.extend(facts.log.iter().map(|line| format!("  {line}")));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turning_sync_on_needs_a_relay_then_supporter() {
        let no_url = need_sync(false, true).unwrap_err();
        assert_eq!(no_url.code, ErrorCode::InvalidRequest);
        assert_eq!(no_url.detail, None);
        let no_plan = need_sync(true, false).unwrap_err();
        assert_eq!(no_plan.detail, Some(ErrorDetail::NotSupporter));
        assert!(need_sync(true, true).is_ok());
    }

    #[test]
    fn a_kept_start_over_sign_in_is_given_once_while_young() {
        let now = Instant::now();
        let mut kept = KeptToken::default();
        assert_eq!(kept.take(), None);
        kept.keep("fresh".into(), now);
        assert!(!kept.expire(now + Duration::from_secs(30)));
        assert_eq!(kept.take(), Some("fresh".into()));
        assert_eq!(kept.take(), None, "given once");
        kept.keep("off".into(), now);
        kept.clear();
        assert_eq!(kept.take(), None, "sync turned off");
    }

    #[test]
    fn a_kept_sign_in_too_old_is_told_as_a_stale_one() {
        let now = Instant::now();
        let mut kept = KeptToken::default();
        let mut model = Model::default();
        kept.keep("young".into(), now);
        assert!(!expire_kept(&mut kept, &mut model, now + START_OVER_KEPT));
        assert_eq!(model.error, None);
        assert!(expire_kept(&mut kept, &mut model, now + START_OVER_KEPT + Duration::from_secs(1)));
        assert_eq!(model.error, Some(SyncProblem::StaleSignIn), "the banner offers to start over again");
        assert_eq!(kept.take(), None, "never sent");
        assert!(!expire_kept(&mut kept, &mut model, now + START_OVER_KEPT * 2), "told once");
    }

    #[test]
    fn the_device_shown_before_sync_is_on_is_the_one_saved_after() {
        let folder = std::env::temp_dir().join(format!("koonapin-sync-state-{}", Uuid::new_v4().simple()));
        let state = SyncState::load(folder.clone());
        let shown = state.shown_identity();
        assert!(!folder.join(identity::FILE).exists(), "nothing is written just to show it");
        assert_eq!(state.saved_identity().unwrap().device, shown.device);
        assert!(folder.join(identity::FILE).exists());
        let again = SyncState::load(folder.clone());
        assert_eq!(again.shown_identity().device, shown.device);
        state.update(|s| s.enabled = true).unwrap();
        assert!(SyncState::load(folder.clone()).stored().enabled);
        let _ = fs::remove_dir_all(folder);
    }

    /// A supervisor pass that saw sync on and then waited for the library and the token asks again
    /// before it starts the client: «Turn off sync», a lost plan or a stop meanwhile wins.
    #[test]
    fn a_pass_started_before_turning_sync_off_starts_nothing() {
        let folder = std::env::temp_dir().join(format!("koonapin-sync-start-{}", Uuid::new_v4().simple()));
        let state = SyncState::load(folder.clone());
        assert!(!state.may_start(true), "off");
        state.update(|s| s.enabled = true).unwrap();
        // The pass reads `enabled` and goes off to prepare the replica and refresh the token…
        let decided = state.stored().enabled;
        assert!(decided && state.may_start(true));
        assert!(!state.may_start(false), "the plan went meanwhile");
        lock(&state.model).stop = Some(Stop::Auth);
        assert!(!state.may_start(true), "the relay stopped it meanwhile");
        state.clear_stop();
        // …and `disable_sync` runs before it takes the `run` lock.
        state.update(|s| s.enabled = false).unwrap();
        assert!(decided && !state.may_start(true), "turned off meanwhile: no client");
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn notices_are_kept_across_restarts_until_dismissed() {
        let folder = std::env::temp_dir().join(format!("koonapin-sync-notices-{}", Uuid::new_v4().simple()));
        let state = SyncState::load(folder.clone());
        let notice = status::SyncNotice::StartedOver { id: "started-over-4".into(), by: Uuid::new_v4().to_string(), by_name: None, at: Utc::now() };
        lock(&state.model).notices.list.push(notice.clone());
        state.keep_notices().unwrap();
        assert!(!folder.join("sync-notices.json.tmp").exists());
        let again = SyncState::load(folder.clone());
        assert_eq!(lock(&again.model).notices.list, vec![notice]);
        again.change_notices(|n| n.dismiss("started-over-4")).unwrap();
        assert!(lock(&SyncState::load(folder.clone()).model).notices.list.is_empty());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn the_account_is_asked_beside_the_relay_socket() {
        assert_eq!(account_url("wss://sync.koonapin.com/v1/sync").as_deref(), Some("https://sync.koonapin.com/v1/account"));
        assert_eq!(account_url("ws://127.0.0.1:8787/v1/sync").as_deref(), Some("http://127.0.0.1:8787/v1/account"));
        assert_eq!(account_url(" wss://example.com/relay/v1/sync/ ").as_deref(), Some("https://example.com/relay/v1/account"));
        assert_eq!(account_url("wss://example.com/v1/sync?x=1#y").as_deref(), Some("https://example.com/v1/account"));
        assert_eq!(account_url("wss://example.com").as_deref(), Some("https://example.com/v1/account"));
        assert_eq!(account_url("https://example.com/v1/sync"), None);
        assert_eq!(account_url("not a url"), None);
    }

    #[test]
    fn the_relay_answer_about_the_account_is_mapped_like_its_close_codes() {
        let id = "0192f3a4-b5c6-7d8e-9f01-23456789abcd";
        let me = Uuid::from_u128(7);
        let hub = account_answer(200, &format!(r#"{{"hub": {{"id": "{id}", "name": "Home iMac"}}}}"#), me).unwrap();
        assert_eq!(hub.main_name.as_deref(), Some("Home iMac"));
        // This computer was the main one and turns sync on again: nobody else to join.
        let itself = account_answer(200, &format!(r#"{{"hub": {{"id": "{me}", "name": "Home iMac"}}}}"#), me).unwrap();
        assert_eq!(itself.main_name, None);
        assert_eq!(account_answer(200, r#"{"hub": null}"#, me).unwrap().main_name, None);
        assert_eq!(account_answer(200, "<html>", me).unwrap_err().code, ErrorCode::Network);
        let refused = |status| account_answer(status, r#"{"code": 4002, "reason": "not_in_beta"}"#, me).unwrap_err();
        assert_eq!(refused(401).detail, Some(ErrorDetail::SignedOut));
        let plan = refused(403);
        assert_eq!((plan.code, plan.detail), (ErrorCode::InvalidRequest, Some(ErrorDetail::NotSupporter)));
        assert!(plan.message.contains("not_in_beta"));
        let old = refused(426);
        assert_eq!((old.code, old.detail), (ErrorCode::InvalidRequest, Some(ErrorDetail::UpdateNeeded)));
        assert_eq!((refused(429).code, refused(429).detail), (ErrorCode::Network, Some(ErrorDetail::TooManyMessages)));
        assert_eq!((refused(502).code, refused(502).detail), (ErrorCode::Network, Some(ErrorDetail::ServiceFailed)));
    }

    #[test]
    fn the_bookmark_count_leaves_the_trash_out_and_moves_with_writes() {
        let conn = worker::tests::library();
        let add = |url: &str| {
            crate::db::insert_or_update_bookmark(&conn, url, "x", None, None, None, "example.com", None, None, crate::db::Source::App).unwrap().id
        };
        let before = bookmarks_key(&conn).unwrap();
        add("https://example.com/1");
        add("https://example.com/2");
        let trashed = add("https://example.com/3");
        crate::db::trash_bookmark(&conn, trashed).unwrap();
        assert_eq!(live_bookmarks(&conn).unwrap(), 2);
        assert_ne!(bookmarks_key(&conn).unwrap(), before, "a write moves the key");
        let after = bookmarks_key(&conn).unwrap();
        assert_eq!(bookmarks_key(&conn).unwrap(), after, "reading doesn't");
    }

    #[test]
    fn what_is_known_of_other_devices_is_kept_across_restarts() {
        let folder = std::env::temp_dir().join(format!("koonapin-sync-peers-{}", Uuid::new_v4().simple()));
        let state = SyncState::load(folder.clone());
        let laptop = Uuid::new_v4();
        let reactions = state.on_event(Event::Session(koona_sync::session::Effect::PeerHello {
            device: laptop,
            platform: "linux".into(),
            app: "0.13.0".into(),
        }));
        assert_eq!(reactions, vec![Reaction::Peers]);
        state.keep_peers().unwrap();
        assert!(!folder.join("sync-devices.json.tmp").exists());
        let again = SyncState::load(folder.clone());
        let facts = lock(&again.model).peers.devices.get(&laptop).cloned().unwrap();
        assert_eq!((facts.platform.as_deref(), facts.app.as_deref()), (Some("linux"), Some("0.13.0")));
        let _ = fs::remove_dir_all(folder);
    }

    /// Names and addresses go in everywhere a status can carry them; none comes out.
    #[test]
    fn the_report_lists_every_device_and_keeps_names_and_secrets_out() {
        use koona_sync::protocol::{DeviceInfo, DeviceStatus, B64};
        use koona_sync::session::{Effect, HubChangeEvent, PairingEvent, Role};
        let me = Identity::new("alice@example.com Mac");
        let (hub, earlier) = (Uuid::from_u128(0x7c1e_9b20_0000_4000_8000_0000_0000_0001), Uuid::from_u128(0x5a2b_3c4d_0000_4000_8000_0000_0000_0002));
        let mut model = Model::default();
        model.me = Some(me.device);
        let info = |id, name: &str, status, last_seen| DeviceInfo { id, name: name.into(), key: B64([1; 32]), status, last_seen };
        let events = [
            Event::Session(Effect::Devices {
                devices: vec![
                    info(hub, "Bob's iMac", DeviceStatus::Active, 1_794_000_000_000),
                    info(me.device, "alice@example.com Mac", DeviceStatus::Pending, 1_794_700_000_000),
                    info(earlier, "Alice Smith's laptop", DeviceStatus::Revoked, 1_793_000_000_000),
                ],
                online: vec![me.device],
                hub: Some(hub),
            }),
            Event::Session(Effect::PeerHello { device: hub, platform: "macos".into(), app: "2.22.2".into() }),
            Event::Session(Effect::Pairing(PairingEvent::Code { role: Role::Asking, peer: hub, peer_name: "Bob's iMac".into(), code: "482913".into() })),
            Event::Session(Effect::HubChange(HubChangeEvent::Waiting { hub, hub_name: "bob@example.com".into() })),
            Event::Session(Effect::StartedOver { by: hub, by_name: Some("Bob Jones".into()), at: 5, epoch: 4 }),
            Event::Closed { code: Some(1012), reason: Some("silent".into()) },
        ];
        for event in events {
            model.on_event(event, Utc::now());
        }
        model.notices.list.push(status::SyncNotice::DeviceAdded {
            id: "device-added-x".into(),
            device: earlier.to_string(),
            name: "Carol <carol@example.com>".into(),
            by_name: Some("Bob's iMac".into()),
            at: Utc::now(),
        });
        model.rejoining = true;
        let context = Context { enabled: true, service: true, plan: true, library_ready: true, identity: &me, app: "2.22.3".into(), bookmarks: None };
        let status = model.status(&context);
        assert!(status.pairing.is_some() && status.hub_change.is_some() && !status.notices.is_empty(), "every place is filled");
        let facts = ReportFacts {
            version: "2.22.3".into(),
            platform: "macos".into(),
            relay: relay_host("wss://sync.example.com/v1/sync?lease=abc"),
            enabled: true,
            key: identity::KeyFileState::Present { epoch: 3, owner: Some(true) },
            set_aside: vec![("sync-device.json.damaged".into(), DateTime::from_timestamp(1_793_500_000, 0))],
            log: vec!["2026-11-14T10:00:00Z phase Pending".into()],
        };
        let text = report(&status, &model, &facts);
        let short = |id: &Uuid| log::short(id);
        assert!(text.contains(&format!("  {} - revoked, offline, runs: not known yet, last seen", short(&earlier))), "the earlier identity:\n{text}");
        assert!(text.contains(&format!("  {} - active, hub, offline, runs macos 2.22.2, last seen", short(&hub))), "{text}");
        let own = format!("  {} - pending, this device, online, runs {} 2.22.3", short(&me.device), koona_sync::protocol::platform());
        assert!(text.contains(&own), "{own:?} in\n{text}");
        assert!(text.contains("devices: 3 (removed ones too)"));
        assert!(text.contains("pairing: Some(Asking)") && text.contains("hub change: Some(Asking)") && text.contains("notices: 2"), "{text}");
        assert!(text.contains("relay: sync.example.com\n"), "the host alone:\n{text}");
        assert!(text.contains("key: epoch none, file of epoch 3, of the signed-in account"));
        assert!(text.contains("  sync-device.json.damaged 2026-11-01T02:26:40Z"), "{text}");
        assert!(text.contains("last close: 1012 silent"));
        assert!(text.contains("rejoining: true"));
        assert!(text.contains("app: 2.22.3 on macos"));
        assert!(text.contains("  2026-11-14T10:00:00Z phase Pending"));
        for secret in [
            "@", "alice", "Alice", "Bob", "Carol", "Smith", "Jones", "iMac", "laptop", "482913", "lease", "abc", "wss://",
            &me.device.to_string(), &hub.to_string(), "AQEBAQ",
        ] {
            assert!(!text.contains(secret), "{secret:?} in the report:\n{text}");
        }
    }

    #[test]
    fn the_relay_host_is_all_the_report_says_of_its_address() {
        assert_eq!(relay_host("wss://sync.koonapin.com/v1/sync").as_deref(), Some("sync.koonapin.com"));
        assert_eq!(relay_host("ws://127.0.0.1:8787/v1/sync?x=1").as_deref(), Some("127.0.0.1:8787"));
        assert_eq!(relay_host("not a url"), None);
    }

    #[test]
    fn the_main_computer_is_said_online_and_last_seen_when_the_relay_tells() {
        let id = "0192f3a4-b5c6-7d8e-9f01-23456789abcd";
        let me = Uuid::from_u128(7);
        let new = account_answer(200, &format!(r#"{{"hub": {{"id": "{id}", "name": "Home iMac", "online": false, "last_seen": 1760399000000}}}}"#), me).unwrap();
        assert_eq!(new, SyncAccount { main_name: Some("Home iMac".into()), main_online: Some(false), main_last_seen: Some(1_760_399_000_000) });
        let old = account_answer(200, &format!(r#"{{"hub": {{"id": "{id}", "name": "Home iMac"}}}}"#), me).unwrap();
        assert_eq!((old.main_online, old.main_last_seen), (None, None), "a relay before them");
    }
}
