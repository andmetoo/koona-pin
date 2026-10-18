//! The tray icon and its menu. The words come from the interface, in its
//! language, at start and on every switch; until then they are English, the
//! source language of the app (NP-085, Р-8).

use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, Wry,
};
use ts_rs::TS;

const ID: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    pub tooltip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        TrayLabels {
            open: "Open Koona Pin".into(),
            quit: "Quit".into(),
            tooltip: "Koona Pin — your link library".into(),
        }
    }
}

pub struct Tray {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    labels: Mutex<TrayLabels>,
}

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let labels = TrayLabels::default();
    let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    // On Linux the menu is all the icon has (sheet 40): «Open» first, then a line.
    #[cfg(target_os = "linux")]
    let menu = Menu::with_items(app, &[&open, &tauri::menu::PredefinedMenuItem::separator(app)?, &quit])?;
    #[cfg(not(target_os = "linux"))]
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id(ID)
        .menu(&menu)
        .tooltip(&labels.tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        // Windows only: Tauri 2 sends no click of the icon on Linux.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_window(tray.app_handle());
            }
        });
    // macOS: the one-colour mark as a template image, painted by the system for the bar and its
    // theme (scripts/brand-icons.mjs). Elsewhere the app's icon.
    #[cfg(target_os = "macos")]
    {
        tray = tray
            .icon(tauri::include_image!("icons/tray-macos.png"))
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Tray {
        open,
        quit,
        labels: Mutex::new(labels),
    });
    Ok(())
}

/// The menu and the tooltip in the interface's language.
#[tauri::command]
pub async fn set_tray_labels(
    app: AppHandle,
    tray: State<'_, Tray>,
    labels: TrayLabels,
) -> Result<(), CommandError> {
    tray.open
        .set_text(&labels.open)
        .map_err(CommandError::internal)?;
    tray.quit
        .set_text(&labels.quit)
        .map_err(CommandError::internal)?;
    if let Some(icon) = app.tray_by_id(ID) {
        icon.set_tooltip(Some(&labels.tooltip))
            .map_err(CommandError::internal)?;
    }
    *tray.labels.lock().map_err(CommandError::internal)? = labels;
    Ok(())
}

/// What the tray says now: the native tests read it, a menu cannot be.
#[tauri::command]
pub async fn get_tray_labels(tray: State<'_, Tray>) -> Result<TrayLabels, CommandError> {
    Ok(tray.labels.lock().map_err(CommandError::internal)?.clone())
}
