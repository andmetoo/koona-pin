//! Test libraries without personal data (NP-005, Р-11).
//!
//! Built through the real migrations, so they follow the schema. The example
//! `test_libraries` writes them to `.test-data/libraries`; Rust tests build
//! the same libraries in their own folders. Everything, including `uid`, is
//! deterministic: the same files on every machine.

use crate::{library, migrations};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use std::{fs, path::Path};

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
const SOURCES: &[&str] = &["chrome", "edge", "firefox", "extension", "app", "import"];

/// Deterministic generator, no extra crates.
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
    /// UUIDv7 at `time` with random bits from this generator.
    fn uid(&mut self, time: DateTime<Utc>) -> String {
        let mut bytes = [0u8; 10];
        for byte in &mut bytes {
            *byte = self.next() as u8;
        }
        uuid::Builder::from_unix_timestamp_millis(time.timestamp_millis() as u64, &bytes)
            .into_uuid()
            .to_string()
    }
}

fn stamp(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn epoch() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2021-01-01T00:00:00Z")
        .unwrap()
        .to_utc()
}

/// A new library of the current schema with the default collections and a fixed token.
pub fn fresh(path: &Path) -> Connection {
    fresh_at(path, migrations::SCHEMA_VERSION)
}

/// The same at an earlier `schema`, as a previous release left it: input for
/// the migrations.
pub fn fresh_at(path: &Path, schema: i64) -> Connection {
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let mut conn = Connection::open(path).unwrap();
    library::configure(&conn).unwrap();
    migrations::migrations()
        .to_version(&mut conn, schema as usize)
        .unwrap();
    // A new library names its first collections when the interface opens it (NP-085).
    let names = ["Development", "Design & UI", "Articles / To read"].map(String::from);
    crate::db::create_starter_collections(&conn, &names).unwrap();
    let mut random = Random(1);
    let created = epoch();
    for id in 1..=3 {
        conn.execute(
            "UPDATE collections SET uid = ?1, created_at = ?2 WHERE id = ?3",
            params![random.uid(created), stamp(created), id],
        )
        .unwrap();
    }
    conn.execute(
        "UPDATE app_settings SET value = ?1 WHERE key = 'capture_token'",
        ["0123456789abcdef".repeat(4)],
    )
    .unwrap();
    conn
}

/// A few hand-made rows: Cyrillic domain and title, «ё», a fragment, notes,
/// a favourite, tags, one bookmark in the inbox and one without a source.
pub fn sample_rows(conn: &Connection) {
    let mut random = Random(2);
    let rows = [
        (
            "https://example.com/notes",
            "Заметка с тегами",
            None,
            "example.com",
            Some("Личная заметка"),
            1,
            Some(1),
            Some("chrome"),
            "2024-05-06T07:08:09.000Z",
            true,
        ),
        (
            "https://пример.рф/статья",
            "Кириллический домен",
            Some("Описание"),
            "пример.рф",
            None,
            0,
            None,
            None,
            "2025-01-02T03:04:05.678Z",
            true,
        ),
        (
            "https://example.com/ёлка?q=Ёж#часть",
            "Ё и фрагмент",
            None,
            "example.com",
            None,
            0,
            Some(2),
            Some("firefox"),
            "2026-01-01T00:00:00.000Z",
            false,
        ),
    ];
    for (url, title, description, domain, notes, favorite, collection, source, created, triaged) in
        rows
    {
        let time = DateTime::parse_from_rfc3339(created).unwrap().to_utc();
        conn.execute(
            "INSERT INTO bookmarks (uid,url,title,description,domain,notes,is_favorite,collection_id,source,created_at,updated_at,triaged_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11)",
            params![random.uid(time), url, title, description, domain, notes, favorite, collection, source, created, triaged.then_some(created)],
        )
        .unwrap();
    }
    for (name, created) in [
        ("архитектура", "2024-05-06T07:08:09.000Z"),
        ("rust", "2025-01-02T03:04:05.678Z"),
    ] {
        let time = DateTime::parse_from_rfc3339(created).unwrap().to_utc();
        conn.execute(
            "INSERT INTO tags (uid, name, created_at) VALUES (?1, ?2, ?3)",
            params![random.uid(time), name, created],
        )
        .unwrap();
    }
    conn.execute_batch("INSERT INTO bookmark_tags VALUES (1,1),(2,1),(2,2);")
        .unwrap();
}

pub fn generated(conn: &Connection, count: usize, seed: u64) {
    let mut random = Random(seed);
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut tag = tx
            .prepare("INSERT OR IGNORE INTO tags (uid,name,created_at) VALUES (?1,?2,?3)")
            .unwrap();
        for word in WORDS {
            tag.execute(params![random.uid(epoch()), word, stamp(epoch())])
                .unwrap();
        }
        let mut bookmark = tx
            .prepare(
                "INSERT INTO bookmarks (uid,url,title,description,domain,notes,is_favorite,collection_id,source,created_at,updated_at,triaged_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11)",
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
            let created = epoch()
                + Duration::days(random.below(5 * 365) as i64)
                + Duration::milliseconds(random.below(86_400_000) as i64);
            // About one in twenty still waits in the inbox.
            let triaged = (random.below(20) > 0).then(|| stamp(created));
            bookmark
                .execute(params![
                    random.uid(created),
                    format!("https://{domain}/{index}/{}", random.word()),
                    title,
                    description,
                    domain,
                    notes,
                    random.below(8) == 0,
                    collection,
                    SOURCES[random.below(SOURCES.len())],
                    stamp(created),
                    triaged
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
pub fn near_duplicates(conn: &Connection) {
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
    let mut random = Random(3);
    for (index, url) in variants.iter().enumerate() {
        let created = epoch() + Duration::days(30 * index as i64);
        conn.execute(
            "INSERT INTO bookmarks (uid,url,title,domain,source,created_at,updated_at,triaged_at)
             VALUES (?1,?2,'Одна и та же страница','example.com','chrome',?3,?3,?3)",
            params![random.uid(created), url, stamp(created)],
        )
        .unwrap();
    }
}

/// A clean file without a WAL, like a library after the app has closed.
pub fn finish(conn: Connection) {
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
}

/// A library of the builds before NP-006: their schema frozen here, no
/// application id, `user_version` 1. Opening it moves it aside (Р-11).
pub fn before_schema_1(path: &Path) {
    let _ = fs::remove_file(path);
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT, icon TEXT, created_at TEXT NOT NULL);
         CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
            image_url TEXT, favicon_url TEXT, domain TEXT NOT NULL, notes TEXT, is_favorite INTEGER NOT NULL DEFAULT 0,
            collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1);
         CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
         CREATE TABLE bookmark_tags (bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (bookmark_id, tag_id));
         CREATE TABLE capture_receipts (request_id TEXT PRIMARY KEY, url TEXT NOT NULL, bookmark_id INTEGER NOT NULL, outcome TEXT NOT NULL);
         CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO collections (name,color,icon,created_at) VALUES ('Разработка','#6366f1','code','2020-01-01');
         INSERT INTO bookmarks (url,title,domain,notes,is_favorite,collection_id,created_at,updated_at) VALUES
           ('https://example.com/legacy-date','Старый формат даты','example.com','Личная заметка',1,1,'2020-01-01','2020-01-01'),
           ('https://пример.рф/статья','Кириллический домен','пример.рф',NULL,0,NULL,'2024-05-06T07:08:09+00:00','2024-05-06T07:08:09+00:00'),
           ('https://example.com/ёлка','Ё','example.com',NULL,0,NULL,'2025-12-31T23:59:59.123456+03:00','2026-01-01T00:00:00Z');
         INSERT INTO app_settings VALUES ('capture_token','old'),('close_to_tray','true');
         PRAGMA user_version = 1;",
    )
    .unwrap();
}

/// Writes every library to `output` and returns one line per file.
pub fn build_all(output: &Path) -> Vec<String> {
    fs::create_dir_all(output).unwrap();
    let mut report = Vec::new();
    let size = |name: &str| fs::metadata(output.join(name)).map_or(0, |m| m.len()) / 1024;

    // Schema 1, as the release before NP-011 left them: opening one in the
    // app runs the migrations, including building the search index.
    for (name, rows) in [
        ("empty-v1.db", 0),
        ("sample-v1.db", 3),
        ("duplicates-v1.db", 8),
        ("library-10k-v1.db", 10_000),
        ("library-100k-v1.db", 100_000),
    ] {
        let conn = fresh_at(&output.join(name), 1);
        match rows {
            0 => {}
            3 => sample_rows(&conn),
            8 => near_duplicates(&conn),
            n => generated(&conn, n, n as u64),
        }
        finish(conn);
        report.push(format!("{name:<26} schema 1 {:>8} KB", size(name)));
    }

    // Made by a future version: must be refused and left unchanged.
    let newer = output.join("newer-schema.db");
    fs::copy(output.join("sample-v1.db"), &newer).unwrap();
    Connection::open(&newer)
        .unwrap()
        .pragma_update(None, "user_version", migrations::SCHEMA_VERSION + 1)
        .unwrap();
    report.push(format!(
        "{:<26} sample marked as schema {}",
        "newer-schema.db",
        migrations::SCHEMA_VERSION + 1
    ));

    before_schema_1(&output.join("before-schema-1.db"));
    report.push(format!(
        "{:<26} build before NP-006, moved aside",
        "before-schema-1.db"
    ));

    let foreign = output.join("foreign-app.db");
    let _ = fs::remove_file(&foreign);
    Connection::open(&foreign)
        .unwrap()
        .execute_batch("PRAGMA application_id = 305419896; CREATE TABLE notes (text TEXT);")
        .unwrap();
    report.push(format!(
        "{:<26} SQLite file of another program",
        "foreign-app.db"
    ));

    // Damaged pages in the middle of a real library: quick_check must fail.
    let damaged = output.join("corrupted-pages-v1.db");
    fs::copy(output.join("library-10k-v1.db"), &damaged).unwrap();
    damage(&damaged);
    report.push(format!(
        "{:<26} damaged 16 KB in the middle",
        "corrupted-pages-v1.db"
    ));

    fs::write(
        output.join("not-a-database.db"),
        b"This is not an SQLite file.\n",
    )
    .unwrap();
    report.push(format!("{:<26} plain text", "not-a-database.db"));
    report
}

/// Overwrites 16 KB in the middle of the file, as a failing disk would.
pub fn damage(path: &Path) {
    let mut bytes = fs::read(path).unwrap();
    let middle = bytes.len() / 2;
    for byte in &mut bytes[middle..middle + 16_384] {
        *byte = 0xA5;
    }
    fs::write(path, bytes).unwrap();
}
