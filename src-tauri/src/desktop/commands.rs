//! The commands only a desktop has (NP-072a): the file manager, the tray and closing to it, the
//! start at sign-in, quitting, browser capture and the MCP server's settings. Registered in the
//! desktop block of `crate::ipc`; a phone never gets them.

use super::{capture_server, mcp, mcp_tools};
use crate::{
    backup,
    browsers::CaptureStatus,
    capture_channel::ChannelState,
    commands::{blocking, over_main_window, text, LastExport, Place},
    db::{self, DbState},
    error::{CommandError, ErrorCode, ErrorDetail},
    library_state::{Library, LibraryStatus},
    offline,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

/// «Показать» after an export: Explorer with the file selected.
#[tauri::command]
pub fn reveal_export(app: AppHandle, last: State<'_, LastExport>) -> Result<(), CommandError> {
    let path = last.0.lock().map_err(CommandError::internal)?.clone();
    let path = path.ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::NothingExported, "Nothing was exported yet"))?;
    app.opener().reveal_item_in_dir(path).map_err(CommandError::internal)
}

/// «Show folder»: the folder of copies, made if there is none yet.
#[tauri::command]
pub async fn reveal_offline_folder(app: AppHandle, state: State<'_, Arc<DbState>>) -> Result<(), CommandError> {
    let root = blocking(&state, |conn| offline::root(conn).ok_or_else(|| CommandError::internal("the library has no folder"))).await?;
    std::fs::create_dir_all(&root).map_err(CommandError::internal)?;
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(CommandError::internal)
}

#[tauri::command]
pub async fn set_close_to_tray(
    state: State<'_, Arc<DbState>>,
    enabled: bool,
) -> Result<(), CommandError> {
    blocking(&state, move |conn| {
        db::set_setting(
            conn,
            "close_to_tray",
            if enabled { "true" } else { "false" },
        )
        .map_err(text)
    })
    .await?;
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// «Hide window» in the dialog of the first close without a tray (NP-096):
/// from then on closing just hides the window.
#[tauri::command]
pub async fn hide_to_background(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
) -> Result<(), CommandError> {
    blocking(&state, |conn| {
        db::set_setting(conn, "background_explained", "true").map_err(text)
    })
    .await?;
    state.background_explained.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        super::hide(&window.as_ref().window()).map_err(CommandError::internal)?;
    }
    Ok(())
}

/// Which browsers are connected; the sidebar and Settings → Browser (NP-016).
#[tauri::command]
pub fn get_capture_status(state: State<'_, Arc<ChannelState>>) -> CaptureStatus {
    state.status(chrono::Utc::now())
}

/// «Повторить» when capture cannot work: registers the host again and reopens
/// the pipe if it failed.
#[tauri::command]
pub async fn repair_capture(
    app: AppHandle,
    state: State<'_, Arc<ChannelState>>,
) -> Result<CaptureStatus, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        capture_server::register_host(&app, &state);
        if state.channel_failed() {
            if let Some(db) = app.try_state::<Arc<DbState>>() {
                capture_server::start(app.clone(), db.inner().clone(), state.clone());
            }
        }
        state.status(chrono::Utc::now())
    })
    .await
    .map_err(CommandError::internal)
}

/// Paths come from the app, never from the page.
#[tauri::command]
pub fn reveal_library_place(
    app: AppHandle,
    library: State<'_, Arc<Library>>,
    place: Place,
) -> Result<(), CommandError> {
    let opener = app.opener();
    let paths = &library.paths;
    let shown = match place {
        Place::Data => opener.open_path(paths.folder().to_string_lossy(), None::<&str>),
        Place::Backups => {
            std::fs::create_dir_all(&paths.backups).map_err(CommandError::internal)?;
            opener.open_path(paths.backups.to_string_lossy(), None::<&str>)
        }
        Place::Backup => match library.status() {
            LibraryStatus::Failed(failure) if failure.backup.is_some() => {
                opener.reveal_item_in_dir(failure.backup.unwrap_or_default())
            }
            _ => opener.open_path(paths.backups.to_string_lossy(), None::<&str>),
        },
    };
    shown.map_err(CommandError::internal)
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Linux keeps its own XDG autostart entry (`autostart::xdg`, NP-097).
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, CommandError> {
    #[cfg(target_os = "linux")]
    return {
        let _ = app;
        Ok(super::autostart::xdg::is_enabled())
    };
    #[cfg(not(target_os = "linux"))]
    app.autolaunch()
        .is_enabled()
        .map_err(CommandError::internal)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    #[cfg(target_os = "linux")]
    return {
        let _ = app;
        if enabled {
            super::autostart::xdg::enable()
        } else {
            super::autostart::xdg::disable()
        }
        .map_err(CommandError::internal)
    };
    #[cfg(not(target_os = "linux"))]
    {
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(CommandError::internal)
    }
}

/// «Show» after a restore: Explorer with the copy of the replaced library selected.
#[tauri::command]
pub fn reveal_backup(app: AppHandle, library: State<'_, Arc<Library>>, file_name: String) -> Result<(), CommandError> {
    let path = backup::listed(&library.paths.backups, &file_name)
        .ok_or_else(|| CommandError::detailed(ErrorCode::NotFound, ErrorDetail::CopyGone, "The copy is gone"))?;
    app.opener().reveal_item_in_dir(path).map_err(CommandError::internal)
}

/// Settings → AI assistants (NP-091): access and the last request.
#[tauri::command]
pub async fn get_mcp_status(state: State<'_, Arc<DbState>>) -> Result<mcp::McpStatus, CommandError> {
    blocking(&state, |conn| Ok(mcp::status(conn))).await
}

/// Off, read only, or read and add; the settings and every open window hear of it.
#[tauri::command]
pub async fn set_mcp_access(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    access: mcp_tools::Access,
) -> Result<mcp::McpStatus, CommandError> {
    let status = blocking(&state, move |conn| {
        mcp::set_access(conn, access)?;
        Ok(mcp::status(conn))
    })
    .await?;
    let _ = app.emit("mcp-status", status.clone());
    Ok(status)
}

/// «How to connect…»: the commands and JSON with this computer's path.
#[tauri::command]
pub fn get_mcp_setup() -> Result<mcp::McpSetup, CommandError> {
    mcp::server_path().map(|server| mcp::setup(&server)).map_err(CommandError::internal)
}

/// «Save for Claude Desktop…»: `koona-pin.mcpb` where the person saves it,
/// Downloads by default, then shown in the file manager. Opening the file
/// from the app failed: on Windows Claude Desktop does not always take the
/// file type, and a package in the temporary folder could not be found to
/// open by hand. The dialog says how to install it. None when cancelled.
#[tauri::command]
pub async fn save_mcpb(app: AppHandle) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let server = mcp::server_path().map_err(CommandError::internal)?;
    if !server.is_file() {
        return Err(CommandError::detailed(ErrorCode::NotFound, ErrorDetail::ServerMissing, "koonapin-mcp is not next to the app"));
    }
    let mut dialog = app.dialog().file().set_file_name("koona-pin.mcpb").add_filter("Claude Desktop", &["mcpb"]);
    if let Some(downloads) = dirs::download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let dialog = over_main_window(&app, dialog);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || mcp::write_bundle(&server, &target))
        .await
        .map_err(CommandError::internal)?
        .map_err(CommandError::internal)?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(Some(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}
