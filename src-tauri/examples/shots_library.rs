//! Fills a library folder with the sample of the store screenshots, for an app that has no shot
//! hooks of its own: the iOS Simulator's (scripts/appstore-shots.mjs). With the app stopped:
//!
//! cargo run --example shots_library --manifest-path src-tauri/Cargo.toml -- <folder> <copy.json> [<library.sql>] [<feeds.sql>]
//!
//! `<folder>` holds the app's `koonapin.db` (made when missing); the copy, in the app's JSON
//! format, replaces the library through the restore of the app (restore.rs), backup included.
//! `<library.sql>` then runs on the library's own connection, its functions and triggers in
//! place, and `<feeds.sql>` on the feed cache `feeds.db` beside it, as the desktop's shots do
//! through `!sql` and `!feeds` (shots.rs). A file named `-` is skipped.

use koonapin_lib::{feeds, library, restore};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [folder, copy, rest @ ..] = args.as_slice() else {
        eprintln!("usage: shots_library <folder> <copy.json> [<library.sql>] [<feeds.sql>]");
        std::process::exit(2);
    };
    let folder = PathBuf::from(folder);
    let paths = library::Paths::new(folder.join(koonapin_lib::db::DB_FILE));
    let opened = library::open(&paths).unwrap_or_else(|e| panic!("the library: {e:?}"));
    let text = std::fs::read_to_string(copy).expect("the copy");
    let checked = restore::check(&text).unwrap_or_else(|e| panic!("the copy: {e:?}"));
    let summary = restore::restore(&opened.conn, &checked, restore::RestoreMode::Replace, &paths.backups)
        .unwrap_or_else(|e| panic!("the restore: {e:?}"));
    println!("restored: {summary:?}");
    let sql = |i: usize| rest.get(i).filter(|f| f.as_str() != "-").map(|f| std::fs::read_to_string(f).expect("an SQL file"));
    if let Some(statements) = sql(0) {
        opened.conn.execute_batch(&statements).expect("the library's statements");
    }
    if let Some(statements) = sql(1) {
        let cache = feeds::cache::open(&folder).expect("the feed cache");
        cache.conn.execute_batch(&statements).expect("the feed cache's statements");
        cache.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").expect("the feed cache's checkpoint");
    }
    opened.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").expect("the library's checkpoint");
}
