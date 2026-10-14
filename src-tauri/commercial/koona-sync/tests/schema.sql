-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
--
-- A library at schema 9 exactly as the app's migrations leave it (src-tauri/src/migrations.rs),
-- read back from sqlite_schema in order. The triggers call the app's SQL functions; the tests
-- stub them (`tests/common/mod.rs`).
CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    icon TEXT,
    created_at TEXT NOT NULL
, position INTEGER);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    favicon_url TEXT,
    domain TEXT NOT NULL,
    notes TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    source TEXT CHECK (source IN ('app','chrome','edge','firefox','extension','bookmarklet','import','mcp','safari')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    triaged_at TEXT,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
, url_key TEXT, title_key BLOB, site_key BLOB, source_name TEXT);
CREATE TABLE bookmark_tags (
    bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
);
CREATE TABLE capture_receipts (
    request_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    bookmark_id INTEGER NOT NULL,
    outcome TEXT NOT NULL
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tombstones (
    uid TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bookmark','collection','tag')),
    deleted_at TEXT NOT NULL,
    purged_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE bookmarks_search USING fts5(
    title, url, domain, description, notes, tags,
    content='', contentless_delete=1, tokenize='trigram'
);
CREATE VIEW bookmarks_search_source AS
SELECT b.id,
    replace(replace(b.title, 'ё', 'е'), 'Ё', 'Е') AS title,
    replace(replace(b.url, 'ё', 'е'), 'Ё', 'Е') AS url,
    replace(replace(b.domain, 'ё', 'е'), 'Ё', 'Е') AS domain,
    replace(replace(COALESCE(b.description, ''), 'ё', 'е'), 'Ё', 'Е') AS description,
    replace(replace(COALESCE(b.notes, ''), 'ё', 'е'), 'Ё', 'Е') AS notes,
    replace(replace(COALESCE((SELECT group_concat(t.name, ' ') FROM bookmark_tags bt
        JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), ''), 'ё', 'е'), 'Ё', 'Е') AS tags
FROM bookmarks b;
CREATE TRIGGER bookmarks_search_insert AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_search_update
AFTER UPDATE OF title, url, domain, description, notes ON bookmarks BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_search_delete AFTER DELETE ON bookmarks BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.id;
END;
CREATE TRIGGER bookmarks_search_tag_link AFTER INSERT ON bookmark_tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid = new.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = new.bookmark_id;
END;
CREATE TRIGGER bookmarks_search_tag_unlink AFTER DELETE ON bookmark_tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid = old.bookmark_id;
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id = old.bookmark_id;
END;
CREATE TRIGGER bookmarks_search_tag_rename AFTER UPDATE OF name ON tags BEGIN
    DELETE FROM bookmarks_search WHERE rowid IN
        (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = new.id);
    INSERT INTO bookmarks_search (rowid, title, url, domain, description, notes, tags)
    SELECT * FROM bookmarks_search_source WHERE id IN
        (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = new.id);
END;
CREATE INDEX idx_bookmarks_trash ON bookmarks(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_bookmarks_url_key ON bookmarks(url_key) WHERE deleted_at IS NULL;
CREATE TABLE duplicates_dismissed (
    url_key TEXT NOT NULL,
    uid TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (url_key, uid)
) WITHOUT ROWID;
CREATE TABLE link_checks (
    bookmark_id INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','gone','moved','failed','local')),
    status INTEGER,
    reason TEXT,
    target TEXT
);
CREATE INDEX idx_link_checks_outcome ON link_checks(outcome) WHERE outcome IN ('gone','moved','failed');
CREATE INDEX idx_bookmarks_title ON bookmarks(title_key, created_at DESC, id DESC, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookmarks_site ON bookmarks(site_key, created_at DESC, id DESC, deleted_at) WHERE deleted_at IS NULL;
CREATE TRIGGER bookmarks_sort_insert AFTER INSERT ON bookmarks BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;
CREATE TRIGGER bookmarks_sort_update AFTER UPDATE OF title, domain ON bookmarks BEGIN
    UPDATE bookmarks SET title_key = np_sort_key(new.title), site_key = np_site_key(new.domain)
    WHERE id = new.id;
END;
CREATE INDEX idx_bookmarks_order ON bookmarks(created_at, id, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookmarks_inbox ON bookmarks(created_at, id, triaged_at, deleted_at, source)
    WHERE triaged_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_bookmarks_favorites ON bookmarks(created_at, id, is_favorite, deleted_at)
    WHERE is_favorite = 1 AND deleted_at IS NULL;
CREATE INDEX idx_bookmarks_collection ON bookmarks(collection_id, deleted_at, created_at, id);
CREATE INDEX idx_bookmarks_domain ON bookmarks(domain, deleted_at, created_at, id);
CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags(tag_id, bookmark_id);
