//! What this build of the app can do (NP-072a), for the interface: shared code asks for a
//! capability, not for the system it runs on (docs/building.md). Not Tauri's capabilities (the
//! permissions in `src-tauri/capabilities`): these say which features exist at all.
//!
//! Built from `cfg` and the build's settings, and handed to the page before its own scripts run by
//! [`plugin`], registered on every platform: the page reads `window.__KOONA__` synchronously at
//! start (`src/platform/platform.ts`). The types are never `cfg`-gated, so `src/bindings` are the
//! same whichever target wrote them.

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;
use ts_rs::TS;

/// The system the app runs on. Only the shell is chosen by it; everything else asks
/// [`Capabilities`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Platform {
    Desktop,
    Android,
    Ios,
}

/// Who updates the app: itself (the desktop's updater), a store, or nobody.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum UpdateSource {
    #[serde(rename = "self")]
    Itself,
    Store,
    None,
}

/// How Supporter is bought: Paddle's checkout in the browser, or not at all in this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Purchase {
    Paddle,
    None,
}

/// What this build can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Capabilities {
    /// A file manager to show a file or a folder in.
    pub file_manager: bool,
    /// A tray (or menu bar) icon, and closing the window into it.
    pub tray: bool,
    /// The start at sign-in.
    pub autostart: bool,
    pub updates: UpdateSource,
    /// The browser extensions' host and the capture socket.
    pub browser_capture: bool,
    /// The MCP server for AI assistants.
    pub mcp: bool,
    /// Quitting from the app (the menu, `Ctrl Q`); a phone's system ends the app itself.
    pub quit: bool,
    /// The system's folder picker (a Supporter's backup folder).
    pub folder_picker: bool,
    /// Links shared into the app from other apps (NP-071).
    pub share_intake: bool,
    /// Haptic feedback.
    pub haptics: bool,
    pub purchase: Purchase,
}

/// What the page reads before its first render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AppInfo {
    pub platform: Platform,
    pub capabilities: Capabilities,
}

impl AppInfo {
    /// This build's.
    pub fn current() -> Self {
        let desktop = cfg!(desktop);
        AppInfo {
            platform: if cfg!(target_os = "android") {
                Platform::Android
            } else if cfg!(target_os = "ios") {
                Platform::Ios
            } else {
                Platform::Desktop
            },
            capabilities: Capabilities {
                file_manager: desktop,
                tray: desktop,
                autostart: desktop,
                updates: if desktop { UpdateSource::Itself } else { UpdateSource::Store },
                browser_capture: desktop,
                mcp: desktop,
                quit: desktop,
                folder_picker: desktop,
                share_intake: false,
                // The haptics plugin is registered on phones only (src/mobile).
                haptics: !desktop,
                purchase: purchase(desktop),
            },
        }
    }
}

/// How this build sells Supporter. A computer with the billing service: Paddle's checkout. A phone:
/// nothing until NP-154 — the Play build may sell only through Play Billing and must not link to
/// the Paddle checkout (Google Play's payments policy); the site's APK gets `Paddle` through its own
/// flavour (NP-074, NP-078). Signing in with the email code stays on phones, so someone who pays on
/// a computer is a Supporter on the phone too.
fn purchase(desktop: bool) -> Purchase {
    if desktop && crate::billing::service().is_some() {
        Purchase::Paddle
    } else {
        Purchase::None
    }
}

/// The script that hands [`AppInfo`] to the page, before the page's own scripts.
fn script(info: &AppInfo) -> String {
    let json = serde_json::to_string(info).expect("AppInfo serializes");
    format!("Object.defineProperty(window, '__KOONA__', {{ value: Object.freeze({json}), configurable: false }});")
}

/// A plugin of the app's own, on every platform: only its init script.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-app").js_init_script(script(&AppInfo::current())).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_build_can_do_what_a_desktop_does() {
        let info = AppInfo::current();
        assert_eq!(info.platform, Platform::Desktop);
        let c = info.capabilities;
        assert!(c.file_manager && c.tray && c.autostart && c.browser_capture && c.mcp && c.quit && c.folder_picker);
        assert_eq!(c.updates, UpdateSource::Itself);
        assert!(!c.share_intake && !c.haptics);
        let paddle = if crate::billing::service().is_some() { Purchase::Paddle } else { Purchase::None };
        assert_eq!(c.purchase, paddle);
    }

    #[test]
    fn a_phone_sells_nothing() {
        assert_eq!(purchase(false), Purchase::None);
    }

    #[test]
    fn the_script_defines_the_object_once() {
        let script = script(&AppInfo::current());
        assert!(script.starts_with("Object.defineProperty(window, '__KOONA__'"), "{script}");
        assert!(script.contains(r#""platform":"desktop""#), "{script}");
        assert!(script.contains(r#""updates":"self""#), "{script}");
        assert!(script.contains(r#""file_manager":true"#), "{script}");
    }
}
