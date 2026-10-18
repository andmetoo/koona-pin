//! Koona Pin on phones (NP-151): what the system does around the page, and Tauri does not.
//!
//! - **System Back** (Android) and the **edge swipe from the left** (iOS) ask the page to go back
//!   one level (`window.__KOONA_MOBILE__.back()`, which `src/services/platform.ts` provides). With
//!   nothing to close, Android moves the app to the background; it never exits.
//! - **Renderer loss** (Android): a WebView whose renderer died cannot be used again, so the app
//!   starts afresh, on the screen if it was there. What was committed is in the library.
//!   (iOS reloads the page through Tauri's own hook, in the app.)
//! - **Insets** (Android): the system bars, the cutout and the keyboard as `--kp-inset-*` CSS
//!   variables, for WebViews whose `env(safe-area-inset-*)` stays zero in an edge-to-edge window.
//!
//! The bridge script also tells the page its platform before the page's own scripts run.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_koona_mobile);

const PLATFORM: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "ios"
} else {
    "desktop"
};

/// The bridge with this build's platform filled in.
fn bridge() -> String {
    include_str!("bridge.js").replace("__PLATFORM__", PLATFORM)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-mobile")
        .js_init_script(bridge())
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("app.koona.pin.mobile", "KoonaMobilePlugin")?;
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_koona_mobile)?;
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_names_the_platform() {
        let bridge = super::bridge();
        assert!(!bridge.contains("__PLATFORM__"));
        assert!(bridge.contains(&format!("platform: '{}'", super::PLATFORM)));
    }
}
