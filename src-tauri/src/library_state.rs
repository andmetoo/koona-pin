//! The Tauri side of the library: the status the interface asks for, the
//! thread that opens the library, and periodic maintenance.
//!
//! The window appears at once; the library opens (and migrates) in the
//! background. Until it is ready `DbState` is not managed, so database
//! commands fail instead of touching the file, and the HTTP server does not
//! start.

use crate::{
    db::DbState,
    library::{self, Health, OpenFailure, Paths},
    server::{self, ServerState},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

/// Checked hourly; a copy is written when the newest one is a day old.
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
        let library = app.state::<Arc<Library>>().inner().clone();
        match library::open(&library.paths) {
            Ok(opened) => {
                crate::autostart::apply_default(&app, &opened.conn);
                let db = Arc::new(DbState::new(opened.conn));
                app.manage(db.clone());
                let status = app.state::<Arc<ServerState>>().inner().clone();
                server::start_server(app.clone(), db.clone(), status);
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
    loop {
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
                        moved_aside,
                    },
                );
                return;
            }
            Ok(Health::Intact { .. }) => {}
            Err(error) => eprintln!("Automatic backup failed: {error}"),
        }
        check = false;
        thread::sleep(MAINTENANCE_PERIOD);
    }
}
