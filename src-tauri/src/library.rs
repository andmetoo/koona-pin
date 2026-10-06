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
use ts_rs::TS;

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

/// Why the library was not opened; the interface has a text for each code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum OpenCode {
    DbLocked,
    DbNewerSchema,
    DbForeign,
    DbNotDatabase,
    DbCorrupt,
    BackupFailed,
    MigrationFailed,
    DbOpenFailed,
}

impl std::fmt::Display for OpenCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = serde_json::to_value(self).map_err(|_| std::fmt::Error)?;
        f.write_str(name.as_str().unwrap_or_default())
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OpenFailure {
    pub code: OpenCode,
    /// Technical reason for the report.
    pub detail: String,
    pub database: String,
    pub folder: String,
    /// Copy made before the failed migration.
    pub backup: Option<String>,
    /// Schema of a library made by a newer version.
    pub schema: Option<i64>,
    pub supported: i64,
    pub version: String,
}

impl OpenFailure {
    fn new(code: OpenCode, detail: impl Into<String>, paths: &Paths) -> Self {
        OpenFailure {
            code,
            detail: detail.into(),
            database: paths.database.to_string_lossy().into_owned(),
            folder: paths.folder().to_string_lossy().into_owned(),
            backup: None,
            schema: None,
            supported: migrations::SCHEMA_VERSION,
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }

    fn sqlite(error: rusqlite::Error, paths: &Paths) -> Self {
        let code = match error.sqlite_error_code() {
            Some(ErrorCode::NotADatabase) => OpenCode::DbNotDatabase,
            Some(ErrorCode::DatabaseCorrupt) => OpenCode::DbCorrupt,
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => OpenCode::DbLocked,
            _ => OpenCode::DbOpenFailed,
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
        .map_err(|e| OpenFailure::new(OpenCode::DbOpenFailed, e.to_string(), paths))?;
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
                OpenFailure::new(OpenCode::BackupFailed, error, paths)
            }
            migrations::MigrationError::Failed {
                version,
                error,
                backup,
            } => OpenFailure {
                backup: backup.map(|p| p.to_string_lossy().into_owned()),
                ..OpenFailure::new(
                    OpenCode::MigrationFailed,
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
    db::register_functions(conn)?;
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
                OpenCode::DbForeign,
                format!("application_id {application_id:#x}, user_version {version}"),
                paths,
            ))
        }
    }
    if version > target {
        return Err(OpenFailure {
            schema: Some(version),
            ..OpenFailure::new(
                OpenCode::DbNewerSchema,
                format!("schema {version}, supported {target}"),
                paths,
            )
        });
    }
    // A damaged library is never migrated: a migration could spread the damage.
    if version < target {
        if let Some(problem) = quick_check(&conn).map_err(fail)? {
            return Err(OpenFailure::new(OpenCode::DbCorrupt, problem, paths));
        }
    }
    Ok(Kind::Library)
}

/// Renames the old file with its WAL, so it still opens as it was.
fn move_aside(paths: &Paths) -> Result<PathBuf, OpenFailure> {
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let target = paths
        .database
        .with_file_name(format!("koonapin.old-{stamp}.db"));
    for suffix in ["-wal", "-shm", ""] {
        let from = PathBuf::from(format!("{}{suffix}", paths.database.display()));
        if from.exists() {
            fs::rename(&from, format!("{}{suffix}", target.display()))
                .map_err(|e| OpenFailure::new(OpenCode::DbOpenFailed, e.to_string(), paths))?;
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
    let conn = match checked_connection(paths)? {
        Ok(conn) => conn,
        Err(problem) => return Ok(Health::Damaged(problem)),
    };
    let copied = if due {
        Some(backup::create_auto(&conn, &paths.backups, now)?)
    } else {
        None
    };
    Ok(Health::Intact { copied })
}

/// «Back up now» in the settings: the same check and copy as the daily one.
pub fn back_up_now(paths: &Paths, now: DateTime<Utc>) -> Result<PathBuf, String> {
    let conn = checked_connection(paths)?
        .map_err(|problem| format!("the library is damaged, no copy was made: {problem}"))?;
    backup::create_auto(&conn, &paths.backups, now)
}

/// «Save a copy…»: the same check and copy as «Back up now», to a file the
/// user chose.
pub fn save_copy(paths: &Paths, target: &Path) -> Result<(), String> {
    let conn = checked_connection(paths)?
        .map_err(|problem| format!("the library is damaged, no copy was made: {problem}"))?;
    backup::write_copy(&conn, target)
}

/// Why a copy cannot be restored (sheet 33); nothing was changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "problem", rename_all = "snake_case")]
#[ts(export)]
pub enum CopyProblem {
    NotDatabase,
    /// Another program's file, or a library of the builds before schema 1.
    NotOurs,
    Newer { schema: i64, supported: i64 },
    Damaged { detail: String },
    Unreadable { detail: String },
}

fn copy_problem(error: rusqlite::Error) -> CopyProblem {
    match error.sqlite_error_code() {
        Some(ErrorCode::NotADatabase) => CopyProblem::NotDatabase,
        Some(ErrorCode::DatabaseCorrupt) => CopyProblem::Damaged {
            detail: error.to_string(),
        },
        _ => CopyProblem::Unreadable {
            detail: error.to_string(),
        },
    }
}

/// Reads a copy without changing it: ours, not newer than this build, intact.
/// Returns its bookmarks outside the trash.
pub fn check_copy(path: &Path) -> Result<u32, CopyProblem> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(copy_problem)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(copy_problem)?;
    let application_id: i32 = conn
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(copy_problem)?;
    if application_id != migrations::APPLICATION_ID {
        return Err(CopyProblem::NotOurs);
    }
    let schema = migrations::user_version(&conn).map_err(copy_problem)?;
    if schema > migrations::SCHEMA_VERSION {
        return Err(CopyProblem::Newer {
            schema,
            supported: migrations::SCHEMA_VERSION,
        });
    }
    if let Some(detail) = quick_check(&conn).map_err(copy_problem)? {
        return Err(CopyProblem::Damaged { detail });
    }
    conn.query_row(
        "SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )
    .map_err(copy_problem)
}

#[derive(Debug)]
pub struct Restored {
    /// Bookmarks of the copy outside the trash.
    pub bookmarks: u32,
    /// The library as it was before the restore.
    pub previous: PathBuf,
}

#[derive(Debug)]
pub enum RestoreFailure {
    Rejected(CopyProblem),
    /// The current library could not be saved first: nothing was changed.
    Backup(String),
    /// Nothing was changed either.
    Failed(String),
}

/// The copy brought to the current schema in a working folder next to the
/// copies: the chosen file is never written to, and migrations run on the
/// working file, not on the library.
fn prepare(source: &Path, backups: &Path) -> Result<PathBuf, String> {
    let work = backups.join("restoring");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let database = work.join("koonapin.db");
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    backup::write_copy(&source, &database)?;
    drop(source);
    let opened = open(&Paths {
        database: database.clone(),
        backups: work.join(backup::FOLDER),
    })
    .map_err(|failure| format!("{}: {}", failure.code, failure.detail))?;
    drop_local_pictures(&opened.conn).map_err(|e| e.to_string())?;
    // Without a WAL the file holds everything the backup API reads.
    opened
        .conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    Ok(database)
}

/// The WebView loads pictures itself (NP-019): a copy from elsewhere must not
/// point it at the user's computer or network. Only the picture goes.
fn drop_local_pictures(conn: &Connection) -> rusqlite::Result<()> {
    for column in ["image_url", "favicon_url"] {
        let local: Vec<i64> = conn
            .prepare(&format!("SELECT id, {column} FROM bookmarks WHERE {column} IS NOT NULL"))?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|row| row.map(|(id, url)| (!crate::net_guard::public_url(&url)).then_some(id)).transpose())
            .collect::<rusqlite::Result<_>>()?;
        let mut clear = conn.prepare(&format!("UPDATE bookmarks SET {column} = NULL WHERE id = ?1"))?;
        for id in local {
            clear.execute([id])?;
        }
    }
    Ok(())
}

fn discard(prepared: &Path) {
    if let Some(work) = prepared.parent() {
        let _ = fs::remove_dir_all(work);
    }
}

/// The library as it is, before it is replaced: a consistent copy, or the
/// files as they are when a damaged library cannot be copied.
fn save_current(conn: &Connection, paths: &Paths) -> Result<PathBuf, String> {
    let target = backup::before_restore_path(&paths.backups);
    if let Err(error) = backup::write_copy(conn, &target) {
        fs::copy(&paths.database, &target).map_err(|e| format!("{error}; {e}"))?;
        let wal = PathBuf::from(format!("{}-wal", paths.database.display()));
        if wal.exists() {
            fs::copy(&wal, format!("{}-wal", target.display())).map_err(|e| e.to_string())?;
        }
    }
    backup::prune_before_restore(&paths.backups);
    Ok(target)
}

/// Every page of the library replaced by the prepared copy in one write
/// transaction of the backup API: on failure the library stays as it was.
fn replace_pages(conn: &mut Connection, prepared: &Path) -> rusqlite::Result<()> {
    use rusqlite::backup::{Backup, StepResult};
    let source = Connection::open_with_flags(
        prepared,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let copy = Backup::new(&source, conn)?;
    for _ in 0..100 {
        match copy.step(-1)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            // A reader of the maintenance thread; it lets go within moments.
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    Err(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
        Some("the library stayed busy".into()),
    ))
}

/// Restores a copy into the open library in place (sheet 33): the
/// connection, the capture channel and the window stay. The caller holds
/// the library lock and clears what refers to the old contents.
pub fn restore_into(
    conn: &mut Connection,
    paths: &Paths,
    source: &Path,
) -> Result<Restored, RestoreFailure> {
    let bookmarks = check_copy(source).map_err(RestoreFailure::Rejected)?;
    let prepared = prepare(source, &paths.backups).map_err(RestoreFailure::Failed)?;
    let result = (|| {
        let previous = save_current(conn, paths).map_err(RestoreFailure::Backup)?;
        // A damaged library is read-only; the restored one is not.
        let read_only: bool = conn
            .pragma_query_value(None, "query_only", |r| r.get(0))
            .unwrap_or(false);
        let replaced = conn
            .pragma_update(None, "query_only", false)
            .and_then(|_| replace_pages(conn, &prepared));
        if let Err(error) = replaced {
            let _ = conn.pragma_update(None, "query_only", read_only);
            return Err(RestoreFailure::Failed(error.to_string()));
        }
        Ok(Restored { bookmarks, previous })
    })();
    discard(&prepared);
    result
}

/// Moves the library with its WAL; the shared-memory file is only a cache.
fn move_files(from: &Path, to: &Path) -> std::io::Result<()> {
    let moved = from.exists();
    if moved {
        fs::rename(from, to)?;
    }
    let wal = PathBuf::from(format!("{}-wal", from.display()));
    if wal.exists() {
        if let Err(error) = fs::rename(&wal, format!("{}-wal", to.display())) {
            // Without its WAL the file is not the library: put it back.
            if moved {
                let _ = fs::rename(to, from);
            }
            return Err(error);
        }
    }
    let _ = fs::remove_file(format!("{}-shm", from.display()));
    Ok(())
}

/// The same for a library that did not open (frame 12): its files go to the
/// backups folder as they are and the prepared copy takes their place. The
/// caller opens the library again.
pub fn restore_closed(paths: &Paths, source: &Path) -> Result<Restored, RestoreFailure> {
    let bookmarks = check_copy(source).map_err(RestoreFailure::Rejected)?;
    let prepared = prepare(source, &paths.backups).map_err(RestoreFailure::Failed)?;
    let result = (|| {
        let previous = backup::before_restore_path(&paths.backups);
        move_files(&paths.database, &previous).map_err(|e| RestoreFailure::Backup(e.to_string()))?;
        if let Err(error) = fs::rename(&prepared, &paths.database) {
            let _ = move_files(&previous, &paths.database);
            return Err(RestoreFailure::Failed(error.to_string()));
        }
        backup::prune_before_restore(&paths.backups);
        Ok(Restored { bookmarks, previous })
    })();
    discard(&prepared);
    result
}

/// A separate read-only connection that passed the integrity check, or the
/// problem the check found.
fn checked_connection(paths: &Paths) -> Result<Result<Connection, String>, String> {
    let conn = Connection::open_with_flags(
        &paths.database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;
    Ok(match quick_check(&conn).map_err(|e| e.to_string())? {
        Some(problem) => Err(problem),
        None => Ok(conn),
    })
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
        Paths::new(folder.join("koonapin.db"))
    }

    fn build(paths: &Paths, rows: usize) {
        let conn = fixtures::fresh_at(&paths.database, 1);
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
            .pragma_update(None, "user_version", migrations::SCHEMA_VERSION + 1)
            .unwrap();
        let failure = unchanged(&paths, || open(&paths));
        assert_eq!(failure.code, OpenCode::DbNewerSchema);
        assert_eq!(failure.schema, Some(migrations::SCHEMA_VERSION + 1));
        assert_eq!(failure.supported, migrations::SCHEMA_VERSION);
    }

    #[test]
    fn foreign_and_unreadable_files_are_refused_unchanged() {
        let paths = library("open-foreign");
        Connection::open(&paths.database)
            .unwrap()
            .execute_batch("PRAGMA application_id = 305419896; CREATE TABLE bookmarks (url TEXT);")
            .unwrap();
        assert_eq!(unchanged(&paths, || open(&paths)).code, OpenCode::DbForeign);

        let paths = library("open-unmarked");
        Connection::open(&paths.database)
            .unwrap()
            .execute_batch("CREATE TABLE notes (text TEXT);")
            .unwrap();
        assert_eq!(unchanged(&paths, || open(&paths)).code, OpenCode::DbForeign);

        let paths = library("open-text");
        fs::write(&paths.database, b"This is not an SQLite file.\n").unwrap();
        assert_eq!(
            unchanged(&paths, || open(&paths)).code,
            OpenCode::DbNotDatabase
        );
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
        assert_eq!(
            migrations::user_version(&opened.conn).unwrap(),
            migrations::SCHEMA_VERSION
        );
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
        assert_eq!(failure.code, OpenCode::DbCorrupt, "{}", failure.detail);
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
        assert_eq!(failure.code, OpenCode::BackupFailed);
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
        assert_eq!(failure.code, OpenCode::MigrationFailed);
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

    fn bookmarks(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn capture(conn: &Connection, url: &str, request: &str) -> crate::capture::CaptureResult {
        crate::capture::save(
            conn,
            &crate::capture::CaptureRequest {
                request_id: Some(request.into()),
                url: url.into(),
                title: Some("Captured".into()),
                collection_id: None,
                tags: None,
            },
            db::Source::Chrome,
        )
        .unwrap()
    }

    fn before_restore_copies(paths: &Paths) -> Vec<PathBuf> {
        fs::read_dir(&paths.backups)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        let name = p.file_name().unwrap().to_string_lossy();
                        name.starts_with("koonapin.before-restore-") && name.ends_with(".db")
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn restore_replaces_an_open_wal_library_in_place() {
        let paths = library("restore-open");
        build(&paths, 200);
        let mut conn = open(&paths).unwrap().conn;
        let copy = back_up_now(&paths, Utc::now()).unwrap();
        let in_copy = bookmarks(&conn);
        // Changes after the copy stay in the WAL of the open library.
        capture(&conn, "https://example.com/after-the-copy", "after");
        conn.execute("UPDATE bookmarks SET deleted_at = '2026-10-04T10:00:00.000Z' WHERE id = 1", [])
            .unwrap();
        assert!(Path::new(&format!("{}-wal", paths.database.display())).exists());

        let restored = restore_into(&mut conn, &paths, &copy).unwrap();
        assert_eq!(restored.bookmarks as i64, in_copy);
        assert_eq!(bookmarks(&conn), in_copy, "the open connection sees the copy");
        assert_eq!(quick_check(&conn).unwrap(), None);
        let after: i64 = conn
            .query_row("SELECT count(*) FROM bookmarks WHERE url = 'https://example.com/after-the-copy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 0, "changes after the copy are gone");
        // The replaced library is kept, with the change made after the copy.
        let previous = Connection::open(&restored.previous).unwrap();
        assert_eq!(bookmarks(&previous), in_copy, "one added, one trashed");
        assert_eq!(before_restore_copies(&paths), vec![restored.previous.clone()]);
        assert!(!paths.backups.join("restoring").exists(), "the working copy is removed");

        // Capture from the extension works on the same connection, and a
        // retried request after the copy saves the link again.
        let again = capture(&conn, "https://example.com/after-the-copy", "after");
        assert!(again.newly_created);
        // The search index came with the copy and still answers.
        conn.query_row(
            "SELECT count(*) FROM bookmarks_search WHERE bookmarks_search MATCH 'captured'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
        drop(conn);
        // The next start opens the restored library as it is.
        let reopened = open(&paths).unwrap().conn;
        assert_eq!(bookmarks(&reopened), in_copy + 1);
    }

    #[test]
    fn restore_makes_a_read_only_damaged_library_writable() {
        let paths = library("restore-damaged");
        build(&paths, 0);
        let mut conn = open(&paths).unwrap().conn;
        let copy = back_up_now(&paths, Utc::now()).unwrap();
        // As the background check leaves a damaged library.
        conn.pragma_update(None, "query_only", true).unwrap();
        restore_into(&mut conn, &paths, &copy).unwrap();
        capture(&conn, "https://example.com/writable", "writable");
    }

    #[test]
    fn restore_of_an_older_schema_migrates_the_copy_only() {
        let paths = library("restore-older");
        drop(open(&paths).unwrap());
        let old = paths.folder().join("old-copy.db");
        let conn = fixtures::fresh_at(&old, 1);
        fixtures::sample_rows(&conn);
        fixtures::finish(conn);
        let original = fs::read(&old).unwrap();
        let mut conn = open(&paths).unwrap().conn;
        let restored = restore_into(&mut conn, &paths, &old).unwrap();
        assert_eq!(
            migrations::user_version(&conn).unwrap(),
            migrations::SCHEMA_VERSION
        );
        assert_eq!(bookmarks(&conn), restored.bookmarks as i64);
        assert!(restored.bookmarks > 0);
        assert_eq!(fs::read(&old).unwrap(), original, "the chosen file is not written to");
    }

    #[test]
    fn restore_drops_pictures_at_local_addresses_and_keeps_the_copy() {
        let paths = library("restore-pictures");
        drop(open(&paths).unwrap());
        let copy = paths.folder().join("picked.db");
        let conn = fixtures::fresh_at(&copy, 1);
        fixtures::sample_rows(&conn);
        conn.execute_batch(
            "UPDATE bookmarks SET image_url = 'http://192.168.1.1/cgi-bin/reboot', favicon_url = 'https://example.com/favicon.ico' WHERE id = 1;
             UPDATE bookmarks SET favicon_url = 'http://localhost:8080/admin' WHERE id = 2;",
        )
        .unwrap();
        fixtures::finish(conn);
        let original = fs::read(&copy).unwrap();
        let mut conn = open(&paths).unwrap().conn;
        restore_into(&mut conn, &paths, &copy).unwrap();
        let pictures = |id: i64| {
            conn.query_row("SELECT image_url, favicon_url FROM bookmarks WHERE id = ?1", [id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .unwrap()
        };
        assert_eq!(pictures(1), (None, Some("https://example.com/favicon.ico".into())));
        assert_eq!(pictures(2).1, None);
        assert_eq!(fs::read(&copy).unwrap(), original, "the chosen file is not written to");
    }

    #[test]
    fn copies_that_cannot_be_restored_change_nothing() {
        let paths = library("restore-refused");
        build(&paths, 0);
        let mut conn = open(&paths).unwrap().conn;
        let count = bookmarks(&conn);
        let folder = paths.folder();

        let text = folder.join("text.db");
        fs::write(&text, b"This is not an SQLite file.\n").unwrap();
        let foreign = folder.join("foreign.db");
        Connection::open(&foreign)
            .unwrap()
            .execute_batch("PRAGMA application_id = 305419896; CREATE TABLE notes (text TEXT);")
            .unwrap();
        let newer = back_up_now(&paths, Utc::now()).unwrap();
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", migrations::SCHEMA_VERSION + 1)
            .unwrap();
        let damaged = folder.join("damaged.db");
        let big = fixtures::fresh_at(&damaged, 1);
        fixtures::generated(&big, 3_000, 3);
        fixtures::finish(big);
        fixtures::damage(&damaged);

        for (file, expected) in [
            (&text, "not_database"),
            (&foreign, "not_ours"),
            (&newer, "newer"),
            (&damaged, "damaged"),
            (&folder.join("missing.db"), "unreadable"),
        ] {
            let Err(RestoreFailure::Rejected(problem)) = restore_into(&mut conn, &paths, file) else {
                panic!("{} must be refused", file.display());
            };
            let tag = serde_json::to_value(&problem).unwrap()["problem"].clone();
            assert_eq!(tag, expected, "{}", file.display());
        }
        assert_eq!(bookmarks(&conn), count);
        assert!(before_restore_copies(&paths).is_empty(), "no copy before a refused restore");
    }

    #[test]
    fn restore_replaces_a_library_that_did_not_open() {
        let paths = library("restore-closed");
        build(&paths, 0);
        let copy = back_up_now(&paths, Utc::now()).unwrap();
        let in_copy = bookmarks(&Connection::open(&copy).unwrap());
        fs::write(&paths.database, b"This is not an SQLite file.\n").unwrap();
        assert_eq!(open(&paths).err().unwrap().code, OpenCode::DbNotDatabase);

        let restored = restore_closed(&paths, &copy).unwrap();
        assert_eq!(restored.bookmarks as i64, in_copy);
        assert_eq!(
            fs::read(&restored.previous).unwrap(),
            b"This is not an SQLite file.\n",
            "the broken file is kept as it was"
        );
        let conn = open(&paths).unwrap().conn;
        assert_eq!(bookmarks(&conn), in_copy);
        assert_eq!(quick_check(&conn).unwrap(), None);
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
