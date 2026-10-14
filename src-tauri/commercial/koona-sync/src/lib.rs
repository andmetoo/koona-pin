//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The sync engine (Р-68): every library is a replica that records the last clock of each field
//! it changed; two replicas exchange the fields beyond each other's version vector, and the later
//! clock wins field by field, so they end in one state whatever the order of delivery. The relay
//! between devices only forwards frames this crate encrypts. No Tauri here: the phone apps wrap
//! the same code later.
//!
//! The library side: [`register`] on every connection, [`attach`] and [`baseline`] when sync is
//! turned on, then [`Delta`] to send and [`apply`] + [`merge_vector`] to receive. The engine
//! needs two SQL functions of the app on the connection besides its own: `np_domain(url)` and
//! `np_url_key(url)`, for the derived columns of a bookmark it writes.

mod apply;
mod baseline;
mod capture;
mod hlc;
pub mod model;
pub mod crypto;
pub mod protocol;
// The device side of the protocol: the session (task B of sync v1) and its socket.
pub mod library;
#[cfg(feature = "net")]
pub mod net;
pub mod session;
mod store;
mod unique;

pub use apply::{apply, Applied};
pub use baseline::baseline;
pub use capture::{attach, register, replica, set_capture, set_wall_clock, Applying};
pub use store::{merge_vector, vector, Chunk, Cursor, Delta};

/// Schema 10: the tables and triggers of sync, for the app's migration.
pub const SCHEMA_10: &str = include_str!("schema10.sql");

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    /// The library has no sync tables (schema 9 or earlier).
    NoSyncSchema,
    /// Sync was never turned on for this library.
    NotAttached,
    /// The library is another replica already.
    OtherReplica { stored: uuid::Uuid, given: uuid::Uuid },
    /// Something stored makes no sense: a uid that is not one, a replica without a number.
    Damaged(String),
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::Sql(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "{e}"),
            Error::NoSyncSchema => write!(f, "the library has no sync tables"),
            Error::NotAttached => write!(f, "sync is not turned on for this library"),
            Error::OtherReplica { stored, given } => write!(f, "the library is replica {stored}, not {given}"),
            Error::Damaged(what) => write!(f, "damaged sync data: {what}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Every chunk of a delta, built at once: for tests and small libraries.
pub fn delta_all(conn: &rusqlite::Connection, since: &model::Vector, max_bytes: usize) -> Result<Vec<Chunk>> {
    let mut delta = Delta::new(conn, since)?;
    let mut chunks = Vec::new();
    while let Some(chunk) = delta.next_chunk(max_bytes)? {
        chunks.push(chunk);
    }
    Ok(chunks)
}
