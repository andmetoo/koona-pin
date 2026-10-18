//! The desktop around the window (NP-053, Р-52): which window buttons the
//! system wants and on which side, whether a tray shows the icon, and how a
//! second start brings the window forward.
//!
//! Windows keeps its own buttons and always has the tray. On Linux the buttons
//! follow `gtk-decoration-layout`, Hyprland tiles the window without them, and
//! a desktop without a StatusNotifier host (Fedora's GNOME without the
//! AppIndicator extension) has no tray at all.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum WindowButton {
    Minimize,
    Maximize,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Desktop {
    /// The system draws the title bar and window controls (macOS).
    pub native_frame: bool,
    /// The buttons follow the system: round, by its layout (sheet 40).
    pub linux: bool,
    /// Window buttons at the start of the window bar and at its end, in order.
    pub left: Vec<WindowButton>,
    pub right: Vec<WindowButton>,
    /// A tray shows the icon. Without one, closing the window only hides it
    /// and the app keeps running in the background (NP-096).
    pub tray: bool,
    /// Started from an AppImage (NP-116): an update replaces the file and needs
    /// no password, unlike the .deb and .rpm.
    pub appimage: bool,
}

/// Passed by a second start to the first one: the token the launcher gave the
/// second process, so the compositor lets the first one take the focus.
pub const ACTIVATION_ARG: &str = "--activation-token=";

/// The token a second start passed along, if any.
pub fn activation_token(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(ACTIVATION_ARG))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

/// The buttons of a GTK `gtk-decoration-layout`, before and after the colon:
/// `appmenu:minimize,maximize,close`. Names the window bar has no use for
/// (`icon`, `menu`, `appmenu`, `spacer`) are skipped. A layout with no button
/// at all still gets «×»: the window must stay closable with the mouse.
pub fn parse_layout(layout: &str) -> (Vec<WindowButton>, Vec<WindowButton>) {
    let side = |part: &str| {
        let mut buttons = Vec::new();
        for name in part.split(',') {
            let button = match name.trim() {
                "minimize" => WindowButton::Minimize,
                "maximize" => WindowButton::Maximize,
                "close" => WindowButton::Close,
                _ => continue,
            };
            if !buttons.contains(&button) {
                buttons.push(button);
            }
        }
        buttons
    };
    let (left, right) = match layout.split_once(':') {
        Some((left, right)) => (side(left), side(right)),
        None => (side(layout), Vec::new()),
    };
    if left.is_empty() && right.is_empty() {
        return (Vec::new(), vec![WindowButton::Close]);
    }
    (left, right)
}

/// A tray shows the icon: always on Windows, on Linux when a StatusNotifier
/// host runs. Without it the window explains once that it only hides (NP-096).
pub fn tray_shown() -> bool {
    #[cfg(target_os = "linux")]
    return linux::tray_shown();
    #[cfg(not(target_os = "linux"))]
    true
}

#[tauri::command]
pub async fn get_desktop(app: AppHandle) -> Desktop {
    #[cfg(target_os = "linux")]
    return linux::desktop(&app).await;
    #[cfg(not(target_os = "linux"))]
    {
        let native_frame = app
            .get_webview_window("main")
            .is_some_and(|window| window.is_decorated().unwrap_or(false));
        Desktop {
            native_frame,
            linux: false,
            left: Vec::new(),
            right: if native_frame {
                Vec::new()
            } else {
                vec![WindowButton::Minimize, WindowButton::Maximize, WindowButton::Close]
            },
            tray: true,
            appimage: false,
        }
    }
}

/// Hides the window into the tray or the background, at once. Windows plays its
/// own transition for a hidden window, and on this frameless WebView2 window it
/// stutters; transitions stay off while the window is hidden and come back in
/// [`crate::show`], so minimizing and showing keep their animation.
pub fn hide<R: tauri::Runtime>(window: &tauri::Window<R>) -> tauri::Result<()> {
    #[cfg(windows)]
    transitions(window, false);
    window.hide()
}

/// Windows' own show, hide and minimize animations of the window.
#[cfg(windows)]
pub fn transitions<R: tauri::Runtime>(window: &tauri::Window<R>, on: bool) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let disabled = i32::from(!on);
    // The handle is the live window's; the value is a BOOL the call only reads.
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const i32 as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };
}

/// Shows the window over the others, with the focus. On Wayland a window may
/// take the focus only with a token from the launcher (xdg-activation): the
/// second start hands its token over.
pub fn bring_forward(app: &AppHandle, token: Option<String>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(target_os = "linux")]
    if let Some(token) = token {
        let _ = app.run_on_main_thread(move || {
            linux::use_activation_token(&window, &token);
            crate::show(&window);
        });
        return;
    }
    let _ = token;
    crate::show(&window);
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::{parse_layout, Desktop, WindowButton};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::AppHandle;

    /// The StatusNotifier host's name on the session bus: KDE, the
    /// AppIndicator extension of GNOME and waybar's tray module all own it.
    const WATCHER: &str = "org.kde.StatusNotifierWatcher";

    fn session() -> Option<&'static zbus::blocking::Connection> {
        static SESSION: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
        SESSION
            .get_or_init(|| zbus::blocking::Connection::session().ok())
            .as_ref()
    }

    fn has_owner(name: &str) -> Option<bool> {
        let dbus = zbus::blocking::fdo::DBusProxy::new(session()?).ok()?;
        let name = zbus::names::BusName::try_from(name).ok()?;
        dbus.name_has_owner(name).ok()
    }

    /// Asked every time: the user can turn the extension on while the app runs.
    pub fn tray_shown() -> bool {
        has_owner(WATCHER).unwrap_or(false)
    }

    pub async fn desktop(app: &AppHandle) -> Desktop {
        let tray = tauri::async_runtime::spawn_blocking(tray_shown)
            .await
            .unwrap_or(false);
        let (left, right) = if hyprland() {
            // A tile is placed and sized by Hyprland: no buttons; a floating
            // window gets «×» (sheet 40). Unknown is treated as floating.
            let floating = tauri::async_runtime::spawn_blocking(hyprland_floating)
                .await
                .ok()
                .flatten();
            if floating == Some(false) {
                (Vec::new(), Vec::new())
            } else {
                (Vec::new(), vec![WindowButton::Close])
            }
        } else {
            parse_layout(&decoration_layout(app).await.unwrap_or_default())
        };
        Desktop {
            native_frame: false,
            linux: true,
            left,
            right,
            tray,
            appimage: crate::desktop::appimage::file().is_some(),
        }
    }

    /// GtkSettings, read on the main thread: GNOME's `button-layout`, or what
    /// kde-gtk-config writes from KWin's settings.
    async fn decoration_layout(app: &AppHandle) -> Option<String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use gtk::prelude::ObjectExt;
            let layout = gtk::Settings::default()
                .and_then(|settings| settings.property::<Option<String>>("gtk-decoration-layout"));
            let _ = tx.send(layout);
        })
        .ok()?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .ok()?
            .ok()
            .flatten()
    }

    fn hyprland() -> bool {
        std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktops| {
            desktops
                .split(':')
                .any(|desktop| desktop.eq_ignore_ascii_case("hyprland"))
        })
    }

    /// Asks Hyprland over its socket whether this process's window floats.
    fn hyprland_floating() -> Option<bool> {
        let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
        let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
        let socket = [
            PathBuf::from(runtime).join("hypr"),
            PathBuf::from("/tmp/hypr"),
        ]
        .into_iter()
        .map(|dir| dir.join(&signature).join(".socket.sock"))
        .find(|path| path.exists())?;
        let mut stream = UnixStream::connect(socket).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
        stream.write_all(b"j/clients").ok()?;
        let mut clients = String::new();
        stream.read_to_string(&mut clients).ok()?;
        floating_in(&clients, std::process::id())
    }

    /// `floating` of the window of `pid` in the answer to `j/clients`.
    pub fn floating_in(clients: &str, pid: u32) -> Option<bool> {
        let clients: Vec<serde_json::Value> = serde_json::from_str(clients).ok()?;
        clients
            .iter()
            .find(|client| client["pid"].as_u64() == Some(u64::from(pid)))?["floating"]
            .as_bool()
    }

    /// A start from the app menu while Koona Pin runs: hands the launcher's
    /// activation token to the first instance together with the arguments,
    /// the way the single-instance plugin does but with the token added.
    /// `false` when there is no token or no first instance: the plugin then
    /// does the rest.
    pub fn hand_over(identifier: &str) -> bool {
        let Some(token) = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"]
            .iter()
            .find_map(|name| std::env::var(name).ok())
            .filter(|token| !token.is_empty())
        else {
            return false;
        };
        // The plugin's names (tauri-plugin-single-instance 2.5, linux.rs).
        let name = format!("{identifier}.SingleInstance");
        let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
        if has_owner(&name) != Some(true) {
            return false;
        }
        let Some(session) = session() else {
            return false;
        };
        let mut args: Vec<String> = std::env::args().collect();
        args.push(format!("{}{token}", super::ACTIVATION_ARG));
        let cwd = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        session
            .call_method(
                Some(name.as_str()),
                path.as_str(),
                Some("org.SingleInstance.DBus"),
                "ExecuteCallback",
                &(args, cwd),
            )
            .is_ok()
    }

    extern "C" {
        // libgdk-3 since 3.22, built with the Wayland backend on every distribution.
        fn gdk_wayland_display_set_startup_notification_id(
            display: *mut gtk::gdk::ffi::GdkDisplay,
            startup_id: *const std::os::raw::c_char,
        );
    }

    /// The next present of the window uses the token: xdg-activation on
    /// Wayland, startup notification on X11. On the main thread.
    pub fn use_activation_token(window: &tauri::WebviewWindow, token: &str) {
        use gtk::glib::translate::ToGlibPtr;
        use gtk::prelude::{GtkWindowExt, ObjectExt, WidgetExt};
        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        let display = gtk_window.display();
        if display.type_().name() == "GdkWaylandDisplay" {
            let Ok(token) = std::ffi::CString::new(token) else {
                return;
            };
            let display: *mut gtk::gdk::ffi::GdkDisplay = display.to_glib_none().0;
            // SAFETY: a live Wayland display and a NUL-terminated string GDK copies.
            unsafe { gdk_wayland_display_set_startup_notification_id(display, token.as_ptr()) };
        } else {
            gtk_window.set_startup_id(token);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::floating_in;

        #[test]
        fn finds_the_window_of_this_process_among_hyprland_clients() {
            let clients = r#"[{"pid":10,"floating":true},{"pid":42,"floating":false}]"#;
            assert_eq!(floating_in(clients, 42), Some(false));
            assert_eq!(floating_in(clients, 10), Some(true));
            assert_eq!(floating_in(clients, 7), None);
            assert_eq!(floating_in("not json", 42), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{activation_token, parse_layout, WindowButton::*};

    #[test]
    fn reads_the_layouts_of_gnome_ubuntu_kde_and_buttons_on_the_left() {
        assert_eq!(parse_layout("appmenu:close"), (vec![], vec![Close]));
        assert_eq!(
            parse_layout("appmenu:minimize,maximize,close"),
            (vec![], vec![Minimize, Maximize, Close])
        );
        assert_eq!(
            parse_layout("icon:minimize,maximize,close"),
            (vec![], vec![Minimize, Maximize, Close])
        );
        assert_eq!(
            parse_layout("close,minimize,maximize:"),
            (vec![Close, Minimize, Maximize], vec![])
        );
        assert_eq!(
            parse_layout("close,spacer,minimize"),
            (vec![Close, Minimize], vec![])
        );
    }

    #[test]
    fn a_layout_without_buttons_still_closes() {
        assert_eq!(parse_layout(""), (vec![], vec![Close]));
        assert_eq!(parse_layout("appmenu:"), (vec![], vec![Close]));
        assert_eq!(parse_layout(":close,close"), (vec![], vec![Close]));
    }

    #[test]
    fn takes_the_activation_token_a_second_start_passed() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(
            activation_token(&args(&[
                "/usr/bin/koonapin",
                "--activation-token=abc_TIME123"
            ])),
            Some("abc_TIME123".into())
        );
        assert_eq!(activation_token(&args(&["/usr/bin/koonapin"])), None);
        assert_eq!(
            activation_token(&args(&["koonapin", "--activation-token="])),
            None
        );
    }
}
