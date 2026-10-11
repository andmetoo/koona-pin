//! The AppImage (NP-116, Р-63): one file for the distributions outside the packages, kept wherever the
//! person likes and started without installing. Nothing of a package is there to lean on, so the app
//! does at every start what the package does once:
//!
//! - the native host is copied out of the image into `~/.local/share/Koona/Pin/host`: the image is
//!   mounted at a new `/tmp/.mount_…` each time, and a browser's manifest needs a path that lasts;
//! - beside the host, `koonapin` is a link to the AppImage file, so the host starts the app where the
//!   person keeps it now (the host starts the `koonapin` next to itself, as in the package);
//! - the manifests go to the user's folders of the browsers (Р-53, п. 3);
//! - the session's autostart entry and the updater name the AppImage file, not the program inside.

use std::path::PathBuf;

/// The host's folder inside the brand's data folder (Р-56).
pub const HOST_FOLDER: &str = "host";
/// The link beside the host that the host starts.
pub const APP_LINK: &str = "koonapin";
/// The host's file, as in the package (`native_host::linux::HOST_BINARY`).
pub const HOST_BINARY: &str = "koonapin-host";
/// The MCP server's file (NP-091), copied out beside the host.
pub const SERVER_BINARY: &str = "koonapin-mcp";

/// The AppImage file this copy runs from: `$APPIMAGE`, set by the AppImage's runtime, when Tauri built
/// this very binary into an AppImage. A variable alone is not enough: anyone can set it.
#[cfg(target_os = "linux")]
pub fn file() -> Option<PathBuf> {
    use tauri::utils::config::BundleType;
    if tauri::utils::platform::bundle_type() != Some(BundleType::AppImage) {
        return None;
    }
    let path = PathBuf::from(std::env::var_os("APPIMAGE")?);
    (path.is_absolute() && path.is_file()).then_some(path)
}

#[cfg(not(target_os = "linux"))]
pub fn file() -> Option<PathBuf> {
    None
}

/// What the session and the host start: the AppImage file, otherwise this program.
pub fn program() -> std::io::Result<PathBuf> {
    file().map_or_else(std::env::current_exe, Ok)
}

/// `~/.local/share/Koona/Pin/host`.
pub fn host_folder() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(crate::db::BRAND_FOLDER).join(crate::db::DATA_FOLDER).join(HOST_FOLDER))
}

/// Copies the host out of the image into `folder` when it differs, and points the link beside it at
/// the AppImage file; returns the host's lasting path. Each file is written beside and renamed over:
/// a browser may be running the old host, and a start cut short leaves the old files, not half ones.
#[cfg(unix)]
pub fn settle_host(inside: &std::path::Path, appimage: &std::path::Path, folder: &std::path::Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(folder)?;
    let host = settle_binary(inside, folder, HOST_BINARY)?;
    // The MCP server (NP-091) beside the host: an assistant's settings name it once and keep it.
    let server = inside.with_file_name(SERVER_BINARY);
    if server.is_file() {
        settle_binary(&server, folder, SERVER_BINARY)?;
    }
    let link = folder.join(APP_LINK);
    if std::fs::read_link(&link).ok().as_deref() != Some(appimage) {
        let partial = folder.join(".koonapin.partial");
        let _ = std::fs::remove_file(&partial);
        std::os::unix::fs::symlink(appimage, &partial)?;
        std::fs::rename(&partial, &link)?;
    }
    Ok(host)
}

/// `inside` copied to `folder/name` when it differs, written beside and renamed over.
#[cfg(unix)]
fn settle_binary(inside: &std::path::Path, folder: &std::path::Path, name: &str) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let target = folder.join(name);
    let bytes = std::fs::read(inside)?;
    if std::fs::read(&target).ok().as_deref() != Some(bytes.as_slice()) {
        let partial = folder.join(format!(".{name}.partial"));
        let _ = std::fs::remove_file(&partial);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o755).open(&partial)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&partial, &target)?;
    }
    Ok(target)
}

/// Where an assistant finds the MCP server of this AppImage: copied out beside the host.
pub fn server() -> Option<PathBuf> {
    file()?;
    Some(host_folder()?.join(SERVER_BINARY))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_host_is_copied_out_once_and_the_link_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("koonapin-appimage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mount = dir.join(".mount_koonap1/usr/bin");
        std::fs::create_dir_all(&mount).unwrap();
        let inside = mount.join("koonapin-host");
        std::fs::write(&inside, b"host 1").unwrap();
        let folder = dir.join("data/Koona/Pin/host");

        let host = settle_host(&inside, &dir.join("Downloads/koonapin.AppImage"), &folder).unwrap();
        assert_eq!(host, folder.join("koonapin-host"));
        assert_eq!(std::fs::read(&host).unwrap(), b"host 1");
        assert_eq!(std::fs::metadata(&host).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(std::fs::read_link(folder.join(APP_LINK)).unwrap(), dir.join("Downloads/koonapin.AppImage"));

        // The person moved the file and a new version came: the next start follows both.
        std::fs::write(&inside, b"host 2").unwrap();
        settle_host(&inside, &dir.join("Apps/koonapin.AppImage"), &folder).unwrap();
        assert_eq!(std::fs::read(&host).unwrap(), b"host 2");
        assert_eq!(std::fs::read_link(folder.join(APP_LINK)).unwrap(), dir.join("Apps/koonapin.AppImage"));
        let names: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "no partial files left: {names:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
