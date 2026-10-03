//! Backup copies of the library (Р-10, point 9).
//!
//! `VACUUM INTO` writes a consistent, compact copy that includes the WAL and
//! opens with the same code as the library itself. A copy is written under a
//! temporary name and renamed only when finished.

use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
use rusqlite::Connection;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub const FOLDER: &str = "backups";
const DAILY: usize = 7;
const WEEKLY: usize = 4;
const AUTO_PREFIX: &str = "netamipin.auto-";
const AUTO_FORMAT: &str = "%Y%m%d-%H%M%S";

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
    folder.join(format!("netamipin.before-v{version}.db"))
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
    for old in expired(&auto_copies(folder)) {
        let _ = fs::remove_file(old);
    }
    Ok(target)
}

/// Copies in the folder (`netamipin.*.db`, as the settings count them),
/// their size and the time of the newest automatic copy.
pub fn summary(folder: &Path) -> (usize, u64, Option<DateTime<Utc>>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return (0, 0, None);
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.starts_with("netamipin.") && name.ends_with(".db")).then_some((name, entry))
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
