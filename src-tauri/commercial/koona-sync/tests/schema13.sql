-- The column schema 13 of the app adds (`migrations::SCHEMA_13`); the app's test
-- `the_engine_tests_schema_12_as_the_app_makes_it` keeps this copy equal to it.
ALTER TABLE bookmarks ADD COLUMN site_name TEXT;
