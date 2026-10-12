//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in this folder).
//!
//! Supporter's automatic backups to a folder of one's choice (NP-066, sheet 45): every automatic
//! copy the app makes (daily, and «Back up now») is also copied into that folder, such as one that
//! Dropbox or Google Drive keep in the cloud, and the automatic copies there are pruned by the same
//! rule as at home (7 daily, 4 weekly), only those this computer put there: other files, and the
//! copies of other computers that share the folder, are never touched. Without an
//! active plan nothing is copied; the folder stays chosen for when the plan comes back.

use crate::backup;
use crate::billing;
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use crate::library;
use crate::library_state::Library;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

pub const EVENT: &str = "backup-folder";
const FILE: &str = "backup-folder.json";

/// `backup-folder.json` next to the library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    folder: Option<PathBuf>,
    last_copy: Option<DateTime<Utc>>,
    /// The last copy could not be written there: the folder is gone, offline or read-only.
    #[serde(default)]
    failed: bool,
    /// The automatic copies this computer put there: only these are pruned, so a folder that
    /// several computers copy into keeps the copies of the others.
    #[serde(default)]
    written: Vec<String>,
}

/// What the Supporter dialog shows in the backups row.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct BackupFolder {
    pub path: Option<String>,
    #[ts(type = "string | null")]
    pub last_copy_at: Option<DateTime<Utc>>,
    pub unreachable: bool,
}

impl From<&Stored> for BackupFolder {
    fn from(stored: &Stored) -> Self {
        BackupFolder {
            path: stored.folder.as_ref().map(|f| f.to_string_lossy().into_owned()),
            last_copy_at: stored.last_copy,
            unreachable: stored.folder.is_some() && stored.failed,
        }
    }
}

pub struct BackupFolderState {
    path: PathBuf,
    stored: Mutex<Stored>,
}

impl BackupFolderState {
    fn load(path: PathBuf) -> Self {
        let stored = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        BackupFolderState { path, stored: Mutex::new(stored) }
    }

    fn get(&self) -> Stored {
        self.stored.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Changes the state and writes it, under one lock, as billing.rs does.
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Stored)) -> Result<BackupFolder, CommandError> {
        let shown = {
            let mut stored = self.stored.lock().map_err(CommandError::internal)?;
            let mut next = stored.clone();
            change(&mut next);
            if let Some(folder) = self.path.parent() {
                fs::create_dir_all(folder).map_err(CommandError::internal)?;
            }
            let temporary = self.path.with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_string_pretty(&next).map_err(CommandError::internal)?).map_err(CommandError::internal)?;
            fs::rename(&temporary, &self.path).map_err(CommandError::internal)?;
            *stored = next;
            BackupFolder::from(&*stored)
        };
        let _ = app.emit(EVENT, shown.clone());
        Ok(shown)
    }
}

/// Called in `setup`.
pub fn start(app: &AppHandle) {
    let path = library::Paths::from_env().folder().join(FILE);
    app.manage(BackupFolderState::load(path));
}

/// A `.part` this old belongs to a copy cut short (the app quit, the computer slept).
const STALE_PART: Duration = Duration::from_secs(60 * 60);

/// Copies one automatic copy into `folder` under the same name, through a temporary name of its
/// own so that a sync client never uploads half a file, then prunes there the automatic copies of
/// this computer (`ours` and this one). Returns the name written.
fn copy_into(folder: &Path, copy: &Path, ours: &[String]) -> std::io::Result<String> {
    if !folder.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "the folder is not there"));
    }
    remove_stale_parts(folder);
    let name = copy.file_name().and_then(|n| n.to_str()).ok_or_else(|| std::io::Error::other("a copy without a name"))?.to_owned();
    let target = folder.join(&name);
    let temporary = folder.join(format!("{name}.{}.part", uuid::Uuid::new_v4().simple()));
    let copied = fs::copy(copy, &temporary).and_then(|_| fs::rename(&temporary, &target));
    if let Err(error) = copied {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    backup::prune_auto_among(folder, |other| other == name || ours.iter().any(|mine| mine == other));
    Ok(name)
}

fn remove_stale_parts(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let stale = entry.file_name().to_str().is_some_and(backup::is_auto_part)
            && entry.metadata().and_then(|m| m.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > STALE_PART);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// After the app made an automatic copy: the same copy into the chosen folder, for a Supporter.
pub fn mirror(app: &AppHandle, copy: &Path) {
    let Some(state) = app.try_state::<BackupFolderState>() else {
        return;
    };
    let Stored { folder: Some(folder), written, .. } = state.get() else {
        return;
    };
    if !billing::has_plan(app) {
        return;
    }
    let result = copy_into(&folder, copy, &written);
    if let Err(error) = &result {
        eprintln!("Copying the backup to the chosen folder failed: {error}");
    }
    let _ = state.update(app, |s| {
        // Only for the folder the copy was made for: a change of folder meanwhile wins.
        if s.folder.as_deref() == Some(folder.as_path()) {
            s.failed = result.is_err();
            if let Ok(name) = &result {
                s.last_copy = Some(Utc::now());
                if !s.written.contains(name) {
                    s.written.push(name.clone());
                }
                s.written.retain(|mine| folder.join(mine).exists());
            }
        }
    });
}

fn need_plan(app: &AppHandle) -> Result<(), CommandError> {
    if billing::has_plan(app) {
        Ok(())
    } else {
        Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::NotSupporter, "Backups to a folder are for Supporters"))
    }
}

/// A fresh copy now and into the folder, so the row shows at once that it works.
fn copy_now(app: &AppHandle) {
    let Some(library) = app.try_state::<Arc<Library>>().map(|l| l.inner().clone()) else {
        return;
    };
    match library::back_up_now(&library.paths, Utc::now()) {
        Ok(copy) => mirror(app, &copy),
        Err(error) => eprintln!("A backup for the chosen folder failed: {error}"),
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_backup_folder(state: State<'_, BackupFolderState>) -> BackupFolder {
    BackupFolder::from(&state.get())
}

/// «Choose folder…» / «Change…»: the system's folder picker, then a first copy there. Cancelling
/// the picker changes nothing.
#[tauri::command]
pub async fn choose_backup_folder(app: AppHandle, title: String) -> Result<BackupFolder, CommandError> {
    need_plan(&app)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |picked| {
        let _ = send.send(picked);
    });
    let picked = receive.await.map_err(CommandError::internal)?;
    let state = app.state::<BackupFolderState>();
    let Some(folder) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(BackupFolder::from(&state.get()));
    };
    state.update(&app, |s| {
        if s.folder.as_deref() != Some(folder.as_path()) {
            s.last_copy = None;
            s.written.clear();
        }
        s.folder = Some(folder);
        s.failed = false;
    })?;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || copy_now(&worker)).await.map_err(CommandError::internal)?;
    Ok(BackupFolder::from(&app.state::<BackupFolderState>().get()))
}

/// «×»: no more copies there; what is there stays.
#[tauri::command]
pub fn stop_backup_folder(app: AppHandle, state: State<'_, BackupFolderState>) -> Result<BackupFolder, CommandError> {
    state.update(&app, |s| *s = Stored::default())
}

/// The folder icon: the chosen folder in the file manager.
#[tauri::command]
pub fn open_backup_folder(app: AppHandle, state: State<'_, BackupFolderState>) -> Result<(), CommandError> {
    let folder = state.get().folder.ok_or_else(|| CommandError::new(ErrorCode::InvalidRequest, "No folder is chosen"))?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(CommandError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-backup-folder-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_copy_lands_whole_in_the_folder_and_old_automatic_copies_go() {
        let home = folder("home");
        let cloud = folder("cloud");
        // Fifteen daily copies of this computer already in the cloud folder, and a file of the person's own.
        let ours: Vec<String> = (1..=15).map(|day| format!("koonapin.auto-202610{day:02}-090000.db")).collect();
        for name in &ours {
            fs::write(cloud.join(name), b"old").unwrap();
        }
        fs::write(cloud.join("notes.txt"), b"mine").unwrap();
        let copy = home.join("koonapin.auto-20261016-090000.db");
        fs::write(&copy, b"new").unwrap();
        assert_eq!(copy_into(&cloud, &copy, &ours).unwrap(), "koonapin.auto-20261016-090000.db");
        assert_eq!(fs::read(cloud.join("koonapin.auto-20261016-090000.db")).unwrap(), b"new");
        assert!(cloud.join("notes.txt").exists(), "other files stay");
        let kept = fs::read_dir(&cloud).unwrap().filter_map(Result::ok).filter(|e| backup::is_auto(&e.file_name().to_string_lossy())).count();
        assert!(kept < 16, "the rule of 7 daily and 4 weekly prunes there too, kept {kept}");
        assert!(!fs::read_dir(&cloud).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".part")));
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cloud);
    }

    #[test]
    fn a_folder_that_is_gone_is_an_error_and_nothing_is_written() {
        let home = folder("home-gone");
        let copy = home.join("koonapin.auto-20261016-090000.db");
        fs::write(&copy, b"new").unwrap();
        let gone = home.join("not-there");
        assert!(copy_into(&gone, &copy, &[]).is_err());
        assert!(!gone.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_shared_by_two_computers_keeps_the_copies_of_the_other() {
        let home = folder("home-shared");
        let cloud = folder("cloud-shared");
        // The other computer's copies, one a day for two weeks, the same day as this one's too.
        let theirs: Vec<String> = (1..=16).map(|day| format!("koonapin.auto-202610{day:02}-070000.db")).collect();
        for name in &theirs {
            fs::write(cloud.join(name), b"theirs").unwrap();
        }
        let copy = home.join("koonapin.auto-20261016-090000.db");
        fs::write(&copy, b"new").unwrap();
        copy_into(&cloud, &copy, &[]).unwrap();
        for name in &theirs {
            assert!(cloud.join(name).exists(), "{name} of the other computer stays");
        }
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cloud);
    }

    #[test]
    fn a_copy_cut_short_long_ago_goes_and_a_fresh_one_stays() {
        let home = folder("home-part");
        let cloud = folder("cloud-part");
        let old = cloud.join("koonapin.auto-20261015-090000.db.1234.part");
        let fresh = cloud.join("koonapin.auto-20261016-085959.db.5678.part");
        fs::write(&old, b"half").unwrap();
        fs::write(&fresh, b"half").unwrap();
        let two_hours_ago = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        fs::File::options().write(true).open(&old).unwrap().set_modified(two_hours_ago).unwrap();
        let copy = home.join("koonapin.auto-20261016-090000.db");
        fs::write(&copy, b"new").unwrap();
        copy_into(&cloud, &copy, &[]).unwrap();
        assert!(!old.exists());
        assert!(fresh.exists(), "another copy may still be writing it");
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cloud);
    }

    #[test]
    fn the_dialog_says_unreachable_only_for_a_chosen_folder() {
        let shown = BackupFolder::from(&Stored { folder: Some(PathBuf::from("D:/Dropbox/Koona Pin")), failed: true, ..Stored::default() });
        assert!(shown.unreachable);
        assert!(!BackupFolder::from(&Stored { failed: true, ..Stored::default() }).unreachable);
    }
}
