//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The engine on small hand-made cases: what capture records, what a delta carries, how two
//! records with one address become one.

mod common;

use common::*;
use koona_sync::model::{Entity, Vector};
use rusqlite::types::Value;
use uuid::Uuid;

fn uid(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

#[test]
fn capture_records_new_records_once_and_edits_by_field() {
    let a = library(replica_id(1));
    let id = add_bookmark(&a, uid(10), "https://example.com/a", "A").unwrap();
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 2"), 1, "one clock for a new record");
    set_bookmark(&a, id, "title", Value::Text("B".into()));
    set_bookmark(&a, id, "title", Value::Text("B".into()));
    // Derived columns record nothing.
    a.execute("UPDATE bookmarks SET revision = revision + 5, updated_at = 'x', domain = 'y' WHERE id = ?1", [id])
        .unwrap();
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 2"), 2);
    assert_eq!(one::<i64>(&a, "SELECT counter FROM sync_vector"), 2);
    tag(&a, id, uid(20), "rust");
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 3"), 1);
    // Purging leaves a tombstone with a clock and no clocks of the record.
    set_bookmark(&a, id, "deleted_at", Value::Text(now(&a)));
    purge(&a, id);
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity IN (2, 3)"), 0);
    let counter: i64 = one(&a, "SELECT counter FROM tombstones WHERE kind = 'bookmark'");
    assert_eq!(counter, one::<i64>(&a, "SELECT counter FROM sync_vector"));
    check_invariants(&a);
}

#[test]
fn nothing_is_recorded_while_applying_or_before_attaching() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    stub_app_functions(&conn);
    koona_sync::register(&conn).unwrap();
    conn.execute_batch(SCHEMA_9).unwrap();
    conn.execute_batch(koona_sync::SCHEMA_10).unwrap();
    add_bookmark(&conn, uid(1), "https://example.com/", "x").unwrap();
    assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock"), 0);
    koona_sync::attach(&conn, replica_id(1)).unwrap();
    {
        let _applying = koona_sync::Applying::new(&conn).unwrap();
        add_bookmark(&conn, uid(2), "https://example.com/2", "y").unwrap();
    }
    assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock"), 0);
    add_bookmark(&conn, uid(3), "https://example.com/3", "z").unwrap();
    assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock"), 1);
    // The baseline stamps everything there.
    koona_sync::baseline(&conn).unwrap();
    assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock"), 3);
    assert!(koona_sync::attach(&conn, replica_id(2)).is_err(), "a library is one replica");
}

#[test]
fn counters_survive_another_connection() {
    let dir = std::env::temp_dir().join(format!("koona-sync-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("library.db");
    let a = library_at(Some(&path), replica_id(1));
    add_bookmark(&a, uid(1), "https://example.com/1", "x").unwrap();
    let b = rusqlite::Connection::open(&path).unwrap();
    stub_app_functions(&b);
    koona_sync::register(&b).unwrap();
    add_bookmark(&b, uid(2), "https://example.com/2", "y").unwrap();
    add_bookmark(&a, uid(3), "https://example.com/3", "z").unwrap();
    let counters = ids(&a, "SELECT counter FROM sync_clock ORDER BY counter");
    assert_eq!(counters, vec![1, 2, 3]);
    let hlcs = ids(&a, "SELECT hlc FROM sync_clock ORDER BY counter");
    assert!(hlcs.windows(2).all(|w| w[0] < w[1]), "the clock moves on across connections");
    drop((a, b));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_snapshot_rebuilds_the_library_elsewhere() {
    let a = library(replica_id(1));
    let c = add_collection(&a, uid(5), "Reading").unwrap();
    let id = add_bookmark(&a, uid(10), "https://example.com/a", "A").unwrap();
    set_bookmark(&a, id, "collection_id", Value::Integer(c));
    set_bookmark(&a, id, "is_favorite", Value::Integer(1));
    tag(&a, id, uid(20), "rust");
    tag(&a, id, uid(21), "sqlite");
    let b = library(replica_id(2));
    // Tiny chunks: one record each.
    assert!(sync(&a, &b, 1));
    assert_eq!(dump(&a), dump(&b));
    assert_eq!(vector(&b).get(&replica_id(1)), vector(&a).get(&replica_id(1)));
    // Nothing new: an empty delta.
    let chunks = koona_sync::delta_all(&a, &vector(&b), 1 << 20).unwrap();
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].groups.is_empty() && chunks[0].last);
    check_invariants(&b);
}

#[test]
fn the_later_edit_wins_field_by_field() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    koona_sync::set_wall_clock(&a, Some(1_000)).unwrap();
    koona_sync::set_wall_clock(&b, Some(1_000)).unwrap();
    let id = add_bookmark(&a, uid(10), "https://example.com/a", "A").unwrap();
    sync(&a, &b, 1 << 20);
    let id_b = one::<i64>(&b, "SELECT id FROM bookmarks");
    set_bookmark(&a, id, "title", Value::Text("from a".into()));
    koona_sync::set_wall_clock(&b, Some(2_000)).unwrap();
    set_bookmark(&b, id_b, "title", Value::Text("from b".into()));
    set_bookmark(&a, id, "notes", Value::Text("notes from a".into()));
    sync(&a, &b, 1 << 20);
    sync(&b, &a, 1 << 20);
    assert_eq!(dump(&a), dump(&b));
    assert_eq!(one::<String>(&a, "SELECT title FROM bookmarks"), "from b");
    assert_eq!(one::<String>(&a, "SELECT notes FROM bookmarks"), "notes from a");
}

#[test]
fn one_address_on_two_devices_becomes_one_bookmark() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let ia = add_bookmark(&a, uid(30), "https://example.com/same", "on a").unwrap();
    tag(&a, ia, uid(40), "a-tag");
    let ib = add_bookmark(&b, uid(20), "https://example.com/same", "on b").unwrap();
    tag(&b, ib, uid(41), "b-tag");
    set_bookmark(&b, ib, "notes", Value::Text("b notes".into()));
    sync(&a, &b, 1 << 20);
    sync(&b, &a, 1 << 20);
    sync(&a, &b, 1 << 20);
    assert_eq!(dump(&a), dump(&b));
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM bookmarks"), 1);
    assert_eq!(one::<String>(&a, "SELECT uid FROM bookmarks"), uid(20).to_string(), "the smaller uid survives");
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM bookmark_tags"), 2, "the tags of both");
    assert_eq!(
        maybe::<String>(&a, &format!("SELECT merged_into FROM tombstones WHERE uid = '{}'", uid(30))),
        Some(uid(20).to_string())
    );
    // A later change to the merged one lands on the survivor.
    let c = library(replica_id(3));
    let ic = add_bookmark(&c, uid(30), "https://example.com/same", "on c").unwrap();
    let _ = ic;
    sync(&a, &c, 1 << 20);
    sync(&c, &a, 1 << 20);
    sync(&a, &b, 1 << 20);
    assert_eq!(dump(&a), dump(&c));
    assert_eq!(dump(&a), dump(&b));
    assert_eq!(one::<i64>(&c, "SELECT count(*) FROM bookmarks"), 1);
}

#[test]
fn a_purge_is_final() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let id = add_bookmark(&a, uid(10), "https://example.com/a", "A").unwrap();
    sync(&a, &b, 1 << 20);
    let id_b = one::<i64>(&b, "SELECT id FROM bookmarks");
    set_bookmark(&a, id, "deleted_at", Value::Text(now(&a)));
    purge(&a, id);
    // Edited later on the other device, still purged.
    set_bookmark(&b, id_b, "title", Value::Text("edited".into()));
    sync(&b, &a, 1 << 20);
    sync(&a, &b, 1 << 20);
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM bookmarks"), 0);
    assert_eq!(one::<i64>(&b, "SELECT count(*) FROM bookmarks"), 0);
    assert_eq!(dump(&a), dump(&b));
}

#[test]
fn a_chunk_carries_covers_only_at_the_end() {
    let a = library(replica_id(1));
    for i in 0..20 {
        add_bookmark(&a, uid(100 + i), &format!("https://example.com/{i}"), "x").unwrap();
    }
    let chunks = koona_sync::delta_all(&a, &Vector::default(), 200).unwrap();
    assert!(chunks.len() > 3);
    assert!(chunks[..chunks.len() - 1].iter().all(|c| !c.last && c.covers == Vector::default()));
    assert_eq!(chunks.last().unwrap().covers, vector(&a));
    assert!(chunks.iter().flat_map(|c| &c.groups).all(|g| g.entity == Entity::Bookmark));
    // Resuming after the second chunk gives the rest.
    let mut resumed = koona_sync::Delta::resume(&a, &Vector::default(), &chunks[1].cursor).unwrap();
    let mut rest = Vec::new();
    while let Some(chunk) = resumed.next_chunk(200).unwrap() {
        rest.extend(chunk.groups);
    }
    let expected: Vec<_> = chunks[2..].iter().flat_map(|c| c.groups.clone()).collect();
    assert_eq!(rest, expected);
}

/// Reading (schema 11, Р-69): a bookmark sent to Reading reaches the other device with its
/// progress and read state; each field keeps its own clock, so reading on one device and taking
/// it out of Reading on the other both hold.
#[test]
fn reading_progress_and_read_state_travel_field_by_field() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let id = add_bookmark(&a, uid(10), "https://example.com/article", "Article").unwrap();
    set_bookmark(&a, id, "reading_at", Value::Text("2026-10-14T10:00:00.000Z".into()));
    set_bookmark(&a, id, "reading_progress", Value::Real(0.25));
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 2"), 3, "a clock per field changed");
    sync(&a, &b, 1 << 20);
    let id_b = one::<i64>(&b, "SELECT id FROM bookmarks");
    let state = |conn: &rusqlite::Connection| -> (Option<String>, f64, Option<String>) {
        conn.query_row("SELECT reading_at, reading_progress, read_at FROM bookmarks", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
    };
    assert_eq!(state(&b), (Some("2026-10-14T10:00:00.000Z".into()), 0.25, None));

    // Read to the end on A; meanwhile B takes it out of Reading.
    set_bookmark(&a, id, "reading_progress", Value::Real(1.0));
    set_bookmark(&a, id, "read_at", Value::Text("2026-10-14T11:00:00.000Z".into()));
    set_bookmark(&b, id_b, "reading_at", Value::Null);
    sync(&a, &b, 1 << 20);
    sync(&b, &a, 1 << 20);
    assert_eq!(state(&a), (None, 1.0, Some("2026-10-14T11:00:00.000Z".into())));
    assert_eq!(state(&a), state(&b));
    assert_eq!(dump(&a), dump(&b));

    // A progress outside 0–1 from a broken peer is ignored.
    let mut chunks = koona_sync::delta_all(&a, &Vector::default(), 1 << 20).unwrap();
    let group = chunks[0].groups.iter_mut().find(|g| g.entity == Entity::Bookmark).unwrap();
    let progress = group.fields.iter_mut().find(|f| f.field == "reading_progress").unwrap();
    assert_eq!(progress.value, serde_json::json!(1.0));
    progress.value = serde_json::json!(7);
    progress.clock.hlc = koona_sync::model::Hlc(u64::MAX >> 1);
    let c = library(replica_id(3));
    let applied = koona_sync::apply(&c, &chunks[0].groups).unwrap();
    assert_eq!(applied.deferred, 1, "a new record without a valid progress waits");
    assert_eq!(one::<i64>(&c, "SELECT count(*) FROM bookmarks"), 0);
    check_invariants(&c);
}

/// The site's name (schema 13): a field of its own, recorded and carried like the icon; a name
/// cleared on one device is cleared on the other.
#[test]
fn the_site_name_travels_as_a_field_of_its_own() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let id = add_bookmark(&a, uid(10), "https://example.com/recipe", "Recipe").unwrap();
    set_bookmark(&a, id, "site_name", Value::Text("Serious Eats".into()));
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 2 AND field = 16"), 1);
    sync(&a, &b, 1 << 20);
    assert_eq!(one::<Option<String>>(&b, "SELECT site_name FROM bookmarks"), Some("Serious Eats".into()));

    let id_b = one::<i64>(&b, "SELECT id FROM bookmarks");
    set_bookmark(&b, id_b, "site_name", Value::Null);
    sync(&b, &a, 1 << 20);
    assert_eq!(one::<Option<String>>(&a, "SELECT site_name FROM bookmarks"), None);
    assert_eq!(dump(&a), dump(&b));
    check_invariants(&a);
}

fn feed_row(conn: &rusqlite::Connection) -> (String, String, Option<String>, String) {
    conn.query_row("SELECT uid, url, title, destination FROM feeds", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
}

/// Feeds (schema 14, NP-130): following, renaming, moving where posts go and leaving reach the
/// other device; only the three synced fields are recorded, and a place this build doesn't know
/// travels as it came.
#[test]
fn a_feed_is_followed_changed_and_left_on_both_devices() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let id = follow(&a, uid(10), "https://example.com/feed.xml", None, "feeds").unwrap();
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 4"), 1, "one clock for a new feed");
    // Local columns record nothing.
    a.execute("UPDATE feeds SET updated_at = 'x', created_at = 'y' WHERE id = ?1", [id]).unwrap();
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 4"), 1);
    let chunks = koona_sync::delta_all(&a, &Vector::default(), 1 << 20).unwrap();
    let group = &chunks[0].groups[0];
    assert_eq!(group.entity, Entity::Feed);
    let names: Vec<&str> = group.fields.iter().map(|f| f.field.as_str()).collect();
    assert_eq!(names, ["url", "title", "destination"], "no time travels");

    let applied = koona_sync::apply(&b, &chunks[0].groups).unwrap();
    assert!(applied.feeds_changed && applied.structure_changed && applied.bookmark_ids.is_empty());
    koona_sync::merge_vector(&b, &chunks[0].covers).unwrap();
    assert_eq!(feed_row(&b), (uid(10).to_string(), "https://example.com/feed.xml".into(), None, "feeds".into()));
    assert_eq!(one::<String>(&b, "SELECT created_at FROM feeds"), one::<String>(&b, "SELECT updated_at FROM feeds"));

    // Renamed on B while A sends its posts somewhere a newer build knows.
    let id_b = one::<i64>(&b, "SELECT id FROM feeds");
    set_feed(&b, id_b, "title", Value::Text("Example".into()));
    set_feed(&a, id, "destination", Value::Text("someday".into()));
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 4 AND field = 2"), 1);
    sync(&a, &b, 1 << 20);
    sync(&b, &a, 1 << 20);
    let expected = (uid(10).to_string(), "https://example.com/feed.xml".into(), Some("Example".into()), "someday".into());
    assert_eq!(feed_row(&a), expected);
    assert_eq!(dump(&a), dump(&b));

    // Left on A: a tombstone of kind `feed`, and gone on B, with its posts.
    unfollow(&a, id);
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM sync_clock WHERE entity = 4"), 0);
    assert_eq!(one::<String>(&a, "SELECT kind FROM tombstones"), "feed");
    set_feed(&b, id_b, "title", Value::Text("Renamed meanwhile".into()));
    let chunks = koona_sync::delta_all(&a, &vector(&b), 1 << 20).unwrap();
    let applied = koona_sync::apply(&b, &chunks[0].groups).unwrap();
    assert_eq!(applied.feeds_gone, [uid(10)]);
    koona_sync::merge_vector(&b, &chunks[0].covers).unwrap();
    assert_eq!(one::<i64>(&b, "SELECT count(*) FROM feeds"), 0);
    // The rename that crossed the unfollow doesn't bring it back.
    sync(&b, &a, 1 << 20);
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM feeds"), 0);
    assert_eq!(dump(&a), dump(&b));
    check_invariants(&a);
    check_invariants(&b);
}

/// One address followed on two devices becomes one feed, the smaller uid, both ways a merge can
/// happen: the arriving feed takes over the one here, or merges into it. Nothing else in the
/// library is touched, also a collection with the same local id (NP-130).
#[test]
fn one_feed_address_on_two_devices_becomes_one_feed() {
    let a = library(replica_id(1));
    let b = library(replica_id(2));
    let url = "https://example.com/feed.xml";
    follow(&a, uid(20), url, Some("from a"), "inbox").unwrap();
    // On B the feed has id 1, as a collection with a bookmark in it does.
    let fb = follow(&b, uid(30), url, None, "notify").unwrap();
    let c = add_collection(&b, uid(5), "Reading").unwrap();
    let bm = add_bookmark(&b, uid(6), "https://example.com/a", "A").unwrap();
    set_bookmark(&b, bm, "collection_id", Value::Integer(c));
    assert_eq!((fb, c), (1, 1));
    let bookmark_clocks = |conn: &rusqlite::Connection| ids(conn, "SELECT counter FROM sync_clock WHERE entity = 2 ORDER BY field");

    // B gets A's feed, whose uid is smaller: B's row takes it, its own uid is gone here.
    let before = bookmark_clocks(&b);
    let chunks = koona_sync::delta_all(&a, &vector(&b), 1 << 20).unwrap();
    let applied = koona_sync::apply(&b, &chunks[0].groups).unwrap();
    assert_eq!(applied.feeds_gone, [uid(30)]);
    assert!(applied.bookmark_ids.is_empty(), "no bookmark moved");
    assert_eq!(bookmark_clocks(&b), before);
    koona_sync::merge_vector(&b, &chunks[0].covers).unwrap();
    assert_eq!(one::<String>(&b, "SELECT uid FROM feeds"), uid(20).to_string());

    // A third device followed it too, with a larger uid: it merges into A's.
    let c3 = library(replica_id(3));
    follow(&c3, uid(40), url, None, "feeds").unwrap();
    let chunks = koona_sync::delta_all(&c3, &vector(&a), 1 << 20).unwrap();
    let applied = koona_sync::apply(&a, &chunks[0].groups).unwrap();
    assert!(applied.feeds_gone.is_empty(), "A keeps its feed");
    koona_sync::merge_vector(&a, &chunks[0].covers).unwrap();
    for _ in 0..2 {
        for (from, to) in [(&a, &b), (&b, &a), (&a, &c3), (&c3, &a)] {
            sync(from, to, 1 << 20);
        }
    }
    assert_eq!(dump(&a), dump(&b));
    assert_eq!(dump(&a), dump(&c3));
    assert_eq!(one::<i64>(&c3, "SELECT count(*) FROM feeds"), 1);
    assert_eq!(one::<String>(&c3, "SELECT uid FROM feeds"), uid(20).to_string(), "the smaller uid survives");
    assert_eq!(one::<i64>(&a, "SELECT count(*) FROM tombstones WHERE kind = 'feed' AND merged_into IS NOT NULL"), 2);
    for conn in [&a, &b, &c3] {
        check_invariants(conn);
    }
}

/// The delta sends feeds after everything else, records before tombstones, and a feed that
/// doesn't hold every field waits (NP-130).
#[test]
fn feeds_come_last_and_wait_for_every_field() {
    let a = library(replica_id(1));
    follow(&a, uid(10), "https://example.com/feed.xml", None, "feeds").unwrap();
    let gone = follow(&a, uid(11), "https://example.org/rss", None, "feeds").unwrap();
    unfollow(&a, gone);
    add_bookmark(&a, uid(12), "https://example.com/a", "A").unwrap();
    let chunks = koona_sync::delta_all(&a, &Vector::default(), 1 << 20).unwrap();
    let order: Vec<(Entity, bool)> = chunks.iter().flat_map(|c| &c.groups).map(|g| (g.entity, g.gone.is_some())).collect();
    assert_eq!(order, [(Entity::Bookmark, false), (Entity::Feed, false), (Entity::Feed, true)]);

    let mut groups: Vec<_> = chunks.into_iter().flat_map(|c| c.groups).collect();
    groups[1].fields.retain(|f| f.field != "destination");
    let b = library(replica_id(2));
    let applied = koona_sync::apply(&b, &groups).unwrap();
    assert_eq!(applied.deferred, 1);
    assert_eq!(one::<i64>(&b, "SELECT count(*) FROM feeds"), 0);
    check_invariants(&b);
}
