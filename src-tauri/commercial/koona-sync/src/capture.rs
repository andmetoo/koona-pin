//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Capture: the SQL functions the triggers of schema 10 call. Each connection has its own state
//! (whether to record, the replica, the clock); the counter and the clock that matter live in
//! the library (`sync_vector`, `sync_meta`), the state only remembers the last ones it gave, so
//! two connections or a restart never give the same counter twice.
//!
//! Nothing is recorded until the library is attached, and nothing while remote changes are being
//! applied ([`Applying`]): those already carry their clocks.

use crate::hlc::{wall_ms, HlcClock};
use crate::{Error, Result};
use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Default)]
struct State {
    capture: bool,
    applying: u32,
    /// This replica in `sync_origins`; 0 before attaching.
    origin: i64,
    hlc: HlcClock,
    counter: u64,
    /// A fixed wall clock for tests.
    wall: Option<u64>,
}

impl State {
    fn wall(&self) -> u64 {
        self.wall.unwrap_or_else(wall_ms)
    }
}

fn base(ctx: &rusqlite::functions::Context<'_>) -> rusqlite::Result<u64> {
    Ok(ctx.get::<Option<i64>>(0)?.unwrap_or(0).max(0) as u64)
}

/// Sets the SQL functions on a connection. Every connection that writes to a library of schema
/// 10 needs them, sync on or off: the triggers call them. When the library is attached already,
/// recording starts at once.
pub fn register(conn: &Connection) -> Result<()> {
    let mut state = State::default();
    if let Some(origin) = self_origin(conn)? {
        state.capture = true;
        state.origin = origin;
    }
    install(conn, state)
}

fn install(conn: &Connection, state: State) -> Result<()> {
    // Applying a batch runs some forty statements per record kind; with rusqlite's default of
    // 16 cached statements each would be prepared again for every record.
    conn.set_prepared_statement_cache_capacity(128);
    let state = Arc::new(Mutex::new(state));
    // Called from triggers, so they must be innocuous; they touch nothing but this state.
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS;
    let s = state.clone();
    conn.create_scalar_function("np_sync_capture", 0, flags, move |_| {
        let s = s.lock().unwrap();
        Ok(s.capture && s.applying == 0)
    })?;
    let s = state.clone();
    conn.create_scalar_function("np_sync_origin", 0, flags, move |_| Ok(s.lock().unwrap().origin))?;
    let s = state.clone();
    conn.create_scalar_function("np_hlc", 1, flags, move |ctx| {
        let base = base(ctx)?;
        let mut s = s.lock().unwrap();
        s.hlc.observe(base);
        let wall = s.wall();
        Ok(s.hlc.tick(wall).0 as i64)
    })?;
    let s = state.clone();
    conn.create_scalar_function("np_hlc_last", 0, flags, move |_| Ok(s.lock().unwrap().hlc.last() as i64))?;
    let s = state.clone();
    conn.create_scalar_function("np_sync_counter", 1, flags, move |ctx| {
        let base = base(ctx)?;
        let mut s = s.lock().unwrap();
        s.counter = s.counter.max(base) + 1;
        Ok(s.counter as i64)
    })?;
    let s = state.clone();
    conn.create_scalar_function("np_sync_counter_last", 0, flags, move |_| Ok(s.lock().unwrap().counter as i64))?;
    // Only from the engine itself, never from a trigger or view.
    let s = state;
    conn.create_scalar_function(
        "np_sync_control",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        move |ctx| {
            let key: String = ctx.get(0)?;
            let value: i64 = ctx.get(1)?;
            let mut s = s.lock().unwrap();
            match key.as_str() {
                "capture" => s.capture = value != 0,
                "applying" if value > 0 => s.applying += 1,
                "applying" => s.applying = s.applying.saturating_sub(1),
                "observe" => s.hlc.observe(value.max(0) as u64),
                // Another replica on the same connection: its counters start anew.
                "origin" => {
                    s.origin = value;
                    s.counter = 0;
                }
                "wall" => s.wall = (value >= 0).then_some(value as u64),
                _ => return Err(rusqlite::Error::InvalidParameterName(key)),
            }
            Ok(value)
        },
    )?;
    Ok(())
}

/// The replica this library is, if sync was ever turned on.
pub fn replica(conn: &Connection) -> Result<Option<Uuid>> {
    if !has_sync_tables(conn)? {
        return Ok(None);
    }
    let value: Option<String> = conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'replica'", [], |r| r.get(0))
        .optional()?;
    value
        .map(|v| Uuid::parse_str(&v).map_err(|e| Error::Damaged(e.to_string())))
        .transpose()
}

fn has_sync_tables(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sync_meta')",
        [],
        |r| r.get(0),
    )?)
}

fn self_origin(conn: &Connection) -> Result<Option<i64>> {
    let Some(replica) = replica(conn)? else {
        return Ok(None);
    };
    Ok(conn
        .query_row("SELECT id FROM sync_origins WHERE origin = ?1", [replica.to_string()], |r| r.get(0))
        .optional()?)
}

/// Makes the library the replica `replica` and starts recording on this connection. Once a
/// library is a replica it stays the same one; attaching it as another is refused. The fields
/// already there are not stamped: that is [`crate::baseline`].
pub fn attach(conn: &Connection, replica: Uuid) -> Result<()> {
    if !has_sync_tables(conn)? {
        return Err(Error::NoSyncSchema);
    }
    match self::replica(conn)? {
        Some(stored) if stored != replica => return Err(Error::OtherReplica { stored, given: replica }),
        _ => {}
    }
    conn.execute(
        "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('replica', ?1), ('hlc', 0)",
        [replica.to_string()],
    )?;
    conn.execute("INSERT OR IGNORE INTO sync_origins (origin) VALUES (?1)", [replica.to_string()])?;
    let origin = self_origin(conn)?.ok_or(Error::NotAttached)?;
    conn.execute("INSERT OR IGNORE INTO sync_vector (origin, counter) VALUES (?1, 0)", [origin])?;
    // On a connection that has the functions, only their state changes:
    // SQLite refuses to replace a function while any statement of the
    // connection runs, and one may in the caller's transaction (the app saw
    // it after writing its FTS5 index).
    if control(conn, "origin", origin).is_ok() {
        return control(conn, "capture", 1);
    }
    install(conn, State { capture: true, origin, ..State::default() })
}

fn control(conn: &Connection, key: &str, value: i64) -> Result<()> {
    conn.query_row("SELECT np_sync_control(?1, ?2)", rusqlite::params![key, value], |_| Ok(()))?;
    Ok(())
}

/// Turns recording on or off on this connection, for work that must not reach other replicas
/// (a restore replaces the library and is followed by [`crate::baseline`]).
pub fn set_capture(conn: &Connection, on: bool) -> Result<()> {
    control(conn, "capture", on as i64)
}

/// A fixed wall clock in milliseconds for this connection, or the real one with `None`. Tests
/// use it to make clocks of different replicas skew and collide.
pub fn set_wall_clock(conn: &Connection, ms: Option<u64>) -> Result<()> {
    control(conn, "wall", ms.map_or(-1, |ms| ms as i64))
}

pub(crate) fn observe(conn: &Connection, hlc: u64) -> Result<()> {
    control(conn, "observe", hlc as i64)
}

/// While it lives, the triggers record nothing on this connection: the changes being written
/// come from another replica with their own clocks.
pub struct Applying<'c>(&'c Connection);

impl<'c> Applying<'c> {
    pub fn new(conn: &'c Connection) -> Result<Applying<'c>> {
        control(conn, "applying", 1)?;
        Ok(Applying(conn))
    }
}

impl Drop for Applying<'_> {
    fn drop(&mut self) {
        let _ = control(self.0, "applying", -1);
    }
}

/// A new clock of this replica for a change the engine itself makes (a merge), as the triggers
/// would give it: (hlc, origin id, counter). [`persist`] keeps the counter afterwards.
pub(crate) fn stamp(conn: &Connection) -> Result<(u64, i64, u64)> {
    let (hlc, origin, counter): (i64, i64, i64) = conn.query_row(
        "SELECT np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
            np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if origin == 0 {
        return Err(Error::NotAttached);
    }
    Ok((hlc as u64, origin, counter as u64))
}

/// Keeps the last counter and clock this connection gave in the library.
pub(crate) fn persist(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE sync_vector SET counter = max(counter, np_sync_counter_last()) WHERE origin = np_sync_origin()",
        [],
    )?;
    conn.execute(
        "UPDATE sync_meta SET value = max(value, np_hlc_last()) WHERE key = 'hlc'",
        [],
    )?;
    Ok(())
}

pub(crate) fn origin_of_self(conn: &Connection) -> Result<i64> {
    let origin: i64 = conn.query_row("SELECT np_sync_origin()", [], |r| r.get(0))?;
    if origin == 0 {
        return Err(Error::NotAttached);
    }
    Ok(origin)
}
