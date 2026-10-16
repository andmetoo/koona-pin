//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The sync session at work in the app (NP-059, Р-68): the relay client of `koona-sync` over the
//! open library, the events it reports turned into the interface's, and local changes pushed.
//!
//! The library is the app's one connection (`DbState`), locked for each call of the session and
//! released between them, so commands, captures and imports write in between. The relay client
//! already runs every session call on the blocking pool; the calls here lock directly and never
//! spawn again.
//!
//! Local changes: the capture triggers of schema 10 raise this replica's counter in
//! `sync_vector` on every write that reaches other devices, whoever makes it — a command, a
//! capture, an import, the link check, the MCP server in its own process. The watcher reads that
//! one row about once a second, without waiting for the lock, and pushes once the writes have
//! been quiet for a second, so no write path needs a hook of its own.

use super::status::Reaction;
use super::SyncState;
use crate::billing;
use crate::capture;
use crate::db::{self, DbState};
use crate::feeds;
use base64::Engine;
use koona_sync::library::{DeltaPage, Library, Meta};
use koona_sync::model::{Group, Vector};
use koona_sync::net::{self, ClientConfig, CredentialSource, Credentials, Event};
use koona_sync::session::{Action, Config, Session};
use koona_sync::{Applied, Cursor, Error};
use rusqlite::{Connection, OptionalExtension};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// More remote changes than this at once and the interface reads everything again, as after an
/// import, instead of merging an event per bookmark.
pub const MAX_EVENT_IDS: usize = 200;
/// How often the watcher looks at the counter.
const WATCH_EVERY: Duration = Duration::from_secs(1);
/// Writes quiet this long are pushed; a stream of writes (an import) is pushed at least this often.
const QUIET: Duration = Duration::from_secs(1);
const LONGEST_WAIT: Duration = Duration::from_secs(5);

/// The session's library: the app's connection under its lock, refused once the library was
/// replaced. `abandoned` is checked under the lock, as the link check's writer does: a restore
/// holds the lock while it replaces the file, so nothing is read or written across it.
pub struct DbLibrary {
    db: Arc<DbState>,
    replica: Uuid,
    abandoned: Arc<AtomicBool>,
    /// Where the library key is kept instead of the library (`identity::KEY_FILE`), and the
    /// account it is of; none keeps it in `sync_meta`, as the engine does by itself.
    key_file: Option<(PathBuf, String)>,
    /// Raised when the key file didn't read and was set aside, for the status to say so.
    key_lost: Arc<AtomicBool>,
}

impl DbLibrary {
    pub fn new(db: Arc<DbState>, replica: Uuid, abandoned: Arc<AtomicBool>) -> DbLibrary {
        DbLibrary { db, replica, abandoned, key_file: None, key_lost: Arc::new(AtomicBool::new(false)) }
    }

    /// The flag raised when the key file was set aside.
    pub fn key_lost(&self) -> Arc<AtomicBool> {
        self.key_lost.clone()
    }

    /// The library key of `account` in `path`, out of the library and so out of its copies.
    pub fn with_key_file(mut self, path: PathBuf, account: String) -> DbLibrary {
        self.key_file = Some((path, account));
        self
    }

    fn with<T>(&mut self, work: impl FnOnce(&mut Connection) -> koona_sync::Result<T>) -> koona_sync::Result<T> {
        if self.abandoned.load(Ordering::SeqCst) {
            return Err(Error::NotAttached);
        }
        let mut conn = self.db.conn.lock().map_err(|_| Error::Damaged("the library lock is poisoned".into()))?;
        if self.abandoned.load(Ordering::SeqCst) {
            return Err(Error::NotAttached);
        }
        // Another library in the same place (a restore of another copy) is not this replica:
        // nothing of the session's state belongs to it.
        match koona_sync::replica(&conn)? {
            Some(replica) if replica == self.replica => {}
            _ => {
                self.abandoned.store(true, Ordering::SeqCst);
                return Err(Error::NotAttached);
            }
        }
        work(&mut conn)
    }
}

impl Library for DbLibrary {
    fn vector(&mut self) -> koona_sync::Result<Vector> {
        self.with(|conn| Library::vector(conn))
    }

    fn delta(&mut self, since: &Vector, cursor: Option<&Cursor>, max_bytes: usize, max_chunks: usize) -> koona_sync::Result<DeltaPage> {
        self.with(|conn| Library::delta(conn, since, cursor, max_bytes, max_chunks))
    }

    // Through the app's apply, which writes the search rows and sort keys once per batch instead
    // of the triggers doing it on every write (a 100k snapshot: 36 s → about 20 s).
    fn apply(&mut self, groups: &[Group]) -> koona_sync::Result<Applied> {
        self.with(|conn| crate::sync_library::apply(conn, groups))
    }

    fn merge_vector(&mut self, covers: &Vector) -> koona_sync::Result<()> {
        self.with(|conn| Library::merge_vector(conn, covers))
    }

    fn load_meta(&mut self) -> koona_sync::Result<Meta> {
        let Some((path, account)) = self.key_file.clone() else {
            return self.with(|conn| Library::load_meta(conn));
        };
        let key_lost = self.key_lost.clone();
        self.with(|conn| {
            let mut meta = Library::load_meta(conn)?;
            let loaded = super::identity::load_key(&path, &account).map_err(key_error)?;
            if loaded.set_aside {
                key_lost.store(true, Ordering::SeqCst);
            }
            let kept = loaded.key;
            // A library from before the key file has it in `sync_meta`: it moves out, once.
            if let Some(old) = meta.key.take() {
                if kept.is_none() {
                    super::identity::save_key(&path, &account, Some(&old)).map_err(key_error)?;
                }
                Library::store_meta(conn, &Meta { key: None, ..meta.clone() })?;
                meta.key = kept.or(Some(old));
            } else if kept.is_some() && meta.hub.is_none() && meta.roster.is_none() {
                // The library forgot its sync (another copy opened in its place): the key goes
                // with the hub and the roster that vouched for it, as it did in `sync_meta`. The
                // session never keeps a key without a hub.
                super::identity::save_key(&path, &account, None).map_err(key_error)?;
            } else {
                meta.key = kept;
            }
            Ok(meta)
        })
    }

    fn store_meta(&mut self, meta: &Meta) -> koona_sync::Result<()> {
        let Some((path, account)) = self.key_file.clone() else {
            return self.with(|conn| Library::store_meta(conn, meta));
        };
        self.with(|conn| {
            super::identity::save_key(&path, &account, meta.key.as_ref()).map_err(key_error)?;
            Library::store_meta(conn, &Meta { key: None, ..meta.clone() })
        })
    }
}

fn key_error(error: std::io::Error) -> Error {
    Error::Damaged(format!("the library key file: {error}"))
}

/// The replica of the library, making it one when sync is turned on (NP-059): attached and every
/// record stamped as this replica's, in one transaction. A joining device does the same: its
/// own bookmarks are merged with what arrives (NP-061), not replaced. `Err(NoSyncSchema)` for a
/// library before schema 10.
pub fn prepare_library(conn: &Connection) -> koona_sync::Result<Uuid> {
    if let Some(replica) = koona_sync::replica(conn)? {
        return Ok(replica);
    }
    let replica = Uuid::new_v4();
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = koona_sync::attach(conn, replica).and_then(|()| koona_sync::baseline(conn));
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(replica)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            // `attach` already set this connection to record as a replica that was rolled back.
            let _ = koona_sync::register(conn);
            Err(e)
        }
    }
}

/// This replica's counter: it grows with every write the triggers record.
pub fn own_counter(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT v.counter FROM sync_vector v JOIN sync_origins o ON o.id = v.origin
         WHERE o.origin = (SELECT CAST(value AS TEXT) FROM sync_meta WHERE key = 'replica')",
        [],
        |r| r.get(0),
    )
    .optional()
}

/// What the interface reads again after remote changes.
#[derive(Debug, PartialEq, Eq)]
pub enum Refresh {
    Nothing,
    Bookmarks(Vec<i64>),
    Everything,
}

pub fn refresh_for(applied: &Applied) -> Refresh {
    if applied.structure_changed || applied.bookmark_ids.len() > MAX_EVENT_IDS {
        Refresh::Everything
    } else if applied.bookmark_ids.is_empty() {
        Refresh::Nothing
    } else {
        Refresh::Bookmarks(applied.bookmark_ids.clone())
    }
}

/// The feeds a batch took away that the library doesn't follow any more: their posts in the
/// cache go. A uid can be gone and back in one batch only in theory; the library decides.
pub fn feeds_to_forget(conn: &Connection, applied: &Applied) -> rusqlite::Result<Vec<String>> {
    let mut gone = Vec::new();
    for uid in &applied.feeds_gone {
        let uid = uid.to_string();
        let followed: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM feeds WHERE uid = ?1)", [&uid], |r| r.get(0))?;
        if !followed {
            gone.push(uid);
        }
    }
    Ok(gone)
}

/// Feeds followed, changed or left on another device (NP-130): the posts of the ones gone leave
/// the cache, and the Feeds page reads the list again. A new feed's first fetch is the refresh
/// loop's (NP-129), which reads the library's feeds on its own.
async fn after_feeds(app: &AppHandle, db: &Arc<DbState>, applied: &Applied) {
    if !applied.feeds_changed && applied.feeds_gone.is_empty() {
        return;
    }
    let (app, db, applied) = (app.clone(), db.clone(), applied.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let read = {
            let Ok(conn) = db.conn.lock() else { return };
            feeds_to_forget(&conn, &applied).and_then(|gone| Ok((gone, feeds::feeds(&conn)?)))
        };
        match read {
            Ok((gone, mut list)) => {
                for uid in gone {
                    feeds::cache::forget_feed(&app, &uid);
                }
                // The interface takes the list as it comes: counts, titles and health
                // from the cache with it, or every feed would read as empty (NP-130).
                if let Some(cache) = app.try_state::<Arc<feeds::cache::FeedCache>>() {
                    if let Ok(conn) = cache.conn.lock() {
                        let _ = feeds::cache::merge_state(&conn, &mut list, chrono::Utc::now());
                    }
                }
                // A feed followed on another computer, never fetched here, is fetched now,
                // not at the next tick; a rename or a new destination asks for nothing.
                let new_here = list.iter().any(|feed| feed.fetched_at.is_none());
                feeds::emit_changed(&app, list);
                if new_here {
                    feeds::schedule::fetch_soon(&app, None);
                }
            }
            Err(error) => eprintln!("Reading the feeds after sync failed: {error}"),
        }
    })
    .await;
}

/// Remote changes as the interface's events: the changed bookmarks with their revisions, which
/// the engine bumps, as a bulk action sends them; everything again for a new collection, tag or
/// feed, a big batch, or bookmarks that are gone (their last revision is not known).
async fn after_applied(app: &AppHandle, db: &Arc<DbState>, applied: &Applied) {
    after_feeds(app, db, applied).await;
    let ids = match refresh_for(applied) {
        Refresh::Nothing => return,
        Refresh::Everything => {
            let _ = app.emit("library-invalidated", ());
            return;
        }
        Refresh::Bookmarks(ids) => ids,
    };
    let db = db.clone();
    let wanted = ids.len();
    let read = tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        db::get_bookmarks_by_ids(&conn, &ids).map_err(|e| e.to_string())
    })
    .await;
    match read {
        Ok(Ok(bookmarks)) if bookmarks.len() == wanted => capture::emit_many(app, &bookmarks),
        _ => {
            let _ = app.emit("library-invalidated", ());
        }
    }
}

/// The JWT's `sub`, which the relay `hello` signs; read, not verified: the relay verifies it.
pub fn jwt_sub(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims["sub"].as_str().filter(|s| !s.is_empty() && !s.contains('\0')).map(str::to_string)
}

/// A client at work.
pub struct Running {
    pub handle: net::Handle,
    pub sub: String,
    pub replica: Uuid,
    pub generation: u64,
    abandoned: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl Running {
    pub fn abandoned(&self) -> bool {
        self.abandoned.load(Ordering::SeqCst)
    }

    pub fn finished(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.handle.shutdown();
    }
}

pub struct Start {
    pub url: String,
    /// `identity::KEY_FILE` in the app's folder.
    pub key_file: PathBuf,
    pub db: Arc<DbState>,
    pub replica: Uuid,
    pub identity: super::identity::Identity,
    pub sub: String,
    pub generation: u64,
}

/// Starts the client on the app's runtime, with the pump of its events and the watcher of local
/// changes beside it.
pub fn spawn(app: &AppHandle, start: Start) -> Running {
    let Start { url, key_file, db, replica, identity, sub, generation } = start;
    let abandoned = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let library = DbLibrary::new(db.clone(), replica, abandoned.clone()).with_key_file(key_file, sub.clone());
    let key_lost = library.key_lost();
    let config = Config::new(identity.device, identity.key_pair(), sub.clone(), identity.name.clone(), app.package_info().version.to_string());
    let session = Session::new(config, Box::new(ring::rand::SystemRandom::new()));
    let credentials: CredentialSource = {
        let (app, sub) = (app.clone(), sub.clone());
        Arc::new(move |refresh| {
            let (app, sub) = (app.clone(), sub.clone());
            Box::pin(async move {
                match billing::sync_credentials(&app, refresh).await {
                    Ok(Some((token, lease))) if jwt_sub(&token).as_deref() == Some(sub.as_str()) => Ok(Credentials { token, lease }),
                    Ok(Some(_)) => {
                        // Another account signed in: a client for it replaces this one.
                        super::wake(&app);
                        Err("the account changed".to_string())
                    }
                    Ok(None) => Err("no account credentials".to_string()),
                    Err(error) => Err(format!("the account service: {}", error.message)),
                }
            })
        })
    };
    let (handle, events, work) = net::client(ClientConfig::new(url), session, library, credentials);
    tauri::async_runtime::spawn(work);
    tauri::async_runtime::spawn(pump(app.clone(), events, handle.clone(), db.clone(), generation, abandoned.clone(), key_lost, done.clone()));
    tauri::async_runtime::spawn(watch(db, handle.clone(), done.clone()));
    Running { handle, sub, replica, generation, abandoned, done }
}

async fn pump(
    app: AppHandle,
    mut events: tokio::sync::mpsc::UnboundedReceiver<Event>,
    handle: net::Handle,
    db: Arc<DbState>,
    generation: u64,
    abandoned: Arc<AtomicBool>,
    key_lost: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
) {
    while let Some(event) = events.recv().await {
        let state = app.state::<SyncState>();
        // A client being replaced may still report; only the current one is shown.
        if state.generation() != generation {
            continue;
        }
        let stopped = matches!(event, Event::Stopped(_));
        for reaction in state.on_event(event) {
            match reaction {
                Reaction::Applied(applied) => after_applied(&app, &db, &applied).await,
                Reaction::StartPairing => {
                    handle.act(Action::StartPairing);
                }
                Reaction::Synced => state.keep_last_sync(),
                Reaction::Notices => {
                    if let Err(error) = state.keep_notices() {
                        eprintln!("Sync cannot keep its notices: {}", error.message);
                    }
                }
                Reaction::Peers => {
                    if let Err(error) = state.keep_peers() {
                        eprintln!("Sync cannot keep what it knows of the other devices: {}", error.message);
                    }
                }
            }
        }
        if key_lost.swap(false, Ordering::SeqCst) {
            state.key_lost(&app);
        }
        if abandoned.load(Ordering::SeqCst) {
            state.library_replaced(generation);
            handle.shutdown();
            super::wake(&app);
        }
        if stopped {
            state.finished(generation);
        }
        state.emit(&app);
    }
    done.store(true, Ordering::SeqCst);
}

/// Pushes local changes: see the module's comment. Until `done`; public for the end-to-end test
/// (`tests/sync_e2e.rs`), which runs clients without Tauri.
pub async fn watch(db: Arc<DbState>, handle: net::Handle, done: Arc<AtomicBool>) {
    let mut last: Option<i64> = None;
    let mut waiting: Option<(Instant, Instant)> = None;
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        if done.load(Ordering::SeqCst) {
            return;
        }
        let state = db.clone();
        // Never waits for the lock: a long import is looked at again a second later.
        let counter = tauri::async_runtime::spawn_blocking(move || match state.conn.try_lock() {
            Ok(conn) => own_counter(&conn).ok().flatten(),
            Err(_) => None,
        })
        .await
        .ok()
        .flatten();
        let now = Instant::now();
        if let Some(counter) = counter {
            if last.is_some_and(|last| counter > last) {
                waiting = Some((waiting.map_or(now, |w| w.0), now));
            }
            last = Some(last.map_or(counter, |last| last.max(counter)));
        }
        if let Some((first, latest)) = waiting {
            if now - latest >= QUIET || now - first >= LONGEST_WAIT {
                waiting = None;
                if !handle.act(Action::LocalChange) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A library of the app's schema with schema 10 on top when the app's migrations don't have
    /// it yet (task A of sync v1 adds it), and the engine's functions on the connection.
    pub fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::register_functions(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        if conn.query_row("SELECT np_domain('https://example.com/')", [], |_| Ok(())).is_err() {
            conn.create_scalar_function("np_domain", 1, rusqlite::functions::FunctionFlags::SQLITE_UTF8, |ctx| {
                let url = ctx.get::<String>(0)?;
                Ok(url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default())
            })
            .unwrap();
        }
        if !crate::migrations::table_exists(&conn, "sync_meta").unwrap() {
            conn.execute_batch(koona_sync::SCHEMA_10).unwrap();
        }
        koona_sync::register(&conn).unwrap();
        conn
    }

    fn add_collection(conn: &Connection, name: &str) {
        conn.execute(
            "INSERT INTO collections (uid, name, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![db::new_uid(), name, db::now()],
        )
        .unwrap();
    }

    fn state(conn: Connection) -> Arc<DbState> {
        Arc::new(DbState::new(conn))
    }

    #[test]
    fn the_library_key_lives_in_its_file_not_in_the_library() {
        let conn = library();
        let replica = prepare_library(&conn).unwrap();
        let folder = std::env::temp_dir().join(format!("koonapin-key-{}", Uuid::new_v4().simple()));
        let path = folder.join(super::super::identity::KEY_FILE);
        let in_library = |conn: &Connection| conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE key = 'library_key'", [], |r| r.get::<_, i64>(0)).unwrap();
        // A library from before the file keeps the key in `sync_meta`.
        koona_sync::library::store_meta(&conn, &Meta { key: Some((3, [7; 32])), ..Meta::default() }).unwrap();
        assert_eq!(in_library(&conn), 1);
        let db = state(conn);
        let mut lib = DbLibrary::new(db.clone(), replica, Arc::new(AtomicBool::new(false))).with_key_file(path.clone(), "account-1".into());

        // Read once, it moves to the file and leaves the library.
        assert_eq!(lib.load_meta().unwrap().key, Some((3, [7; 32])));
        assert_eq!(in_library(&db.conn.lock().unwrap()), 0);
        assert_eq!(super::super::identity::load_key(&path, "account-1").unwrap().key, Some((3, [7; 32])));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // A new key (a rotation) goes to the file only; the rest of the meta to the library.
        let hub = Uuid::new_v4();
        lib.store_meta(&Meta { key: Some((4, [9; 32])), hub: Some(hub), roster: None }).unwrap();
        assert_eq!(in_library(&db.conn.lock().unwrap()), 0);
        let meta = lib.load_meta().unwrap();
        assert_eq!((meta.key, meta.hub), (Some((4, [9; 32])), Some(hub)));

        // A file from before the account was written down is bound to the account that reads it.
        std::fs::write(&path, format!("{{\"v\": 1, \"epoch\": 4, \"key\": \"{}\"}}", base64::engine::general_purpose::STANDARD.encode([9u8; 32]))).unwrap();
        assert_eq!(super::super::identity::load_key(&path, "account-1").unwrap().key, Some((4, [9; 32])));
        assert_eq!(super::super::identity::load_key(&path, "account-2").unwrap().key, None, "now the first account's");

        // Another account signed in here doesn't get it.
        let mut other = DbLibrary::new(db.clone(), replica, Arc::new(AtomicBool::new(false))).with_key_file(path.clone(), "account-2".into());
        assert_eq!(other.load_meta().unwrap().key, None);
        assert!(path.exists(), "still the first account's");

        // A file that doesn't read is set aside: the key is asked for again, sync goes on.
        std::fs::write(&path, "{\"v\": 1, \"epoch\": 4, \"key\": \"cut sho").unwrap();
        assert_eq!(lib.load_meta().unwrap().key, None);
        assert!(!path.exists() && path.with_extension("json.damaged").exists());
        assert!(lib.key_lost().swap(false, Ordering::SeqCst), "the status is told");

        // The library forgot its sync (another copy opened in its place): the key goes too.
        lib.store_meta(&Meta { key: Some((4, [9; 32])), hub: Some(hub), roster: None }).unwrap();
        koona_sync::library::store_meta(&db.conn.lock().unwrap(), &Meta::default()).unwrap();
        assert_eq!(lib.load_meta().unwrap().key, None);
        assert!(!path.exists());

        // Removed from the account: the key is forgotten, the file goes.
        lib.store_meta(&Meta { key: Some((5, [1; 32])), hub: Some(hub), roster: None }).unwrap();
        lib.store_meta(&Meta { key: None, hub: Some(hub), roster: None }).unwrap();
        assert!(!path.exists());
        assert_eq!(lib.load_meta().unwrap().key, None);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn turning_sync_on_makes_the_library_a_replica_once() {
        let conn = library();
        add_collection(&conn, "Reading");
        assert_eq!(own_counter(&conn).unwrap(), None, "nothing before sync is turned on");
        let replica = prepare_library(&conn).unwrap();
        assert_eq!(prepare_library(&conn).unwrap(), replica, "the same replica next time");
        let baseline = own_counter(&conn).unwrap().unwrap();
        assert!(baseline >= 1, "the collection there before got a clock");
        let vector = koona_sync::vector(&conn).unwrap();
        assert_eq!(vector.get(&replica), baseline as u64);
    }

    #[test]
    fn a_library_before_schema_10_is_refused_and_left_as_it_was() {
        let mut conn = Connection::open_in_memory().unwrap();
        db::register_functions(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        if crate::migrations::table_exists(&conn, "sync_meta").unwrap() {
            // Task A's migration is in: every library has the tables.
            return;
        }
        assert!(matches!(prepare_library(&conn), Err(Error::NoSyncSchema)));
    }

    #[test]
    fn every_local_write_raises_the_counter_the_watcher_reads() {
        let conn = library();
        prepare_library(&conn).unwrap();
        let before = own_counter(&conn).unwrap().unwrap();
        add_collection(&conn, "Recipes");
        let after = own_counter(&conn).unwrap().unwrap();
        assert!(after > before);
        // Remote changes are written without capture: they move the counter of their own replica.
        let applying = koona_sync::Applying::new(&conn).unwrap();
        add_collection(&conn, "From the laptop");
        drop(applying);
        assert_eq!(own_counter(&conn).unwrap().unwrap(), after);
    }

    #[test]
    fn the_session_reads_and_writes_the_library_under_its_lock() {
        let conn = library();
        add_collection(&conn, "Reading");
        let replica = prepare_library(&conn).unwrap();
        let db = state(conn);
        let mut lib = DbLibrary::new(db.clone(), replica, Arc::new(AtomicBool::new(false)));
        assert!(lib.vector().unwrap().0.contains_key(&replica));
        let meta = Meta { key: Some((3, [9; 32])), hub: Some(replica), roster: None };
        lib.store_meta(&meta).unwrap();
        assert_eq!(lib.load_meta().unwrap(), meta);
        // A command holding the library: the session waits for it, then goes on.
        let held = db.clone();
        let (locked, release) = (std::sync::mpsc::channel(), std::sync::mpsc::channel::<()>());
        let holder = std::thread::spawn(move || {
            let _conn = held.conn.lock().unwrap();
            locked.0.send(()).unwrap();
            release.1.recv().unwrap();
        });
        locked.1.recv().unwrap();
        let waiting = std::thread::spawn(move || {
            let started = Instant::now();
            lib.vector().unwrap();
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(150));
        release.0.send(()).unwrap();
        holder.join().unwrap();
        assert!(waiting.join().unwrap() >= Duration::from_millis(100), "it waited for the lock");
        assert!(db.conn.try_lock().is_ok(), "and let it go");
    }

    #[test]
    fn a_replaced_or_abandoned_library_is_refused() {
        let conn = library();
        let replica = prepare_library(&conn).unwrap();
        let db = state(conn);
        let abandoned = Arc::new(AtomicBool::new(false));
        let mut lib = DbLibrary::new(db.clone(), replica, abandoned.clone());
        assert!(lib.vector().is_ok());
        abandoned.store(true, Ordering::SeqCst);
        assert!(matches!(lib.vector(), Err(Error::NotAttached)));
        abandoned.store(false, Ordering::SeqCst);
        // Another library in its place, as after a restore of a copy made before sync.
        db.conn.lock().unwrap().execute("DELETE FROM sync_meta WHERE key = 'replica'", []).unwrap();
        assert!(matches!(lib.store_meta(&Meta::default()), Err(Error::NotAttached)));
        assert!(abandoned.load(Ordering::SeqCst), "the worker sees it and stops");
        let other = DbLibrary::new(db, Uuid::new_v4(), Arc::new(AtomicBool::new(false))).vector();
        assert!(other.is_err());
    }

    #[test]
    fn few_remote_changes_are_events_and_many_read_everything_again() {
        let few = Applied { bookmark_ids: vec![4, 5], ..Applied::default() };
        assert_eq!(refresh_for(&few), Refresh::Bookmarks(vec![4, 5]));
        let many = Applied { bookmark_ids: (0..=MAX_EVENT_IDS as i64).collect(), ..Applied::default() };
        assert_eq!(refresh_for(&many), Refresh::Everything);
        let sidebar = Applied { structure_changed: true, ..Applied::default() };
        assert_eq!(refresh_for(&sidebar), Refresh::Everything);
        assert_eq!(refresh_for(&Applied::default()), Refresh::Nothing);
    }

    /// A feed from another device is structure: `library-invalidated`, and the posts of the
    /// feeds that went leave the cache, those still followed stay (NP-130).
    #[test]
    fn a_feed_from_another_device_reads_everything_and_forgets_the_gone() {
        let a = library();
        crate::sync_library::turn_on(&a, Uuid::from_u128(1)).unwrap();
        let url = |s: &str| url::Url::parse(s).unwrap();
        let kept = feeds::subscribe(&a, &url("https://example.com/feed.xml"), None, feeds::FeedDestination::Inbox).unwrap();
        let left = feeds::subscribe(&a, &url("https://example.org/rss"), None, feeds::FeedDestination::Feeds).unwrap();
        let b = library();
        crate::sync_library::turn_on(&b, Uuid::from_u128(2)).unwrap();
        let send = |from: &Connection, to: &Connection| {
            let since = koona_sync::vector(to).unwrap();
            let mut applied = Applied::default();
            for chunk in koona_sync::delta_all(from, &since, 1 << 20).unwrap() {
                let got = crate::sync_library::apply(to, &chunk.groups).unwrap();
                applied.structure_changed |= got.structure_changed;
                applied.feeds_changed |= got.feeds_changed;
                applied.feeds_gone.extend(got.feeds_gone);
                koona_sync::merge_vector(to, &chunk.covers).unwrap();
            }
            applied
        };
        let applied = send(&a, &b);
        assert!(applied.feeds_changed);
        assert_eq!(refresh_for(&applied), Refresh::Everything);
        assert_eq!(feeds::feeds(&b).unwrap().len(), 2);
        assert_eq!(feeds::feed(&b, &kept.uid).unwrap().destination, feeds::FeedDestination::Inbox);

        feeds::unsubscribe(&a, &left.uid).unwrap();
        let applied = send(&a, &b);
        assert_eq!(applied.feeds_gone, [Uuid::parse_str(&left.uid).unwrap()]);
        assert_eq!(feeds_to_forget(&b, &applied).unwrap(), [left.uid.clone()]);
        // One still followed is never forgotten.
        let back = Applied { feeds_gone: vec![Uuid::parse_str(&kept.uid).unwrap()], ..Applied::default() };
        assert!(feeds_to_forget(&b, &back).unwrap().is_empty());
    }

    #[test]
    fn the_account_is_read_from_the_token() {
        let encode = |json: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        let token = format!("{}.{}.sig", encode(r#"{"alg":"ES256"}"#), encode(r#"{"sub":"8d0c-acc","email":"a@b.c"}"#));
        assert_eq!(jwt_sub(&token).as_deref(), Some("8d0c-acc"));
        assert_eq!(jwt_sub("not a token"), None);
        let nul = format!("x.{}.y", encode("{\"sub\":\"a\\u0000b\"}"));
        assert_eq!(jwt_sub(&nul), None, "the relay refuses a sub with NUL");
    }
}
