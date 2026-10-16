-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
--
-- Schema 12: the site's name (`site_name`) is synced like the picture and the icon. The app's
-- migration adds the column and then runs this text: the capture trigger of schema 11 gets the
-- field, place 16 of `BOOKMARK_FIELDS`.
DROP TRIGGER sync_bookmarks_update;
CREATE TRIGGER sync_bookmarks_update AFTER UPDATE OF url, title, description, image_url, favicon_url,
    notes, is_favorite, collection_id, triaged_at, deleted_at, source, source_name, created_at,
    reading_at, reading_progress, read_at, site_name ON bookmarks
WHEN np_sync_capture() AND (old.url IS NOT new.url OR old.title IS NOT new.title
    OR old.description IS NOT new.description OR old.image_url IS NOT new.image_url
    OR old.favicon_url IS NOT new.favicon_url OR old.notes IS NOT new.notes
    OR old.is_favorite IS NOT new.is_favorite OR old.collection_id IS NOT new.collection_id
    OR old.triaged_at IS NOT new.triaged_at OR old.deleted_at IS NOT new.deleted_at
    OR old.source IS NOT new.source OR old.source_name IS NOT new.source_name
    OR old.created_at IS NOT new.created_at OR old.reading_at IS NOT new.reading_at
    OR old.reading_progress IS NOT new.reading_progress OR old.read_at IS NOT new.read_at
    OR old.site_name IS NOT new.site_name) BEGIN
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
        UNION ALL SELECT 12 WHERE old.created_at IS NOT new.created_at
        UNION ALL SELECT 13 WHERE old.reading_at IS NOT new.reading_at
        UNION ALL SELECT 14 WHERE old.reading_progress IS NOT new.reading_progress
        UNION ALL SELECT 15 WHERE old.read_at IS NOT new.read_at
        UNION ALL SELECT 16 WHERE old.site_name IS NOT new.site_name)
    WHERE true
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
