//! In-memory, synthetic data only. Run with cargo run --release --example feeds_bench.
//! Compares the v3 indexes with the current schema using the real list command.
use koonapin_lib::feeds::{cache, FeedItemQuery};
use rusqlite::{params, Connection};
use std::time::Instant;

fn measure(label: &str, mut run: impl FnMut()) {
    run();
    let mut times = Vec::new();
    for _ in 0..50 {
        let start = Instant::now();
        run();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    // Nearest rank: the 25th and the 48th of 50 sorted runs.
    let rank = |p: f64| times[(p * times.len() as f64).ceil() as usize - 1];
    println!("{label}: p50={:.3} ms p95={:.3} ms", rank(0.50), rank(0.95));
}

fn measurements(conn: &Connection) -> Vec<Vec<i64>> {
    let used: i64 = conn.query_row("SELECT (page_count - freelist_count) * page_size FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()", [], |r| r.get(0)).unwrap();
    println!("Used SQLite pages: {:.2} MiB", used as f64 / 1048576.0);
    let mut answers = Vec::new();
    for (label, feed_uid, after) in [
        ("all / first", None, None),
        ("one / first", Some("feed-12".to_string()), None),
        ("all / later", None, Some("2026-10-10T00:00:00Z|10000".to_string())),
    ] {
        let query = FeedItemQuery { feed_uid, after, limit: 50, ..Default::default() };
        answers.push(cache::list_items(conn, &query).unwrap().0.iter().map(|(item, _)| item.id).collect());
        measure(label, || { std::hint::black_box(cache::list_items(conn, &query).unwrap()); });
    }
    measure("sidebar counts", || {
        let mut feeds = [];
        cache::merge_state(conn, &mut feeds, chrono::Utc::now()).unwrap();
    });
    answers
}

fn main() {
    println!("SQLite {}; 50 feeds x 500 posts; 6 KiB article bodies; 50 warm runs", rusqlite::version());
    let conn = cache::open_in_memory().unwrap();
    // Save the actual migration's index definitions, then restore the previous schema's indexes.
    let indexes: Vec<String> = conn.prepare("SELECT sql FROM sqlite_schema WHERE name IN ('feed_items_list', 'feed_items_all', 'feed_items_counts')")
        .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    conn.execute_batch("DROP INDEX feed_items_list; DROP INDEX feed_items_all; DROP INDEX feed_items_counts;
        CREATE INDEX feed_items_list ON feed_items(feed_uid, published_at DESC, id DESC);
        CREATE INDEX feed_items_unread ON feed_items (feed_uid) WHERE read_at IS NULL;").unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let body = "article ".repeat(768);
    for i in 0..25_000 {
        let date = format!("2026-10-{:02}T00:00:00Z", 1 + (i * 17 % 28));
        let published = (i % 4 != 0).then_some(&date);
        tx.execute("INSERT INTO feed_items(feed_uid,key,title,excerpt,content_html,published_at,fetched_at,read_at)
            VALUES(?1,?2,'Article title','Short excerpt',?3,?4,?5,?6)",
            params![format!("feed-{}", i % 50), i.to_string(), body, published, date, (i % 3 == 0).then_some(&date)]).unwrap();
    }
    tx.commit().unwrap();
    println!("BEFORE");
    let before = measurements(&conn);
    let start = Instant::now();
    conn.execute_batch("DROP INDEX feed_items_list; DROP INDEX feed_items_unread").unwrap();
    for sql in indexes { conn.execute_batch(&sql).unwrap(); }
    println!("Index migration: {:.1} ms", start.elapsed().as_secs_f64() * 1000.0);
    println!("AFTER");
    assert_eq!(before, measurements(&conn), "same rows and order");
}
