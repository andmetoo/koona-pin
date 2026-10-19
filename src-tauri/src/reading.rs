//! The Reading list (NP-121, Р-69, point 3): what to read, with how far it
//! was read and whether it was.
//!
//! Sending to Reading, taking out and marking read or unread by hand are
//! bulk actions (`db::Bulk::Reading`, `db::Bulk::Read`) and commands of the
//! undo journal. Progress is written by the reader (NP-122) as the person
//! scrolls: no command of the journal, and reaching the end marks the
//! bookmark read. A read bookmark goes to the bottom of the list
//! (`db::BookmarkQuery::only_reading`) and leaves Reading [`KEEP_DAYS`] after
//! it was read; the setting [`KEEP_DAYS_SETTING`] changes that (its
//! interface is NP-124). Leaving keeps the progress and read state: they
//! belong to the bookmark.

use crate::db::{self, Bookmark};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, Result};

/// Days a read bookmark stays in Reading by default.
pub const KEEP_DAYS: i64 = 7;
/// `app_settings` key of the days a read bookmark stays; a number of days.
pub const KEEP_DAYS_SETTING: &str = "reading_keep_days";

/// Unread bookmarks in Reading: the number by «Reading» in the sidebar.
pub fn unread(conn: &Connection) -> Result<i64> {
    counts(conn).map(|(_, unread)| unread)
}

/// Bookmarks in Reading and the unread ones of them, in one pass over the
/// index (`idx_bookmarks_reading`, schema 11).
pub fn counts(conn: &Connection) -> Result<(i64, i64)> {
    conn.query_row(
        "SELECT count(*), COALESCE(sum(read_at IS NULL), 0) FROM bookmarks
         WHERE reading_at IS NOT NULL AND deleted_at IS NULL",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// The reader's position in an article, 0 to 1 (out of range is clamped).
/// At 1 the bookmark is read, from then on, unless «Mark as read at the end»
/// ([`MARK_AT_END_SETTING`]) is off; a smaller value later keeps it read, as
/// rereading does. A position that changes nothing writes nothing, so a quiet
/// scroll records no change for sync. The trash is left alone.
pub fn set_progress(conn: &Connection, id: i64, progress: f64) -> Result<Bookmark> {
    let progress = if progress.is_nan() { 0.0 } else { progress.clamp(0.0, 1.0) };
    let marks = mark_at_end(conn);
    conn.execute(
        "UPDATE bookmarks SET reading_progress = ?2,
             read_at = CASE WHEN ?2 >= 1 AND ?4 THEN COALESCE(read_at, ?3) ELSE read_at END,
             updated_at = ?3, revision = revision + 1
         WHERE id = ?1 AND deleted_at IS NULL
             AND (reading_progress IS NOT ?2 OR (?2 >= 1 AND ?4 AND read_at IS NULL))",
        params![id, progress, db::now(), marks],
    )?;
    db::get_bookmark_by_id(conn, id)
}

/// `app_settings` key of «Mark as read at the end» (NP-124, Settings → Reading):
/// `false` turns it off; anything else, or nothing, leaves it on.
pub const MARK_AT_END_SETTING: &str = "reading_mark_at_end";

/// Whether reaching the end of an article marks it read; on by default.
pub fn mark_at_end(conn: &Connection) -> bool {
    db::setting(conn, MARK_AT_END_SETTING).map_or(true, |v| v != "false")
}

/// How many days a read bookmark stays in Reading.
pub fn keep_days(conn: &Connection) -> i64 {
    db::setting(conn, KEEP_DAYS_SETTING)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|days| *days >= 0)
        .unwrap_or(KEEP_DAYS)
}

/// Takes out of Reading what was read [`keep_days`] ago or earlier, at
/// start and hourly with the trash (`library_state`). Returns the ids. A
/// clock moved ahead takes them out early, which loses nothing: the
/// bookmark, its progress and read state stay.
pub fn tidy(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<i64>> {
    let cutoff = db::stamp(now - Duration::days(keep_days(conn)));
    let tx = conn.unchecked_transaction()?;
    let ids = tx
        .prepare(
            "SELECT id FROM bookmarks
             WHERE reading_at IS NOT NULL AND deleted_at IS NULL AND read_at IS NOT NULL AND read_at <= ?1",
        )?
        .query_map([&cutoff], |r| r.get(0))?
        .collect::<Result<Vec<i64>>>()?;
    tx.execute(
        "UPDATE bookmarks SET reading_at = NULL, updated_at = ?2, revision = revision + 1
         WHERE id IN (SELECT value FROM json_each(?1))",
        params![db::id_list(&ids)?, db::stamp(now)],
    )?;
    tx.commit()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{apply_bulk, get_bookmark_ids, get_bookmarks, insert_or_update_bookmark, BookmarkQuery, Bulk, Source};
    use crate::journal::{Action, Journal, Undo};

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn add(conn: &Connection, path: &str) -> i64 {
        insert_or_update_bookmark(conn, &format!("https://example.com/{path}"), path, None, None, None, "example.com", None, None, Source::App)
            .unwrap()
            .id
    }

    /// In Reading since `at`, read at `read` (none: unread).
    fn place(conn: &Connection, id: i64, at: &str, read: Option<&str>) {
        conn.execute("UPDATE bookmarks SET reading_at = ?2, read_at = ?3 WHERE id = ?1", params![id, at, read]).unwrap();
    }

    fn reading() -> BookmarkQuery {
        BookmarkQuery { only_reading: true, ..Default::default() }
    }

    fn titles(conn: &Connection, query: &BookmarkQuery) -> Vec<String> {
        get_bookmarks(conn, query).unwrap().items.into_iter().map(|b| b.title).collect()
    }

    #[test]
    fn unread_newest_added_first_then_the_read_ones_and_pages_follow_that_order() {
        let conn = library();
        let ids: Vec<i64> = ["a", "b", "c", "d", "e", "out"].iter().map(|p| add(&conn, p)).collect();
        place(&conn, ids[0], "2026-10-01T10:00:00.000Z", None);
        place(&conn, ids[1], "2026-10-03T10:00:00.000Z", None);
        place(&conn, ids[2], "2026-10-05T10:00:00.000Z", Some("2026-10-06T10:00:00.000Z"));
        place(&conn, ids[3], "2026-10-02T10:00:00.000Z", Some("2026-10-08T10:00:00.000Z"));
        // Equal times go by id, newest first.
        place(&conn, ids[4], "2026-10-03T10:00:00.000Z", None);
        // Read but not in Reading: not listed.
        conn.execute("UPDATE bookmarks SET read_at = '2026-10-09T10:00:00.000Z' WHERE id = ?1", [ids[5]]).unwrap();
        let all = ["e", "b", "a", "d", "c"];
        // The order chosen for the library does not apply.
        let by_title = BookmarkQuery { sort: Some(db::BookmarkSort::Title), ..reading() };
        assert_eq!(titles(&conn, &by_title), all);
        assert_eq!(get_bookmarks(&conn, &reading()).unwrap().total, Some(5));
        assert_eq!(unread(&conn).unwrap(), 3);
        let ids_in_order = get_bookmark_ids(&conn, &reading()).unwrap();
        assert_eq!(ids_in_order, [ids[4], ids[1], ids[0], ids[3], ids[2]]);
        // Page by page, two at a time, across the unread and read ones.
        let mut seen = Vec::new();
        let mut query = BookmarkQuery { limit: Some(2), ..reading() };
        loop {
            let page = get_bookmarks(&conn, &query).unwrap();
            seen.extend(page.items.into_iter().map(|b| b.title));
            match page.next {
                Some(next) => query.after = Some(next),
                None => break,
            }
        }
        assert_eq!(seen, all);
        // The trash leaves it.
        db::trash_bookmark(&conn, ids[0]).unwrap();
        assert_eq!(unread(&conn).unwrap(), 2);
        assert_eq!(titles(&conn, &reading()), ["e", "b", "d", "c"]);
        // A search inside Reading.
        assert_eq!(titles(&conn, &BookmarkQuery { search: Some("example.com/b".into()), ..reading() }), ["b"]);
    }

    #[test]
    fn progress_reaches_the_end_and_marks_read_once() {
        let conn = library();
        let id = add(&conn, "article");
        apply_bulk(&conn, &[id], &Bulk::Reading(true)).unwrap();
        let b = set_progress(&conn, id, 0.4).unwrap();
        assert_eq!((b.reading_progress, b.read_at.is_none()), (0.4, true));
        let revision = b.revision;
        assert_eq!(set_progress(&conn, id, 0.4).unwrap().revision, revision, "no change, no write");
        let read = set_progress(&conn, id, 1.7).unwrap();
        assert_eq!(read.reading_progress, 1.0);
        let at = read.read_at.clone().expect("read at the end");
        // Scrolling back keeps it read since then.
        let back = set_progress(&conn, id, 0.2).unwrap();
        assert_eq!((back.reading_progress, back.read_at.as_deref()), (0.2, Some(at.as_str())));
        assert_eq!(set_progress(&conn, id, f64::NAN).unwrap().reading_progress, 0.0);
        assert_eq!(unread(&conn).unwrap(), 0);
        // The trash is left alone.
        db::trash_bookmark(&conn, id).unwrap();
        assert_eq!(set_progress(&conn, id, 0.9).unwrap().reading_progress, 0.0);
    }

    #[test]
    fn the_end_does_not_mark_read_with_the_setting_off() {
        let conn = library();
        let id = add(&conn, "article");
        apply_bulk(&conn, &[id], &Bulk::Reading(true)).unwrap();
        assert!(mark_at_end(&conn), "on by default");
        db::set_setting(&conn, MARK_AT_END_SETTING, "false").unwrap();
        let b = set_progress(&conn, id, 1.0).unwrap();
        assert_eq!((b.reading_progress, b.read_at.is_none()), (1.0, true));
        let revision = b.revision;
        assert_eq!(set_progress(&conn, id, 1.0).unwrap().revision, revision, "nothing to write at the end again");
        assert_eq!(unread(&conn).unwrap(), 1);
        // Back on: the next time the end is reached it is read.
        db::set_setting(&conn, MARK_AT_END_SETTING, "true").unwrap();
        assert!(set_progress(&conn, id, 1.0).unwrap().read_at.is_some());
    }

    #[test]
    fn sending_taking_out_and_marking_are_undone_by_the_journal() {
        let conn = library();
        let mut journal = Journal::default();
        let a = add(&conn, "a");
        let b = add(&conn, "b");
        let ids = [a, b];
        let mut run = |action: Action, change: Bulk| {
            journal.record(&conn, action, &ids, |conn| apply_bulk(conn, &ids, &change).map(|(_, c)| c)).unwrap()
        };
        let (sent, command) = run(Action::ToReading, Bulk::Reading(true));
        assert_eq!(sent.len(), 2);
        assert!(command.is_some());
        assert!(sent.iter().all(|b| b.reading_at.is_some() && b.triaged_at.is_none()), "still in the inbox");
        // Sending again changes nothing and records nothing.
        assert_eq!(run(Action::ToReading, Bulk::Reading(true)).1, None);
        set_progress(&conn, a, 0.5).unwrap();
        run(Action::Read, Bulk::Read(true));
        assert_eq!(unread(&conn).unwrap(), 0);
        run(Action::FromReading, Bulk::Reading(false));
        assert_eq!(get_bookmarks(&conn, &reading()).unwrap().total, Some(0));
        let out = db::get_bookmark_by_id(&conn, a).unwrap();
        assert_eq!((out.reading_progress, out.read_at.is_some()), (1.0, true), "progress and read state stay");

        // Ctrl Z: back into Reading, then unread with the progress it had, then out.
        let mut undo = |expected: Action| match journal.undo(&conn, None).unwrap() {
            Undo::Undone { action, bookmarks } => {
                assert_eq!(action, expected);
                bookmarks
            }
            other => panic!("expected an undo, got {other:?}"),
        };
        assert!(undo(Action::FromReading).iter().all(|b| b.reading_at.is_some()));
        let unread_again = undo(Action::Read);
        let a_back = unread_again.iter().find(|x| x.id == a).unwrap();
        assert_eq!((a_back.reading_progress, a_back.read_at.as_deref()), (0.5, None));
        assert_eq!(unread(&conn).unwrap(), 2);
        assert!(undo(Action::ToReading).iter().all(|b| b.reading_at.is_none()));
        assert_eq!(unread(&conn).unwrap(), 0);
        assert!(matches!(journal.undo(&conn, None).unwrap(), Undo::Nothing));
    }

    #[test]
    fn finishing_takes_it_out_of_reading_and_marks_it_read_in_one_command() {
        let conn = library();
        let mut journal = Journal::default();
        let id = add(&conn, "finished");
        apply_bulk(&conn, &[id], &Bulk::Reading(true)).unwrap();
        set_progress(&conn, id, 0.4).unwrap();
        let (done, command) = journal.record(&conn, Action::FromReading, &[id], |conn| apply_bulk(conn, &[id], &Bulk::Finish).map(|(_, c)| c)).unwrap();
        assert!(command.is_some());
        let b = &done[0];
        assert_eq!((b.reading_at.is_none(), b.read_at.is_some(), b.reading_progress), (true, true, 1.0));
        // Finished again: nothing to change, nothing recorded.
        assert_eq!(apply_bulk(&conn, &[id], &Bulk::Finish).unwrap().1.len(), 0);
        // One undo puts back both: in Reading, unread, where it stopped.
        match journal.undo(&conn, None).unwrap() {
            Undo::Undone { bookmarks, .. } => {
                let b = &bookmarks[0];
                assert_eq!((b.reading_at.is_some(), b.read_at.is_none(), b.reading_progress), (true, true, 0.4));
            }
            other => panic!("expected an undo, got {other:?}"),
        }
    }

    #[test]
    fn a_read_one_sent_again_starts_over_and_unread_starts_from_the_top() {
        let conn = library();
        let id = add(&conn, "again");
        apply_bulk(&conn, &[id], &Bulk::Reading(true)).unwrap();
        set_progress(&conn, id, 1.0).unwrap();
        apply_bulk(&conn, &[id], &Bulk::Reading(false)).unwrap();
        let (_, changed) = apply_bulk(&conn, &[id], &Bulk::Reading(true)).unwrap();
        assert_eq!((changed[0].reading_progress, changed[0].read_at.as_deref()), (0.0, None));
        set_progress(&conn, id, 0.3).unwrap();
        let (_, changed) = apply_bulk(&conn, &[id], &Bulk::Read(false)).unwrap();
        assert_eq!(changed[0].reading_progress, 0.0);
        assert_eq!(apply_bulk(&conn, &[id], &Bulk::Read(false)).unwrap().1.len(), 0, "unread already");
    }

    #[test]
    fn read_ones_leave_after_the_days_set_and_keep_their_state() {
        let conn = library();
        let old = add(&conn, "old");
        let recent = add(&conn, "recent");
        let unread_one = add(&conn, "unread");
        place(&conn, old, "2026-10-01T10:00:00.000Z", Some("2026-10-06T09:00:00.000Z"));
        place(&conn, recent, "2026-10-01T10:00:00.000Z", Some("2026-10-10T10:00:00.000Z"));
        place(&conn, unread_one, "2026-09-01T10:00:00.000Z", None);
        let now = DateTime::parse_from_rfc3339("2026-10-13T10:00:00Z").unwrap().to_utc();
        assert_eq!(keep_days(&conn), 7);
        assert_eq!(tidy(&conn, now).unwrap(), [old]);
        let left = db::get_bookmark_by_id(&conn, old).unwrap();
        assert_eq!((left.reading_at, left.read_at.is_some()), (None, true));
        assert_eq!(titles(&conn, &reading()), ["unread", "recent"]);
        // A setting of two days takes the recent one too; nothing unread ever goes.
        db::set_setting(&conn, KEEP_DAYS_SETTING, "2").unwrap();
        assert_eq!(tidy(&conn, now).unwrap(), [recent]);
        db::set_setting(&conn, KEEP_DAYS_SETTING, "never").unwrap();
        assert_eq!(keep_days(&conn), KEEP_DAYS);
        assert!(tidy(&conn, now + Duration::days(400)).unwrap().is_empty());
        assert_eq!(titles(&conn, &reading()), ["unread"]);
    }
}
