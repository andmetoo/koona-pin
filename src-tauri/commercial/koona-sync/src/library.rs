//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! What a [`crate::session::Session`] needs from a library, as a trait: the session never owns
//! the database, so the app can take its own lock for each call and other code can write between
//! calls. `rusqlite::Connection` implements it directly.
//!
//! The session's own state lives in `sync_meta` beside the engine's keys (`replica`, `hlc`):
//!
//! | key | value |
//! |-----|-------|
//! | `library_key` | base64 of the 32-byte library key |
//! | `key_epoch` | the epoch of that key |
//! | `hub` | the last hub this device trusted (UUID) |
//! | `roster` | JSON `{"hub": uuid, "devices": [{"id", "key"}]}`, the pinned roster |
//!
//! The library key is a secret: an app that keeps secrets in the OS keychain implements
//! [`Library::load_meta`] and [`Library::store_meta`] over the keychain instead.

use crate::crypto::LibraryKey;
use crate::model::{Group, Vector};
use crate::protocol::RosterEntry;
use crate::{Applied, Chunk, Cursor, Delta, Error, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The schema version a library of this engine has; `hello.schema`.
pub const SCHEMA: u32 = 10;

/// The keys of the active devices as the hub vouched for them (`PROTOCOL.md` 4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub hub: Uuid,
    pub devices: Vec<RosterEntry>,
}

impl Roster {
    pub fn key_of(&self, device: Uuid) -> Option<[u8; 32]> {
        self.devices.iter().find(|d| d.id == device).map(|d| d.key.0)
    }

    pub fn set(&mut self, device: Uuid, key: [u8; 32]) {
        self.devices.retain(|d| d.id != device);
        self.devices.push(RosterEntry { id: device, key: crate::protocol::B64(key) });
        self.devices.sort_by_key(|d| d.id);
    }

    pub fn remove(&mut self, device: Uuid) {
        self.devices.retain(|d| d.id != device);
    }
}

/// What the session keeps across runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Meta {
    /// The library key and its epoch.
    pub key: Option<(u32, LibraryKey)>,
    pub hub: Option<Uuid>,
    pub roster: Option<Roster>,
}

/// One call's worth of a delta: a few chunks, and how many records are still to come.
#[derive(Debug, Clone)]
pub struct DeltaPage {
    pub chunks: Vec<Chunk>,
    pub remaining: usize,
}

pub trait Library {
    fn vector(&mut self) -> Result<Vector>;
    /// Up to `max_chunks` chunks of the delta beyond `since`, after `cursor` when given (the
    /// cursor of the last chunk of the previous page). Empty `chunks` once the last was given.
    fn delta(&mut self, since: &Vector, cursor: Option<&Cursor>, max_bytes: usize, max_chunks: usize)
        -> Result<DeltaPage>;
    fn apply(&mut self, groups: &[Group]) -> Result<Applied>;
    fn merge_vector(&mut self, covers: &Vector) -> Result<()>;
    fn load_meta(&mut self) -> Result<Meta>;
    fn store_meta(&mut self, meta: &Meta) -> Result<()>;
}

/// A delta resumes from its cursor on each call, so no statement or borrow outlives the call.
pub fn delta_page(
    conn: &Connection,
    since: &Vector,
    cursor: Option<&Cursor>,
    max_bytes: usize,
    max_chunks: usize,
) -> Result<DeltaPage> {
    let mut delta = match cursor {
        Some(cursor) => Delta::resume(conn, since, cursor)?,
        None => Delta::new(conn, since)?,
    };
    let mut chunks = Vec::new();
    while chunks.len() < max_chunks.max(1) {
        match delta.next_chunk(max_bytes)? {
            Some(chunk) => {
                let last = chunk.last;
                chunks.push(chunk);
                if last {
                    break;
                }
            }
            None => break,
        }
    }
    Ok(DeltaPage { chunks, remaining: delta.remaining() })
}

fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT CAST(value AS TEXT) FROM sync_meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

fn put(conn: &Connection, key: &str, value: Option<String>) -> Result<()> {
    match value {
        Some(value) => conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?,
        None => conn.execute("DELETE FROM sync_meta WHERE key = ?1", [key])?,
    };
    Ok(())
}

fn damaged(what: &str) -> Error {
    Error::Damaged(format!("sync_meta {what}"))
}

pub fn load_meta(conn: &Connection) -> Result<Meta> {
    let key = match (get(conn, "library_key")?, get(conn, "key_epoch")?) {
        (Some(key), Some(epoch)) => {
            let bytes = STANDARD.decode(key).map_err(|_| damaged("library_key"))?;
            let key: LibraryKey = bytes.try_into().map_err(|_| damaged("library_key"))?;
            Some((epoch.parse().map_err(|_| damaged("key_epoch"))?, key))
        }
        _ => None,
    };
    let hub = get(conn, "hub")?.map(|h| Uuid::parse_str(&h).map_err(|_| damaged("hub"))).transpose()?;
    let roster = get(conn, "roster")?
        .map(|r| serde_json::from_str(&r).map_err(|_| damaged("roster")))
        .transpose()?;
    Ok(Meta { key, hub, roster })
}

pub fn store_meta(conn: &Connection, meta: &Meta) -> Result<()> {
    conn.execute_batch("SAVEPOINT koona_sync_meta")?;
    let result = (|| {
        put(conn, "library_key", meta.key.map(|(_, key)| STANDARD.encode(key)))?;
        put(conn, "key_epoch", meta.key.map(|(epoch, _)| epoch.to_string()))?;
        put(conn, "hub", meta.hub.map(|h| h.to_string()))?;
        put(conn, "roster", meta.roster.as_ref().map(|r| serde_json::to_string(r).expect("a roster serializes")))
    })();
    match &result {
        Ok(()) => conn.execute_batch("RELEASE koona_sync_meta")?,
        Err(_) => conn.execute_batch("ROLLBACK TO koona_sync_meta; RELEASE koona_sync_meta")?,
    }
    result
}

impl Library for Connection {
    fn vector(&mut self) -> Result<Vector> {
        crate::vector(self)
    }

    fn delta(&mut self, since: &Vector, cursor: Option<&Cursor>, max_bytes: usize, max_chunks: usize) -> Result<DeltaPage> {
        delta_page(self, since, cursor, max_bytes, max_chunks)
    }

    fn apply(&mut self, groups: &[Group]) -> Result<Applied> {
        crate::apply(self, groups)
    }

    fn merge_vector(&mut self, covers: &Vector) -> Result<()> {
        crate::merge_vector(self, covers)
    }

    fn load_meta(&mut self) -> Result<Meta> {
        load_meta(self)
    }

    fn store_meta(&mut self, meta: &Meta) -> Result<()> {
        store_meta(self, meta)
    }
}
