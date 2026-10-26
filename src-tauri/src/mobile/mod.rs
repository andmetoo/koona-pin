//! What only a phone has (NP-151, NP-072a): the app's own folders, the plugin for system Back,
//! renderer loss and the insets, the suspend and resume of the loops, and the end of a run. `run()`
//! reaches this module as `platform` on a phone build; `crate::desktop` exports the same functions.

use crate::{db, feeds, library, lifecycle};
use std::sync::Arc;
use tauri::Manager;

/// Nothing to hand over: a phone starts one copy of the app.
pub fn hand_over(_context: &tauri::Context<tauri::Wry>) -> bool {
    false
}

/// System Back, the iOS edge swipe, renderer loss and the insets (NP-151); the signals of the
/// phone's look and haptic feedback (NP-072b, src/platform/system.ts and haptics.ts); the share
/// sheet (NP-071).
pub fn plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let builder = builder.plugin(tauri_plugin_koona_mobile::init());
    // Links shared from other apps (NP-071): the share sheet's queue folder, taken in by share_queue.rs.
    let builder = builder.plugin(tauri_plugin_koona_share::init());
    // The Play build's purchases (NP-154, billing/play.rs): Play Billing, under the commercial license.
    #[cfg(play)]
    let builder = builder.plugin(tauri_plugin_koona_play::init());
    // The App Store build's purchases (billing/appstore.rs): StoreKit 2, under the commercial license.
    #[cfg(appstore)]
    let builder = builder.plugin(tauri_plugin_koona_appstore::init());
    // iOS ended the page's WebContent process (memory, a crash): the same page again, which
    // reads the library anew. What was committed is in the library already.
    #[cfg(target_os = "ios")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        eprintln!("Koona Pin: the WebContent process ended, reloading the page");
        let _ = webview.reload();
    });
    builder
}

/// Where the library lives (NP-151): everything in the app's own folders the system gives, the
/// picture cache in its cache folder; a folder it cannot name stops the start.
pub fn library_paths(app: &tauri::App) -> tauri::Result<library::Paths> {
    let folders = app.path();
    Ok(library::Paths::in_app_folders(&folders.app_data_dir()?, &folders.app_cache_dir()?))
}

/// Before the shared starts: an Android WebView too old for the interface gets the plugin's update
/// screen; nothing starts behind it: the library stays closed and the loops wait for good (NP-151).
/// The share sheet's queue is known before the library opens, which takes it in (NP-071); a share
/// made while the app runs is taken in at once, also when the app stays on the screen beside the
/// app that shares (split screen, a pop-up window), which brings no resume.
pub fn prepare(app: &tauri::App) {
    crate::share_queue::manage(app, tauri_plugin_koona_share::queue_folder(app.handle()));
    let handle = app.handle().clone();
    tauri_plugin_koona_share::on_queued(app.handle(), move || crate::share_queue::ingest(&handle));
    #[cfg(target_os = "android")]
    if !tauri_plugin_koona_mobile::webview_supported(app.handle()) {
        lifecycle::hold(app.handle());
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

/// After the shared starts: the window; a phone has no browser host, tray or updater.
pub fn setup(app: &tauri::App, _channel_state: Arc<crate::capture_channel::ChannelState>) -> tauri::Result<()> {
    crate::show_window(app.handle());
    Ok(())
}

/// A phone put the app behind the screen or brought it back (NP-151): the loops wait meanwhile,
/// and the interface reads its counts and list again on the way back (`tauri://resumed`). Links
/// shared meanwhile are taken in then, and when the window gets the focus back (NP-071).
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Suspended => lifecycle::set(window.app_handle(), false),
        tauri::WindowEvent::Resumed => {
            lifecycle::set(window.app_handle(), true);
            crate::share_queue::ingest(window.app_handle());
        }
        tauri::WindowEvent::Focused(true) => crate::share_queue::ingest(window.app_handle()),
        _ => {}
    }
}

/// The system finished the activity: the run ends here.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::Exit = event {
        end_on_phone(app);
    }
}

/// The end of a phone's run (NP-151): the system finished the activity. The process ends here, without
/// the exit handlers, which would tear down what the runtime's and the library's threads may still use (a
/// "lock of a destroyed mutex" abort, seen once in NP-150). The library's and the feed cache's locks are
/// taken first when they come within [`END_WAIT`], so no write is cut in half; a write that holds one longer
/// is cut, and SQLite's journal rolls it back at the next start. What was committed is in the files.
fn end_on_phone(app: &tauri::AppHandle) -> ! {
    eprintln!("Koona Pin: the app ends");
    let library = app.try_state::<Arc<db::DbState>>().map(|state| state.inner().clone());
    let feeds = app.try_state::<Arc<feeds::cache::FeedCache>>().map(|state| state.inner().clone());
    let deadline = std::time::Instant::now() + END_WAIT;
    let _library = library.as_ref().and_then(|state| lock_until(&state.conn, deadline));
    let _feeds = feeds.as_ref().and_then(|state| lock_until(&state.conn, deadline));
    // SAFETY: `_exit` only ends the process; nothing after it runs.
    unsafe { libc::_exit(0) }
}

/// How long the end of a phone's run waits for writes in progress, at most.
const END_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// The lock, if it comes before `deadline`; the main thread never waits on it for good.
fn lock_until<T>(mutex: &std::sync::Mutex<T>, deadline: std::time::Instant) -> Option<std::sync::MutexGuard<'_, T>> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(std::sync::TryLockError::WouldBlock) => return None,
        }
    }
}
