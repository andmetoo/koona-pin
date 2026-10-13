-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
--
-- Schema 10 (Р-68): what the sync engine keeps in a library. The app's migration takes this text
-- as it is. Every trigger here calls the engine's SQL functions (`capture.rs`), so they must be
-- registered on every connection that writes, sync on or off; with sync off they only answer
-- that nothing is recorded.
--
-- `sync_clock` holds the last clock of each field, not the values: a delta reads the values from
-- the tables themselves. `entity` is 0 collections, 1 tags, 2 bookmarks, 3 a bookmark's tag;
-- `row` is the local id (for a tag of a bookmark: the bookmark's); `field` is the field's place
-- in the entity's list on the wire (for a tag of a bookmark: the tag's id). Field -1 is the
-- clock of the whole record as it was created: every field without its own row has it, so a new
-- or untouched record costs one row, not one per field.
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value NOT NULL) WITHOUT ROWID;
CREATE TABLE sync_origins (id INTEGER PRIMARY KEY, origin TEXT NOT NULL UNIQUE);
CREATE TABLE sync_vector (origin INTEGER PRIMARY KEY, counter INTEGER NOT NULL);
CREATE TABLE sync_clock (
    entity INTEGER NOT NULL,
    row INTEGER NOT NULL,
    field INTEGER NOT NULL,
    hlc INTEGER NOT NULL,
    origin INTEGER NOT NULL,
    counter INTEGER NOT NULL,
    PRIMARY KEY (entity, row, field)
) WITHOUT ROWID;
CREATE INDEX sync_clock_change ON sync_clock(origin, counter);

-- A tombstone with a clock is a change like any other; `merged_into` is the record that took
-- this one's place (same address or name), none for a purge. Tombstones made before sync have
-- no clock until `baseline`.
ALTER TABLE tombstones ADD COLUMN hlc INTEGER;
ALTER TABLE tombstones ADD COLUMN origin INTEGER;
ALTER TABLE tombstones ADD COLUMN counter INTEGER;
ALTER TABLE tombstones ADD COLUMN merged_into TEXT;
CREATE INDEX tombstones_change ON tombstones(origin, counter) WHERE origin IS NOT NULL;

-- The sidebar's order as a fractional key: moving one collection writes only its own key, so
-- two devices that move different collections both keep their move.
ALTER TABLE collections ADD COLUMN position_key TEXT;

-- Capture. Each trigger stamps the fields that changed with a new clock of this replica, then
-- keeps the replica's counter and clock in the library, so a counter is never given twice, even
-- by another connection or after a restart.
CREATE TRIGGER sync_collections_insert AFTER INSERT ON collections WHEN np_sync_capture() BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (0, new.id, -1, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_collections_update AFTER UPDATE OF name, color, icon, position_key ON collections
WHEN np_sync_capture() AND (old.name IS NOT new.name OR old.color IS NOT new.color
    OR old.icon IS NOT new.icon OR old.position_key IS NOT new.position_key) BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    SELECT 0, new.id, f, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))
    FROM (SELECT 0 AS f WHERE old.name IS NOT new.name
        UNION ALL SELECT 1 WHERE old.color IS NOT new.color
        UNION ALL SELECT 2 WHERE old.icon IS NOT new.icon
        UNION ALL SELECT 3 WHERE old.position_key IS NOT new.position_key)
    WHERE true
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_collections_delete AFTER DELETE ON collections WHEN np_sync_capture() BEGIN
    INSERT INTO tombstones (uid, kind, deleted_at, purged_at, hlc, origin, counter, merged_into)
    VALUES (old.uid, 'collection', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())), NULL)
    ON CONFLICT (uid) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
        counter = excluded.counter, merged_into = NULL;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;

CREATE TRIGGER sync_tags_insert AFTER INSERT ON tags WHEN np_sync_capture() BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (1, new.id, -1, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_tags_update AFTER UPDATE OF name ON tags
WHEN np_sync_capture() AND old.name IS NOT new.name BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (1, new.id, 0, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_tags_delete AFTER DELETE ON tags WHEN np_sync_capture() BEGIN
    INSERT INTO tombstones (uid, kind, deleted_at, purged_at, hlc, origin, counter, merged_into)
    VALUES (old.uid, 'tag', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())), NULL)
    ON CONFLICT (uid) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
        counter = excluded.counter, merged_into = NULL;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;

-- Derived and local columns (`domain`, `url_key`, the sort keys, `revision`, `updated_at`) are
-- not listed: writing them records nothing.
CREATE TRIGGER sync_bookmarks_insert AFTER INSERT ON bookmarks WHEN np_sync_capture() BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (2, new.id, -1, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_bookmarks_update AFTER UPDATE OF url, title, description, image_url, favicon_url,
    notes, is_favorite, collection_id, triaged_at, deleted_at, source, source_name, created_at ON bookmarks
WHEN np_sync_capture() AND (old.url IS NOT new.url OR old.title IS NOT new.title
    OR old.description IS NOT new.description OR old.image_url IS NOT new.image_url
    OR old.favicon_url IS NOT new.favicon_url OR old.notes IS NOT new.notes
    OR old.is_favorite IS NOT new.is_favorite OR old.collection_id IS NOT new.collection_id
    OR old.triaged_at IS NOT new.triaged_at OR old.deleted_at IS NOT new.deleted_at
    OR old.source IS NOT new.source OR old.source_name IS NOT new.source_name
    OR old.created_at IS NOT new.created_at) BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    SELECT 2, new.id, f, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))
    FROM (SELECT 0 AS f WHERE old.url IS NOT new.url
        UNION ALL SELECT 1 WHERE old.title IS NOT new.title
        UNION ALL SELECT 2 WHERE old.description IS NOT new.description
        UNION ALL SELECT 3 WHERE old.image_url IS NOT new.image_url
        UNION ALL SELECT 4 WHERE old.favicon_url IS NOT new.favicon_url
        UNION ALL SELECT 5 WHERE old.notes IS NOT new.notes
        UNION ALL SELECT 6 WHERE old.is_favorite IS NOT new.is_favorite
        UNION ALL SELECT 7 WHERE old.collection_id IS NOT new.collection_id
        UNION ALL SELECT 8 WHERE old.triaged_at IS NOT new.triaged_at
        UNION ALL SELECT 9 WHERE old.deleted_at IS NOT new.deleted_at
        UNION ALL SELECT 10 WHERE old.source IS NOT new.source
        UNION ALL SELECT 11 WHERE old.source_name IS NOT new.source_name
        UNION ALL SELECT 12 WHERE old.created_at IS NOT new.created_at)
    WHERE true
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_bookmarks_delete AFTER DELETE ON bookmarks WHEN np_sync_capture() BEGIN
    INSERT INTO tombstones (uid, kind, deleted_at, purged_at, hlc, origin, counter, merged_into)
    VALUES (old.uid, 'bookmark', COALESCE(old.deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())), NULL)
    ON CONFLICT (uid) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
        counter = excluded.counter, merged_into = NULL;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;

-- A tag of a bookmark: the clock says when the pair was last added or taken off. Links that go
-- with their bookmark or tag record nothing: the tombstone says it all.
CREATE TRIGGER sync_links_insert AFTER INSERT ON bookmark_tags WHEN np_sync_capture() BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (3, new.bookmark_id, new.tag_id, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')),
        np_sync_origin(), np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_links_delete AFTER DELETE ON bookmark_tags
WHEN np_sync_capture() AND EXISTS (SELECT 1 FROM bookmarks WHERE id = old.bookmark_id)
    AND EXISTS (SELECT 1 FROM tags WHERE id = old.tag_id) BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (3, old.bookmark_id, old.tag_id, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')),
        np_sync_origin(), np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;

-- The clocks of a record go with it, also while remote changes are applied.
CREATE TRIGGER sync_collections_forget AFTER DELETE ON collections BEGIN
    DELETE FROM sync_clock WHERE entity = 0 AND row = old.id;
END;
CREATE TRIGGER sync_tags_forget AFTER DELETE ON tags BEGIN
    DELETE FROM sync_clock WHERE entity = 1 AND row = old.id;
    DELETE FROM sync_clock WHERE entity = 3 AND field = old.id;
END;
CREATE TRIGGER sync_bookmarks_forget AFTER DELETE ON bookmarks BEGIN
    DELETE FROM sync_clock WHERE entity IN (2, 3) AND row = old.id;
END;
