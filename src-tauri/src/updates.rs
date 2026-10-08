//! The app updates itself (NP-038, NP-102; Р-9, Р-45 п. 8, Р-60, sheet 42). Ten seconds after the
//! start and then once a day the updater reads `latest.json` of the releases of `andmetoo/koona-pin`;
//! a newer version shows as a row in the sidebar and in Settings → Updates, and nothing more happens
//! until the person presses «Update». The package is then downloaded and its minisign signature
//! checked against the key in `tauri.conf.json`, bound to the announced version
//! (`requireSignedVersion`). Windows runs the NSIS installer of the release, passive, which starts
//! the app again; Linux installs the .deb or .rpm through pkexec — polkit asks for the password —
//! and the app restarts. The AUR package is updated by pacman (Р-55): it never checks.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;
use ts_rs::TS;

use crate::channel::Channel;
use crate::error::CommandError;

/// The status after every change, for the sidebar row and Settings → Updates.
pub const EVENT: &str = "update-status";
/// Not in the way of the start: the library opens and the window shows first.
const FIRST_CHECK: Duration = Duration::from_secs(10);
/// How often the clock is looked at; a check runs when the last one is a day old. A sleeping
/// computer does not move a timer of 24 hours forward, the wall clock does.
const TICK: Duration = Duration::from_secs(60 * 60);
const DAY: chrono::TimeDelta = chrono::TimeDelta::hours(24);
/// The release page of a version: «What's new» opens it in the browser.
const RELEASE_PAGE: &str = "https://github.com/andmetoo/koona-pin/releases/tag/v";
/// Progress events while downloading: often enough for the bar, not for every chunk.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum UpdateStatus {
    /// No check yet since the start (or a development build, which checks only on request).
    #[default]
    Unknown,
    Checking,
    /// The newest version; `checked_at` in RFC 3339.
    UpToDate { checked_at: String },
    /// The releases could not be reached; the next check is a day later. Quiet in the sidebar.
    CheckFailed { checked_at: String },
    /// `notes_url`: the release page, «What's new».
    Available { version: String, notes_url: String },
    /// `total` when the server said the size.
    Downloading { version: String, received: u64, total: Option<u64> },
    /// Downloaded and verified; Windows' installer or polkit's password dialog is next.
    Installing { version: String },
    Failed { version: String, problem: UpdateProblem },
    /// The AUR package: pacman brings new versions (Р-55).
    Pacman,
}

/// Why an update did not happen; the version that runs keeps working in every case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UpdateProblem {
    /// No internet, or the download stopped.
    NoConnection,
    /// The file is not signed with Koona's key or not for this version: it was not installed.
    BadSignature,
    /// Linux: the password dialog was closed.
    PasswordCancelled,
    /// Linux: no polkit agent, or dpkg or rpm refused the package.
    InstallFailed,
    /// Anything else.
    Failed,
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<UpdateStatus>,
    /// The update the last check found, installed on «Update».
    pending: Mutex<Option<Update>>,
    /// «Cancel download» of the download under way.
    cancel: Mutex<Option<Arc<Notify>>>,
    /// When a check last ran, successful or not.
    last_check: Mutex<Option<DateTime<Utc>>>,
}

fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<Updates>().status.lock().map(|s| s.clone()).unwrap_or_default()
}

fn set(app: &AppHandle, next: UpdateStatus) {
    if let Ok(mut status) = app.state::<Updates>().status.lock() {
        *status = next.clone();
    }
    let _ = app.emit(EVENT, next);
}

/// Called in `setup`: the AUR package never checks; a development build only on request, unless
/// `KOONAPIN_UPDATE_ENDPOINT` points it at a test server.
pub fn start(app: &AppHandle) {
    app.manage(Updates::default());
    if !Channel::current().updater() {
        set(app, UpdateStatus::Pacman);
        return;
    }
    if cfg!(debug_assertions) && std::env::var_os("KOONAPIN_UPDATE_ENDPOINT").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let last = app.state::<Updates>().last_check.lock().ok().and_then(|l| *l);
            if last.is_none_or(|last| Utc::now() - last >= DAY) {
                check(&app).await;
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
    // A test server and key for development builds only: a release reads latest.json of the
    // releases and trusts only the key in tauri.conf.json.
    #[cfg(debug_assertions)]
    {
        if let Ok(endpoint) = std::env::var("KOONAPIN_UPDATE_ENDPOINT") {
            builder = builder.endpoints(vec![endpoint.parse()?])?;
        }
        if let Ok(key) = std::env::var("KOONAPIN_UPDATE_PUBKEY") {
            builder = builder.pubkey(key);
        }
    }
    builder.build()
}

/// One check. While a download or an installation runs nothing is checked; an update already
/// offered stays offered when a later check cannot reach the releases.
pub async fn check(app: &AppHandle) -> UpdateStatus {
    let before = status(app);
    if matches!(
        before,
        UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. } | UpdateStatus::Pacman
    ) {
        return before;
    }
    let offered = matches!(before, UpdateStatus::Available { .. } | UpdateStatus::Failed { .. });
    // The row in the sidebar does not blink while an offered update is checked again.
    if !offered {
        set(app, UpdateStatus::Checking);
    }
    let state = app.state::<Updates>();
    let now = Utc::now();
    if let Ok(mut last) = state.last_check.lock() {
        *last = Some(now);
    }
    let found = match updater(app) {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let next = match found {
        Ok(Some(update)) => {
            let next = UpdateStatus::Available {
                notes_url: format!("{RELEASE_PAGE}{}", update.version),
                version: update.version.clone(),
            };
            if let Ok(mut pending) = state.pending.lock() {
                *pending = Some(update);
            }
            next
        }
        // A release for the other system only (`build:latest -- --only linux`) has nothing for this one.
        Ok(None) | Err(tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)) => {
            if let Ok(mut pending) = state.pending.lock() {
                *pending = None;
            }
            UpdateStatus::UpToDate { checked_at: now.to_rfc3339() }
        }
        Err(error) => {
            eprintln!("Koona Pin: the update check failed: {error}");
            if offered {
                before
            } else {
                UpdateStatus::CheckFailed { checked_at: now.to_rfc3339() }
            }
        }
    };
    set(app, next.clone());
    next
}

/// What a failure of the plugin is called in the dialog.
fn problem_of(error: &tauri_plugin_updater::Error) -> UpdateProblem {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => UpdateProblem::NoConnection,
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::MissingSignedVersion | E::SignedVersionMismatch { .. } => {
            UpdateProblem::BadSignature
        }
        _ => UpdateProblem::Failed,
    }
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> UpdateStatus {
    status(&app)
}

/// «Check for updates» and «Try again» in Settings.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateStatus, CommandError> {
    if !Channel::current().updater() {
        return Ok(UpdateStatus::Pacman);
    }
    Ok(check(&app).await)
}

/// «Update» and «Try again» in the dialog: the download starts and reports through `EVENT`.
#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<(), CommandError> {
    let state = app.state::<Updates>();
    if matches!(status(&app), UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. }) {
        return Ok(());
    }
    let update = state
        .pending
        .lock()
        .map_err(CommandError::internal)?
        .clone()
        .ok_or_else(|| CommandError::invalid("No update to install"))?;
    let cancel = Arc::new(Notify::new());
    *state.cancel.lock().map_err(CommandError::internal)? = Some(cancel.clone());
    set(&app, UpdateStatus::Downloading { version: update.version.clone(), received: 0, total: None });
    tauri::async_runtime::spawn(async move {
        // latest.json may have changed since the check — a release fixed after a bad package, or a
        // newer version: the download takes what it says now; without a connection, the offer found.
        let fresh = match updater(&app) {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        let update = match fresh {
            Ok(Some(fresh)) => fresh,
            Ok(None) | Err(tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)) => {
                if let Ok(mut pending) = app.state::<Updates>().pending.lock() {
                    *pending = None;
                }
                set(&app, UpdateStatus::UpToDate { checked_at: Utc::now().to_rfc3339() });
                return;
            }
            Err(_) => update,
        };
        if let Ok(mut pending) = app.state::<Updates>().pending.lock() {
            *pending = Some(update.clone());
        }
        run(app, update, cancel).await
    });
    Ok(())
}

/// «Cancel download»: the row offers the version again.
#[tauri::command]
pub fn cancel_update(app: AppHandle) {
    if let Some(cancel) = app.state::<Updates>().cancel.lock().ok().and_then(|mut c| c.take()) {
        cancel.notify_one();
    }
}

async fn run(app: AppHandle, update: Update, cancel: Arc<Notify>) {
    let version = update.version.clone();
    let offered_again = UpdateStatus::Available { notes_url: format!("{RELEASE_PAGE}{version}"), version: version.clone() };
    let mut received = 0u64;
    let mut shown = Instant::now();
    let download = update.download(
        |chunk, total| {
            received += chunk as u64;
            if shown.elapsed() >= PROGRESS_EVERY {
                shown = Instant::now();
                set(&app, UpdateStatus::Downloading { version: version.clone(), received, total });
            }
        },
        || {},
    );
    let bytes = tokio::select! {
        bytes = download => bytes,
        _ = cancel.notified() => {
            set(&app, offered_again);
            return;
        }
    };
    if let Ok(mut cancel) = app.state::<Updates>().cancel.lock() {
        *cancel = None;
    }
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Koona Pin: the update download failed: {error}");
            set(&app, UpdateStatus::Failed { problem: problem_of(&error), version });
            return;
        }
    };
    set(&app, UpdateStatus::Installing { version: version.clone() });
    if let Err(problem) = install(&app, &update, bytes).await {
        set(&app, UpdateStatus::Failed { version, problem });
    }
}

/// Windows: the plugin starts the installer, passive with `/UPDATE` and `/R`, and ends this
/// process; the installer keeps the library, the settings and the browsers' keys (hooks.nsh) and
/// starts the new version.
#[cfg(windows)]
async fn install(_app: &AppHandle, update: &Update, bytes: Vec<u8>) -> Result<(), UpdateProblem> {
    update.install(bytes).map_err(|error| {
        eprintln!("Koona Pin: the installer did not start: {error}");
        UpdateProblem::Failed
    })
}

/// Linux: the package through pkexec, then a restart into the new binary. The plugin's own install
/// would fall back to zenity and to sudo in a terminal when the password is not given; here a
/// closed password dialog is just that.
#[cfg(target_os = "linux")]
async fn install(app: &AppHandle, _update: &Update, bytes: Vec<u8>) -> Result<(), UpdateProblem> {
    tauri::async_runtime::spawn_blocking(move || linux::install(&bytes))
        .await
        .map_err(|_| UpdateProblem::Failed)??;
    app.restart()
}

#[cfg(not(any(windows, target_os = "linux")))]
async fn install(_app: &AppHandle, _update: &Update, _bytes: Vec<u8>) -> Result<(), UpdateProblem> {
    Err(UpdateProblem::Failed)
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::UpdateProblem;
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::path::PathBuf;
    use std::process::Command;
    use tauri::utils::config::BundleType;

    /// pkexec's exit code when the password dialog was dismissed.
    const DISMISSED: i32 = 126;

    /// The package manager of this package: Tauri marks the binary with its bundle type when it
    /// builds the .deb and the .rpm (build-linux-packages.mjs).
    pub fn manager() -> Option<(&'static str, &'static str, &'static str)> {
        match tauri::utils::platform::bundle_type()? {
            BundleType::Deb => Some(("dpkg", "-i", "deb")),
            BundleType::Rpm => Some(("rpm", "-U", "rpm")),
            _ => None,
        }
    }

    pub fn install(bytes: &[u8]) -> Result<(), UpdateProblem> {
        let (program, flag, extension) = manager().ok_or(UpdateProblem::InstallFailed)?;
        // A folder only this user can enter: another account cannot swap the file between this
        // write and the moment root reads it.
        let dir = folder().ok_or(UpdateProblem::Failed)?;
        let file = dir.join(format!("koonapin-update.{extension}"));
        let _ = std::fs::remove_file(&file);
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&file)
            .and_then(|mut f| f.write_all(bytes));
        if written.is_err() {
            return Err(UpdateProblem::Failed);
        }
        let status = Command::new("pkexec").arg(program).arg(flag).arg(&file).status();
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => {
                eprintln!("Koona Pin: pkexec {program} {flag} ended with {status}");
                Err(problem_of_exit(status.code()))
            }
            Err(error) => {
                eprintln!("Koona Pin: pkexec did not start: {error}");
                Err(UpdateProblem::InstallFailed)
            }
        }
    }

    /// 126: the dialog was dismissed; 127 and the rest: not authorized, no agent, or the
    /// package manager failed.
    pub fn problem_of_exit(code: Option<i32>) -> UpdateProblem {
        match code {
            Some(DISMISSED) => UpdateProblem::PasswordCancelled,
            _ => UpdateProblem::InstallFailed,
        }
    }

    fn folder() -> Option<PathBuf> {
        let base = dirs::runtime_dir().or_else(dirs::cache_dir)?;
        let dir = base.join(format!("koonapin-update-{}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).ok().map(|_| dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_is_tagged_for_the_interface() {
        let json = |status: UpdateStatus| serde_json::to_string(&status).unwrap();
        assert_eq!(json(UpdateStatus::Unknown), r#"{"state":"unknown"}"#);
        assert_eq!(
            json(UpdateStatus::Available { version: "0.3.0".into(), notes_url: format!("{RELEASE_PAGE}0.3.0") }),
            r#"{"state":"available","version":"0.3.0","notes_url":"https://github.com/andmetoo/koona-pin/releases/tag/v0.3.0"}"#
        );
        assert_eq!(
            json(UpdateStatus::Downloading { version: "0.3.0".into(), received: 10, total: None }),
            r#"{"state":"downloading","version":"0.3.0","received":10,"total":null}"#
        );
        assert_eq!(
            json(UpdateStatus::Failed { version: "0.3.0".into(), problem: UpdateProblem::PasswordCancelled }),
            r#"{"state":"failed","version":"0.3.0","problem":"password_cancelled"}"#
        );
    }

    #[test]
    fn plugin_failures_are_named() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(problem_of(&E::Network("Download request failed with status: 404".into())), UpdateProblem::NoConnection);
        assert_eq!(problem_of(&E::MissingSignedVersion), UpdateProblem::BadSignature);
        assert_eq!(
            problem_of(&E::SignedVersionMismatch { signed: "0.2.0".into(), announced: "0.3.0".into() }),
            UpdateProblem::BadSignature
        );
        assert_eq!(problem_of(&E::ReleaseNotFound), UpdateProblem::Failed);
    }

    #[test]
    fn the_key_and_the_releases_are_configured() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        assert_eq!(updater["endpoints"][0], "https://github.com/andmetoo/koona-pin/releases/latest/download/latest.json");
        // Only a signature made for the announced version is accepted (no downgrade by an old file).
        assert_eq!(updater["requireSignedVersion"], true);
        assert_eq!(updater["windows"]["installMode"], "passive");
        // The public key of NP-042, never the private one.
        let key = updater["pubkey"].as_str().unwrap();
        let decoded = String::from_utf8(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, key).unwrap()).unwrap();
        assert!(decoded.starts_with("untrusted comment: minisign public key"), "{decoded}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_dismissed_password_dialog_is_not_a_failed_install() {
        assert_eq!(linux::problem_of_exit(Some(126)), UpdateProblem::PasswordCancelled);
        assert_eq!(linux::problem_of_exit(Some(127)), UpdateProblem::InstallFailed);
        assert_eq!(linux::problem_of_exit(Some(1)), UpdateProblem::InstallFailed);
        assert_eq!(linux::problem_of_exit(None), UpdateProblem::InstallFailed);
    }
}
