//! Builds test libraries without personal data (NP-005).
//!
//! cargo run --example test_libraries --manifest-path src-tauri/Cargo.toml -- [output]
//!
//! The output folder (default `.test-data/libraries`) is outside version control.
//! Every library is built from the real schema code, so it follows migrations.

use netamipin_lib::db::{create_tables, migrate};
use rusqlite::{params, Connection};
use std::{
    fs,
    path::{Path, PathBuf},
};

const WORDS: &[&str] = &[
    "архитектура",
    "дизайн",
    "типографика",
    "интерфейс",
    "ёлка",
    "поиск",
    "свет",
    "rust",
    "tauri",
    "sqlite",
    "react",
    "design",
    "notes",
    "reading",
    "garden",
    "music",
    "кириллица",
    "заметки",
    "путешествия",
    "рецепты",
    "история",
    "science",
    "photo",
];
const DOMAINS: &[&str] = &[
    "example.com",
    "пример.рф",
    "docs.example.org",
    "blog.example.net",
    "news.example.io",
    "github.com",
    "habr.com",
    "youtube.com",
    "wikipedia.org",
    "archdaily.com",
];

/// Deterministic generator: the same libraries on every machine, no extra crates.
struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn word(&mut self) -> &'static str {
        WORDS[self.below(WORDS.len())]
    }
}

fn fresh(path: &Path) -> Connection {
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .unwrap();
    create_tables(&conn).unwrap();
    conn
}

/// Rows the way OddClicks 0.1 stored them: date-only and RFC3339 times mixed,
/// notes, favourites, tags, a collection and one without.
fn legacy_rows(conn: &Connection) {
    conn.execute_batch(
        "INSERT INTO bookmarks (url,title,description,domain,notes,is_favorite,collection_id,created_at,updated_at) VALUES
         ('https://example.com/legacy-date','Старый формат даты',NULL,'example.com','Личная заметка',1,1,'2020-01-01','2020-01-01'),
         ('https://пример.рф/статья','Кириллический домен','Описание','пример.рф',NULL,0,NULL,'2024-05-06T07:08:09+00:00','2024-05-06T07:08:09+00:00'),
         ('https://example.com/ёлка?q=Ёж#часть','Ё и фрагмент',NULL,'example.com',NULL,0,2,'2025-12-31T23:59:59.123456+03:00','2026-01-01T00:00:00Z');
         INSERT INTO tags (name,created_at) VALUES ('архитектура','2020-01-01'),('rust','2024-05-06T07:08:09+00:00');
         INSERT INTO bookmark_tags VALUES (1,1),(2,1),(2,2);",
    )
    .unwrap();
}

fn generated(conn: &Connection, count: usize, seed: u64) {
    let mut random = Random(seed);
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut tag = tx
            .prepare(
                "INSERT OR IGNORE INTO tags (name,created_at) VALUES (?1,'2026-01-01T00:00:00Z')",
            )
            .unwrap();
        for word in WORDS {
            tag.execute([word]).unwrap();
        }
        let mut bookmark = tx
            .prepare(
                "INSERT INTO bookmarks (url,title,description,domain,notes,is_favorite,collection_id,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
            )
            .unwrap();
        let mut link = tx
            .prepare("INSERT OR IGNORE INTO bookmark_tags VALUES (?1,?2)")
            .unwrap();
        for index in 0..count {
            let domain = DOMAINS[random.below(DOMAINS.len())];
            let title = format!("{} {} {}", random.word(), random.word(), index);
            let description = (random.below(3) > 0)
                .then(|| format!("{} {} {}", random.word(), random.word(), random.word()));
            let notes = (random.below(10) == 0).then(|| format!("заметка {}", random.word()));
            let collection = match random.below(4) {
                0 => None,
                n => Some(n as i64),
            };
            // Spread over five years so sorting and date groups have real work.
            let day = random.below(5 * 365);
            let created = (chrono::DateTime::parse_from_rfc3339("2021-01-01T00:00:00Z").unwrap()
                + chrono::Duration::days(day as i64)
                + chrono::Duration::seconds(random.below(86_400) as i64))
            .to_utc()
            .to_rfc3339();
            bookmark
                .execute(params![
                    format!("https://{domain}/{index}/{}", random.word()),
                    title,
                    description,
                    domain,
                    notes,
                    random.below(8) == 0,
                    collection,
                    created
                ])
                .unwrap();
            let id = tx.last_insert_rowid();
            for _ in 0..random.below(4) {
                link.execute(params![id, 1 + random.below(WORDS.len()) as i64])
                    .unwrap();
            }
        }
    }
    tx.commit().unwrap();
}

/// Addresses that point to one page but differ as strings (input for NP-035).
fn near_duplicates(conn: &Connection) {
    let variants = [
        "https://example.com/page",
        "https://example.com/page/",
        "https://EXAMPLE.com/page",
        "http://example.com/page",
        "https://www.example.com/page",
        "https://example.com/page#section",
        "https://example.com/page?utm_source=newsletter&utm_medium=email",
        "https://example.com/page?ref=twitter",
    ];
    for (index, url) in variants.iter().enumerate() {
        conn.execute(
            "INSERT INTO bookmarks (url,title,domain,created_at,updated_at) VALUES (?1,'Одна и та же страница','example.com',?2,?2)",
            params![url, format!("2026-0{}-01T00:00:00Z", 1 + index % 9)],
        )
        .unwrap();
    }
}

fn finish(conn: Connection, path: &Path, version: u8) {
    if version >= 1 {
        migrate(&conn, None).unwrap();
    }
    // A clean file without a WAL, like a library after the app has closed.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    drop(conn);
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    println!(
        "{:<34} v{version} {:>8} KB",
        path.file_name().unwrap().to_string_lossy(),
        size / 1024
    );
}

fn main() {
    let output = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.test-data/libraries")
        });
    fs::create_dir_all(&output).unwrap();

    let path = output.join("empty-v1.db");
    finish(fresh(&path), &path, 1);

    let path = output.join("legacy-v0.db");
    let conn = fresh(&path);
    legacy_rows(&conn);
    finish(conn, &path, 0);

    let path = output.join("legacy-v1.db");
    let conn = fresh(&path);
    legacy_rows(&conn);
    finish(conn, &path, 1);

    let path = output.join("duplicates-v1.db");
    let conn = fresh(&path);
    near_duplicates(&conn);
    finish(conn, &path, 1);

    for (name, count) in [
        ("library-10k-v1.db", 10_000),
        ("library-100k-v1.db", 100_000),
    ] {
        let path = output.join(name);
        let conn = fresh(&path);
        generated(&conn, count, count as u64);
        finish(conn, &path, 1);
    }

    // Damaged pages in the middle of a real library: quick_check must fail.
    let damaged = output.join("corrupted-pages-v1.db");
    fs::copy(output.join("library-10k-v1.db"), &damaged).unwrap();
    let mut bytes = fs::read(&damaged).unwrap();
    let middle = bytes.len() / 2;
    for byte in &mut bytes[middle..middle + 16_384] {
        *byte = 0xA5;
    }
    fs::write(&damaged, bytes).unwrap();
    println!(
        "{:<34}    damaged 16 KB in the middle",
        "corrupted-pages-v1.db"
    );

    fs::write(
        output.join("not-a-database.db"),
        b"This is not an SQLite file.\n",
    )
    .unwrap();
    println!("{:<34}    plain text", "not-a-database.db");

    // Layout for NETAMIPIN_LEGACY_DIR: an OddClicks library to import.
    let legacy = output.join("oddclicks-legacy");
    fs::create_dir_all(&legacy).unwrap();
    fs::copy(output.join("legacy-v1.db"), legacy.join("oddclicks.db")).unwrap();
    println!(
        "{:<34}    NETAMIPIN_LEGACY_DIR layout",
        "oddclicks-legacy/oddclicks.db"
    );
}
