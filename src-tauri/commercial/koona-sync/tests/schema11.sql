-- The columns schema 11 of the app adds (`migrations::SCHEMA_11`); the app's test
-- `the_engine_tests_schema_11_as_the_app_makes_it` keeps this copy equal to it.
ALTER TABLE bookmarks ADD COLUMN reading_at TEXT;
ALTER TABLE bookmarks ADD COLUMN reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress BETWEEN 0 AND 1);
ALTER TABLE bookmarks ADD COLUMN read_at TEXT;
CREATE INDEX idx_bookmarks_reading ON bookmarks(reading_at, read_at, id, deleted_at)
    WHERE reading_at IS NOT NULL AND deleted_at IS NULL;
