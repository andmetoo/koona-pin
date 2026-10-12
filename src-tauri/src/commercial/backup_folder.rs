//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in this folder).
//!
//! Supporter's automatic backups to a folder of one's choice (NP-066, sheet 45): every automatic
//! copy the app makes (daily, and «Back up now») is also copied into that folder, such as one that
//! Dropbox or Google Drive keep in the cloud, and the automatic copies there are pruned by the same
//! rule as at home (7 daily, 4 weekly). Other files in the folder are never touched. Without an
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

/// Copies one automatic copy into `folder` under the same name, through a temporary name so that a
/// sync client never uploads half a file, then prunes the automatic copies there.
fn copy_into(folder: &Path, copy: &Path) -> std::io::Result<()> {
    if !folder.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "the folder is not there"));
    }
    let name = copy.file_name().ok_or_else(|| std::io::Error::other("a copy without a name"))?;
    let target = folder.join(name);
    let temporary = folder.join(format!("{}.part", name.to_string_lossy()));
    fs::copy(copy, &temporary)?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    backup::prune_auto(folder);
    Ok(())
}

/// After the app made an automatic copy: the same copy into the chosen folder, for a Supporter.
pub fn mirror(app: &AppHandle, copy: &Path) {
    let Some(state) = app.try_state::<BackupFolderState>() else {
        return;
    };
    let Some(folder) = state.get().folder else {
        return;
    };
    if !billing::has_plan(app) {
        return;
    }
    let result = copy_into(&folder, copy);
    if let Err(error) = &result {
        eprintln!("Copying the backup to the chosen folder failed: {error}");
    }
    let _ = state.update(app, |s| {
        // Only for the folder the copy was made for: a change of folder meanwhile wins.
        if s.folder.as_deref() == Some(folder.as_path()) {
            s.failed = result.is_err();
            if result.is_ok() {
                s.last_copy = Some(Utc::now());
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
    app.dialog().file().set_title(title).pick_folder(move |picked| {
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
        // Fifteen daily copies already in the cloud folder, and a file of the person's own.
        for day in 1..=15 {
            fs::write(cloud.join(format!("koonapin.auto-202610{day:02}-090000.db")), b"old").unwrap();
        }
        fs::write(cloud.join("notes.txt"), b"mine").unwrap();
        let copy = home.join("koonapin.auto-20261016-090000.db");
        fs::write(&copy, b"new").unwrap();
        copy_into(&cloud, &copy).unwrap();
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
        assert!(copy_into(&gone, &copy).is_err());
        assert!(!gone.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_dialog_says_unreachable_only_for_a_chosen_folder() {
        let shown = BackupFolder::from(&Stored { folder: Some(PathBuf::from("D:/Dropbox/Koona Pin")), last_copy: None, failed: true });
        assert!(shown.unreachable);
        assert!(!BackupFolder::from(&Stored { folder: None, last_copy: None, failed: true }).unreachable);
    }
}
