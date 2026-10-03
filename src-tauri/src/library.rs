//! Opening the library: checks before any write, migrations, and the
//! background integrity check with automatic copies (Р-3, Р-10, Р-11).
//!
//! Nothing here panics. A library that cannot be opened safely produces an
//! [`OpenFailure`] with a machine code, which the interface turns into a screen.

use crate::{backup, db, migrations};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use rusqlite_migration::Migrations;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Paths {
    pub database: PathBuf,
    pub backups: PathBuf,
}

impl Paths {
    pub fn new(database: PathBuf) -> Self {
        let backups = database
            .parent()
            .unwrap_or(Path::new("."))
            .join(backup::FOLDER);
        Paths { database, backups }
    }

    pub fn from_env() -> Self {
        Paths::new(db::db_path())
    }

    pub fn folder(&self) -> PathBuf {
        self.database
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenFailure {
    /// `DB_LOCKED`, `DB_NEWER_SCHEMA`, `DB_FOREIGN`, `DB_NOT_DATABASE`,
    /// `DB_CORRUPT`, `BACKUP_FAILED`, `MIGRATION_FAILED` or `DB_OPEN_FAILED`.
    pub code: &'static str,
    /// Technical reason for the report.
    pub detail: String,
    pub database: String,
    pub folder: String,
    /// Copy made before the failed migration.
    pub backup: Option<String>,
    /// Schema of a library made by a newer version.
    pub schema: Option<i64>,
    pub supported: i64,
    pub version: &'static str,
}

impl OpenFailure {
    fn new(code: &'static str, detail: impl Into<String>, paths: &Paths) -> Self {
        OpenFailure {
            code,
            detail: detail.into(),
            database: paths.database.to_string_lossy().into_owned(),
            folder: paths.folder().to_string_lossy().into_owned(),
            backup: None,
            schema: None,
            supported: migrations::SCHEMA_VERSION,
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    fn sqlite(error: rusqlite::Error, paths: &Paths) -> Self {
        let code = match error.sqlite_error_code() {
            Some(ErrorCode::NotADatabase) => "DB_NOT_DATABASE",
            Some(ErrorCode::DatabaseCorrupt) => "DB_CORRUPT",
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "DB_LOCKED",
            _ => "DB_OPEN_FAILED",
        };
        OpenFailure::new(code, error.to_string(), paths)
    }
}

pub struct Opened {
    pub conn: Connection,
    /// A library of the builds before schema 1, renamed and kept next to the
    /// new one (Р-11).
    pub moved_aside: Option<PathBuf>,
}

/// Opens the library for work or explains why it must not be opened.
pub fn open(paths: &Paths) -> Result<Opened, OpenFailure> {
    open_with(paths, &migrations::migrations(), migrations::SCHEMA_VERSION)
}

/// `migrations` must have exactly `target` steps; tests pass extra ones.
pub fn open_with(
    paths: &Paths,
    migrations: &Migrations,
    target: i64,
) -> Result<Opened, OpenFailure> {
    fs::create_dir_all(paths.folder())
        .map_err(|e| OpenFailure::new("DB_OPEN_FAILED", e.to_string(), paths))?;
    let moved_aside = match paths.database.exists() {
        true => match inspect(paths, target)? {
            Kind::Library => None,
            Kind::BeforeSchema1 => Some(move_aside(paths)?),
        },
        false => None,
    };
    let mut conn = Connection::open(&paths.database).map_err(|e| OpenFailure::sqlite(e, paths))?;
    configure(&conn).map_err(|e| OpenFailure::sqlite(e, paths))?;
    migrations::migrate_with(migrations, target, &mut conn, Some(&paths.backups)).map_err(
        |error| match error {
            migrations::MigrationError::Backup { error, .. } => {
                OpenFailure::new("BACKUP_FAILED", error, paths)
            }
            migrations::MigrationError::Failed {
                version,
                error,
                backup,
            } => OpenFailure {
                backup: backup.map(|p| p.to_string_lossy().into_owned()),
                ..OpenFailure::new(
                    "MIGRATION_FAILED",
                    format!("migration to {version}: {error}"),
                    paths,
                )
            },
        },
    )?;
    Ok(Opened { conn, moved_aside })
}

pub fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // FULL: a capture confirmed to the extension survives a power cut (Р-3).
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = FULL;",
    )
}

enum Kind {
    Library,
    /// Made by a build before NP-006: no application id, but the bookmarks table.
    BeforeSchema1,
}

/// Read-only look at an existing file before anything can write to it: a
/// foreign or newer library stays byte-for-byte as it was.
fn inspect(paths: &Paths, target: i64) -> Result<Kind, OpenFailure> {
    let fail = |e| OpenFailure::sqlite(e, paths);
    let conn = Connection::open_with_flags(
        &paths.database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(fail)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(fail)?;
    let application_id: i32 = conn
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(fail)?;
    let version = migrations::user_version(&conn).map_err(fail)?;
    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table'",
            [],
            |r| r.get(0),
        )
        .map_err(fail)?;
    let bookmarks = migrations::table_exists(&conn, "bookmarks").map_err(fail)?;

    match application_id {
        migrations::APPLICATION_ID => {}
        // An empty file, for example left by an interrupted first start.
        0 if tables == 0 && version == 0 => return Ok(Kind::Library),
        0 if bookmarks && version <= 1 => return Ok(Kind::BeforeSchema1),
        _ => {
            return Err(OpenFailure::new(
                "DB_FOREIGN",
                format!("application_id {application_id:#x}, user_version {version}"),
                paths,
            ))
        }
    }
    if version > target {
        return Err(OpenFailure {
            schema: Some(version),
            ..OpenFailure::new(
                "DB_NEWER_SCHEMA",
                format!("schema {version}, supported {target}"),
                paths,
            )
        });
    }
    // A damaged library is never migrated: a migration could spread the damage.
    if version < target {
        if let Some(problem) = quick_check(&conn).map_err(fail)? {
            return Err(OpenFailure::new("DB_CORRUPT", problem, paths));
        }
    }
    Ok(Kind::Library)
}

/// Renames the old file with its WAL, so it still opens as it was.
fn move_aside(paths: &Paths) -> Result<PathBuf, OpenFailure> {
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let target = paths
        .database
        .with_file_name(format!("netamipin.old-{stamp}.db"));
    for suffix in ["-wal", "-shm", ""] {
        let from = PathBuf::from(format!("{}{suffix}", paths.database.display()));
        if from.exists() {
            fs::rename(&from, format!("{}{suffix}", target.display()))
                .map_err(|e| OpenFailure::new("DB_OPEN_FAILED", e.to_string(), paths))?;
        }
    }
    eprintln!(
        "A library of an earlier build was moved to {}",
        target.display()
    );
    Ok(target)
}

/// `None` when the file is intact, otherwise the first problems found.
pub fn quick_check(conn: &Connection) -> rusqlite::Result<Option<String>> {
    let result = conn
        .prepare("PRAGMA quick_check(5)")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>();
    match result {
        Ok(lines) if lines == ["ok"] => Ok(None),
        Ok(lines) => Ok(Some(lines.join("; "))),
        Err(e) if e.sqlite_error_code() == Some(ErrorCode::DatabaseCorrupt) => {
            Ok(Some(e.to_string()))
        }
        Err(e) => Err(e),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Health {
    Intact { copied: Option<PathBuf> },
    Damaged(String),
}

/// Background work on a separate read-only connection, so the window and
/// captures are not held up: the integrity check, then a copy when one is due.
/// A damaged library gets no copy and does not push good copies out.
pub fn maintain(paths: &Paths, now: DateTime<Utc>, check: bool) -> Result<Health, String> {
    let due = backup::auto_due(&paths.backups, now);
    if !check && !due {
        return Ok(Health::Intact { copied: None });
    }
    let conn = Connection::open_with_flags(
        &paths.database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;
    if let Some(problem) = quick_check(&conn).map_err(|e| e.to_string())? {
        return Ok(Health::Damaged(problem));
    }
    let copied = if due {
        Some(backup::create_auto(&conn, &paths.backups, now)?)
    } else {
        None
    };
    Ok(Health::Intact { copied })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_libraries as fixtures;
    use rusqlite_migration::M;

    fn library(name: &str) -> Paths {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        Paths::new(folder.join("netamipin.db"))
    }

    fn build(paths: &Paths, rows: usize) {
        let conn = fixtures::fresh(&paths.database);
        if rows > 0 {
            fixtures::generated(&conn, rows, 3);
        } else {
            fixtures::sample_rows(&conn);
        }
        fixtures::finish(conn);
    }

    /// Schema 1 plus one more step, to open a library that needs a migration.
    fn next_schema() -> Migrations<'static> {
        Migrations::new(vec![
            migrations::steps().remove(0),
            M::up("CREATE TABLE notes (text TEXT);"),
        ])
    }

    /// The refusal must not touch the library: same bytes, no copies.
    fn refused(paths: &Paths, result: Result<Opened, OpenFailure>) -> OpenFailure {
        let failure = result.err().expect("the library must not open");
        assert!(
            !paths.backups.exists(),
            "{}: copies were made",
            failure.code
        );
        failure
    }

    fn unchanged(paths: &Paths, open: impl FnOnce() -> Result<Opened, OpenFailure>) -> OpenFailure {
        let before = fs::read(&paths.database).unwrap();
        let failure = refused(paths, open());
        assert_eq!(
            fs::read(&paths.database).unwrap(),
            before,
            "{}: file changed",
            failure.code
        );
        failure
    }

    #[test]
    fn library_of_a_newer_version_is_refused_unchanged() {
        let paths = library("open-newer");
        build(&paths, 0);
        Connection::open(&paths.database)
            .unwrap()
            .pragma_update(None, "user_version", 2)
            .unwrap();
        let failure = unchanged(&paths, || open(&paths));
        assert_eq!(failure.code, "DB_NEWER_SCHEMA");
        assert_eq!(failure.schema, Some(2));
        assert_eq!(failure.supported, migrations::SCHEMA_VERSION);
    }

    #[test]
    fn foreign_and_unreadable_files_are_refused_unchanged() {
        let paths = library("open-foreign");
        Connection::open(&paths.database)
            .unwrap()
            .execute_batch("PRAGMA application_id = 305419896; CREATE TABLE bookmarks (url TEXT);")
            .unwrap();
        assert_eq!(unchanged(&paths, || open(&paths)).code, "DB_FOREIGN");

        let paths = library("open-unmarked");
        Connection::open(&paths.database)
            .unwrap()
            .execute_batch("CREATE TABLE notes (text TEXT);")
            .unwrap();
        assert_eq!(unchanged(&paths, || open(&paths)).code, "DB_FOREIGN");

        let paths = library("open-text");
        fs::write(&paths.database, b"This is not an SQLite file.\n").unwrap();
        assert_eq!(unchanged(&paths, || open(&paths)).code, "DB_NOT_DATABASE");
    }

    #[test]
    fn library_of_earlier_builds_is_moved_aside_intact() {
        let paths = library("open-before-schema-1");
        fixtures::before_schema_1(&paths.database);
        let original = fs::read(&paths.database).unwrap();
        let opened = open(&paths).unwrap();
        let old = opened.moved_aside.clone().expect("the old library is kept");
        assert_eq!(
            fs::read(&old).unwrap(),
            original,
            "the old file is not changed"
        );
        let count: i64 = Connection::open(&old)
            .unwrap()
            .query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(db::get_counts(&opened.conn).unwrap().total, 0);
        assert_eq!(migrations::user_version(&opened.conn).unwrap(), 1);
        // The next start opens the new library and moves nothing.
        drop(opened);
        assert!(open(&paths).unwrap().moved_aside.is_none());
    }

    #[test]
    fn damaged_library_is_not_migrated() {
        let paths = library("open-damaged");
        build(&paths, 3_000);
        fixtures::damage(&paths.database);
        let failure = unchanged(&paths, || open_with(&paths, &next_schema(), 2));
        assert_eq!(failure.code, "DB_CORRUPT", "{}", failure.detail);
    }

    #[test]
    fn failed_copy_before_migration_leaves_the_library() {
        let mut paths = library("open-backup-fails");
        build(&paths, 0);
        // A file where the backups folder should be: the copy cannot be written.
        paths.backups = paths.folder().join("backups-blocked");
        fs::write(&paths.backups, b"").unwrap();
        let failure = open_with(&paths, &next_schema(), 2)
            .err()
            .expect("no migration without a copy");
        assert_eq!(failure.code, "BACKUP_FAILED");
        let conn = Connection::open(&paths.database).unwrap();
        assert_eq!(migrations::user_version(&conn).unwrap(), 1);
    }

    #[test]
    fn failed_migration_reports_the_copy() {
        let paths = library("open-migration-fails");
        build(&paths, 0);
        let broken = Migrations::new(vec![
            migrations::steps().remove(0),
            M::up("INSERT INTO bookmarks (url) VALUES ('https://example.com/no-title');"),
        ]);
        let failure = open_with(&paths, &broken, 2).err().unwrap();
        assert_eq!(failure.code, "MIGRATION_FAILED");
        assert!(Path::new(failure.backup.as_deref().unwrap()).exists());
        let conn = Connection::open(&paths.database).unwrap();
        assert_eq!(migrations::user_version(&conn).unwrap(), 1);
    }

    #[test]
    fn background_check_copies_an_intact_library_once_a_day() {
        let paths = library("maintain-intact");
        drop(open(&paths).unwrap());
        let now = Utc::now();
        let Health::Intact { copied: Some(copy) } = maintain(&paths, now, true).unwrap() else {
            panic!("expected a copy");
        };
        let conn = Connection::open(&copy).unwrap();
        assert_eq!(
            migrations::user_version(&conn).unwrap(),
            migrations::SCHEMA_VERSION
        );
        assert_eq!(quick_check(&conn).unwrap(), None);
        assert_eq!(
            maintain(&paths, now + chrono::Duration::hours(1), false).unwrap(),
            Health::Intact { copied: None }
        );
    }

    #[test]
    fn background_check_finds_damage_and_keeps_good_copies() {
        let paths = library("maintain-damaged");
        build(&paths, 3_000);
        let now = Utc::now();
        assert!(matches!(
            maintain(&paths, now, true).unwrap(),
            Health::Intact { copied: Some(_) }
        ));
        let copies = || fs::read_dir(&paths.backups).unwrap().count();
        assert_eq!(copies(), 1);
        fixtures::damage(&paths.database);
        let later = now + chrono::Duration::days(2);
        assert!(matches!(
            maintain(&paths, later, true).unwrap(),
            Health::Damaged(_)
        ));
        assert_eq!(
            copies(),
            1,
            "a damaged library must not be copied over good copies"
        );
    }
}
