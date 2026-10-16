-- The column schema 12 of the app adds (`migrations::SCHEMA_12`); the app's test
-- `the_engine_tests_schema_12_as_the_app_makes_it` keeps this copy equal to it.
ALTER TABLE bookmarks ADD COLUMN site_name TEXT;
