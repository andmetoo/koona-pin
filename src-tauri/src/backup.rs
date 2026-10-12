//! Backup copies of the library (Р-10, point 9).
//!
//! `VACUUM INTO` writes a consistent, compact copy that includes the WAL and
//! opens with the same code as the library itself. A copy is written under a
//! temporary name and renamed only when finished.

use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
use rusqlite::Connection;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use ts_rs::TS;

pub const FOLDER: &str = "backups";
const DAILY: usize = 7;
const WEEKLY: usize = 4;
const AUTO_PREFIX: &str = "koonapin.auto-";
const AUTO_FORMAT: &str = "%Y%m%d-%H%M%S";
const BEFORE_MIGRATION: &str = "koonapin.before-v";
const BEFORE_RESTORE: &str = "koonapin.before-restore-";
/// Copies before a restore kept, like those before a migration (Р-10, point 9).
const KEPT_BEFORE_RESTORE: usize = 2;

pub fn write_copy(conn: &Connection, target: &Path) -> Result<(), String> {
    let folder = target.parent().ok_or("backup path has no folder")?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let partial = target.with_extension("db.partial");
    let _ = fs::remove_file(&partial);
    let written = conn
        .execute("VACUUM INTO ?1", [partial.to_string_lossy()])
        .map_err(|e| e.to_string())
        .and_then(|_| fs::rename(&partial, target).map_err(|e| e.to_string()));
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

pub fn before_migration_path(folder: &Path, version: i64) -> PathBuf {
    folder.join(format!("koonapin.before-v{version}.db"))
}

/// A repeated attempt replaces the copy: the library has not changed since.
pub fn before_migration(conn: &Connection, folder: &Path, version: i64) -> Result<PathBuf, String> {
    let target = before_migration_path(folder, version);
    write_copy(conn, &target)?;
    Ok(target)
}

/// Keeps the copies before the last two migrations.
pub fn prune_before_migration(folder: &Path, version: i64) {
    for old in 1..version - 1 {
        let _ = fs::remove_file(before_migration_path(folder, old));
    }
}

/// The time in the name of a copy before a restore: UTC with milliseconds,
/// marked `Z`. Earlier builds wrote local time to the second.
const RESTORE_FORMAT: &str = "%Y%m%d-%H%M%S%3fZ";
const RESTORE_FORMAT_LOCAL: &str = "%Y%m%d-%H%M%S";

/// `koonapin.before-restore-<time>.db`: the library as it was before a
/// restore. UTC, so the clock going back (end of summer time) does not make
/// a newer copy look older; milliseconds and a free name, so a second restore
/// in the same second does not write over the first copy.
pub fn before_restore_path(folder: &Path) -> PathBuf {
    loop {
        let path = folder.join(format!("{BEFORE_RESTORE}{}.db", Utc::now().format(RESTORE_FORMAT)));
        if !path.exists() {
            return path;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// When a copy before a restore was written, from its name, either format.
fn restore_stamp(name: &str) -> Option<DateTime<Utc>> {
    let stamp = name.strip_prefix(BEFORE_RESTORE)?.strip_suffix(".db")?;
    match NaiveDateTime::parse_from_str(stamp, RESTORE_FORMAT) {
        Ok(time) => Some(time.and_utc()),
        Err(_) => NaiveDateTime::parse_from_str(stamp, RESTORE_FORMAT_LOCAL)
            .ok()?
            .and_local_timezone(chrono::Local)
            .earliest()
            .map(|time| time.with_timezone(&Utc)),
    }
}

/// Keeps the newest copies before a restore, by the time in their names; a
/// name without a time counts as the oldest.
pub fn prune_before_restore(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut copies: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(BEFORE_RESTORE) && n.ends_with(".db"))
        })
        .collect();
    copies.sort_by_cached_key(|p| (p.file_name().and_then(|n| n.to_str()).and_then(restore_stamp), p.clone()));
    let extra = copies.len().saturating_sub(KEPT_BEFORE_RESTORE);
    for old in &copies[..extra] {
        let _ = fs::remove_file(old);
        let _ = fs::remove_file(format!("{}-wal", old.display()));
    }
}

/// What made a copy in the backups folder, from its name (sheet 33).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CopyKind {
    /// Daily, or «Back up now».
    Automatic,
    BeforeUpdate,
    BeforeRestore,
    Other,
}

fn kind_of(name: &str) -> CopyKind {
    if name.starts_with(AUTO_PREFIX) {
        CopyKind::Automatic
    } else if name.starts_with(BEFORE_RESTORE) {
        CopyKind::BeforeRestore
    } else if name.starts_with(BEFORE_MIGRATION) {
        CopyKind::BeforeUpdate
    } else {
        CopyKind::Other
    }
}

/// A copy the restore dialog offers.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BackupCopy {
    pub file_name: String,
    pub kind: CopyKind,
    /// When it was written, UTC.
    pub created_at: String,
    #[ts(type = "number")]
    pub bytes: u64,
    /// Bookmarks outside the trash; none when the file cannot be read.
    pub bookmarks: Option<u32>,
}

/// Bookmarks outside the trash, read without changing the file.
pub fn bookmarks_in(path: &Path) -> Option<u32> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.query_row(
        "SELECT count(*) FROM bookmarks WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )
    .ok()
}

/// One copy as the dialog shows it; the time of an automatic copy comes from
/// its name, of the others from the file.
pub fn describe(path: &Path) -> Option<BackupCopy> {
    let file_name = path.file_name()?.to_str()?.to_owned();
    let metadata = fs::metadata(path).ok()?;
    let created = auto_stamp(&file_name)
        .map(|time| time.and_utc())
        .or_else(|| metadata.modified().ok().map(DateTime::<Utc>::from))?;
    Some(BackupCopy {
        kind: kind_of(&file_name),
        created_at: crate::db::stamp(created),
        bytes: metadata.len(),
        bookmarks: bookmarks_in(path),
        file_name,
    })
}

/// The copies in the folder (`koonapin.*.db`, as the settings count them),
/// newest first.
pub fn list(folder: &Path) -> Vec<BackupCopy> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut copies: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("koonapin.") && name.ends_with(".db")
        })
        .filter_map(|entry| describe(&entry.path()))
        .collect();
    copies.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    copies
}

/// A listed copy by name; anything that is not a plain file name of the
/// folder is refused, so the page cannot point outside it.
pub fn listed(folder: &Path, file_name: &str) -> Option<PathBuf> {
    let plain = Path::new(file_name).file_name()?.to_str()? == file_name;
    (plain && file_name.starts_with("koonapin.") && file_name.ends_with(".db"))
        .then(|| folder.join(file_name))
        .filter(|path| path.is_file())
}

/// The time of an automatic copy, from its file name.
fn auto_stamp(name: &str) -> Option<NaiveDateTime> {
    let stamp = name.strip_prefix(AUTO_PREFIX)?.strip_suffix(".db")?;
    NaiveDateTime::parse_from_str(stamp, AUTO_FORMAT).ok()
}

fn auto_copies(folder: &Path) -> Vec<(PathBuf, NaiveDateTime)> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let time = auto_stamp(entry.file_name().to_str()?)?;
            Some((entry.path(), time))
        })
        .collect()
}

/// At start and every day in the tray, when the newest copy is a day old.
pub fn auto_due(folder: &Path, now: DateTime<Utc>) -> bool {
    auto_copies(folder)
        .iter()
        .map(|(_, time)| time.and_utc())
        .max()
        .is_none_or(|newest| now - newest >= chrono::Duration::hours(24))
}

pub fn create_auto(
    conn: &Connection,
    folder: &Path,
    now: DateTime<Utc>,
) -> Result<PathBuf, String> {
    let target = folder.join(format!("{AUTO_PREFIX}{}.db", now.format(AUTO_FORMAT)));
    write_copy(conn, &target)?;
    prune_auto(folder);
    Ok(target)
}

/// Removes the automatic copies in `folder` that the rule of [`expired`] no longer keeps. Other
/// files there are never touched: the folder may be one the person shares with other things.
pub fn prune_auto(folder: &Path) {
    for old in expired(&auto_copies(folder)) {
        let _ = fs::remove_file(old);
    }
}

/// Whether a file name is one of the automatic copies.
pub fn is_auto(name: &str) -> bool {
    auto_stamp(name).is_some()
}

/// Copies in the folder (`koonapin.*.db`, as the settings count them),
/// their size and the time of the newest automatic copy.
pub fn summary(folder: &Path) -> (usize, u64, Option<DateTime<Utc>>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return (0, 0, None);
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.starts_with("koonapin.") && name.ends_with(".db")).then_some((name, entry))
        })
        .fold((0, 0, None), |(count, bytes, last), (name, entry)| {
            let time = auto_stamp(&name).map(|time| time.and_utc());
            (
                count + 1,
                bytes + entry.metadata().map_or(0, |m| m.len()),
                last.max(time),
            )
        })
}

/// The newest copy of each of the last 7 days with copies stays, then the
/// newest copy of each of 4 earlier weeks; everything else goes. About 11
/// copies reaching a month back.
pub fn expired(copies: &[(PathBuf, NaiveDateTime)]) -> Vec<PathBuf> {
    let mut sorted: Vec<_> = copies.iter().collect();
    sorted.sort_by_key(|(_, time)| std::cmp::Reverse(*time));
    let mut keep = HashSet::new();
    let mut days = HashSet::new();
    let mut weeks = HashSet::new();
    let week_of = |time: &NaiveDateTime| {
        let week = time.iso_week();
        (week.year(), week.week())
    };
    let mut daily_week = None;
    for (path, time) in &sorted {
        if days.len() < DAILY {
            if days.insert(time.date()) {
                keep.insert(path.clone());
                daily_week = Some(week_of(time));
            }
            continue;
        }
        // Weeks before the daily copies, so each weekly copy adds history.
        let week = week_of(time);
        if weeks.len() < WEEKLY && Some(week) < daily_week && weeks.insert(week) {
            keep.insert(path.clone());
        }
    }
    sorted
        .into_iter()
        .filter(|(path, _)| !keep.contains(path))
        .map(|(path, _)| path.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn retention_keeps_seven_days_and_four_weeks() {
        // Two copies a day for 60 days, as in a tray that runs day and night.
        let start = at("2026-08-01 08:00");
        let copies: Vec<_> = (0..120)
            .map(|i| {
                let time = start + chrono::Duration::hours(12 * i);
                (PathBuf::from(format!("{i}.db")), time)
            })
            .collect();
        let gone: HashSet<_> = expired(&copies).into_iter().collect();
        let kept: Vec<_> = copies.iter().filter(|(p, _)| !gone.contains(p)).collect();
        assert_eq!(kept.len(), DAILY + WEEKLY);
        // The newest copy always stays, and the oldest kept is about a month old.
        assert!(kept.iter().any(|(p, _)| p == &copies[119].0));
        let oldest = kept.iter().map(|(_, t)| *t).min().unwrap();
        let newest = copies[119].1;
        assert!((newest - oldest).num_days() >= 28, "{oldest} .. {newest}");
        // Running retention again on what is left removes nothing more.
        let left: Vec<_> = kept.into_iter().cloned().collect();
        assert!(expired(&left).is_empty());
        // One copy per day: the older copy of the newest day goes.
        assert!(gone.contains(&copies[118].0));
    }

    #[test]
    fn a_second_restore_in_the_same_second_keeps_the_first_copy() {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("backups-restore-names-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let first = before_restore_path(&folder);
        fs::write(&first, "the library before the first restore").unwrap();
        let second = before_restore_path(&folder);
        assert_ne!(first, second);
        fs::write(&second, "the library before the second restore").unwrap();
        // A copy of an earlier build, a minute before: local time to the
        // second. East of UTC its name sorts after the new ones as text.
        let older = folder.join(format!(
            "{BEFORE_RESTORE}{}.db",
            (chrono::Local::now() - chrono::Duration::minutes(1)).format(RESTORE_FORMAT_LOCAL)
        ));
        fs::write(&older, "older").unwrap();
        let stamp = |p: &Path| restore_stamp(p.file_name().unwrap().to_str().unwrap()).unwrap();
        assert!(stamp(&older) < stamp(&first) && stamp(&first) < stamp(&second), "by the time in the names");
        // Pruning keeps the two newest.
        prune_before_restore(&folder);
        assert!(!older.exists() && first.exists() && second.exists());
    }

    #[test]
    fn copies_are_listed_newest_first_with_their_kind() {
        use chrono::Timelike;
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("backups-list-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE bookmarks (deleted_at TEXT);
             INSERT INTO bookmarks VALUES (NULL), (NULL), ('2026-10-01T00:00:00.000Z');",
        )
        .unwrap();
        let older = Utc::now() - chrono::Duration::days(2);
        create_auto(&conn, &folder, older).unwrap();
        before_migration(&conn, &folder, 4).unwrap();
        write_copy(&conn, &before_restore_path(&folder)).unwrap();
        fs::write(folder.join("notes.txt"), "not a copy").unwrap();
        fs::create_dir_all(folder.join("restoring")).unwrap();

        let copies = list(&folder);
        let kinds: Vec<_> = copies.iter().map(|c| c.kind).collect();
        assert_eq!(copies.len(), 3);
        assert_eq!(*kinds.last().unwrap(), CopyKind::Automatic, "the oldest is last");
        assert!(kinds.contains(&CopyKind::BeforeUpdate) && kinds.contains(&CopyKind::BeforeRestore));
        assert!(copies.iter().all(|c| c.bookmarks == Some(2) && c.bytes > 0));
        assert_eq!(copies.last().unwrap().created_at, crate::db::stamp(older.with_nanosecond(0).unwrap()));

        // Only plain names of copies in the folder can be restored by name.
        let name = &copies[0].file_name;
        assert_eq!(listed(&folder, name), Some(folder.join(name)));
        for wrong in ["../koonapin.db", "notes.txt", "koonapin.missing.db", "C:\\koonapin.x.db"] {
            assert_eq!(listed(&folder, wrong), None, "{wrong}");
        }
    }

    #[test]
    fn auto_copy_is_due_after_a_day() {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("backups-{}", uuid::Uuid::new_v4()));
        let now = Utc::now();
        assert!(auto_due(&folder, now));
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
            .unwrap();
        let copy = create_auto(&conn, &folder, now).unwrap();
        assert!(copy.exists());
        assert!(!copy.with_extension("db.partial").exists());
        assert!(!auto_due(&folder, now + chrono::Duration::hours(23)));
        assert!(auto_due(&folder, now + chrono::Duration::hours(24)));
    }
}
