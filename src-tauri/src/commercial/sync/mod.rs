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
//! it stopped. `sync-notices.json` keeps the notices until the person dismisses them.

pub mod identity;
pub mod status;
pub mod worker;

use crate::billing;
use crate::db::DbState;
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use crate::library;
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
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager};
use uuid::Uuid;
use worker::Running;

pub use status::{PairingPrompt, PairingRole, PausedReason, SyncDevice, SyncDeviceStatus, SyncPhase, UnavailableReason};

pub const EVENT: &str = "sync-status";
const FILE: &str = "sync.json";
const NOTICES_FILE: &str = "sync-notices.json";
/// What is known of the other devices from syncing with them (`status::Peers`).
const PEERS_FILE: &str = "sync-devices.json";
/// How long `start_over` waits for a client it had to start.
const START_WAIT: Duration = Duration::from_secs(10);
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
    wake: tokio::sync::Notify,
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
            wake: tokio::sync::Notify::new(),
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
        let loaded = if self.identity_path.exists() { Identity::load_or_create(&self.identity_path).ok() } else { None };
        let entry = match loaded {
            Some(identity) => (identity, true),
            None => (Identity::new(""), false),
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
            Some((shown, false)) if !self.identity_path.exists() => {
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
    app.manage(SyncState::load(library::Paths::from_env().folder()));
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
    tauri::async_runtime::spawn(async move {
        loop {
            let wait = supervise(&app).await;
            let state = app.state::<SyncState>();
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = state.wake.notified() => {}
            }
        }
    });
}

/// The library's replica, made one if sync is on and it is not yet (turned on, or restored
/// from a copy made before sync); None when the library is not open or has no sync tables.
async fn replica(app: &AppHandle) -> Option<(Arc<DbState>, Uuid)> {
    let db = app.try_state::<Arc<DbState>>()?.inner().clone();
    let state = db.clone();
    let replica = tauri::async_runtime::spawn_blocking(move || {
        let conn = state.conn.lock().ok()?;
        match worker::prepare_library(&conn) {
            Ok(replica) => Some(replica),
            Err(error) => {
                eprintln!("Sync cannot use the library: {error}");
                None
            }
        }
    })
    .await
    .ok()
    .flatten()?;
    Some((db, replica))
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
    let (Some(url), Some((db, replica)), false) = (url, library, stopped) else {
        // A stop stays shown (and keeps the client from starting again) until the person acts.
        if lock(&state.run).take().is_some() && !stopped {
            lock(&state.model).restart();
        }
        state.emit(app);
        return RECHECK;
    };
    // The account, from its token: the relay `hello` signs it.
    let sub = billing::sync_credentials(app, false).await.ok().flatten().and_then(|(token, _)| worker::jwt_sub(&token));
    let Some(sub) = sub else {
        // Signed out (the plan check stops the client then), or the token wants a refresh and the
        // account service is away: a running client goes on with what it has, and a start waits.
        state.emit(app);
        return RETRY_START;
    };
    {
        let mut run = lock(&state.run);
        let keep = run.as_ref().is_some_and(|r| r.sub == sub && r.replica == replica && !r.finished() && !r.abandoned());
        if !keep {
            let identity = match state.saved_identity() {
                Ok(identity) => identity,
                Err(error) => {
                    eprintln!("Sync cannot keep this device's identity: {}", error.message);
                    return RETRY_START;
                }
            };
            // The old client stops as it is dropped.
            *run = None;
            let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            {
                let mut model = lock(&state.model);
                model.restart();
                model.me = Some(identity.device);
            }
            *run = Some(worker::spawn(app, worker::Start { url, key_file: state.key_path.clone(), db, replica, identity, sub, generation }));
        }
    }
    state.emit(app);
    RECHECK
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
    lock(&state.run).take();
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
/// sign-in too old for the relay comes back as `StaleSignIn` in the status.
#[tauri::command]
pub async fn start_over(app: AppHandle, code: String) -> Result<SyncStatus, CommandError> {
    let state = app.state::<SyncState>();
    if !state.stored().enabled {
        return Err(CommandError::invalid("Sync is off"));
    }
    let (handle, token) = match state.handle() {
        // Running: the code is checked only now, so it isn't spent on a client that can't send it.
        Some(handle) => (handle, billing::sign_in_again(&app, &code).await?),
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
            state.clear_stop();
            wake(&app);
            let handle = running(&state).await.ok_or_else(|| CommandError::invalid("Sync is not running"))?;
            (handle, token)
        }
    };
    lock(&state.model).error = None;
    // The session sends it once the relay welcomed it, now if it already did.
    if !handle.act(Action::StartOver { token }) {
        return Err(CommandError::invalid("Sync is not running"));
    }
    Ok(state.emit(&app))
}

/// The client once the supervisor started one, within `START_WAIT`.
async fn running(state: &SyncState) -> Option<koona_sync::net::Handle> {
    let until = std::time::Instant::now() + START_WAIT;
    loop {
        if let Some(handle) = state.handle() {
            return Some(handle);
        }
        if std::time::Instant::now() >= until {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
            .map(|answer| SyncAccount { main_name: answer.hub.filter(|hub| hub.id != me).map(|hub| hub.name) })
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

/// What support needs to see why sync does what it does: states, ids, the recent story. No
/// bookmark, collection or tag of the library, and no key.
#[tauri::command]
pub fn copy_sync_report(app: AppHandle) -> String {
    let state = app.state::<SyncState>();
    let status = state.status(&app);
    let model = lock(&state.model);
    let text = report(&status, &app.package_info().version.to_string(), state.stored().enabled, &model);
    text
}

fn report(status: &SyncStatus, version: &str, enabled: bool, model: &Model) -> String {
    let mut lines = vec![
        "Koona Pin sync report".to_string(),
        format!("app: {version}"),
        format!("service: {}", if status.available { "yes" } else { "no" }),
        format!("enabled: {enabled}"),
        format!("phase: {:?}", status.phase),
        format!("stop: {:?}", model.stop),
        format!("device: {} ({:?})", status.device.id, status.device.status),
        format!("hub: {} (this device: {})", status.hub.as_deref().unwrap_or("none"), status.is_hub),
        format!("last sync: {}", status.last_sync_at.map_or("never".to_string(), |t| t.to_rfc3339())),
        format!("error: {:?}", status.error),
        format!("pairing: {:?}", status.pairing.as_ref().map(|p| p.role)),
        format!("hub change: {:?}", status.hub_change.as_ref().map(|h| h.role)),
        format!("notices: {}", status.notices.len()),
        format!("devices: {}", status.devices.len()),
    ];
    for device in &status.devices {
        lines.push(format!(
            "  {} {:?}{}{} last seen {}",
            device.id,
            device.status,
            if device.online { " online" } else { "" },
            if device.is_hub { " hub" } else { "" },
            device.last_seen.map_or("-".to_string(), |ms| ms.to_string()),
        ));
    }
    lines.push("recent:".to_string());
    lines.extend(model.log().map(|line| format!("  {line}")));
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

    #[test]
    fn the_report_names_states_and_ids_only() {
        let me = Identity::new("Studio Mac");
        let mut model = Model::default();
        model.on_event(
            Event::Session(koona_sync::session::Effect::Devices {
                devices: vec![koona_sync::protocol::DeviceInfo {
                    id: me.device,
                    name: "Studio Mac".into(),
                    key: koona_sync::protocol::B64([1; 32]),
                    status: koona_sync::protocol::DeviceStatus::Active,
                    last_seen: 5,
                }],
                online: vec![me.device],
                hub: Some(me.device),
            }),
            Utc::now(),
        );
        let context = Context { enabled: true, service: true, plan: true, library_ready: true, identity: &me, app: "0.13.0".into(), bookmarks: None };
        let text = report(&model.status(&context), "0.13.0", true, &model);
        assert!(text.contains(&me.device.to_string()));
        assert!(text.contains("app: 0.13.0"));
        assert!(!text.contains("Studio Mac"), "names stay out:\n{text}");
    }
}
