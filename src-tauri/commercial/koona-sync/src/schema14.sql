-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
--
-- Schema 14 (NP-130): the feeds a person follows are synced as entity 4, fields `url`, `title`,
-- `destination` (`FEED_FIELDS`). The app's migration makes the `feeds` table and lets the
-- tombstones take kind `feed`, then runs this text. `created_at` and `updated_at` are local and
-- record nothing.
CREATE TRIGGER sync_feeds_insert AFTER INSERT ON feeds WHEN np_sync_capture() BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    VALUES (4, new.id, -1, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())))
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_feeds_update AFTER UPDATE OF url, title, destination ON feeds
WHEN np_sync_capture() AND (old.url IS NOT new.url OR old.title IS NOT new.title
    OR old.destination IS NOT new.destination) BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    SELECT 4, new.id, f, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))
    FROM (SELECT 0 AS f WHERE old.url IS NOT new.url
        UNION ALL SELECT 1 WHERE old.title IS NOT new.title
        UNION ALL SELECT 2 WHERE old.destination IS NOT new.destination)
    WHERE true
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
CREATE TRIGGER sync_feeds_delete AFTER DELETE ON feeds WHEN np_sync_capture() BEGIN
    INSERT INTO tombstones (uid, kind, deleted_at, purged_at, hlc, origin, counter, merged_into)
    VALUES (old.uid, 'feed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin())), NULL)
    ON CONFLICT (uid) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
        counter = excluded.counter, merged_into = NULL;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
-- The clocks of a feed go with it, also while remote changes are applied.
CREATE TRIGGER sync_feeds_forget AFTER DELETE ON feeds BEGIN
    DELETE FROM sync_clock WHERE entity = 4 AND row = old.id;
END;
