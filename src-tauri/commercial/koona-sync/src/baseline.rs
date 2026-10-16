//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The baseline: every record, tag of a bookmark and tombstone of the library gets a new clock of
//! this replica, as if it had just been written. Run when sync is turned on (the library's
//! contents were never recorded) and after a restore (what was recorded is not what is there).
//! A record costs one clock, not one per field (`ROW`).

use crate::capture;
use crate::store::{BOOKMARKS, COLLECTIONS, FEEDS, LINK, ROW, TAGS};
use crate::Result;
use rusqlite::Connection;

const STAMP: &str = "np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
    np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))";

pub fn baseline(conn: &Connection) -> Result<()> {
    capture::origin_of_self(conn)?;
    conn.execute_batch("SAVEPOINT koona_sync_baseline")?;
    let result = stamp_all(conn);
    match result {
        Ok(()) => conn.execute_batch("RELEASE koona_sync_baseline")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO koona_sync_baseline; RELEASE koona_sync_baseline");
            return Err(e);
        }
    }
    Ok(())
}

fn stamp_all(conn: &Connection) -> Result<()> {
    // Feeds too (NP-130); a library before schema 14 has none to stamp.
    for t in [&COLLECTIONS, &TAGS, &BOOKMARKS, &FEEDS] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [t.name],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        conn.execute("DELETE FROM sync_clock WHERE entity = ?1", [t.code])?;
        conn.execute(
            &format!(
                "INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
                 SELECT {}, id, {ROW}, {STAMP} FROM {} ORDER BY id",
                t.code, t.name
            ),
            [],
        )?;
    }
    conn.execute("DELETE FROM sync_clock WHERE entity = ?1", [LINK])?;
    conn.execute(
        &format!(
            "INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
             SELECT {LINK}, bookmark_id, tag_id, {STAMP} FROM bookmark_tags ORDER BY bookmark_id, tag_id"
        ),
        [],
    )?;
    // Purges from before sync reach the other replicas too.
    let tombstones: Vec<String> = conn
        .prepare("SELECT uid FROM tombstones WHERE hlc IS NULL ORDER BY rowid")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for uid in tombstones {
        let (hlc, origin, counter) = capture::stamp(conn)?;
        conn.execute(
            "UPDATE tombstones SET hlc = ?1, origin = ?2, counter = ?3 WHERE uid = ?4",
            rusqlite::params![hlc as i64, origin, counter as i64, uid],
        )?;
    }
    capture::persist(conn)
}
