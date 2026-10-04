//! The trash empties itself (NP-023, Р-22): a bookmark that has lain there
//! 30 days is deleted for good, at start and hourly, without a word.
//!
//! The age comes from the system clock, and a clock moved far ahead would
//! empty the whole trash at once. So the library remembers when it last
//! looked; when the clock has moved more than two days since then — a jump,
//! or simply a long break — the cleanup waits until the clock has run
//! steadily for a day. A clock moved back deletes nothing early: the cutoff
//! only moves back with it.

use crate::db::{self, Purge};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, Result};

/// How long the trash keeps a bookmark; the interface counts the same days.
pub const KEEP_DAYS: i64 = 30;
/// A larger step between two looks is not trusted at once.
const JUMP: Duration = Duration::days(2);
/// How long the clock must then run without jumps.
const STEADY: Duration = Duration::hours(24);
/// When the cleanup last looked at the clock.
const LOOKED: &str = "trash_clock_looked";
/// Milliseconds the clock still has to run steadily; 0 once it is trusted.
const WAIT: &str = "trash_clock_wait_ms";

/// One look at the clock: returns the `id` and revision of each bookmark it
/// deleted. A failed write leaves the trash as it was; the next look repeats.
pub fn tidy(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<(i64, i64)>> {
    let looked = db::setting(conn, LOOKED)
        .ok()
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|time| time.with_timezone(&Utc));
    let wait = db::setting(conn, WAIT)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let wait = match looked {
        // A clock that went back counts nothing towards the wait.
        Some(looked) if now - looked <= JUMP => {
            (wait - (now - looked).num_milliseconds().max(0)).max(0)
        }
        // The first look, a long break or a jump ahead.
        _ => STEADY.num_milliseconds(),
    };
    db::set_setting(conn, LOOKED, &db::stamp(now))?;
    db::set_setting(conn, WAIT, &wait.to_string())?;
    if wait > 0 {
        return Ok(Vec::new());
    }
    let cutoff = db::stamp(now - Duration::days(KEEP_DAYS));
    db::purge_trash(conn, Purge::Before(&cutoff))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        get_bookmarks, get_counts, insert_or_update_bookmark, trash_bookmark, Bookmark,
        BookmarkQuery, Source,
    };

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn add(conn: &Connection, url: &str) -> Bookmark {
        let tags = ["тег".to_string()];
        insert_or_update_bookmark(
            conn,
            url,
            "Ссылка",
            None,
            None,
            None,
            "example.com",
            None,
            Some(&tags),
            Source::App,
        )
        .unwrap()
    }

    /// A bookmark sent to the trash at `deleted`.
    fn thrown(conn: &Connection, url: &str, deleted: &str) -> i64 {
        let b = add(conn, url);
        trash_bookmark(conn, b.id).unwrap();
        conn.execute(
            "UPDATE bookmarks SET deleted_at = ?1 WHERE id = ?2",
            rusqlite::params![deleted, b.id],
        )
        .unwrap();
        b.id
    }

    fn left(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT url FROM bookmarks ORDER BY url")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap()
    }

    /// The clock was last seen at `time` and is trusted.
    fn steady_since(conn: &Connection, time: &str) {
        db::set_setting(conn, LOOKED, time).unwrap();
        db::set_setting(conn, WAIT, "0").unwrap();
    }

    #[test]
    fn only_bookmarks_older_than_thirty_days_go_and_leave_a_tombstone() {
        let conn = library();
        let old = thrown(&conn, "https://example.com/old", "2026-09-01T10:00:00.000Z");
        thrown(
            &conn,
            "https://example.com/recent",
            "2026-09-20T10:00:00.000Z",
        );
        add(&conn, "https://example.com/live");
        steady_since(&conn, "2026-10-04T09:00:00.000Z");

        let gone = tidy(&conn, at("2026-10-04T10:00:00.000Z")).unwrap();
        assert_eq!(gone.iter().map(|g| g.0).collect::<Vec<_>>(), [old]);
        assert_eq!(
            left(&conn),
            ["https://example.com/live", "https://example.com/recent"]
        );
        // Tags, the search index and the counts let go of it too.
        let links: i64 = conn
            .query_row(
                "SELECT count(*) FROM bookmark_tags WHERE bookmark_id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(links, 0);
        let query = BookmarkQuery {
            search: Some("old".into()),
            only_trash: true,
            ..Default::default()
        };
        assert_eq!(get_bookmarks(&conn, &query).unwrap().items.len(), 0);
        assert_eq!(get_counts(&conn).unwrap().trash, 1);
        let (kind, deleted): (String, String) = conn
            .query_row("SELECT kind, deleted_at FROM tombstones", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(
            (kind.as_str(), deleted.as_str()),
            ("bookmark", "2026-09-01T10:00:00.000Z")
        );
    }

    #[test]
    fn after_a_long_break_the_cleanup_waits_a_day_and_then_keeps_the_rule() {
        let conn = library();
        thrown(&conn, "https://example.com/old", "2026-08-01T10:00:00.000Z");
        thrown(
            &conn,
            "https://example.com/recent",
            "2026-09-20T10:00:00.000Z",
        );
        steady_since(&conn, "2026-08-20T10:00:00.000Z");

        // Six weeks without a start: the clock is not trusted yet.
        assert!(tidy(&conn, at("2026-10-01T10:00:00.000Z"))
            .unwrap()
            .is_empty());
        assert!(tidy(&conn, at("2026-10-01T22:00:00.000Z"))
            .unwrap()
            .is_empty());
        // A day later, across a restart, only the old one goes.
        tidy(&conn, at("2026-10-02T10:00:00.000Z")).unwrap();
        assert_eq!(left(&conn), ["https://example.com/recent"]);
    }

    #[test]
    fn a_clock_moved_a_year_ahead_and_back_deletes_nothing_early() {
        let conn = library();
        thrown(
            &conn,
            "https://example.com/yesterday",
            "2026-10-03T10:00:00.000Z",
        );
        steady_since(&conn, "2026-10-04T09:00:00.000Z");

        // A year ahead: the bookmark looks a year old, but the jump is not trusted.
        assert!(tidy(&conn, at("2027-10-04T10:00:00.000Z"))
            .unwrap()
            .is_empty());
        assert!(tidy(&conn, at("2027-10-04T11:00:00.000Z"))
            .unwrap()
            .is_empty());
        // Put right: going back counts nothing, and the true age is one day.
        assert!(tidy(&conn, at("2026-10-04T12:00:00.000Z"))
            .unwrap()
            .is_empty());
        assert!(tidy(&conn, at("2026-10-05T13:00:00.000Z"))
            .unwrap()
            .is_empty());
        assert_eq!(left(&conn), ["https://example.com/yesterday"]);
        // The clock is trusted again and the rule holds as usual.
        let wait: String = db::setting(&conn, WAIT).unwrap();
        assert_eq!(wait, "0");
    }

    #[test]
    fn the_first_look_waits_too() {
        let conn = library();
        thrown(&conn, "https://example.com/old", "2026-08-01T10:00:00.000Z");
        assert!(tidy(&conn, at("2026-10-04T10:00:00.000Z"))
            .unwrap()
            .is_empty());
        assert_eq!(
            tidy(&conn, at("2026-10-05T10:00:00.000Z")).unwrap().len(),
            1
        );
    }

    #[test]
    fn a_failed_cleanup_loses_nothing_and_runs_again() {
        let conn = library();
        thrown(&conn, "https://example.com/old", "2026-08-01T10:00:00.000Z");
        steady_since(&conn, "2026-10-04T09:00:00.000Z");

        conn.pragma_update(None, "query_only", true).unwrap();
        assert!(tidy(&conn, at("2026-10-04T10:00:00.000Z")).is_err());
        conn.pragma_update(None, "query_only", false).unwrap();
        assert_eq!(left(&conn), ["https://example.com/old"]);

        // A write that fails halfway through the purge rolls all of it back.
        conn.execute_batch(
            "CREATE TRIGGER refuse BEFORE INSERT ON tombstones BEGIN SELECT RAISE(ABORT, 'disk'); END;",
        )
        .unwrap();
        assert!(tidy(&conn, at("2026-10-04T11:00:00.000Z")).is_err());
        assert_eq!(left(&conn), ["https://example.com/old"]);
        let tombstones: i64 = conn
            .query_row("SELECT count(*) FROM tombstones", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombstones, 0);

        conn.execute_batch("DROP TRIGGER refuse;").unwrap();
        assert_eq!(
            tidy(&conn, at("2026-10-04T12:00:00.000Z")).unwrap().len(),
            1
        );
        assert!(left(&conn).is_empty());
    }

    #[test]
    fn only_the_trash_is_ever_deleted_for_good() {
        let conn = library();
        let live = add(&conn, "https://example.com/live");
        let one = thrown(&conn, "https://example.com/one", "2026-10-04T10:00:00.000Z");
        thrown(&conn, "https://example.com/two", "2026-10-04T10:00:00.000Z");

        assert!(db::purge_trash(&conn, Purge::One(live.id))
            .unwrap()
            .is_empty());
        assert_eq!(db::purge_trash(&conn, Purge::One(one)).unwrap().len(), 1);
        assert_eq!(db::purge_trash(&conn, Purge::All).unwrap().len(), 1);
        assert_eq!(left(&conn), ["https://example.com/live"]);
    }
}
