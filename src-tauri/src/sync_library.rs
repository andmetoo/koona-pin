//! Sync in the library (Р-68): what the app's database code needs from the
//! sync engine `koona_sync` (commercial), and what it must do itself around
//! it. The engine records every change through the triggers of schema 10;
//! the writes here are those it cannot see as plain changes: a batch from
//! another device, and a restore that replaces the library.

use crate::db;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;

fn sql(error: koona_sync::Error) -> rusqlite::Error {
    match error {
        koona_sync::Error::Sql(e) => e,
        other => rusqlite::Error::UserFunctionError(other.to_string().into()),
    }
}

/// The engine's SQL functions on a connection: every connection that writes
/// needs them, sync on or off (`db::register_functions`).
pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    koona_sync::register(conn).map_err(sql)
}

/// Whether sync was turned on for this library: it is a replica then.
pub fn is_on(conn: &Connection) -> bool {
    matches!(koona_sync::replica(conn), Ok(Some(_)))
}

/// Turns sync on: the library becomes `replica` and everything in it is
/// recorded once, in one transaction.
pub fn turn_on(conn: &Connection, replica: uuid::Uuid) -> koona_sync::Result<()> {
    let tx = conn.unchecked_transaction()?;
    koona_sync::attach(&tx, replica)?;
    koona_sync::baseline(&tx)?;
    tx.commit()?;
    Ok(())
}

/// A batch from another device in one transaction. The search rows and sort
/// keys of the bookmarks it writes are written once at the end, not by the
/// triggers on every write: a snapshot writes a bookmark, then each of its
/// tags, and the search row was written again for each.
pub fn apply(conn: &Connection, groups: &[koona_sync::model::Group]) -> koona_sync::Result<koona_sync::Applied> {
    let tx = conn.unchecked_transaction()?;
    let deferred = db::IndexDeferred::new(&tx)?;
    let applied = koona_sync::apply(&tx, groups)?;
    deferred.finish()?;
    tx.commit()?;
    Ok(applied)
}

/// The chunks of one answer applied in fewer, larger transactions. Each
/// commit writes the index pages it touched again: the snapshot of SPIKE.md
/// (100 000 bookmarks, 248 chunks of 1 MB) took 27 s as a transaction per
/// chunk, 12.5 s held here, 36 s with the triggers on every write
/// (`a_snapshot_of_a_hundred_thousand_bookmarks`, release, M-series Mac).
/// Chunks wait until about [`Receiving::GROUPS`] groups are held, or the last
/// one comes. Held groups lost with the connection come again: the session
/// merges `covers` only after the last chunk, so the vector does not cover
/// them.
#[derive(Default)]
pub struct Receiving {
    held: Vec<koona_sync::model::Group>,
}

impl Receiving {
    /// About 27 MB of a snapshot's JSON, a second or two of writing.
    pub const GROUPS: usize = 20_000;

    /// One chunk; returns what was applied when it applied the held ones.
    /// `last`: the answer is complete, everything held is applied now.
    pub fn add(
        &mut self,
        conn: &Connection,
        groups: Vec<koona_sync::model::Group>,
        last: bool,
    ) -> koona_sync::Result<Option<koona_sync::Applied>> {
        self.held.extend(groups);
        if !last && self.held.len() < Self::GROUPS {
            return Ok(None);
        }
        let applied = apply(conn, &self.held)?;
        self.held.clear();
        Ok(Some(applied))
    }
}

/// Clears what the engine keeps: a library copied from another one must not
/// go on as the replica it was. Sync is off afterwards, and the tombstones
/// lose their clocks (a [`koona_sync::baseline`] gives them new ones).
pub fn forget(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM sync_clock; DELETE FROM sync_vector; DELETE FROM sync_origins; DELETE FROM sync_meta;
         UPDATE tombstones SET hlc = NULL, origin = NULL, counter = NULL WHERE hlc IS NOT NULL OR origin IS NOT NULL;",
    )?;
    // Off on this connection too. Not by registering the functions again:
    // SQLite refuses that while a statement runs, as one may in the caller's
    // transaction.
    koona_sync::set_capture(conn, false).map_err(sql)
}

/// What a library with sync on keeps across a restore: the settings of
/// `sync_meta` (the library key, its epoch, the hub, the clock), not the
/// replica.
pub struct Kept(Vec<(String, Value)>);

/// Before a restore replaces the library: none when sync is off.
pub fn keep(conn: &Connection) -> rusqlite::Result<Option<Kept>> {
    if !is_on(conn) {
        return Ok(None);
    }
    let rows = conn
        .prepare("SELECT key, value FROM sync_meta WHERE key <> 'replica'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(Kept(rows)))
}

/// After a restore replaced the library of a device with sync on. What the
/// other devices hold stays theirs, and nothing they have is purged:
///
/// - the library becomes a new replica that holds nothing of anyone, with the
///   settings it had: its old counters may be known elsewhere already, and
///   what the copy says it held is not what it holds now;
/// - the bookmarks outside the trash in `previous` (the library as it was)
///   that the copy lacks go to the trash, so the other devices see them
///   trashed and the person can get them back;
/// - everything is recorded anew ([`koona_sync::baseline`]): the copy's
///   values win over the other devices' ones once, the way a restore means.
///
/// A `previous` that cannot be read keeps no bookmarks in the trash; the
/// restore goes on. Returns how many went there.
pub fn after_restore(conn: &Connection, kept: Kept, previous: &Path) -> koona_sync::Result<usize> {
    forget(conn)?;
    {
        let mut insert = conn.prepare("INSERT INTO sync_meta (key, value) VALUES (?1, ?2)")?;
        for (key, value) in &kept.0 {
            insert.execute(params![key, value])?;
        }
    }
    let trashed = match trash_missing(conn, previous) {
        Ok(n) => n,
        Err(error) => {
            eprintln!("The bookmarks of the replaced library were not kept in the trash: {error}");
            0
        }
    };
    // A record the restore brought back is no longer purged here. Another
    // device that purged it keeps it purged: a purge is final (SPIKE.md).
    conn.execute(
        "DELETE FROM tombstones WHERE uid IN (SELECT uid FROM bookmarks UNION ALL SELECT uid FROM collections UNION ALL SELECT uid FROM tags)",
        [],
    )?;
    koona_sync::attach(conn, uuid::Uuid::new_v4())?;
    koona_sync::baseline(conn)?;
    Ok(trashed)
}

/// Puts the bookmarks outside the trash in `previous` that the library lacks
/// (by uid; an address the library has is the same page and stays out) into
/// the trash with their notes, tags and collection (by uid, if the library
/// has it). Returns how many.
fn trash_missing(conn: &Connection, previous: &Path) -> rusqlite::Result<usize> {
    let old = Connection::open_with_flags(previous, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let now = db::now();
    let mut statement = old.prepare(
        "SELECT b.uid, b.url, b.title, b.description, b.image_url, b.favicon_url, b.domain, b.notes, b.is_favorite,
                c.uid, b.source, b.created_at, b.triaged_at, b.source_name,
                (SELECT json_group_array(t.name) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id),
                b.site_name
         FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id
         WHERE b.deleted_at IS NULL ORDER BY b.id",
    )?;
    let mut rows = statement.query([])?;
    let mut count = 0;
    while let Some(r) = rows.next()? {
        let (uid, url): (String, String) = (r.get(0)?, r.get(1)?);
        let present: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM bookmarks WHERE uid = ?1 OR url = ?2)",
            params![uid, url],
            |r| r.get(0),
        )?;
        if present {
            continue;
        }
        let collection: Option<String> = r.get(9)?;
        let collection: Option<i64> = match collection {
            Some(uid) => {
                use rusqlite::OptionalExtension;
                conn.query_row("SELECT id FROM collections WHERE uid = ?1", [uid], |r| r.get(0)).optional()?
            }
            None => None,
        };
        conn.execute(
            "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, notes, is_favorite,
                 collection_id, source, created_at, updated_at, triaged_at, deleted_at, url_key, source_name, site_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?15, ?16, ?17)",
            params![
                uid,
                url,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, bool>(8)?,
                collection,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, String>(11)?,
                now,
                r.get::<_, Option<String>>(12)?,
                crate::dedupe::url_key(&url),
                r.get::<_, Option<String>>(13)?,
                r.get::<_, Option<String>>(15)?,
            ],
        )?;
        let tags: Vec<String> = serde_json::from_str(&r.get::<_, String>(14)?).unwrap_or_default();
        if !tags.is_empty() {
            db::link_tags(conn, conn.last_insert_rowid(), &tags, &now)?;
        }
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Bulk, Purge, Source};
    use std::collections::BTreeSet;

    const BOOKMARK: i64 = 2;
    const LINK: i64 = 3;
    const COLLECTION: i64 = 0;
    const TAG: i64 = 1;

    type Clocks = BTreeSet<(i64, i64, i64)>;
    type Tombstones = BTreeSet<(String, Option<String>)>;

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn synced(n: u128) -> Connection {
        let conn = library();
        turn_on(&conn, uuid::Uuid::from_u128(n)).unwrap();
        conn
    }

    fn counter(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT counter FROM sync_vector WHERE origin =
                (SELECT id FROM sync_origins WHERE origin = (SELECT value FROM sync_meta WHERE key = 'replica'))",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// What a write recorded: the clocks it gave (entity, row, field) and the tombstones.
    fn recorded(conn: &Connection, write: impl FnOnce(&Connection)) -> (Clocks, Tombstones) {
        let since = counter(conn);
        write(conn);
        let clocks = conn
            .prepare("SELECT entity, row, field FROM sync_clock WHERE counter > ?1")
            .unwrap()
            .query_map([since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let tombstones = conn
            .prepare("SELECT kind || ' ' || uid, merged_into FROM tombstones WHERE counter > ?1")
            .unwrap()
            .query_map([since], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        (clocks, tombstones)
    }

    fn clocks(conn: &Connection, write: impl FnOnce(&Connection)) -> Clocks {
        let (clocks, tombstones) = recorded(conn, write);
        assert!(tombstones.is_empty(), "{tombstones:?}");
        clocks
    }

    fn save(conn: &Connection, url: &str, tags: &[&str]) -> db::Bookmark {
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        let domain = crate::metadata::extract_domain(url);
        db::insert_or_update_bookmark(conn, url, "Title", None, None, None, &domain, None, Some(&tags), Source::Chrome).unwrap()
    }

    fn tag(conn: &Connection, name: &str) -> i64 {
        conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0)).unwrap()
    }

    fn uid(conn: &Connection, table: &str, id: i64) -> String {
        conn.query_row(&format!("SELECT uid FROM {table} WHERE id = ?1"), [id], |r| r.get(0)).unwrap()
    }

    fn set<const N: usize>(items: [(i64, i64, i64); N]) -> Clocks {
        items.into_iter().collect()
    }

    /// Every write of the app with sync on records exactly the fields it
    /// changes: one clock per new record, one per changed field or link.
    #[test]
    fn every_write_records_what_it_changes() {
        let conn = synced(1);
        let mut b = None;
        // A new bookmark with new tags: the record, the tags, the links.
        let made = clocks(&conn, |conn| b = Some(save(conn, "https://example.com/a", &["one", "two"])));
        let b = b.unwrap();
        let (one, two) = (tag(&conn, "one"), tag(&conn, "two"));
        assert_eq!(made, set([(BOOKMARK, b.id, -1), (TAG, one, -1), (TAG, two, -1), (LINK, b.id, one), (LINK, b.id, two)]));
        // Saved again: nothing.
        assert!(clocks(&conn, |conn| drop(save(conn, "https://example.com/a", &["three"]))).is_empty());

        // The editor: the title, the decision (it leaves the inbox).
        let edited = clocks(&conn, |conn| drop(db::update_bookmark(conn, b.id, Some("New".into()), None, None, None, None).unwrap()));
        assert_eq!(edited, set([(BOOKMARK, b.id, 1), (BOOKMARK, b.id, 8)]));
        // The same values again: only the notes, from none to empty.
        let same = clocks(&conn, |conn| {
            let tags = Some(vec!["one".into(), "two".into()]);
            db::update_bookmark(conn, b.id, Some("New".into()), Some(String::new()), Some(false), Some(None), tags).unwrap();
        });
        assert_eq!(same, set([(BOOKMARK, b.id, 5)]));
        // Tags: one kept, one taken off, one added. Only the links that change.
        let mut three = 0;
        let retagged = clocks(&conn, |conn| {
            db::update_bookmark(conn, b.id, None, None, None, None, Some(vec!["one".into(), "three".into()])).unwrap();
            three = tag(conn, "three");
        });
        assert_eq!(retagged, set([(TAG, three, -1), (LINK, b.id, two), (LINK, b.id, three)]));
        assert_eq!(db::get_bookmark_by_id(&conn, b.id).unwrap().tags.unwrap(), ["one", "three"]);

        // An assistant (NP-091): a tag it lacks, a move, a star, its name.
        let shelf = db::create_collection(&conn, "Shelf", None, None).unwrap();
        let assistant = clocks(&conn, |conn| {
            db::assistant_update(conn, b.id, &db::AssistantChange::Tag(vec!["one".into(), "four".into()])).unwrap();
            db::assistant_update(conn, b.id, &db::AssistantChange::Move(shelf.id)).unwrap();
            db::assistant_update(conn, b.id, &db::AssistantChange::Favorite(true)).unwrap();
            db::set_source_name(conn, b.id, "Claude").unwrap();
        });
        let four = tag(&conn, "four");
        let expected = set([(TAG, four, -1), (LINK, b.id, four), (BOOKMARK, b.id, 7), (BOOKMARK, b.id, 6), (BOOKMARK, b.id, 11)]);
        assert_eq!(assistant, expected);

        // Metadata: the description, the picture and the icon are the
        // person's data too (they are synced fields).
        let meta = crate::metadata::PageMetadata {
            title: Some("Page".into()),
            description: Some("About".into()),
            image_url: Some("https://example.com/i.png".into()),
            favicon_url: Some("https://example.com/f.ico".into()),
            site_name: Some("Example".into()),
            domain: "example.com".into(),
        };
        let revision = db::get_bookmark_by_id(&conn, b.id).unwrap().revision;
        let enriched = clocks(&conn, |conn| drop(db::enrich_bookmark(conn, b.id, revision, &meta).unwrap()));
        assert_eq!(enriched, set([(BOOKMARK, b.id, 1), (BOOKMARK, b.id, 2), (BOOKMARK, b.id, 3), (BOOKMARK, b.id, 4), (BOOKMARK, b.id, 16)]));
        let fresh = crate::metadata::PageMetadata { image_url: Some("https://example.com/j.png".into()), ..meta };
        let refreshed = clocks(&conn, |conn| drop(db::refresh_preview(conn, b.id, &fresh).unwrap()));
        assert_eq!(refreshed, set([(BOOKMARK, b.id, 3)]));

        // Trash and back, one and in bulk.
        assert_eq!(clocks(&conn, |conn| drop(db::trash_bookmark(conn, b.id).unwrap())), set([(BOOKMARK, b.id, 9)]));
        let restored = clocks(&conn, |conn| drop(db::restore_bookmark(conn, b.id, true).unwrap()));
        assert_eq!(restored, set([(BOOKMARK, b.id, 9), (BOOKMARK, b.id, 8)]));
        let c = save(&conn, "https://example.com/c", &[]);
        let bulk = clocks(&conn, |conn| {
            db::apply_bulk(conn, &[b.id, c.id], &Bulk::Move(None)).unwrap();
            db::apply_bulk(conn, &[b.id, c.id], &Bulk::Tag("one".into())).unwrap();
            db::apply_bulk(conn, &[c.id], &Bulk::Favorite(true)).unwrap();
        });
        let expected = set([(BOOKMARK, b.id, 7), (BOOKMARK, b.id, 8), (BOOKMARK, c.id, 8), (LINK, c.id, one), (BOOKMARK, c.id, 6)]);
        assert_eq!(bulk, expected);
        let trashed = clocks(&conn, |conn| drop(db::apply_bulk(conn, &[c.id], &Bulk::Trash).unwrap()));
        assert_eq!(trashed, set([(BOOKMARK, c.id, 9)]));

        // A purge: a tombstone with its clock; the bookmark's clocks go with it.
        let c_uid = uid(&conn, "bookmarks", c.id);
        let (purged, gone) = recorded(&conn, |conn| drop(db::purge_trash(conn, Purge::One(c.id)).unwrap()));
        assert!(purged.is_empty());
        assert_eq!(gone, [(format!("bookmark {c_uid}"), None)].into_iter().collect());
        let left: i64 = conn
            .query_row("SELECT count(*) FROM sync_clock WHERE entity IN (2, 3) AND row = ?1", [c.id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);

        // A moved link gets the new address (NP-036).
        conn.execute(
            "INSERT INTO link_checks (bookmark_id, url, checked_at, outcome, target) VALUES (?1, ?2, 'x', 'moved', 'https://example.com/moved')",
            params![b.id, b.url],
        )
        .unwrap();
        let replaced = clocks(&conn, |conn| drop(crate::linkcheck::replace(conn, &[b.id]).unwrap()));
        assert_eq!(replaced, set([(BOOKMARK, b.id, 0)]));

        // Undo (NP-024) writes back only what the command changed.
        let mut journal = crate::journal::Journal::default();
        let (_, command) = journal
            .record(&conn, crate::journal::Action::Edit, &[b.id], |conn| {
                Ok(vec![db::update_bookmark(conn, b.id, None, Some("note".into()), None, None, Some(vec!["one".into()]))?])
            })
            .unwrap();
        let undone = clocks(&conn, |conn| drop(journal.undo(conn, command).unwrap()));
        assert_eq!(undone, set([(BOOKMARK, b.id, 5), (LINK, b.id, three), (LINK, b.id, four)]));

        // Collections: new ones; the first move gives every listed one a key,
        // the next writes one; a new one has its key from the start; deleting.
        let (mut x, mut y) = (0, 0);
        let created = clocks(&conn, |conn| {
            x = db::create_collection(conn, "X", None, None).unwrap().id;
            y = db::create_collection(conn, "Y", None, None).unwrap().id;
        });
        assert_eq!(created, set([(COLLECTION, x, -1), (COLLECTION, y, -1)]));
        let first = clocks(&conn, |conn| db::reorder_collections(conn, &[y, shelf.id, x]).unwrap());
        assert_eq!(first, set([(COLLECTION, y, 3), (COLLECTION, shelf.id, 3), (COLLECTION, x, 3)]));
        let moved = clocks(&conn, |conn| db::reorder_collections(conn, &[shelf.id, y, x]).unwrap());
        assert_eq!(moved.len(), 1, "{moved:?}");
        let mut z = 0;
        let last = clocks(&conn, |conn| z = db::create_collection(conn, "Z", None, None).unwrap().id);
        assert_eq!(last, set([(COLLECTION, z, -1)]));
        db::update_bookmark(&conn, b.id, None, None, None, Some(Some(x)), None).unwrap();
        let x_uid = uid(&conn, "collections", x);
        let (deleted, gone) = recorded(&conn, |conn| db::delete_collection(conn, x).unwrap());
        assert_eq!(deleted, set([(BOOKMARK, b.id, 7)]));
        assert_eq!(gone, [(format!("collection {x_uid}"), None)].into_iter().collect());
    }

    /// Duplicates (NP-035): the main bookmark takes what the others held, the
    /// others go to the trash, as without sync; each is an edit.
    #[test]
    fn a_merge_of_duplicates_records_edits_and_the_trash() {
        let conn = synced(1);
        let main = save(&conn, "https://example.com/page", &["one"]);
        let other = save(&conn, "https://www.example.com/page/", &["one", "two"]);
        db::update_bookmark(&conn, other.id, None, Some("note".into()), Some(true), None, None).unwrap();
        let two = tag(&conn, "two");
        let merged = clocks(&conn, |conn| {
            crate::dedupe::merge(conn, &[crate::dedupe::MergeGroup { main: main.id, others: vec![other.id] }]).unwrap();
        });
        let expected =
            set([(BOOKMARK, main.id, 5), (BOOKMARK, main.id, 6), (BOOKMARK, main.id, 8), (LINK, main.id, two), (BOOKMARK, other.id, 9)]);
        assert_eq!(merged, expected);
    }

    /// What the library derives from the person's data records nothing: sort
    /// keys, address keys, the search index, link checks, settings.
    #[test]
    fn derived_writes_record_nothing() {
        let conn = synced(1);
        let b = save(&conn, "https://example.com/a", &["one"]);
        conn.execute("UPDATE bookmarks SET url_key = NULL WHERE id = ?1", [b.id]).unwrap();
        let derived = recorded(&conn, |conn| {
            assert!(crate::sorting::set_language(conn, "ru").unwrap());
            assert!(crate::sorting::set_language(conn, "de").unwrap());
            assert_eq!(crate::dedupe::fill_keys(conn).unwrap(), 1);
            db::rebuild_search(conn).unwrap();
            conn.execute("INSERT INTO link_checks (bookmark_id, url, checked_at, outcome) VALUES (?1, ?2, 'x', 'ok')", params![b.id, b.url])
                .unwrap();
            db::set_setting(conn, "close_to_tray", "false").unwrap();
            crate::dedupe::dismiss(conn, "example.com/a", &[b.id]).unwrap();
            conn.execute("UPDATE bookmarks SET revision = revision + 1, updated_at = 'x' WHERE id = ?1", [b.id]).unwrap();
        });
        assert_eq!(derived, Default::default());
    }

    /// «Заменить» from a JSON copy with sync on (NP-033): the library is the
    /// copy, the bookmarks it had besides wait in the trash, nothing is purged
    /// on the other devices, and it goes on as a new replica.
    #[test]
    fn a_replace_from_a_copy_with_sync_on_purges_nothing_elsewhere() {
        let conn = synced(1);
        conn.execute("INSERT INTO sync_meta (key, value) VALUES ('library_key', 'k1')", []).unwrap();
        let a = save(&conn, "https://example.com/a", &["one"]);
        save(&conn, "https://example.com/b", &[]);
        let at = chrono::Utc::now();
        let text = crate::export::json(&conn, crate::export::Scope::Library, at).unwrap().0;
        let d = save(&conn, "https://example.com/d", &["two"]);
        let d_uid = uid(&conn, "bookmarks", d.id);
        db::update_bookmark(&conn, a.id, Some("Edited after the copy".into()), None, None, None, None).unwrap();

        let folder = std::env::temp_dir().join(format!("koonapin-sync-restore-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&folder).unwrap();
        let copy = crate::restore::check(&text).unwrap();
        crate::restore::restore(&conn, &copy, crate::restore::RestoreMode::Replace, &folder).unwrap();

        let replica = koona_sync::replica(&conn).unwrap().expect("sync stays on");
        assert_ne!(replica, uuid::Uuid::from_u128(1));
        let key: String = conn.query_row("SELECT value FROM sync_meta WHERE key = 'library_key'", [], |r| r.get(0)).unwrap();
        assert_eq!(key, "k1");
        let one = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(one("SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL"), 2);
        let title: String = conn.query_row("SELECT title FROM bookmarks WHERE url = 'https://example.com/a'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Title", "the copy's");
        let kept = conn.query_row("SELECT id FROM bookmarks WHERE uid = ?1", [d_uid], |r| r.get(0)).unwrap();
        let kept = db::get_bookmark_by_id(&conn, kept).unwrap();
        assert!(kept.deleted_at.is_some());
        assert_eq!(kept.tags.unwrap(), ["two"]);
        assert_eq!(one("SELECT count(*) FROM tombstones"), 0, "no purge");
        assert_eq!(one("SELECT count(*) FROM sync_origins"), 1);
        assert_eq!(one("SELECT count(*) FROM sync_clock WHERE entity = 2 AND field = -1"), 3);
        assert_eq!(one("SELECT count(*) FROM sync_clock WHERE entity = 3"), one("SELECT count(*) FROM bookmark_tags"));
        // Search finds the bookmark kept in the trash by its tag; the others by theirs.
        let search = db::BookmarkQuery { search: Some("one".into()), ..Default::default() };
        assert_eq!(db::get_bookmarks(&conn, &search).unwrap().total, Some(1));
    }

    fn on_disk(name: &str) -> std::path::PathBuf {
        let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        folder.join("koonapin.db")
    }

    /// A library of `n` generated bookmarks with sync on, and an empty one
    /// with sync on that will receive it, both as the app opens them.
    fn sender_and_receiver(n: usize) -> (Connection, Connection) {
        sender_and_receiver_of(|a| crate::test_libraries::generated(a, n, 11))
    }

    fn sender_and_receiver_of(fill: impl FnOnce(&Connection)) -> (Connection, Connection) {
        let a = crate::test_libraries::fresh(&on_disk("sync-sender"));
        fill(&a);
        a.execute("UPDATE bookmarks SET deleted_at = updated_at WHERE id % 17 = 0", []).unwrap();
        // The domain as the app writes it (the fixtures keep «пример.рф» as
        // typed): it is derived, each device writes it from the address.
        a.execute("UPDATE bookmarks SET domain = np_domain(url)", []).unwrap();
        turn_on(&a, uuid::Uuid::from_u128(1)).unwrap();
        let b = crate::library::open(&crate::library::Paths::new(on_disk("sync-receiver"))).unwrap().conn;
        turn_on(&b, uuid::Uuid::from_u128(2)).unwrap();
        (a, b)
    }

    /// Every chunk of what `from` has and `to` lacks, applied with `apply`.
    fn send(from: &Connection, to: &Connection, apply: impl Fn(&Connection, &[koona_sync::model::Group]) -> koona_sync::Applied) {
        let since = koona_sync::vector(to).unwrap();
        for chunk in koona_sync::delta_all(from, &since, 1 << 20).unwrap() {
            assert_eq!(apply(to, &chunk.groups).deferred, 0);
            if chunk.last {
                koona_sync::merge_vector(to, &chunk.covers).unwrap();
            }
        }
    }

    /// What a person sees of a library, by uid: the bookmarks with their sort
    /// keys and tags, and what a search finds.
    fn seen(conn: &Connection) -> (Vec<String>, Vec<Option<i64>>) {
        let rows = conn
            .prepare(
                "SELECT b.uid || b.url || b.title || COALESCE(b.notes, '') || COALESCE(b.deleted_at, '') || hex(b.title_key) || hex(b.site_key)
                     || COALESCE(c.uid, '') || COALESCE((SELECT group_concat(t.name, ',' ORDER BY t.name) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), '')
                 FROM bookmarks b LEFT JOIN collections c ON c.id = b.collection_id ORDER BY b.uid",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let found = ["архитектура", "rust", "ёлка", "заметка", "github.com", "design 7"]
            .iter()
            .map(|word| db::get_bookmarks(conn, &db::BookmarkQuery { search: Some(word.to_string()), ..Default::default() }).unwrap().total)
            .collect();
        (rows, found)
    }

    /// A batch from another device writes the search rows and sort keys once
    /// at the end, and they are what the triggers would have written.
    #[test]
    fn a_batch_from_another_device_is_found_and_sorted_as_its_own() {
        let (a, b) = sender_and_receiver(300);
        send(&a, &b, |conn, groups| apply(conn, groups).unwrap());
        let (rows, found) = seen(&b);
        assert_eq!((rows.len(), &found), (300, &seen(&a).1));
        assert_eq!(rows, seen(&a).0);
        assert!(found.iter().all(|n| n.unwrap() > 0), "{found:?}");
        // Edits both ways after that, a tag renamed and one taken off.
        db::update_bookmark(&a, 5, Some("renamed архитектура".into()), None, None, None, Some(vec!["новый".into()])).unwrap();
        b.execute("UPDATE tags SET name = 'rust-lang' WHERE name = 'rust'", []).unwrap();
        db::trash_bookmark(&b, 7).unwrap();
        send(&a, &b, |conn, groups| apply(conn, groups).unwrap());
        send(&b, &a, |conn, groups| apply(conn, groups).unwrap());
        assert_eq!(seen(&a), seen(&b));
        // Normal writes still index at once: the triggers run.
        db::update_bookmark(&b, 9, Some("уникальное слово".into()), None, None, None, None).unwrap();
        let search = db::BookmarkQuery { search: Some("уникальное".into()), ..Default::default() };
        assert_eq!(db::get_bookmarks(&b, &search).unwrap().total, Some(1));
    }

    /// The library of `koona-sync/tests/measure.rs`, which SPIKE.md measured:
    /// longer texts and more tags than the app's fixtures (224 MB against
    /// about 110 MB), 30 collections and 300 tags more.
    fn spike_library(conn: &Connection) {
        struct Random(u64);
        impl Random {
            fn next(&mut self) -> u64 {
                self.0 ^= self.0 << 13;
                self.0 ^= self.0 >> 7;
                self.0 ^= self.0 << 17;
                self.0
            }
            fn below(&mut self, n: usize) -> usize {
                (self.next() % n as u64) as usize
            }
            fn words(&mut self, n: usize) -> String {
                const WORDS: [&str; 16] = [
                    "rust", "sqlite", "design", "notes", "guide", "release", "async", "parser", "browser", "sync", "library",
                    "review", "talk", "paper", "theory", "practice",
                ];
                (0..n).map(|_| WORDS[self.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
            }
        }
        let mut random = Random(0x9E37_79B9_7F4A_7C15);
        let tx = conn.unchecked_transaction().unwrap();
        let first: i64 = tx.query_row("SELECT COALESCE(max(id), 0) + 1 FROM collections", [], |r| r.get(0)).unwrap();
        let first_tag: i64 = tx.query_row("SELECT COALESCE(max(id), 0) + 1 FROM tags", [], |r| r.get(0)).unwrap();
        for i in 0..30 {
            let name = format!("Collection {i}");
            tx.execute("INSERT INTO collections (uid, name, created_at) VALUES (?1, ?2, '2024-01-01T00:00:00.000Z')", params![db::new_uid(), name])
                .unwrap();
        }
        for i in 0..300 {
            let name = format!("tag-{i}");
            tx.execute("INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, '2024-01-01T00:00:00.000Z')", params![db::new_uid(), name]).unwrap();
        }
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO bookmarks (uid, url, title, description, image_url, favicon_url, domain, notes,
                        is_favorite, collection_id, source, created_at, updated_at, triaged_at, url_key)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, np_domain(?2), ?7, ?8, ?9, 'extension', ?10, ?10, ?10, np_url_key(?2))",
                )
                .unwrap();
            let mut link = tx.prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2)").unwrap();
            for i in 0..100_000 {
                let site = random.below(5_000);
                let url = format!("https://site{site}.example.com/articles/{}/{i}", random.words(2).replace(' ', "-"));
                let time = format!("2025-{:02}-{:02}T10:{:02}:{:02}.000Z", 1 + i % 12, 1 + i % 28, i % 60, i % 59);
                let notes = (random.below(10) == 0).then(|| random.words(8));
                let collection = (random.below(3) > 0).then(|| first + random.below(30) as i64);
                insert
                    .execute(params![
                        db::new_uid(),
                        url,
                        random.words(6),
                        random.words(20),
                        format!("https://site{site}.example.com/images/{i}.jpg"),
                        format!("https://site{site}.example.com/favicon.ico"),
                        notes,
                        (random.below(20) == 0) as i64,
                        collection,
                        time,
                    ])
                    .unwrap();
                let id = tx.last_insert_rowid();
                for _ in 0..random.below(5) {
                    link.execute(params![id, first_tag + random.below(300) as i64]).unwrap();
                }
            }
        }
        tx.commit().unwrap();
    }

    /// The full snapshot of 100 000 bookmarks into an empty library, in
    /// chunks of 1 MB as SPIKE.md measured it (35 s there, with the triggers
    /// on every write): `cargo test --release --lib a_snapshot_of_a_hundred
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_snapshot_of_a_hundred_thousand_bookmarks() {
        let fills: [(&str, fn(&Connection)); 2] =
            [("SPIKE.md's library", spike_library), ("the app's fixtures", |conn| crate::test_libraries::generated(conn, 100_000, 11))];
        for (name, fill) in fills {
            println!("{name}:");
            snapshot_of(fill);
        }
    }

    fn snapshot_of(fill: fn(&Connection)) {
        let started = std::time::Instant::now();
        let (a, b) = sender_and_receiver_of(fill);
        println!("built in {:?}", started.elapsed());
        let receiver = |n: u128| {
            let conn = crate::library::open(&crate::library::Paths::new(on_disk("sync-receiver"))).unwrap().conn;
            turn_on(&conn, uuid::Uuid::from_u128(n)).unwrap();
            conn
        };
        let started = std::time::Instant::now();
        let chunks = koona_sync::delta_all(&a, &koona_sync::vector(&b).unwrap(), 1 << 20).unwrap();
        let groups: usize = chunks.iter().map(|c| c.groups.len()).sum();
        println!("{} chunks, {groups} groups, made in {:?}", chunks.len(), started.elapsed());

        let started = std::time::Instant::now();
        let mut receiving = Receiving::default();
        for chunk in &chunks {
            if let Some(applied) = receiving.add(&b, chunk.groups.clone(), chunk.last).unwrap() {
                assert_eq!(applied.deferred, 0);
            }
            if chunk.last {
                koona_sync::merge_vector(&b, &chunk.covers).unwrap();
            }
        }
        let held = started.elapsed();
        println!("applied {} groups a transaction, search and sort written once: {held:?}", Receiving::GROUPS);
        assert_eq!(seen(&a), seen(&b));

        let c = receiver(3);
        let started = std::time::Instant::now();
        send(&a, &c, |conn, groups| apply(conn, groups).unwrap());
        println!("applied a chunk a transaction, search and sort written once: {:?}", started.elapsed());
        let d = receiver(4);
        let started = std::time::Instant::now();
        send(&a, &d, |conn, groups| koona_sync::apply(conn, groups).unwrap());
        println!("applied a chunk a transaction, the triggers on every write: {:?}", started.elapsed());
        assert!(held.as_secs() <= 15, "{held:?}");
    }

    /// Sync off, as every library is until the person turns it on: nothing.
    #[test]
    fn nothing_is_recorded_with_sync_off() {
        let conn = library();
        let b = save(&conn, "https://example.com/a", &["one"]);
        db::update_bookmark(&conn, b.id, Some("x".into()), None, None, None, Some(vec!["two".into()])).unwrap();
        db::trash_bookmark(&conn, b.id).unwrap();
        db::purge_trash(&conn, Purge::All).unwrap();
        let c = db::create_collection(&conn, "C", None, None).unwrap();
        db::delete_collection(&conn, c.id).unwrap();
        let recorded: i64 = conn
            .query_row("SELECT (SELECT count(*) FROM sync_clock) + (SELECT count(*) FROM tombstones WHERE hlc IS NOT NULL)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recorded, 0);
        assert!(!is_on(&conn));
    }
}
