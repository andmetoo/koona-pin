//! Links shared into Koona Pin from other apps (NP-071), on Android.
//!
//! The share sheet is the Kotlin `ShareActivity` (`app.koona.pin.share`), in a process of its own
//! (`:share`): no WebView, no Rust, no network, so it opens at once over the app that shares and
//! works while the app's own process is gone. It writes the link to the queue folder and closes;
//! the app takes the queue in when its library opens and whenever it comes back to the screen
//! (`share_queue.rs` in the app crate, which an iOS share extension will feed the same way).
//!
//! The queue: one JSON file per share, `<request_id>.json`, written as `<request_id>.json.tmp`,
//! synced to disk and renamed, so a file under its final name is complete:
//!
//! ```json
//! { "request_id": "<UUID v4>", "url": "https://…", "title": "…", "created_at": "<RFC 3339, UTC>" }
//! ```
//!
//! `title` is the sharing app's subject, empty when it gave none. The files in `queue-fixtures` are
//! the format's examples, read by the app crate's tests and written by the Kotlin side's.
//!
//! This crate only tells the app where the queue is: [`queue_folder`].

use std::path::PathBuf;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

/// The queue folder, asked of the Kotlin side once at start.
struct QueueFolder(Option<PathBuf>);

/// The folder the share sheet writes to; none where this build has no share sheet (iOS until its
/// extension exists) or the Kotlin side could not say.
pub fn queue_folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<QueueFolder>().and_then(|folder| folder.0.clone())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-share")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            {
                #[derive(serde::Deserialize)]
                struct Answer {
                    path: String,
                }
                let handle = _api.register_android_plugin("app.koona.pin.share", "KoonaSharePlugin")?;
                let folder = handle.run_mobile_plugin::<Answer>("queueFolder", ()).ok().map(|answer| PathBuf::from(answer.path));
                app.manage(QueueFolder(folder));
            }
            #[cfg(not(target_os = "android"))]
            app.manage(QueueFolder(None));
            Ok(())
        })
        .build()
}
