//! Koona Pin on phones (NP-151): what the system does around the page, and Tauri does not.
//!
//! - **System Back** (Android) and the **edge swipe from the left** (iOS) ask the page to go back
//!   one level (`window.__KOONA_MOBILE__.back()`, which `src/platform/back.ts` provides). With
//!   nothing to close, Android moves the app to the background; it never exits.
//! - **Renderer loss** (Android): a WebView whose renderer died cannot be used again, so the app
//!   starts afresh, on the screen if it was there. What was committed is in the library.
//!   (iOS reloads the page through Tauri's own hook, in the app.)
//! - **Insets** (Android): the system bars, the cutout and the keyboard as `--kp-inset-*` CSS
//!   variables, for WebViews whose `env(safe-area-inset-*)` stays zero in an edge-to-edge window
//!   (iOS: the keyboard only).
//!
//! - **An old WebView** (Android): the interface needs Chromium 111. With an older one the plugin
//!   shows a native «Update Android System WebView» screen instead of the page, and
//!   [`webview_supported`] tells the app so, which then starts nothing behind it.
//! - **The look's signals** (Android, NP-072b): battery saver and a low-RAM device (the glass drawn
//!   flat) and the text scale, through the bridge (`system()`, the `koona-system` event), read
//!   before the page's first render. iOS sends Low Power Mode as battery saver and Reduce
//!   Transparency as the page loads and when they change.
//! - **iOS only:** the keyboard's height as the bottom inset (the WebView's own scroll pinned), the
//!   status bar following the page's theme, and iOS 27.1's vertical bar on iPhone Duo (`barChanged`,
//!   src/platform/verticalBar.ts).
//! - **Haptics** (NP-072b): the one command, `haptic`, plays the page's feedback as the system's
//!   own (Android `performHapticFeedback`, iOS UIKit's generators), which follows the system's
//!   touch-feedback setting.
//!
//! The page learns its platform from the app's own init script (`window.__KOONA__`, NP-072a), not
//! from this bridge; the bridge only knows it to tell whether a Back is Android's.

use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

/// Whether the WebView runs the interface, asked of the Kotlin side once at start.
struct WebViewSupport(bool);

/// False only on an Android phone whose WebView is too old for the interface; true everywhere
/// else, and when the plugin could not tell.
pub fn webview_supported<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<WebViewSupport>().is_none_or(|support| support.0)
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_koona_mobile);

const PLATFORM: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "ios"
} else {
    "desktop"
};

/// The bridge with this build's platform filled in, for its own `claim`.
fn bridge() -> String {
    include_str!("bridge.js").replace("__PLATFORM__", PLATFORM)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-mobile")
        .js_init_script(bridge())
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                #[derive(serde::Deserialize)]
                struct Answer {
                    supported: bool,
                }
                let handle = _api.register_android_plugin("app.koona.pin.mobile", "KoonaMobilePlugin")?;
                let supported = handle.run_mobile_plugin::<Answer>("webViewSupport", ()).map_or(true, |answer| answer.supported);
                _app.manage(WebViewSupport(supported));
            }
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_koona_mobile)?;
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_fills_in_the_platform_and_leaves_naming_it_to_the_app() {
        let bridge = super::bridge();
        assert!(!bridge.contains("__PLATFORM__"));
        assert!(bridge.contains(&format!("'{}' !== 'android'", super::PLATFORM)));
        assert!(!bridge.contains("platform:"), "the page reads its platform from window.__KOONA__");
    }
}
