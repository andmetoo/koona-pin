// Замер поиска: текущий способ Netami Pin (db::get_bookmarks) против SQLite FTS5.
// Синтетическая библиотека в памяти; та же сборка SQLite, что в приложении (rusqlite 0.32 bundled).
// Запуск: cargo run --release --locked (из scripts/search-bench).
use rusqlite::{params, Connection};
use std::time::Instant;

const RU: &[&str] = &[
    "Архитектура", "интерфейс", "закладка", "библиотека", "разработка", "дизайн", "статья",
    "производительность", "безопасность", "синхронизация", "поиск", "железо", "сервер",
    "приложение", "компонент", "таблица", "миграция", "резервная", "копия", "ссылка",
    "Ёлка", "объявление", "руководство", "обзор", "заметка", "новости", "клавиатура",
];
const EN: &[&str] = &[
    "Rust", "Tauri", "React", "design", "system", "guide", "Performance", "database", "search",
    "release", "notes", "trezor", "wallet", "github", "docs", "tutorial", "Kubernetes",
    "typescript", "layout", "grid", "inbox", "backup", "sync", "Mobile", "Android",
];

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick(&mut self, words: &[&'static str]) -> &'static str {
        words[(self.next() % words.len() as u64) as usize]
    }
    fn words(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| if self.next() % 2 == 0 { self.pick(RU) } else { self.pick(EN) })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn setup(n: usize) -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
           description TEXT, domain TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL);
         CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
         CREATE TABLE bookmark_tags (bookmark_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (bookmark_id, tag_id));
         CREATE INDEX idx_created ON bookmarks(created_at DESC);",
    )
    .unwrap();
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    let tx = c.unchecked_transaction().unwrap();
    for t in 0..300 {
        let name = format!("{}-{t}", r.pick(RU).to_lowercase());
        tx.execute("INSERT INTO tags (name) VALUES (?1)", [name]).unwrap();
    }
    for i in 0..n {
        let domain = format!("site{}.example", r.next() % 2000);
        let url = format!("https://{domain}/{}/{i}", r.pick(EN).to_lowercase());
        let notes = (r.next() % 4 == 0).then(|| r.words(10));
        let created = format!(
            "2026-{:02}-{:02}T{:02}:00:00+00:00",
            1 + r.next() % 9,
            1 + r.next() % 28,
            r.next() % 24
        );
        tx.execute(
            "INSERT INTO bookmarks (url,title,description,domain,notes,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![url, r.words(6), r.words(18), domain, notes, created],
        )
        .unwrap();
        let id = tx.last_insert_rowid();
        for _ in 0..3 {
            tx.execute(
                "INSERT OR IGNORE INTO bookmark_tags VALUES (?1,?2)",
                params![id, 1 + r.next() % 300],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();
    c
}

fn tags_for(c: &Connection, id: i64) -> Vec<String> {
    let mut s = c
        .prepare_cached(
            "SELECT t.name FROM tags t JOIN bookmark_tags bt ON t.id=bt.tag_id WHERE bt.bookmark_id=?1",
        )
        .unwrap();
    s.query_map([id], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

/// Повторяет db::get_bookmarks: все строки, отдельный запрос тегов на каждую, подстрока в Rust.
fn current(c: &Connection, query: &str) -> usize {
    let mut s = c
        .prepare(
            "SELECT DISTINCT b.id,b.url,b.title,b.description,b.domain,b.notes FROM bookmarks b
             LEFT JOIN bookmark_tags bt ON b.id=bt.bookmark_id LEFT JOIN tags t ON bt.tag_id=t.id
             ORDER BY b.created_at DESC, b.id DESC",
        )
        .unwrap();
    type Row = (i64, String, String, Option<String>, String, Option<String>);
    let rows: Vec<Row> = s
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let query = query.to_lowercase();
    rows.into_iter()
        .filter(|(id, url, title, description, domain, notes)| {
            let haystack = format!(
                "{title} {url} {domain} {} {} {}",
                notes.as_deref().unwrap_or(""),
                description.as_deref().unwrap_or(""),
                tags_for(c, *id).join(" ")
            )
            .to_lowercase();
            haystack.contains(&query)
        })
        .count()
}

fn build_fts(c: &Connection, table: &str, tokenizer: &str) -> f64 {
    let t = Instant::now();
    c.execute_batch(&format!(
        "CREATE VIRTUAL TABLE {table} USING fts5(title,url,domain,notes,description,tags, tokenize='{tokenizer}');
         INSERT INTO {table}(rowid,title,url,domain,notes,description,tags)
           SELECT b.id,b.title,b.url,b.domain,COALESCE(b.notes,''),COALESCE(b.description,''),
             COALESCE((SELECT group_concat(t.name,' ') FROM bookmark_tags bt JOIN tags t ON t.id=bt.tag_id
                       WHERE bt.bookmark_id=b.id),'')
           FROM bookmarks b;"
    ))
    .unwrap();
    t.elapsed().as_secs_f64() * 1000.0
}

/// Поиск по индексу: общее число и первая страница из 100 записей с тегами одним запросом.
fn fts(c: &Connection, table: &str, query: &str) -> usize {
    let total: i64 = c
        .query_row(
            &format!("SELECT count(*) FROM {table} WHERE {table} MATCH ?1"),
            [query],
            |r| r.get(0),
        )
        .unwrap();
    let mut page = c
        .prepare_cached(&format!(
            "SELECT b.id FROM {table} f JOIN bookmarks b ON b.id=f.rowid WHERE {table} MATCH ?1
             ORDER BY b.created_at DESC, b.id DESC LIMIT 100"
        ))
        .unwrap();
    let ids: Vec<String> = page
        .query_map([query], |r| r.get::<_, i64>(0))
        .unwrap()
        .map(|id| id.unwrap().to_string())
        .collect();
    let mut tags = c
        .prepare(&format!(
            "SELECT bt.bookmark_id,t.name FROM bookmark_tags bt JOIN tags t ON t.id=bt.tag_id
             WHERE bt.bookmark_id IN ({})",
            if ids.is_empty() { "0".into() } else { ids.join(",") }
        ))
        .unwrap();
    tags.query_map([], |_| Ok(())).unwrap().count();
    total as usize
}

/// Медиана нескольких прогонов после одного прогрева.
fn median_ms<T>(runs: usize, mut f: impl FnMut() -> T) -> (f64, T) {
    let mut out = f();
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        out = f();
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    (times[times.len() / 2], out)
}

fn main() {
    println!("SQLite {}", rusqlite::version());
    for n in [10_000usize, 100_000] {
        let c = setup(n);
        println!("\n=== {n} закладок ===");
        let (t, hits) = median_ms(5, || current(&c, "АРХИТЕКТ"));
        println!("текущий способ, 'АРХИТЕКТ': {t:.1} мс, найдено {hits}");

        let like = |pattern: &str| -> i64 {
            c.query_row("SELECT count(*) FROM bookmarks WHERE title LIKE ?1", [pattern], |r| r.get(0))
                .unwrap()
        };
        println!(
            "встроенный LIKE: '%архитект%' = {}, '%Архитект%' = {} (регистр кириллицы не сворачивается)",
            like("%архитект%"),
            like("%Архитект%")
        );

        println!("построение FTS5 trigram: {:.0} мс", build_fts(&c, "fts_tri", "trigram"));
        for query in ["\"архитект\"", "\"АРХИТЕКТ\"", "\"site12\""] {
            let (t, hits) = median_ms(20, || fts(&c, "fts_tri", query));
            println!("FTS5 trigram {query}: {t:.2} мс, найдено {hits}");
        }

        println!(
            "построение FTS5 unicode61: {:.0} мс",
            build_fts(&c, "fts_words", "unicode61 remove_diacritics 2")
        );
        for query in ["архитект*", "елка*"] {
            let (t, hits) = median_ms(20, || fts(&c, "fts_words", query));
            println!("FTS5 unicode61 {query}: {t:.2} мс, найдено {hits}");
        }
    }
}
