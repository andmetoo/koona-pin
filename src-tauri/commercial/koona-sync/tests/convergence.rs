//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Convergence: three or four replicas make random edits from small pools of addresses, names,
//! tags and feeds (so they collide, also when an address or a name is changed), and sync between random pairs with chunks duplicated, reordered
//! and cut off, sometimes while the sender keeps editing. Then every pair syncs cleanly until
//! nothing changes: every library must hold the same records with the same clocks, and the same
//! vector. No step may fail (a UNIQUE violation would), and no library may ever hold a link or a
//! clock of a record that is gone.
//!
//! `PROPTEST_CASES=2000 cargo test -p koona-sync --release --test convergence` for a longer run.

mod common;

use common::*;
use koona_sync::Delta;
use proptest::prelude::*;
use rusqlite::types::Value;
use rusqlite::Connection;
use uuid::Uuid;

const URLS: usize = 6;
const COLLECTION_NAMES: [&str; 3] = ["Reading", "Work", "Later"];
const TAG_NAMES: [&str; 4] = ["rust", "sqlite", "news", "music"];
/// Few feed addresses, so two replicas follow the same one (NP-130).
const FEED_URLS: usize = 3;
/// `later` stands for a place a newer build knows: it travels as it is.
const DESTINATIONS: [&str; 4] = ["feeds", "inbox", "notify", "later"];

#[derive(Debug, Clone)]
enum Op {
    Add { url: usize, title: u8, uid: u128 },
    Title { pick: u16, title: u8 },
    Notes { pick: u16, notes: u8 },
    Favorite { pick: u16 },
    Move { pick: u16, to: u16 },
    NewCollection { name: usize, uid: u128 },
    Tag { pick: u16, name: usize, uid: u128 },
    Untag { pick: u16, which: u16 },
    Trash { pick: u16 },
    Restore { pick: u16 },
    Purge { pick: u16 },
    DeleteCollection { pick: u16 },
    /// A new address; refused, as in the app, when another bookmark has it.
    Address { pick: u16, url: usize },
    Rename { pick: u16, name: usize },
    /// Into Reading (unread, from the start) or out of it (Р-69).
    Reading { pick: u16 },
    /// Read so far; at 1 it is read.
    Progress { pick: u16, tenths: u8 },
    /// Marked read, or unread again.
    Read { pick: u16 },
    /// Follows a feed; an address already followed here is left as it is (NP-130).
    Follow { url: usize, title: Option<u8>, destination: usize, uid: u128 },
    /// The person's name for a feed, or none.
    FeedTitle { pick: u16, title: Option<u8> },
    Destination { pick: u16, destination: usize },
    Unfollow { pick: u16 },
    /// A feed moved to another address; refused when another feed has it.
    FeedAddress { pick: u16, url: usize },
}

#[derive(Debug, Clone)]
enum Step {
    Edit { replica: usize, op: Op },
    Sync {
        from: usize,
        to: usize,
        max_bytes: usize,
        /// Per chunk: 0–5 delivered once, 6 twice, 7 swapped with the next, 8 the session breaks.
        faults: Vec<u8>,
        /// An edit on the sender after the first chunk is made.
        meanwhile: Option<Op>,
    },
    /// Time passes on one replica's wall clock, or runs back.
    Clock { replica: usize, ms: i64 },
}

fn op() -> impl Strategy<Value = Op> {
    let pick = any::<u16>();
    prop_oneof![
        4 => (0..URLS, any::<u8>(), any::<u128>()).prop_map(|(url, title, uid)| Op::Add { url, title, uid }),
        2 => (pick, any::<u8>()).prop_map(|(pick, title)| Op::Title { pick, title }),
        1 => (pick, any::<u8>()).prop_map(|(pick, notes)| Op::Notes { pick, notes }),
        1 => pick.prop_map(|pick| Op::Favorite { pick }),
        2 => (pick, any::<u16>()).prop_map(|(pick, to)| Op::Move { pick, to }),
        2 => (0..COLLECTION_NAMES.len(), any::<u128>()).prop_map(|(name, uid)| Op::NewCollection { name, uid }),
        3 => (pick, 0..TAG_NAMES.len(), any::<u128>()).prop_map(|(pick, name, uid)| Op::Tag { pick, name, uid }),
        1 => (pick, any::<u16>()).prop_map(|(pick, which)| Op::Untag { pick, which }),
        2 => pick.prop_map(|pick| Op::Trash { pick }),
        1 => pick.prop_map(|pick| Op::Restore { pick }),
        2 => pick.prop_map(|pick| Op::Purge { pick }),
        1 => pick.prop_map(|pick| Op::DeleteCollection { pick }),
        1 => (pick, 0..URLS).prop_map(|(pick, url)| Op::Address { pick, url }),
        1 => (pick, 0..COLLECTION_NAMES.len()).prop_map(|(pick, name)| Op::Rename { pick, name }),
        2 => pick.prop_map(|pick| Op::Reading { pick }),
        2 => (pick, 0u8..=10).prop_map(|(pick, tenths)| Op::Progress { pick, tenths }),
        1 => pick.prop_map(|pick| Op::Read { pick }),
        3 => (0..FEED_URLS, prop::option::of(0u8..3), 0..DESTINATIONS.len(), any::<u128>())
            .prop_map(|(url, title, destination, uid)| Op::Follow { url, title, destination, uid }),
        1 => (pick, prop::option::of(0u8..3)).prop_map(|(pick, title)| Op::FeedTitle { pick, title }),
        1 => (pick, 0..DESTINATIONS.len()).prop_map(|(pick, destination)| Op::Destination { pick, destination }),
        1 => pick.prop_map(|pick| Op::Unfollow { pick }),
        1 => (pick, 0..FEED_URLS).prop_map(|(pick, url)| Op::FeedAddress { pick, url }),
    ]
}

fn steps(replicas: usize) -> impl Strategy<Value = Vec<Step>> {
    let step = prop_oneof![
        6 => (0..replicas, op()).prop_map(|(replica, op)| Step::Edit { replica, op }),
        3 => (0..replicas, 0..replicas, prop_oneof![Just(1usize), Just(300), Just(1200), Just(1 << 20)],
              prop::collection::vec(0u8..9, 0..12), prop::option::weighted(0.2, op()))
            .prop_map(|(from, to, max_bytes, faults, meanwhile)| Step::Sync { from, to, max_bytes, faults, meanwhile }),
        1 => (0..replicas, -3_000i64..20_000).prop_map(|(replica, ms)| Step::Clock { replica, ms }),
    ];
    prop::collection::vec(step, 1..70)
}

struct Replica {
    conn: Connection,
    wall: u64,
}

impl Replica {
    fn tick(&mut self) {
        self.wall += 3;
        koona_sync::set_wall_clock(&self.conn, Some(self.wall)).unwrap();
    }
}

fn pick(conn: &Connection, sql: &str, n: u16) -> Option<i64> {
    let all = ids(conn, sql);
    (!all.is_empty()).then(|| all[n as usize % all.len()])
}

/// A uid from the generated number: random high bits (which record survives a merge), a serial
/// below, so two records never share one.
fn uid_from(n: u128, serial: &mut u64) -> Uuid {
    *serial += 1;
    Uuid::from_u128((n >> 64) << 64 | u128::from(*serial))
}

fn feed_url(n: usize) -> String {
    format!("https://site{n}.example/feed.xml")
}

fn edit(conn: &Connection, op: &Op, serial: &mut u64) {
    let bookmark = |n| pick(conn, "SELECT id FROM bookmarks ORDER BY id", n);
    let feed = |n| pick(conn, "SELECT id FROM feeds ORDER BY id", n);
    match op {
        Op::Follow { url, title, destination, uid } => {
            let title = title.map(|t| format!("feed {t}"));
            follow(conn, uid_from(*uid, serial), &feed_url(*url), title.as_deref(), DESTINATIONS[*destination]);
        }
        Op::FeedTitle { pick, title } => {
            if let Some(id) = feed(*pick) {
                set_feed(conn, id, "title", title.map_or(Value::Null, |t| Value::Text(format!("feed {t}"))));
            }
        }
        Op::Destination { pick, destination } => {
            if let Some(id) = feed(*pick) {
                set_feed(conn, id, "destination", Value::Text(DESTINATIONS[*destination].into()));
            }
        }
        Op::Unfollow { pick } => {
            if let Some(id) = feed(*pick) {
                unfollow(conn, id);
            }
        }
        Op::FeedAddress { pick, url } => {
            if let Some(id) = feed(*pick) {
                conn.execute("UPDATE OR IGNORE feeds SET url = ?1 WHERE id = ?2", rusqlite::params![feed_url(*url), id])
                    .unwrap();
            }
        }
        Op::Add { url, title, uid } => {
            add_bookmark(conn, uid_from(*uid, serial), &format!("https://site{url}.example/page"), &format!("title {title}"));
        }
        Op::Address { pick, url } => {
            if let Some(id) = bookmark(*pick) {
                let url = format!("https://site{url}.example/page");
                let taken: bool = one(conn, &format!("SELECT EXISTS (SELECT 1 FROM bookmarks WHERE url = '{url}')"));
                if !taken {
                    conn.execute(
                        "UPDATE bookmarks SET url = ?1, domain = np_domain(?1), url_key = np_url_key(?1) WHERE id = ?2",
                        rusqlite::params![url, id],
                    )
                    .unwrap();
                }
            }
        }
        Op::Rename { pick: p, name } => {
            if let Some(id) = pick(conn, "SELECT id FROM collections ORDER BY id", *p) {
                conn.execute(
                    "UPDATE OR IGNORE collections SET name = ?1 WHERE id = ?2",
                    rusqlite::params![COLLECTION_NAMES[*name], id],
                )
                .unwrap();
            }
        }
        Op::Title { pick, title } => {
            if let Some(id) = bookmark(*pick) {
                set_bookmark(conn, id, "title", Value::Text(format!("title {}", title % 5)));
            }
        }
        Op::Notes { pick, notes } => {
            if let Some(id) = bookmark(*pick) {
                let value = if notes % 3 == 0 { Value::Null } else { Value::Text(format!("notes {}", notes % 4)) };
                set_bookmark(conn, id, "notes", value);
            }
        }
        Op::Favorite { pick } => {
            if let Some(id) = bookmark(*pick) {
                let fav: i64 = one(conn, &format!("SELECT is_favorite FROM bookmarks WHERE id = {id}"));
                set_bookmark(conn, id, "is_favorite", Value::Integer(1 - fav));
            }
        }
        Op::Move { pick: b, to } => {
            if let Some(id) = bookmark(*b) {
                let collections = ids(conn, "SELECT id FROM collections ORDER BY id");
                let target = match *to as usize % (collections.len() + 1) {
                    0 => Value::Null,
                    i => Value::Integer(collections[i - 1]),
                };
                set_bookmark(conn, id, "collection_id", target);
            }
        }
        Op::NewCollection { name, uid } => {
            add_collection(conn, uid_from(*uid, serial), COLLECTION_NAMES[*name]);
        }
        Op::Tag { pick, name, uid } => {
            if let Some(id) = bookmark(*pick) {
                tag(conn, id, uid_from(*uid, serial), TAG_NAMES[*name]);
            }
        }
        Op::Untag { pick: p, which } => {
            if let Some(id) = bookmark(*p) {
                if let Some(t) = pick(conn, &format!("SELECT tag_id FROM bookmark_tags WHERE bookmark_id = {id} ORDER BY tag_id"), *which) {
                    untag(conn, id, t);
                }
            }
        }
        Op::Trash { pick } => {
            if let Some(id) = bookmark(*pick) {
                set_bookmark(conn, id, "deleted_at", Value::Text(now(conn)));
            }
        }
        Op::Restore { pick: p } => {
            if let Some(id) = pick(conn, "SELECT id FROM bookmarks WHERE deleted_at IS NOT NULL ORDER BY id", *p) {
                set_bookmark(conn, id, "deleted_at", Value::Null);
            }
        }
        Op::Purge { pick: p } => {
            if let Some(id) = pick(conn, "SELECT id FROM bookmarks WHERE deleted_at IS NOT NULL ORDER BY id", *p) {
                purge(conn, id);
            }
        }
        Op::DeleteCollection { pick: p } => {
            if let Some(id) = pick(conn, "SELECT id FROM collections ORDER BY id", *p) {
                delete_collection(conn, id);
            }
        }
        // The writes of `reading.rs`: several fields in one statement.
        Op::Reading { pick } => {
            if let Some(id) = bookmark(*pick) {
                conn.execute(
                    "UPDATE bookmarks SET reading_at = CASE WHEN reading_at IS NULL THEN ?2 END,
                         read_at = CASE WHEN reading_at IS NULL THEN NULL ELSE read_at END,
                         reading_progress = CASE WHEN reading_at IS NULL AND read_at IS NOT NULL THEN 0 ELSE reading_progress END
                     WHERE id = ?1",
                    rusqlite::params![id, now(conn)],
                )
                .unwrap();
            }
        }
        Op::Progress { pick, tenths } => {
            if let Some(id) = bookmark(*pick) {
                conn.execute(
                    "UPDATE bookmarks SET reading_progress = ?2,
                         read_at = CASE WHEN ?2 >= 1 THEN COALESCE(read_at, ?3) ELSE read_at END
                     WHERE id = ?1",
                    rusqlite::params![id, f64::from(*tenths) / 10.0, now(conn)],
                )
                .unwrap();
            }
        }
        Op::Read { pick } => {
            if let Some(id) = bookmark(*pick) {
                conn.execute(
                    "UPDATE bookmarks SET read_at = CASE WHEN read_at IS NULL THEN ?2 END,
                         reading_progress = CASE WHEN read_at IS NULL THEN 1 ELSE 0 END
                     WHERE id = ?1",
                    rusqlite::params![id, now(conn)],
                )
                .unwrap();
            }
        }
    }
}

/// A session with faults: chunks are made one by one (the sender may edit in between), then
/// delivered in the faulty order.
fn faulty_sync(
    replicas: &mut [Replica],
    serial: &mut u64,
    (from, to, max_bytes): (usize, usize, usize),
    faults: &[u8],
    meanwhile: &Option<Op>,
) {
    if from == to {
        return;
    }
    replicas[from].tick();
    replicas[to].tick();
    let since = vector(&replicas[to].conn);
    let mut chunks = Vec::new();
    {
        let sender = &replicas[from].conn;
        let mut delta = Delta::new(sender, &since).unwrap();
        while let Some(chunk) = delta.next_chunk(max_bytes).unwrap() {
            chunks.push(chunk);
            if chunks.len() == 1 {
                if let Some(op) = meanwhile {
                    edit(sender, op, serial);
                    check_invariants(sender);
                }
            }
        }
    }
    let mut order: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < chunks.len() {
        match faults.get(i).copied().unwrap_or(0) {
            6 => order.extend([i, i]),
            7 if i + 1 < chunks.len() => {
                order.extend([i + 1, i]);
                i += 1;
            }
            8 => break,
            _ => order.push(i),
        }
        i += 1;
    }
    let receiver = &replicas[to].conn;
    let mut session = Session::new();
    for index in order {
        session.receive(receiver, index, &chunks[index]);
        check_invariants(receiver);
    }
}

fn run(replica_count: usize, steps: &[Step]) -> Result<(), TestCaseError> {
    let mut replicas: Vec<Replica> = (0..replica_count)
        .map(|i| {
            let conn = library(replica_id(i as u8 + 1));
            // Skewed clocks that collide: equal milliseconds on different replicas happen.
            let wall = 1_760_000_000_000 + (i as u64 % 2) * 50;
            koona_sync::set_wall_clock(&conn, Some(wall)).unwrap();
            Replica { conn, wall }
        })
        .collect();
    let mut serial = 0;
    for step in steps {
        match step {
            Step::Edit { replica, op } => {
                replicas[*replica].tick();
                edit(&replicas[*replica].conn, op, &mut serial);
                check_invariants(&replicas[*replica].conn);
            }
            Step::Sync { from, to, max_bytes, faults, meanwhile } => {
                faulty_sync(&mut replicas, &mut serial, (*from, *to, *max_bytes), faults, meanwhile);
            }
            Step::Clock { replica, ms } => {
                let r = &mut replicas[*replica];
                r.wall = (r.wall as i64 + ms) as u64;
                koona_sync::set_wall_clock(&r.conn, Some(r.wall)).unwrap();
            }
        }
    }
    // Every pair, cleanly, until nothing moves.
    let mut rounds = 0;
    loop {
        rounds += 1;
        let before: Vec<_> = replicas.iter().map(|r| (dump(&r.conn), vector(&r.conn))).collect();
        for from in 0..replica_count {
            for to in 0..replica_count {
                if from != to {
                    replicas[from].tick();
                    replicas[to].tick();
                    sync(&replicas[from].conn, &replicas[to].conn, 4_000);
                    check_invariants(&replicas[to].conn);
                }
            }
        }
        let after: Vec<_> = replicas.iter().map(|r| (dump(&r.conn), vector(&r.conn))).collect();
        if before == after {
            break;
        }
        prop_assert!(rounds < 12, "no quiescence after {rounds} rounds");
    }
    if std::env::var_os("KOONA_SYNC_STATS").is_some() {
        // What a case exercised, to see that the pools collide: merges, purges, what is left.
        let c = &replicas[0].conn;
        eprintln!(
            "stats merged={} purged={} bookmarks={} collections={} tags={} links={} feeds={} feeds_merged={} rounds={rounds}",
            one::<i64>(c, "SELECT count(*) FROM tombstones WHERE merged_into IS NOT NULL"),
            one::<i64>(c, "SELECT count(*) FROM tombstones WHERE merged_into IS NULL"),
            one::<i64>(c, "SELECT count(*) FROM bookmarks"),
            one::<i64>(c, "SELECT count(*) FROM collections"),
            one::<i64>(c, "SELECT count(*) FROM tags"),
            one::<i64>(c, "SELECT count(*) FROM bookmark_tags"),
            one::<i64>(c, "SELECT count(*) FROM feeds"),
            one::<i64>(c, "SELECT count(*) FROM tombstones WHERE kind = 'feed' AND merged_into IS NOT NULL"),
        );
    }
    let first = dump(&replicas[0].conn);
    let first_vector = vector(&replicas[0].conn);
    for (i, r) in replicas.iter().enumerate().skip(1) {
        let other = dump(&r.conn);
        if other != first {
            let a: std::collections::BTreeSet<_> = first.iter().collect();
            let b: std::collections::BTreeSet<_> = other.iter().collect();
            let only_a: Vec<_> = a.difference(&b).collect();
            let only_b: Vec<_> = b.difference(&a).collect();
            prop_assert!(false, "replica 0 and {i} differ:\n only in 0: {only_a:#?}\n only in {i}: {only_b:#?}");
        }
        prop_assert_eq!(&vector(&r.conn), &first_vector, "vectors differ");
    }
    Ok(())
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(300)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), max_shrink_iters: 4_000, ..ProptestConfig::default() })]

    #[test]
    fn three_replicas_converge(steps in steps(3)) {
        run(3, &steps)?;
    }

    #[test]
    fn four_replicas_converge(steps in steps(4)) {
        run(4, &steps)?;
    }
}
