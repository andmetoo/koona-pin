//! One-time import of data left by OddClicks, the previous name of the app.
//!
//! The OddClicks folders are only read: they stay in place as a rollback copy.

use rusqlite::{Connection, DatabaseName, OpenFlags};
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
};

/// Points tests at a prepared OddClicks copy laid out like an isolated run:
/// `oddclicks.db` and `webview/EBWebView`.
pub const LEGACY_DIR_ENV: &str = "NETAMIPIN_LEGACY_DIR";
/// Matches `identifier` in tauri.conf.json; WebView2 keeps its profile there.
const IDENTIFIER: &str = "app.netami.pin";

struct LegacyPaths {
    database: PathBuf,
    webview: PathBuf,
}

/// Isolated runs (`NETAMIPIN_DATA_DIR`) never read the real OddClicks library.
fn legacy_paths() -> Option<LegacyPaths> {
    if let Some(directory) = std::env::var_os(LEGACY_DIR_ENV) {
        let directory = PathBuf::from(directory);
        return Some(LegacyPaths {
            database: directory.join("oddclicks.db"),
            webview: directory.join("webview").join("EBWebView"),
        });
    }
    if std::env::var_os(crate::db::DATA_DIR_ENV).is_some() {
        return None;
    }
    Some(LegacyPaths {
        database: dirs::data_dir()?.join("OddClicks").join("oddclicks.db"),
        webview: dirs::data_local_dir()?
            .join("com.oddclicks.app")
            .join("EBWebView"),
    })
}

pub fn legacy_database() -> Option<PathBuf> {
    legacy_paths().map(|paths| paths.database)
}

fn webview_profile() -> Option<PathBuf> {
    if let Some(directory) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        return Some(PathBuf::from(directory).join("EBWebView"));
    }
    Some(dirs::data_local_dir()?.join(IDENTIFIER).join("EBWebView"))
}

/// Copies the OddClicks library with the SQLite Backup API, so WAL contents are
/// included. Nothing happens once the Netami Pin library exists.
pub fn import_database(legacy: &Path, target: &Path) -> Result<bool, Box<dyn Error>> {
    if target.exists() || !legacy.is_file() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    // A copy interrupted halfway must not look like a finished library.
    let partial = target.with_extension("db.importing");
    let _ = fs::remove_file(&partial);
    let source = Connection::open_with_flags(legacy, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    source.backup(DatabaseName::Main, &partial, None)?;
    drop(source);
    fs::rename(&partial, target)?;
    Ok(true)
}

/// Carries theme and view, kept by the interface in localStorage, into the new
/// WebView2 profile. Must run before the first webview is created.
pub fn import_webview_storage(legacy: &Path, target: &Path) -> io::Result<bool> {
    let source = legacy.join("Default").join("Local Storage");
    if target.exists() || !source.is_dir() {
        return Ok(false);
    }
    copy_directory(&source, &target.join("Default").join("Local Storage"))?;
    Ok(true)
}

fn copy_directory(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let destination = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

/// Losing theme and view is not worth refusing to start, so errors are only logged.
pub fn import_webview() {
    let (Some(legacy), Some(target)) = (legacy_paths(), webview_profile()) else {
        return;
    };
    if let Err(error) = import_webview_storage(&legacy.webview, &target) {
        eprintln!("Cannot import OddClicks interface settings: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn database_import_copies_wal_and_never_overwrites() {
        let directory = directory("legacy-import");
        let legacy = directory.join("oddclicks.db");
        let conn = Connection::open(&legacy).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE bookmarks (title TEXT);
             INSERT INTO bookmarks VALUES ('Из OddClicks');",
        )
        .unwrap();
        // The row lives only in the WAL while OddClicks keeps the database open.
        assert!(directory.join("oddclicks.db-wal").metadata().unwrap().len() > 0);
        let target = directory.join("Netami Pin").join("netamipin.db");
        assert!(import_database(&legacy, &target).unwrap());
        let imported = Connection::open(&target).unwrap();
        let title: String = imported
            .query_row("SELECT title FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Из OddClicks");
        assert!(!target.with_extension("db.importing").exists());

        imported.execute("DELETE FROM bookmarks", []).unwrap();
        assert!(!import_database(&legacy, &target).unwrap());
        let count: i64 = imported
            .query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "an existing Netami Pin library is never replaced");
        assert!(
            !import_database(&directory.join("missing.db"), &directory.join("other.db")).unwrap()
        );
        assert!(!directory.join("other.db").exists());
    }

    #[test]
    fn webview_import_copies_local_storage_once() {
        let directory = directory("legacy-webview");
        let legacy = directory.join("old").join("EBWebView");
        let leveldb = legacy.join("Default").join("Local Storage").join("leveldb");
        fs::create_dir_all(&leveldb).unwrap();
        fs::write(leveldb.join("000003.log"), "oddclicks.theme=dark").unwrap();
        let target = directory.join("new").join("EBWebView");
        assert!(import_webview_storage(&legacy, &target).unwrap());
        let copied = target
            .join("Default")
            .join("Local Storage")
            .join("leveldb")
            .join("000003.log");
        assert_eq!(fs::read_to_string(&copied).unwrap(), "oddclicks.theme=dark");
        fs::write(&copied, "changed").unwrap();
        assert!(!import_webview_storage(&legacy, &target).unwrap());
        assert_eq!(fs::read_to_string(&copied).unwrap(), "changed");
    }
}
