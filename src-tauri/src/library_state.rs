//! The Tauri side of the library: the status the interface asks for, the
//! thread that opens the library, and periodic maintenance.
//!
//! The window appears at once; the library opens (and migrates) in the
//! background. Until it is ready `DbState` is not managed, so database
//! commands fail instead of touching the file, and the capture pipe does not
//! start.

#[cfg(desktop)]
use crate::capture_channel::{self, ChannelState};
use crate::{
    db::DbState,
    library::{self, Health, OpenFailure, Paths},
    trash,
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

/// Checked hourly; a copy is written when the newest one is a day old, and
/// the trash lets go of what it has kept 30 days.
const MAINTENANCE_PERIOD: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "state", rename_all = "lowercase")]
#[ts(export)]
pub enum LibraryStatus {
    Opening,
    Ready {
        /// The integrity check failed; the library is read-only.
        damaged: bool,
        /// Where a library of an earlier build was moved on this start.
        moved_aside: Option<String>,
    },
    Failed(OpenFailure),
}

pub struct Library {
    status: Mutex<LibraryStatus>,
    pub paths: Paths,
}

impl Library {
    pub fn new(paths: Paths) -> Self {
        Library {
            status: Mutex::new(LibraryStatus::Opening),
            paths,
        }
    }

    pub fn status(&self) -> LibraryStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set(&self, app: &AppHandle, status: LibraryStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        let _ = app.emit("library-status", status);
    }

    fn damaged(&self) -> bool {
        matches!(self.status(), LibraryStatus::Ready { damaged: true, .. })
    }

    /// After a restore into the open library (NP-034): intact and writable again.
    pub fn restored(&self, app: &AppHandle) {
        self.set(
            app,
            LibraryStatus::Ready {
                damaged: false,
                moved_aside: None,
            },
        );
    }

    pub fn begin_retry(&self) -> bool {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*status, LibraryStatus::Failed(_)) {
            *status = LibraryStatus::Opening;
            true
        } else {
            false
        }
    }
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        // Not while a phone shows only its WebView update screen (lifecycle::hold, NP-151).
        crate::lifecycle::foreground(&app).wait_blocking();
        let library = app.state::<Arc<Library>>().inner().clone();
        match library::open(&library.paths) {
            Ok(opened) => {
                // Linux turns the start with the session on at the first start (NP-097).
                #[cfg(target_os = "linux")]
                crate::autostart::xdg::apply_default(&opened.conn);
                let db = Arc::new(DbState::new(opened.conn));
                app.manage(db.clone());
                // The feed cache beside it (NP-128): its own file and lock.
                crate::feeds::cache::start(&app, &library.paths.folder());
                // The picture cache's sweep (NP-146): it needs both to know what is referred to.
                crate::thumbs::start(&app);
                // The browsers' pipe (NP-016); a phone has no browser extension to listen to.
                #[cfg(desktop)]
                capture_channel::start(app.clone(), db.clone(), app.state::<Arc<ChannelState>>().inner().clone());
                let moved_aside = opened
                    .moved_aside
                    .map(|path| path.to_string_lossy().into_owned());
                library.set(
                    &app,
                    LibraryStatus::Ready {
                        damaged: false,
                        moved_aside: moved_aside.clone(),
                    },
                );
                maintain(&app, &library, &db, moved_aside);
            }
            Err(failure) => {
                eprintln!(
                    "Cannot open the library ({}): {}",
                    failure.code, failure.detail
                );
                library.set(&app, LibraryStatus::Failed(failure));
            }
        }
    });
}

fn maintain(app: &AppHandle, library: &Library, db: &DbState, moved_aside: Option<String>) {
    let mut check = true;
    let mut foreground = crate::lifecycle::foreground(app);
    loop {
        // A phone's app behind the screen copies and tidies when it is back (NP-151).
        foreground.wait_blocking();
        // A damaged library gets no copies and no cleanup until it is restored.
        if library.damaged() {
            thread::sleep(MAINTENANCE_PERIOD);
            continue;
        }
        match library::maintain(&library.paths, chrono::Utc::now(), check) {
            Ok(Health::Damaged(problem)) => {
                eprintln!("The library is damaged: {problem}");
                // Writing to a damaged file can make it worse. Captures now
                // fail, so the extension keeps links in its queue.
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.pragma_update(None, "query_only", true);
                }
                library.set(
                    app,
                    LibraryStatus::Ready {
                        damaged: true,
                        moved_aside: moved_aside.clone(),
                    },
                );
                continue;
            }
            // A Supporter's chosen folder gets the same copy (commercial/backup_folder.rs).
            Ok(Health::Intact { copied: Some(copy) }) => crate::commercial::backup_folder::mirror(app, &copy),
            Ok(Health::Intact { copied: None }) => {}
            Err(error) => eprintln!("Automatic backup failed: {error}"),
        }
        // After the copy: what the cleanup deletes is still in the newest one.
        let tidied = match db.conn.lock() {
            Ok(conn) => trash::tidy(&conn, chrono::Utc::now()),
            Err(_) => Ok(Vec::new()),
        };
        match tidied {
            // Silent (Р-22): the trash count simply goes down.
            Ok(gone) if !gone.is_empty() => {
                let _ = app.emit("library-invalidated", ());
            }
            Ok(_) => {}
            Err(error) => eprintln!("Emptying the trash failed, will try again: {error}"),
        }
        // Read a week ago or earlier: out of Reading (NP-121), as quietly.
        let read = match db.conn.lock() {
            Ok(conn) => crate::reading::tidy(&conn, chrono::Utc::now()),
            Err(_) => Ok(Vec::new()),
        };
        match read {
            Ok(ids) if !ids.is_empty() => {
                let _ = app.emit("library-invalidated", ());
            }
            Ok(_) => {}
            Err(error) => eprintln!("Tidying Reading failed, will try again: {error}"),
        }
        // Offline copies and their rows agree (NP-126): a purge synced from
        // another device leaves a folder, a folder removed by hand leaves a row.
        let swept = match db.conn.lock() {
            Ok(conn) => crate::offline::sweep(&conn),
            Err(_) => Ok(0),
        };
        match swept {
            Ok(rows) if rows > 0 => {
                let _ = app.emit("library-invalidated", ());
            }
            Ok(_) => {}
            Err(error) => eprintln!("Sweeping offline copies failed, will try again: {error}"),
        }
        check = false;
        thread::sleep(MAINTENANCE_PERIOD);
    }
}
