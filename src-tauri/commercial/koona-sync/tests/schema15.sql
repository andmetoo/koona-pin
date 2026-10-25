-- The column schema 15 of the app adds (`migrations::SCHEMA_15`); the app's test
-- `the_engine_tests_schemas_11_13_and_15_as_the_app_makes_them` (`migrations.rs`) keeps this copy equal to it.
ALTER TABLE collections ADD COLUMN parent_id INTEGER REFERENCES collections(id) ON DELETE SET NULL;
CREATE INDEX idx_collections_parent ON collections(parent_id);
