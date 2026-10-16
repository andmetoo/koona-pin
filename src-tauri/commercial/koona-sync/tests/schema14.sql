-- The table schema 14 of the app makes (`migrations::SCHEMA_14`); the app's test
-- `the_engine_tests_schema_14_as_the_app_makes_it` (`sync_library.rs`) keeps this copy equal to it.
CREATE TABLE feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    destination TEXT NOT NULL DEFAULT 'feeds' CHECK (typeof(destination) = 'text'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
