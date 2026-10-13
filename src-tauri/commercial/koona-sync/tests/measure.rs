//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! What sync costs on a large library: 100 000 bookmarks with collections and tags. Not run by
//! default:
//!
//! cargo test -p koona-sync --release --test measure -- --ignored --nocapture

mod common;

use common::*;
use koona_sync::model::Vector;
use koona_sync::Delta;
use rusqlite::{params, Connection};
use std::io::Write;
use std::time::Instant;
use uuid::Uuid;

const BOOKMARKS: usize = 100_000;
const COLLECTIONS: usize = 30;
const TAGS: usize = 300;

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
            "rust", "sqlite", "design", "notes", "guide", "release", "async", "parser", "browser", "sync",
            "library", "review", "talk", "paper", "theory", "practice",
        ];
        (0..n).map(|_| WORDS[self.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
    }
}

/// A library as a person keeps it: titles, descriptions, images, a few notes, collections, tags.
fn fill(conn: &Connection) {
    let mut random = Random(0x9E37_79B9_7F4A_7C15);
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..COLLECTIONS {
        tx.execute(
            "INSERT INTO collections (uid, name, created_at, position_key) VALUES (?1, ?2, '2024-01-01T00:00:00.000Z', ?3)",
            params![Uuid::now_v7().to_string(), format!("Collection {i}"), format!("a{i:03}")],
        )
        .unwrap();
    }
    for i in 0..TAGS {
        tx.execute(
            "INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, '2024-01-01T00:00:00.000Z')",
            params![Uuid::now_v7().to_string(), format!("tag-{i}")],
        )
        .unwrap();
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
        for i in 0..BOOKMARKS {
            let site = random.below(5_000);
            let url = format!("https://site{site}.example.com/articles/{}/{i}", random.words(2).replace(' ', "-"));
            let time = format!("2025-{:02}-{:02}T10:{:02}:{:02}.000Z", 1 + i % 12, 1 + i % 28, i % 60, i % 59);
            let notes = (random.below(10) == 0).then(|| random.words(8));
            let collection = (random.below(3) > 0).then(|| 1 + random.below(COLLECTIONS) as i64);
            insert
                .execute(params![
                    Uuid::now_v7().to_string(),
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
                link.execute(params![id, 1 + random.below(TAGS) as i64]).unwrap();
            }
        }
    }
    tx.commit().unwrap();
}

fn sizes(conn: &Connection) -> (i64, i64) {
    let total: i64 = one(conn, "SELECT sum(pgsize) FROM dbstat");
    let sync: i64 = one(conn, "SELECT sum(pgsize) FROM dbstat WHERE name IN ('sync_clock', 'sync_clock_change')");
    (total, sync)
}

fn ids_text(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

fn mb(bytes: i64) -> f64 {
    bytes as f64 / 1_048_576.0
}

fn open(path: &std::path::Path, replica: Uuid) -> Connection {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let conn = library_at(Some(path), replica);
    // As `library::configure` sets them.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA cache_size = -65536;").unwrap();
    conn
}

#[test]
#[ignore]
fn one_hundred_thousand_bookmarks() {
    let folder = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("koona-sync-measure");
    std::fs::create_dir_all(&folder).unwrap();
    let a = open(&folder.join("a.db"), replica_id(1));
    koona_sync::set_capture(&a, false).unwrap();
    let started = Instant::now();
    fill(&a);
    println!("filled {BOOKMARKS} bookmarks in {:?}", started.elapsed());
    let links: i64 = one(&a, "SELECT count(*) FROM bookmark_tags");
    koona_sync::set_capture(&a, true).unwrap();

    let started = Instant::now();
    koona_sync::baseline(&a).unwrap();
    println!("baseline: {:?}", started.elapsed());
    let (total, sync) = sizes(&a);
    println!(
        "after baseline: library {:.1} MB, sync_clock + index {:.2} MB ({:.1}%), {} clocks, {links} links",
        mb(total),
        mb(sync),
        100.0 * sync as f64 / total as f64,
        one::<i64>(&a, "SELECT count(*) FROM sync_clock"),
    );

    // A year of use: a fifth of the bookmarks edited in two fields, a tenth retagged.
    let started = Instant::now();
    a.execute_batch(
        "BEGIN;
         UPDATE bookmarks SET title = title || ' (read)', notes = 'seen' WHERE id % 5 = 0;
         INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) SELECT id, 1 + id % 300 FROM bookmarks WHERE id % 10 = 3;
         COMMIT;",
    )
    .unwrap();
    println!("20 000 edits and 10 000 tags recorded in {:?}", started.elapsed());
    let (total, sync) = sizes(&a);
    println!(
        "after edits: library {:.1} MB, sync_clock + index {:.2} MB ({:.1}%), {} clocks",
        mb(total),
        mb(sync),
        100.0 * sync as f64 / total as f64,
        one::<i64>(&a, "SELECT count(*) FROM sync_clock"),
    );

    // The full snapshot into an empty library.
    let b = open(&folder.join("b.db"), replica_id(2));
    let started = Instant::now();
    let mut delta = Delta::new(&a, &Vector::default()).unwrap();
    let keys = delta.remaining();
    let mut chunks = Vec::new();
    while let Some(chunk) = delta.next_chunk(1 << 20).unwrap() {
        chunks.push(chunk);
    }
    let made = started.elapsed();
    let (mut json, mut deflated, mut groups) = (0usize, 0usize, 0usize);
    for chunk in &chunks {
        let bytes = serde_json::to_vec(&chunk.groups).unwrap();
        json += bytes.len();
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&bytes).unwrap();
        deflated += encoder.finish().unwrap().len();
        groups += chunk.groups.len();
    }
    println!(
        "snapshot: {keys} records in {} chunks of 1 MB, made in {made:?}; {groups} groups, {:.1} MB JSON, {:.1} MB deflated",
        chunks.len(),
        mb(json as i64),
        mb(deflated as i64)
    );
    let started = Instant::now();
    let mut session = Session::new();
    for (i, chunk) in chunks.iter().enumerate() {
        session.receive(&b, i, chunk);
    }
    println!("applied in {:?}; covers merged: {}", started.elapsed(), session.merged);
    assert!(session.merged);
    assert_eq!(one::<i64>(&b, "SELECT count(*) FROM bookmarks"), BOOKMARKS as i64);
    assert_eq!(one::<i64>(&b, "SELECT count(*) FROM bookmark_tags"), one::<i64>(&a, "SELECT count(*) FROM bookmark_tags"));
    let started = Instant::now();
    assert_eq!(dump(&a), dump(&b));
    println!("dumps equal (compared in {:?})", started.elapsed());
    let (total, sync) = sizes(&b);
    println!(
        "receiver: library {:.1} MB, sync_clock + index {:.2} MB ({:.1}%), {} clocks",
        mb(total),
        mb(sync),
        100.0 * sync as f64 / total as f64,
        one::<i64>(&b, "SELECT count(*) FROM sync_clock"),
    );

    // The same into a library without the app's search and sort triggers: what the engine
    // itself costs.
    let c = open(&folder.join("c.db"), replica_id(3));
    let triggers = ids_text(&c, "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'bookmarks_%'");
    for name in triggers {
        c.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    let started = Instant::now();
    let mut session = Session::new();
    for (i, chunk) in chunks.iter().enumerate() {
        session.receive(&c, i, chunk);
    }
    println!("applied without the search and sort triggers in {:?}", started.elapsed());
    // And what writing the same rows costs there without the engine.
    let d = open(&folder.join("d.db"), replica_id(4));
    for name in ids_text(&d, "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'bookmarks_%'") {
        d.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    koona_sync::set_capture(&d, false).unwrap();
    let started = Instant::now();
    fill(&d);
    println!("the same rows written directly, without those triggers: {:?}", started.elapsed());

    // Day to day: one edit, then the delta and its apply.
    let id: i64 = one(&a, "SELECT id FROM bookmarks WHERE id = 777");
    set_bookmark(&a, id, "title", rusqlite::types::Value::Text("one edit".into()));
    let started = Instant::now();
    let chunks = koona_sync::delta_all(&a, &vector(&b), 1 << 20).unwrap();
    let made = started.elapsed();
    let started = Instant::now();
    let mut session = Session::new();
    for (i, chunk) in chunks.iter().enumerate() {
        session.receive(&b, i, chunk);
    }
    println!(
        "one edit: delta {made:?} ({} groups), applied {:?}",
        chunks.iter().map(|c| c.groups.len()).sum::<usize>(),
        started.elapsed()
    );
    assert_eq!(one::<String>(&b, "SELECT title FROM bookmarks WHERE id = 777"), "one edit");
}
