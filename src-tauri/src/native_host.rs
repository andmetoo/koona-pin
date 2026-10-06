//! Tells the browsers where the native messaging host is (Р-17): one manifest
//! for Chrome and Edge, one for Firefox, next to the app, and a key under
//! `HKCU` for each browser. The app checks and repairs this at every start; the
//! installer writes it too and the uninstaller removes it (NP-037), both through
//! `netamipin.exe` with [`REGISTER_ARG`] or [`UNREGISTER_ARG`].

use crate::browsers::CaptureProblem;
use serde_json::json;
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "app.netami.pin";
pub const HOST_EXE: &str = "netamipin-host.exe";
pub const GECKO_ID: &str = "pin@netami.app";
/// The extension built from extension/dev-key.txt (NP-015). Anyone can load an
/// unpacked extension with that public key, so the installer build leaves it out.
pub const DEV_EXTENSION_ID: &str = "iibgiagcbediajombmkohanobgicbepn";
/// Chrome Web Store and Edge Add-ons ids from the catalog drafts (NP-017).
/// Edge Add-ons gives the same package an id of its own.
pub const STORE_EXTENSION_IDS: &[&str] = &[
    // Chrome Web Store
    "dedcgklilbgbieabgpklellnaccpjhpc",
    // Edge Add-ons
    "ocdkndgdeagephdnlmofffbapdifhkho",
];
/// Registers even a development build or an isolated test run.
pub const REGISTER_ENV: &str = "NETAMIPIN_REGISTER_HOST";
/// The installer registers the host before the app ever starts, so the
/// extension works right after installation with the app closed.
pub const REGISTER_ARG: &str = "--register-host";
/// The uninstaller removes the keys before the files they point at.
pub const UNREGISTER_ARG: &str = "--unregister-host";

const CHROMIUM_MANIFEST: &str = "app.netami.pin.chromium.json";
const FIREFOX_MANIFEST: &str = "app.netami.pin.firefox.json";
const BROWSER_KEYS: [(&str, &str); 3] = [
    (r"Software\Google\Chrome\NativeMessagingHosts", CHROMIUM_MANIFEST),
    (r"Software\Microsoft\Edge\NativeMessagingHosts", CHROMIUM_MANIFEST),
    (r"Software\Mozilla\NativeMessagingHosts", FIREFOX_MANIFEST),
];

pub fn chromium_origins(public_release: bool) -> Vec<String> {
    STORE_EXTENSION_IDS
        .iter()
        .copied()
        .chain((!public_release).then_some(DEV_EXTENSION_ID))
        .map(|id| format!("chrome-extension://{id}/"))
        .collect()
}

/// Both manifests; the host path is relative to them (allowed on Windows).
pub fn manifests(public_release: bool) -> [(&'static str, String); 2] {
    let common = |extra: (&str, serde_json::Value)| {
        let mut manifest = json!({
            "name": HOST_NAME,
            "description": "Netami Pin",
            "path": HOST_EXE,
            "type": "stdio",
        });
        manifest[extra.0] = extra.1;
        serde_json::to_string_pretty(&manifest).expect("serializable") + "\n"
    };
    [
        (
            CHROMIUM_MANIFEST,
            common(("allowed_origins", json!(chromium_origins(public_release)))),
        ),
        (
            FIREFOX_MANIFEST,
            common(("allowed_extensions", json!([GECKO_ID]))),
        ),
    ]
}

/// Release builds register themselves; development builds and isolated test
/// runs only when asked, so they do not take over the installed app's host.
pub fn should_register() -> bool {
    if std::env::var_os(REGISTER_ENV).is_some_and(|v| v == "1") {
        return true;
    }
    !cfg!(debug_assertions) && std::env::var_os(crate::db::DATA_DIR_ENV).is_none()
}

fn app_folder() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// Writes the manifests next to the app and points the browsers at them.
pub fn register() -> Result<(), (CaptureProblem, String)> {
    let folder = app_folder().ok_or((
        CaptureProblem::Registration,
        "cannot find the app's folder".to_string(),
    ))?;
    if !folder.join(HOST_EXE).is_file() {
        return Err((
            CaptureProblem::HostMissing,
            folder.join(HOST_EXE).to_string_lossy().into_owned(),
        ));
    }
    let registration = |e: std::io::Error| (CaptureProblem::Registration, e.to_string());
    for (file, content) in manifests(cfg!(feature = "public-release")) {
        let path = folder.join(file);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
            std::fs::write(&path, content).map_err(registration)?;
        }
    }
    for (key, file) in BROWSER_KEYS {
        registry::set_default(&format!(r"{key}\{HOST_NAME}"), &folder.join(file))
            .map_err(registration)?;
    }
    Ok(())
}

/// Removes the keys that point at this folder and the manifests in it. A key
/// that points elsewhere (another copy, a development build) stays.
pub fn unregister() -> std::io::Result<()> {
    let folder = app_folder().ok_or_else(|| std::io::Error::other("cannot find the app's folder"))?;
    for (key, file) in BROWSER_KEYS {
        let key = format!(r"{key}\{HOST_NAME}");
        let ours = folder.join(file).to_string_lossy().into_owned();
        if registry::default(&key).is_some_and(|value| value.eq_ignore_ascii_case(&ours)) {
            registry::delete(&key)?;
        }
    }
    for (file, _) in manifests(false) {
        match std::fs::remove_file(folder.join(file)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(windows)]
mod registry {
    use std::path::Path;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegGetValueW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// The default value of `HKCU\<key>`, if the key and the value exist.
    pub fn default(key: &str) -> Option<String> {
        let key = wide(key);
        let mut size = 0u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                std::ptr::null(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let mut value = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                std::ptr::null(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                value.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let end = value.iter().position(|&c| c == 0).unwrap_or(value.len());
        Some(String::from_utf16_lossy(&value[..end]))
    }

    /// Deletes `HKCU\<key>`; the host keys have no subkeys.
    pub fn delete(key: &str) -> std::io::Result<()> {
        let key = wide(key);
        match unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) } {
            0 | 2 => Ok(()), // 2: ERROR_FILE_NOT_FOUND, already gone
            status => Err(std::io::Error::from_raw_os_error(status as i32)),
        }
    }

    /// `HKCU\<key>` with the default value set to `path`.
    pub fn set_default(key: &str, path: &Path) -> std::io::Result<()> {
        let key = wide(key);
        let value = wide(&path.to_string_lossy());
        unsafe {
            let mut handle: HKEY = std::ptr::null_mut();
            let status = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            );
            if status != 0 {
                return Err(std::io::Error::from_raw_os_error(status as i32));
            }
            let status = RegSetValueExW(
                handle,
                std::ptr::null(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            );
            RegCloseKey(handle);
            if status != 0 {
                return Err(std::io::Error::from_raw_os_error(status as i32));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod registry {
    // macOS and Linux keep manifests in per-browser folders (NP-048, NP-052).
    pub fn set_default(_key: &str, _path: &std::path::Path) -> std::io::Result<()> {
        Err(std::io::Error::other("not available on this system yet"))
    }

    pub fn default(_key: &str) -> Option<String> {
        None
    }

    pub fn delete(_key: &str) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::Digest;

    #[test]
    fn the_development_id_stays_out_of_the_installer_build() {
        assert!(chromium_origins(false)
            .contains(&format!("chrome-extension://{DEV_EXTENSION_ID}/")));
        assert!(!chromium_origins(true)
            .iter()
            .any(|origin| origin.contains(DEV_EXTENSION_ID)));
    }

    #[test]
    fn the_installer_build_lets_the_store_extensions_in() {
        for id in STORE_EXTENSION_IDS {
            // Chromium ids: 32 letters a–p.
            assert!(id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)), "{id}");
            assert!(chromium_origins(true).contains(&format!("chrome-extension://{id}/")));
            assert!(chromium_origins(false).contains(&format!("chrome-extension://{id}/")));
        }
        assert!(!STORE_EXTENSION_IDS.is_empty());
    }

    #[test]
    fn manifests_name_the_host_next_to_them() {
        let [(chromium_file, chromium), (firefox_file, firefox)] = manifests(false);
        assert_ne!(chromium_file, firefox_file);
        let chromium: serde_json::Value = serde_json::from_str(&chromium).unwrap();
        let firefox: serde_json::Value = serde_json::from_str(&firefox).unwrap();
        for manifest in [&chromium, &firefox] {
            assert_eq!(manifest["name"], HOST_NAME);
            assert_eq!(manifest["path"], HOST_EXE);
            assert_eq!(manifest["type"], "stdio");
        }
        // Chrome refuses wildcards and wants the trailing slash.
        for origin in chromium["allowed_origins"].as_array().unwrap() {
            let origin = origin.as_str().unwrap();
            assert!(origin.starts_with("chrome-extension://") && origin.ends_with('/'));
            assert!(!origin.contains('*'));
        }
        assert_eq!(firefox["allowed_extensions"], json!([GECKO_ID]));
    }

    #[test]
    fn the_installer_hooks_match_the_app() {
        // The hooks cannot read tauri.conf.json, so they spell the names out.
        let hooks = include_str!("../nsis/hooks.nsh");
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let define = |name: &str, value: &str| format!(r#"!define {name} "{value}""#);
        // The Run value tauri-plugin-autostart uses is named after productName.
        assert!(hooks.contains(&define("NP_PRODUCT", conf["productName"].as_str().unwrap())));
        let exe = format!("{}.exe", conf["mainBinaryName"].as_str().unwrap());
        assert!(hooks.contains(&define("NP_EXE", &exe)));
        assert!(hooks.contains(&define("NP_HOST_EXE", HOST_EXE)));
        for arg in [REGISTER_ARG, UNREGISTER_ARG] {
            assert!(hooks.contains(&format!(r#""$INSTDIR\${{NP_EXE}}" {arg}'"#)), "{arg}");
        }
        // The uninstaller's checkbox removes the library folder (Р-10, item 8).
        assert!(hooks.contains(&define("NP_DATA_DIR", crate::db::DATA_FOLDER)));
    }

    #[test]
    fn ids_match_the_extension_build() {
        let build = include_str!("../../scripts/build-extension.mjs");
        assert!(build.contains(&format!(r#"geckoId = "{GECKO_ID}""#)));
        // The development key in the repository gives exactly this id.
        let key = include_str!("../../extension/dev-key.txt").trim();
        let der = base64::engine::general_purpose::STANDARD
            .decode(key)
            .unwrap();
        let digest = sha2::Sha256::digest(&der);
        let id: String = digest[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 15])
            .map(|nibble| (b'a' + nibble) as char)
            .collect();
        assert_eq!(id, DEV_EXTENSION_ID);
    }
}