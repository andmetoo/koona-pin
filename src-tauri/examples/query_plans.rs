//! Plans and timings of the queries the list and the sidebar run (NP-114).
//!
//! cargo run --release --example query_plans --manifest-path src-tauri/Cargo.toml [rows]
//!
//! Builds a test library of 100 000 bookmarks (or `rows`) at the current
//! schema in `.test-data/query-plans`, then for every scenario prints the
//! plan of each statement it ran (captured by the SQLite trace, parameters
//! expanded) and its p50 and p95.

use koonapin_lib::{db, dedupe, linkcheck, test_libraries as fixtures};
use rusqlite::Connection;
use std::{path::PathBuf, sync::Mutex, time::Instant};

const RUNS: usize = 30;

static STATEMENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record(sql: &str) {
    STATEMENTS.lock().unwrap().push(sql.to_string());
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// The plan of one statement, indented like the SQLite shell prints it.
fn plan(conn: &Connection, sql: &str) -> Vec<String> {
    let Ok(mut statement) = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")) else {
        return vec!["(no plan)".into()];
    };
    let rows: Vec<(i64, i64, String)> = statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let depth = |parent: i64| {
        let mut depth = 0;
        let mut at = parent;
        while at != 0 {
            depth += 1;
            at = rows.iter().find(|(id, _, _)| *id == at).map_or(0, |r| r.1);
        }
        depth
    };
    rows.iter()
        .map(|(_, parent, detail)| format!("{}{detail}", "  ".repeat(depth(*parent))))
        .collect()
}

fn scenario<T>(conn: &mut Connection, label: &str, run: impl Fn(&Connection) -> T) {
    STATEMENTS.lock().unwrap().clear();
    conn.trace(Some(record));
    run(conn);
    conn.trace(None);
    let statements = std::mem::take(&mut *STATEMENTS.lock().unwrap());
    let mut times = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        run(conn);
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!(
        "\n## {label}: p50 {:.2} ms, p95 {:.2} ms",
        percentile(&times, 0.5),
        percentile(&times, 0.95)
    );
    for sql in statements.iter().filter(|s| s.trim_start().to_uppercase().starts_with("SELECT")) {
        let short: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        println!("  > {}", short.chars().take(160).collect::<String>());
        for line in plan(conn, sql) {
            println!("      {line}");
        }
    }
}

fn main() {
    let rows: usize = std::env::args().nth(1).map_or(100_000, |n| n.parse().unwrap());
    println!("SQLite {}, {rows} bookmarks", rusqlite::version());
    let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.test-data/query-plans");
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("library-{rows}.db"));
    let conn = fixtures::fresh(&path);
    fixtures::generated(&conn, rows, rows as u64);
    // A rare tag: a filter that keeps a handful of rows.
    conn.execute_batch(
        "INSERT INTO tags (uid, name, created_at) VALUES ('rare-tag', 'редкий', '2026-01-01T00:00:00.000Z');
         INSERT INTO bookmark_tags SELECT id, (SELECT id FROM tags WHERE name = 'редкий') FROM bookmarks WHERE id % 10000 = 7;
         UPDATE bookmarks SET deleted_at = updated_at WHERE id % 50 = 0;",
    )
    .unwrap();
    fixtures::finish(conn);
    let mut conn = Connection::open(&path).unwrap();
    koonapin_lib::library::configure(&conn).unwrap();

    let list = |query: db::BookmarkQuery| move |c: &Connection| db::get_bookmarks(c, &query).unwrap();
    let since = Some(vec![
        "2025-12-31T00:00:00.000Z".to_string(),
        "2025-12-30T00:00:00.000Z".to_string(),
        "2025-12-25T00:00:00.000Z".to_string(),
    ]);
    let first = db::BookmarkQuery { since: since.clone(), ..Default::default() };
    scenario(&mut conn, "list: all, first page with date groups", list(first.clone()));
    let deep = {
        let mut query = db::BookmarkQuery::default();
        for _ in 0..50 {
            query.after = db::get_bookmarks(&conn, &query).unwrap().next;
        }
        query
    };
    scenario(&mut conn, "list: all, page 51", list(deep));
    scenario(&mut conn, "list: inbox", list(db::BookmarkQuery { only_inbox: true, since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: favorites", list(db::BookmarkQuery { only_favorites: true, since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: collection", list(db::BookmarkQuery { collection_id: Some(2), since: since.clone(), ..Default::default() }));
    // Its own bookmarks only (2.19.0); the one above reads its subtree's too.
    scenario(&mut conn, "list: collection only", list(db::BookmarkQuery { collection_id: Some(2), only_collection: true, since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: common tag", list(db::BookmarkQuery { tag: Some("rust".into()), since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: rare tag", list(db::BookmarkQuery { tag: Some("редкий".into()), since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: site", list(db::BookmarkQuery { domain: Some("github.com".into()), since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: trash", list(db::BookmarkQuery { only_trash: true, since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: search", list(db::BookmarkQuery { search: Some("архитект".into()), since: since.clone(), ..Default::default() }));
    scenario(&mut conn, "list: total after a change (limit 1)", list(db::BookmarkQuery { limit: Some(1), since, ..Default::default() }));
    // The orders of NP-114.
    let sorted = |sort: db::BookmarkSort| db::BookmarkQuery { sort: Some(sort), ..Default::default() };
    for (label, sort) in [
        ("oldest", db::BookmarkSort::Oldest),
        ("title", db::BookmarkSort::Title),
        ("site", db::BookmarkSort::Site),
    ] {
        scenario(&mut conn, &format!("list: all by {label}, first page"), list(sorted(sort)));
        let deep = {
            let mut query = sorted(sort);
            for _ in 0..50 {
                query.after = db::get_bookmarks(&conn, &query).unwrap().next;
            }
            query
        };
        scenario(&mut conn, &format!("list: all by {label}, page 51"), list(deep));
    }
    let title = || sorted(db::BookmarkSort::Title);
    scenario(&mut conn, "list: inbox by title", list(db::BookmarkQuery { only_inbox: true, ..title() }));
    scenario(&mut conn, "list: favorites by title", list(db::BookmarkQuery { only_favorites: true, ..title() }));
    scenario(&mut conn, "list: collection by title", list(db::BookmarkQuery { collection_id: Some(2), ..title() }));
    scenario(&mut conn, "list: rare tag by title", list(db::BookmarkQuery { tag: Some("редкий".into()), ..title() }));
    scenario(&mut conn, "list: search by title", list(db::BookmarkQuery { search: Some("архитект".into()), ..title() }));
    scenario(&mut conn, "Ctrl A: all ids by title", |c| db::get_bookmark_ids(c, &title()).unwrap());
    for language in ["ru", "en"] {
        let started = Instant::now();
        koonapin_lib::sorting::set_language(&conn, language).unwrap();
        println!("\n## sort keys rewritten in «{language}»: {:.0} ms", started.elapsed().as_secs_f64() * 1000.0);
    }
    scenario(&mut conn, "Ctrl A: all ids", |c| db::get_bookmark_ids(c, &db::BookmarkQuery::default()).unwrap());
    scenario(&mut conn, "Ctrl A: ids of a rare tag", |c| {
        db::get_bookmark_ids(c, &db::BookmarkQuery { tag: Some("редкий".into()), ..Default::default() }).unwrap()
    });
    scenario(&mut conn, "sidebar: counts", |c| db::get_counts(c).unwrap());
    scenario(&mut conn, "sidebar: collections", |c| db::get_collections(c).unwrap());
    scenario(&mut conn, "sidebar: tags", |c| db::get_tags(c).unwrap());
    scenario(&mut conn, "sidebar: sites", |c| db::get_domains(c).unwrap());
    scenario(&mut conn, "sidebar: duplicate groups", |c| dedupe::count(c).unwrap());
    scenario(&mut conn, "sidebar: link check results", |c| linkcheck::count(c).unwrap());
    scenario(&mut conn, "quick search: counts", |c| db::search_counts(c, Some("архитект")).unwrap().all);
    scenario(&mut conn, "triage: suggested collection", |c| db::suggest_collection(c, 12_345).unwrap());
    let size = std::fs::metadata(&path).map_or(0, |m| m.len()) / 1024;
    println!("\nfile: {size} KB");
}
