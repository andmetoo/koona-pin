//! Search timing on the real schema and `db::get_bookmarks` (NP-011).
//!
//! cargo run --release --example search_bench --manifest-path src-tauri/Cargo.toml
//!
//! Builds the 10 000 and 100 000 test libraries at schema 1 in
//! `.test-data/search-bench`, times the migration that builds the index, then
//! the first page (100 bookmarks with tags and the total) for typical queries.

use koonapin_lib::{db, library, migrations, test_libraries as fixtures};
use rusqlite::Connection;
use std::{path::PathBuf, time::Instant};

const RUNS: usize = 50;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    println!("SQLite {}", rusqlite::version());
    let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.test-data/search-bench");
    std::fs::create_dir_all(&folder).unwrap();
    for rows in [10_000usize, 100_000] {
        let path = folder.join(format!("library-{rows}.db"));
        let conn = fixtures::fresh_at(&path, 1);
        fixtures::generated(&conn, rows, rows as u64);
        fixtures::finish(conn);

        let mut conn = Connection::open(&path).unwrap();
        library::configure(&conn).unwrap();
        let started = Instant::now();
        migrations::migrate(&mut conn, None).unwrap();
        println!(
            "\n=== {rows} bookmarks ===\nmigration to schema {} with the index: {:.0} ms",
            migrations::SCHEMA_VERSION,
            started.elapsed().as_secs_f64() * 1000.0
        );
        let started = Instant::now();
        db::rebuild_search(&conn).unwrap();
        println!(
            "rebuild: {:.0} ms",
            started.elapsed().as_secs_f64() * 1000.0
        );

        let collection = Some(2);
        for (label, search, collection_id) in [
            ("no search", "", None),
            ("архитект", "архитект", None),
            ("АРХИТЕКТУРА", "АРХИТЕКТУРА", None),
            ("елка (ё)", "елка", None),
            ("two words", "дизайн rust", None),
            ("domain", "пример.рф", None),
            ("rare", "кириллица 9999", None),
            ("nothing", "несуществующее", None),
            ("1 char", "а", None),
            ("2 chars", "ру", None),
            ("long + short", "rust 12", None),
            ("in collection", "дизайн", collection),
        ] {
            let query = db::BookmarkQuery {
                search: Some(search.into()),
                collection_id,
                ..Default::default()
            };
            let mut page = db::get_bookmarks(&conn, &query).unwrap();
            let mut times = Vec::with_capacity(RUNS);
            for _ in 0..RUNS {
                let started = Instant::now();
                page = db::get_bookmarks(&conn, &query).unwrap();
                times.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(f64::total_cmp);
            println!(
                "{label:<14} p50 {:>7.2} ms  p95 {:>7.2} ms  found {:>6}",
                percentile(&times, 0.5),
                percentile(&times, 0.95),
                page.total.unwrap_or_default()
            );
        }

        // The last page through the cursor, as scrolling to the end would read it.
        let mut query = db::BookmarkQuery::default();
        let started = Instant::now();
        let mut pages = 0;
        while let Some(next) = db::get_bookmarks(&conn, &query).unwrap().next {
            query.after = Some(next);
            pages += 1;
        }
        println!(
            "all {} pages: {:.0} ms",
            pages + 1,
            started.elapsed().as_secs_f64() * 1000.0
        );
        let size = std::fs::metadata(&path).map_or(0, |m| m.len()) / 1024;
        println!("file: {size} KB");
    }
}
