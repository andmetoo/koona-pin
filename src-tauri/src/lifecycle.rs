//! Whether the app is on the screen (NP-151). A phone suspends the app when it goes to the
//! background; the loops that wake on their own (the feed scheduler, the sync supervisor and its
//! watcher, the plan check, the library's maintenance) wait here until it comes back, so nothing
//! ticks behind the screen. A desktop window is never suspended: the gate stays open.

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::watch;

/// Managed from the start; [`set`] moves it on `Suspended` and `Resumed`, [`hold`] keeps it shut.
pub struct Lifecycle {
    on_screen: watch::Sender<bool>,
    held: std::sync::atomic::AtomicBool,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Lifecycle { on_screen: watch::Sender::new(true), held: Default::default() }
    }
}

/// A loop's view of the gate; cheap to clone into a task.
#[derive(Clone)]
pub struct Foreground(watch::Receiver<bool>);

impl Foreground {
    /// Always open: tests and code without the app.
    pub fn always() -> Self {
        Foreground(watch::channel(true).1)
    }

    pub fn is_on_screen(&self) -> bool {
        *self.0.borrow()
    }

    /// Returns at once on the screen; otherwise when the app is back.
    pub async fn wait(&mut self) {
        // A closed channel keeps its last value: open, or nothing will ever reopen it.
        let _ = self.0.wait_for(|on| *on).await;
    }

    /// Returns when the app leaves the screen; never on a desktop.
    pub async fn suspended(&mut self) {
        if self.0.wait_for(|on| !*on).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// [`Foreground::wait`] for a plain thread.
    pub fn wait_blocking(&mut self) {
        if !self.is_on_screen() {
            tauri::async_runtime::block_on(self.wait());
        }
    }
}

/// The gate of this app; open when the state is not managed (a test app).
pub fn foreground<R: Runtime>(app: &AppHandle<R>) -> Foreground {
    match app.try_state::<Lifecycle>() {
        Some(lifecycle) => Foreground(lifecycle.on_screen.subscribe()),
        None => Foreground::always(),
    }
}

/// The app came to the screen or left it.
pub fn set<R: Runtime>(app: &AppHandle<R>, on_screen: bool) {
    eprintln!("Koona Pin: {}", if on_screen { "back on the screen" } else { "behind the screen, the loops wait" });
    if let Some(lifecycle) = app.try_state::<Lifecycle>() {
        if !lifecycle.held.load(std::sync::atomic::Ordering::SeqCst) {
            lifecycle.on_screen.send_replace(on_screen);
        }
    }
}

/// Shuts the gate for this whole run: the app shows only a screen the interface cannot replace
/// (an Android WebView too old for it), so the library stays closed and no loop starts.
pub fn hold<R: Runtime>(app: &AppHandle<R>) {
    if let Some(lifecycle) = app.try_state::<Lifecycle>() {
        lifecycle.held.store(true, std::sync::atomic::Ordering::SeqCst);
        lifecycle.on_screen.send_replace(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_loop_waits_behind_the_screen_and_goes_on_when_the_app_is_back() {
        let lifecycle = Lifecycle::default();
        let mut gate = Foreground(lifecycle.on_screen.subscribe());
        tokio::time::timeout(Duration::from_millis(50), gate.wait()).await.expect("open at the start");
        lifecycle.on_screen.send_replace(false);
        tokio::time::timeout(Duration::from_millis(50), gate.suspended()).await.expect("sees the suspend");
        assert!(tokio::time::timeout(Duration::from_millis(50), gate.wait()).await.is_err(), "waits while suspended");
        let mut waiting = gate.clone();
        let back = tokio::spawn(async move { waiting.wait().await });
        lifecycle.on_screen.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), back).await.expect("goes on when resumed").unwrap();
    }

    #[tokio::test]
    async fn without_the_app_the_gate_is_always_open() {
        let mut gate = Foreground::always();
        assert!(gate.is_on_screen());
        tokio::time::timeout(Duration::from_millis(50), gate.wait()).await.expect("open");
        assert!(tokio::time::timeout(Duration::from_millis(50), gate.suspended()).await.is_err(), "never suspended");
    }
}
