-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
--
-- Schema 15 (2.19.0): nested collections. A collection's parent (`parent_id`, the parent's uid on
-- the wire) is synced as field `parent`, place 4 of `COLLECTION_FIELDS`. The app's migration adds
-- the column and then runs this text; it may drop the old trigger first, to write the collections
-- without recording.
DROP TRIGGER IF EXISTS sync_collections_update;
CREATE TRIGGER sync_collections_update AFTER UPDATE OF name, color, icon, position_key, parent_id ON collections
WHEN np_sync_capture() AND (old.name IS NOT new.name OR old.color IS NOT new.color
    OR old.icon IS NOT new.icon OR old.position_key IS NOT new.position_key
    OR old.parent_id IS NOT new.parent_id) BEGIN
    INSERT INTO sync_clock (entity, row, field, hlc, origin, counter)
    SELECT 0, new.id, f, np_hlc((SELECT value FROM sync_meta WHERE key = 'hlc')), np_sync_origin(),
        np_sync_counter((SELECT counter FROM sync_vector WHERE origin = np_sync_origin()))
    FROM (SELECT 0 AS f WHERE old.name IS NOT new.name
        UNION ALL SELECT 1 WHERE old.color IS NOT new.color
        UNION ALL SELECT 2 WHERE old.icon IS NOT new.icon
        UNION ALL SELECT 3 WHERE old.position_key IS NOT new.position_key
        UNION ALL SELECT 4 WHERE old.parent_id IS NOT new.parent_id)
    WHERE true
    ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter;
    UPDATE sync_vector SET counter = np_sync_counter_last() WHERE origin = np_sync_origin();
    UPDATE sync_meta SET value = np_hlc_last() WHERE key = 'hlc';
END;
