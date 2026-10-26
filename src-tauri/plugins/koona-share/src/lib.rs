//! Links shared into Koona Pin from other apps (NP-071), on Android and iOS.
//!
//! The share sheet runs without the app: no WebView, no Rust, no network, so it opens at once over
//! the app that shares and works while the app's own process is gone. On Android it is the Kotlin
//! `ShareActivity` (`app.koona.pin.share`), in a process of its own (`:share`), writing to the
//! app's `filesDir/share-queue`; on iOS the share extension `app.koona.pin.share` (the Xcode target
//! `koonapin_Share`, its Swift in `ios-extension/`), writing to `share-queue` in the App Group
//! container `group.app.koona.pin`. It writes the link to the queue folder and closes; the app takes
//! the queue in when its library opens and whenever it comes back to the screen (`share_queue.rs`
//! in the app crate).
//!
//! The queue: one JSON file per share, `<request_id>.json`, written as `<request_id>.json.tmp`,
//! synced to disk and renamed, so a file under its final name is complete:
//!
//! ```json
//! { "request_id": "<UUID v4>", "url": "https://…", "title": "…", "created_at": "<RFC 3339, UTC>" }
//! ```
//!
//! `title` is the sharing app's subject, empty when it gave none. The files in `queue-fixtures` are
//! the format's examples, read by the app crate's tests and written by the Kotlin and Swift sides'.
//!
//! This crate only tells the app where the queue is ([`queue_folder`]) and when a share lands in
//! it while the app runs ([`on_queued`]).

use std::path::PathBuf;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

/// The queue folder, asked of the Kotlin or Swift side once at start.
struct QueueFolder(Option<PathBuf>);

/// The Kotlin or Swift side, for its events.
#[cfg(any(target_os = "android", target_os = "ios"))]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_koona_share);

/// The folder the share sheet writes to; none where this build has no share sheet (a computer) or
/// the native side could not say (on iOS: an app signed without the App Group).
pub fn queue_folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<QueueFolder>().and_then(|folder| folder.0.clone())
}

/// Calls `handler` whenever the share sheet queues a link while the app's process lives, also
/// with the app on the screen beside the app that shares (split screen, a pop-up window), which
/// brings no resume; on iOS the extension's Darwin notification, heard while the app is alive.
/// Nothing where there is no share sheet.
pub fn on_queued<R: Runtime>(app: &AppHandle<R>, handler: impl Fn() + Send + Sync + 'static) {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if let Some(native) = app.try_state::<Native<R>>() {
        #[derive(serde::Serialize)]
        struct Listener {
            event: &'static str,
            handler: tauri::ipc::Channel,
        }
        let channel = tauri::ipc::Channel::new(move |_| {
            handler();
            Ok(())
        });
        if let Err(error) = native.0.run_mobile_plugin::<()>("registerListener", Listener { event: "queued", handler: channel }) {
            eprintln!("Koona Pin: no word of new shares while the app runs: {error}");
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = (app, handler);
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-share")
        .setup(|app, _api| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                #[derive(serde::Deserialize)]
                struct Answer {
                    path: String,
                }
                #[cfg(target_os = "android")]
                let handle = _api.register_android_plugin("app.koona.pin.share", "KoonaSharePlugin")?;
                #[cfg(target_os = "ios")]
                let handle = _api.register_ios_plugin(init_plugin_koona_share)?;
                let folder = match handle.run_mobile_plugin::<Answer>("queueFolder", ()) {
                    Ok(answer) => Some(PathBuf::from(answer.path)),
                    Err(error) => {
                        eprintln!("Koona Pin: no queue for shared links: {error}");
                        None
                    }
                };
                app.manage(QueueFolder(folder));
                app.manage(Native(handle));
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.manage(QueueFolder(None));
            Ok(())
        })
        .build()
}
