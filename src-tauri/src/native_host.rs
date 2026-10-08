//! Tells the browsers where the native messaging host is (Р-17, Р-53).
//!
//! Windows: one manifest for Chrome and Edge, one for Firefox, next to the app,
//! and a key under `HKCU` for each browser. The app checks and repairs this at
//! every start; the installer writes it too and the uninstaller removes it
//! (NP-037), both through `koonapin.exe` with [`REGISTER_ARG`] or
//! [`UNREGISTER_ARG`].
//!
//! Linux: the package puts the manifests in the browsers' system folders and
//! the app only checks them (Р-45, п. 5); a development build registers in the
//! user's folders instead (see [`linux`]).

use crate::browsers::CaptureProblem;
use serde_json::json;
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "app.koona.pin";
/// The host on Windows; on Linux it is `koonapin-host`.
pub const HOST_EXE: &str = "koonapin-host.exe";
pub const GECKO_ID: &str = "pin@koona.app";
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
pub const REGISTER_ENV: &str = "KOONAPIN_REGISTER_HOST";
/// The installer registers the host before the app ever starts, so the
/// extension works right after installation with the app closed.
pub const REGISTER_ARG: &str = "--register-host";
/// The uninstaller removes the keys before the files they point at.
pub const UNREGISTER_ARG: &str = "--unregister-host";

const CHROMIUM_MANIFEST: &str = "app.koona.pin.chromium.json";
const FIREFOX_MANIFEST: &str = "app.koona.pin.firefox.json";
#[cfg(not(target_os = "linux"))]
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

/// Chrome, Edge and Chromium read one kind of manifest, Firefox another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Chromium,
    Firefox,
}

/// One manifest. `path` is the host: relative to the manifest on Windows,
/// absolute on Linux (the only form allowed there).
pub fn manifest(family: Family, public_release: bool, path: &str) -> String {
    let mut manifest = json!({
        "name": HOST_NAME,
        "description": "Koona Pin",
        "path": path,
        "type": "stdio",
    });
    match family {
        Family::Chromium => manifest["allowed_origins"] = json!(chromium_origins(public_release)),
        Family::Firefox => manifest["allowed_extensions"] = json!([GECKO_ID]),
    }
    serde_json::to_string_pretty(&manifest).expect("serializable") + "\n"
}

/// Both manifests of Windows, next to the host.
pub fn manifests(public_release: bool) -> [(&'static str, String); 2] {
    [
        (CHROMIUM_MANIFEST, manifest(Family::Chromium, public_release, HOST_EXE)),
        (FIREFOX_MANIFEST, manifest(Family::Firefox, public_release, HOST_EXE)),
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

/// At every start and on «Повторить», when [`should_register`]: Linux checks
/// the package's manifests, or registers a development build for the user.
#[cfg(target_os = "linux")]
pub fn register() -> Result<(), (CaptureProblem, String)> {
    if std::env::var_os(REGISTER_ENV).is_some_and(|v| v == "1") {
        linux::register_user()
    } else {
        linux::check_system(Path::new("/"))
    }
}

/// `--register-host`: the installer on Windows; on Linux the registration for
/// the user (the package brings its own files).
pub fn register_on_request() -> Result<(), (CaptureProblem, String)> {
    #[cfg(target_os = "linux")]
    return linux::register_user();
    #[cfg(not(target_os = "linux"))]
    register()
}

/// `--unregister-host`.
#[cfg(target_os = "linux")]
pub fn unregister() -> std::io::Result<()> {
    linux::unregister_user()
}

/// Writes the manifests next to the app and points the browsers at them.
#[cfg(not(target_os = "linux"))]
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
#[cfg(not(target_os = "linux"))]
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

/// Linux (Р-53): the folders the browsers read, the package's manifests, the
/// check at start and the registration of a development build. The tests of
/// the files run on every system.
#[cfg(any(target_os = "linux", test))]
pub mod linux {
    use super::{manifest, CaptureProblem, Family, GECKO_ID, HOST_NAME, STORE_EXTENSION_IDS};
    use std::{
        io,
        path::{Path, PathBuf},
    };

    /// `koonapin --package-manifests <deb|rpm|arch> <root>`: the package's
    /// files under `<root>` (NP-055 builds the packages).
    pub const PACKAGE_ARG: &str = "--package-manifests";
    /// The host the package installs (Р-45, п. 4).
    pub const PACKAGE_HOST: &str = "/usr/bin/koonapin-host";
    /// The host next to the app.
    pub const HOST_BINARY: &str = "koonapin-host";

    /// Chrome, Edge and Chromium of the distributions; Edge reads only its own.
    const CHROMIUM_FOLDERS: [&str; 3] = [
        "etc/opt/chrome/native-messaging-hosts",
        "etc/opt/edge/native-messaging-hosts",
        "etc/chromium/native-messaging-hosts",
    ];
    /// Firefox reads one of the two, chosen when it is built (`--libdir`):
    /// lib64 only Fedora's.
    const FIREFOX_LIB: &str = "usr/lib/mozilla/native-messaging-hosts";
    const FIREFOX_LIB64: &str = "usr/lib64/mozilla/native-messaging-hosts";
    /// Where Fedora's Firefox is installed: then the app wants lib64 too.
    const FEDORA_FIREFOX: &str = "usr/lib64/firefox";

    /// On Linux a browser finds the manifest by the host's name.
    pub fn file_name() -> String {
        format!("{HOST_NAME}.json")
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Package {
        Deb,
        Rpm,
        Arch,
    }

    impl Package {
        pub fn parse(name: &str) -> Option<Self> {
            match name {
                "deb" => Some(Package::Deb),
                "rpm" => Some(Package::Rpm),
                "arch" => Some(Package::Arch),
                _ => None,
            }
        }

        /// The folders under the root: lib64 only in the rpm, Debian and Arch
        /// have none.
        fn folders(self) -> Vec<(&'static str, Family)> {
            let mut folders: Vec<_> = CHROMIUM_FOLDERS
                .iter()
                .map(|folder| (*folder, Family::Chromium))
                .collect();
            folders.push((FIREFOX_LIB, Family::Firefox));
            if self == Package::Rpm {
                folders.push((FIREFOX_LIB64, Family::Firefox));
            }
            folders
        }
    }

    /// Writes the package's manifests under `root`; returns the files.
    pub fn write_package(package: Package, root: &Path, public_release: bool) -> io::Result<Vec<PathBuf>> {
        let mut written = Vec::new();
        for (folder, family) in package.folders() {
            let folder = root.join(folder);
            std::fs::create_dir_all(&folder)?;
            let path = folder.join(file_name());
            std::fs::write(&path, manifest(family, public_release, PACKAGE_HOST))?;
            written.push(path);
        }
        Ok(written)
    }

    /// The `--package-manifests` step: 0 when written, 1 otherwise.
    pub fn package_step(args: &[String]) -> i32 {
        let (Some(package), Some(root)) = (args.first().and_then(|a| Package::parse(a)), args.get(1)) else {
            eprintln!("usage: koonapin {PACKAGE_ARG} <deb|rpm|arch> <root>");
            return 1;
        };
        match write_package(package, Path::new(root), cfg!(feature = "public-release")) {
            Ok(written) => {
                for path in written {
                    println!("{}", path.display());
                }
                0
            }
            Err(error) => {
                eprintln!("{error}");
                1
            }
        }
    }

    /// At start: the package's manifests are in place, ours and pointing at a
    /// host that runs (Р-53, п. 2). Nothing is written; `root` is `/` outside
    /// the tests.
    pub fn check_system(root: &Path) -> Result<(), (CaptureProblem, String)> {
        let mut folders = Package::Deb.folders();
        if root.join(FEDORA_FIREFOX).is_dir() {
            folders.push((FIREFOX_LIB64, Family::Firefox));
        }
        for (folder, family) in folders {
            let shown = format!("/{folder}/{}", file_name());
            let registration = |why: &str| (CaptureProblem::Registration, format!("{shown}: {why}"));
            let text = std::fs::read_to_string(root.join(folder).join(file_name()))
                .map_err(|error| registration(&error.to_string()))?;
            let host = host_of(&text, family).map_err(registration)?;
            if !runnable(&root.join(host.trim_start_matches('/'))) {
                return Err((CaptureProblem::HostMissing, host));
            }
        }
        Ok(())
    }

    /// The host a manifest names, if the manifest is ours and lets the store
    /// extensions in.
    fn host_of(text: &str, family: Family) -> Result<String, &'static str> {
        let manifest: serde_json::Value = serde_json::from_str(text).map_err(|_| "not a manifest")?;
        if manifest["name"] != HOST_NAME || manifest["type"] != "stdio" {
            return Err("names another host");
        }
        let allowed = |key: &str| -> Vec<String> {
            manifest[key]
                .as_array()
                .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default()
        };
        let lets_in = match family {
            Family::Chromium => {
                let origins = allowed("allowed_origins");
                STORE_EXTENSION_IDS
                    .iter()
                    .all(|id| origins.contains(&format!("chrome-extension://{id}/")))
            }
            Family::Firefox => allowed("allowed_extensions").iter().any(|id| id == GECKO_ID),
        };
        if !lets_in {
            return Err("does not let the extension in");
        }
        match manifest["path"].as_str() {
            Some(path) if path.starts_with('/') => Ok(path.to_owned()),
            _ => Err("has no absolute host path"),
        }
    }

    fn runnable(path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = true;
        meta.is_file() && executable
    }

    /// The user's folders (Р-53, п. 3): Chrome, Edge and Chromium under the
    /// config folder (`$XDG_CONFIG_HOME`); Firefox only reads `~/.mozilla`,
    /// and so do the Snap portal and proxy.
    pub fn user_folders(home: &Path, config: &Path) -> [(PathBuf, Family); 4] {
        [
            (config.join("google-chrome/NativeMessagingHosts"), Family::Chromium),
            (config.join("microsoft-edge/NativeMessagingHosts"), Family::Chromium),
            (config.join("chromium/NativeMessagingHosts"), Family::Chromium),
            (home.join(".mozilla/native-messaging-hosts"), Family::Firefox),
        ]
    }

    fn user_places() -> io::Result<(PathBuf, PathBuf)> {
        dirs::home_dir()
            .zip(dirs::config_dir())
            .ok_or_else(|| io::Error::other("cannot find the home folder"))
    }

    fn own_host() -> io::Result<PathBuf> {
        super::app_folder()
            .map(|folder| folder.join(HOST_BINARY))
            .ok_or_else(|| io::Error::other("cannot find the app's folder"))
    }

    /// A development build (`KOONAPIN_REGISTER_HOST=1`, `--register-host`):
    /// manifests for the host next to it in the user's folders.
    pub fn register_user() -> Result<(), (CaptureProblem, String)> {
        let registration = |e: io::Error| (CaptureProblem::Registration, e.to_string());
        let host = own_host().map_err(registration)?;
        if !runnable(&host) {
            return Err((CaptureProblem::HostMissing, host.display().to_string()));
        }
        let (home, config) = user_places().map_err(registration)?;
        write_user(&home, &config, &host, cfg!(feature = "public-release")).map_err(registration)
    }

    pub fn write_user(home: &Path, config: &Path, host: &Path, public_release: bool) -> io::Result<()> {
        let host = host
            .to_str()
            .ok_or_else(|| io::Error::other("the host's path is not UTF-8"))?;
        for (folder, family) in user_folders(home, config) {
            std::fs::create_dir_all(&folder)?;
            let path = folder.join(file_name());
            let content = manifest(family, public_release, host);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
                std::fs::write(&path, content)?;
            }
        }
        Ok(())
    }

    /// `--unregister-host`.
    pub fn unregister_user() -> io::Result<()> {
        let (home, config) = user_places()?;
        remove_user(&home, &config, &own_host()?)
    }

    /// Removes the user's manifests that point at this host; those of another
    /// copy stay, as the keys on Windows.
    pub fn remove_user(home: &Path, config: &Path, host: &Path) -> io::Result<()> {
        for (folder, _) in user_folders(home, config) {
            let path = folder.join(file_name());
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let ours = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .is_some_and(|manifest| manifest["path"].as_str().map(Path::new) == Some(host));
            if ours {
                std::fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
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

#[cfg(not(any(windows, target_os = "linux")))]
mod registry {
    // macOS keeps manifests in per-browser folders (NP-048).
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
    fn every_installer_language_has_every_string() {
        // A missing LangString is only a makensis warning, and the page shows
        // an empty label (NP-106).
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let nsis = &conf["bundle"]["windows"]["nsis"];
        let files = nsis["customLanguageFiles"].as_object().unwrap();
        let languages: Vec<&str> = nsis["languages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|language| language.as_str().unwrap())
            .collect();
        assert_eq!(languages[0], "English", "the fallback for other languages");
        assert_eq!(languages.len(), files.len());
        let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let strings = |language: &str| -> Vec<(String, String)> {
            let path = files[language].as_str().unwrap();
            let text = std::fs::read_to_string(folder.join(path)).unwrap();
            let prefix = format!("${{LANG_{}}} \"", language.to_uppercase());
            text.lines()
                .filter(|line| !line.starts_with(';') && !line.is_empty())
                .map(|line| {
                    let rest = line.strip_prefix("LangString ").expect(line);
                    let (key, value) = rest.split_once(' ').expect(line);
                    let value = value.strip_prefix(&prefix).expect(line);
                    let value = value.strip_suffix('"').expect(line);
                    (key.to_owned(), value.to_owned())
                })
                .collect()
        };
        let english = strings("English");
        let keys: Vec<&String> = english.iter().map(|(key, _)| key).collect();
        let hooks = include_str!("../nsis/hooks.nsh");
        assert!(hooks.contains("$(npAutostart)") && keys.contains(&&"npAutostart".to_owned()));
        // The variables the template fills in, which a translation must keep.
        let tokens = ["{{product_name}}", "${PRODUCTNAME}", "${VERSION}", "$R4", "$0", "$1"];
        for language in languages {
            let translated = strings(language);
            let translated_keys: Vec<&String> = translated.iter().map(|(key, _)| key).collect();
            assert_eq!(translated_keys, keys, "{language}");
            for ((key, value), (_, source)) in translated.iter().zip(&english) {
                assert!(!value.trim().is_empty(), "{language} {key}");
                for token in tokens {
                    assert_eq!(
                        value.matches(token).count() > 0,
                        source.matches(token).count() > 0,
                        "{language} {key} {token}"
                    );
                }
                // A lost brace leaves {product_name} as text in the dialog.
                let braces = value.replace("{{product_name}}", "");
                assert!(!braces.contains("product_name"), "{language} {key}");
            }
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-host-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The package's files come from the constants of this file (Р-53, п. 1):
    /// the store ids and only them in the release, the Gecko id, the host of
    /// the package; lib64 only in the rpm.
    #[test]
    fn the_package_manifests_carry_the_ids_of_this_file() {
        use linux::Package;
        let root = scratch("package");
        for (package, lib64) in [(Package::Deb, false), (Package::Rpm, true), (Package::Arch, false)] {
            let root = root.join(format!("{package:?}"));
            let written = linux::write_package(package, &root, true).unwrap();
            assert_eq!(written.len(), if lib64 { 5 } else { 4 }, "{package:?}");
            let at = |folder: &str| root.join(folder).join("app.koona.pin.json");
            for folder in [
                "etc/opt/chrome/native-messaging-hosts",
                "etc/opt/edge/native-messaging-hosts",
                "etc/chromium/native-messaging-hosts",
            ] {
                let manifest = read_json(&at(folder));
                assert_eq!(manifest["name"], HOST_NAME);
                assert_eq!(manifest["path"], linux::PACKAGE_HOST);
                assert_eq!(manifest["allowed_origins"], json!(chromium_origins(true)));
                assert!(!manifest.to_string().contains(DEV_EXTENSION_ID));
            }
            for folder in ["usr/lib/mozilla/native-messaging-hosts", "usr/lib64/mozilla/native-messaging-hosts"] {
                if folder.contains("lib64") && !lib64 {
                    assert!(!at(folder).exists(), "{package:?}: {folder}");
                    continue;
                }
                let manifest = read_json(&at(folder));
                assert_eq!(manifest["path"], linux::PACKAGE_HOST);
                assert_eq!(manifest["allowed_extensions"], json!([GECKO_ID]));
            }
        }
        // Outside the release the development id is let in too, as on Windows.
        let dev = linux::write_package(Package::Deb, &root.join("dev"), false).unwrap();
        assert!(std::fs::read_to_string(&dev[0]).unwrap().contains(DEV_EXTENSION_ID));
        assert_eq!(Package::parse("rpm"), Some(Package::Rpm));
        assert_eq!(Package::parse("appimage"), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The check at start names what is wrong: a missing or foreign manifest
    /// (registration, with its path), a host that is not there (host_missing);
    /// lib64 is wanted only beside Fedora's Firefox.
    #[test]
    fn the_check_at_start_names_what_is_missing() {
        use linux::{check_system, write_package, Package};
        let root = scratch("check");
        let problem = |root: &Path| check_system(root).unwrap_err();
        let missing = problem(&root);
        assert_eq!(missing.0, CaptureProblem::Registration);
        assert!(missing.1.starts_with("/etc/opt/chrome/native-messaging-hosts/app.koona.pin.json: "), "{}", missing.1);

        write_package(Package::Deb, &root, true).unwrap();
        assert_eq!(problem(&root), (CaptureProblem::HostMissing, linux::PACKAGE_HOST.to_owned()));
        let host = root.join("usr/bin/koonapin-host");
        std::fs::create_dir_all(host.parent().unwrap()).unwrap();
        std::fs::write(&host, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A host that cannot run is as good as missing.
            assert_eq!(problem(&root).0, CaptureProblem::HostMissing);
            std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(check_system(&root), Ok(()));

        // Fedora's Firefox reads only lib64: the deb's files are not enough.
        std::fs::create_dir_all(root.join("usr/lib64/firefox")).unwrap();
        let lib64 = problem(&root);
        assert_eq!(lib64.0, CaptureProblem::Registration);
        assert!(lib64.1.starts_with("/usr/lib64/mozilla/"), "{}", lib64.1);
        write_package(Package::Rpm, &root, true).unwrap();
        assert_eq!(check_system(&root), Ok(()));

        // A damaged file, another host's, one that keeps the extension out.
        let edge = root.join("etc/opt/edge/native-messaging-hosts/app.koona.pin.json");
        let good = std::fs::read_to_string(&edge).unwrap();
        for (content, why) in [
            ("{".to_owned(), "not a manifest"),
            (good.replace(HOST_NAME, "app.other"), "names another host"),
            (good.replace(STORE_EXTENSION_IDS[1], "aaaa"), "does not let the extension in"),
            (good.replace(linux::PACKAGE_HOST, "koonapin-host"), "has no absolute host path"),
        ] {
            std::fs::write(&edge, content).unwrap();
            assert_eq!(
                problem(&root),
                (
                    CaptureProblem::Registration,
                    format!("/etc/opt/edge/native-messaging-hosts/app.koona.pin.json: {why}")
                )
            );
        }
        let firefox = root.join("usr/lib/mozilla/native-messaging-hosts/app.koona.pin.json");
        std::fs::write(&edge, &good).unwrap();
        std::fs::write(&firefox, std::fs::read_to_string(&firefox).unwrap().replace(GECKO_ID, "other@example.com")).unwrap();
        assert!(problem(&root).1.ends_with("does not let the extension in"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A development build writes its manifests in the user's folders with the
    /// absolute host path; removing takes only those that point at it.
    #[test]
    fn the_user_registration_writes_and_removes_only_its_own() {
        let dir = scratch("user");
        let (home, config) = (dir.join("home"), dir.join("home/.config"));
        let host = Path::new("/opt/koonapin-dev/koonapin-host");
        linux::write_user(&home, &config, host, false).unwrap();
        let folders = linux::user_folders(&home, &config);
        for (folder, family) in &folders {
            let manifest = read_json(&folder.join("app.koona.pin.json"));
            assert_eq!(manifest["path"], host.to_str().unwrap());
            match family {
                Family::Chromium => assert_eq!(manifest["allowed_origins"], json!(chromium_origins(false))),
                Family::Firefox => assert_eq!(manifest["allowed_extensions"], json!([GECKO_ID])),
            }
        }
        // Firefox reads ~/.mozilla even with its profiles under XDG (147+).
        assert!(home.join(".mozilla/native-messaging-hosts/app.koona.pin.json").is_file());
        assert!(config.join("chromium/NativeMessagingHosts/app.koona.pin.json").is_file());
        // Another copy registered in one folder keeps its manifest.
        let other = folders[1].0.join("app.koona.pin.json");
        std::fs::write(&other, manifest(Family::Chromium, false, "/elsewhere/koonapin-host")).unwrap();
        linux::remove_user(&home, &config, host).unwrap();
        for (folder, _) in &folders {
            let path = folder.join("app.koona.pin.json");
            assert_eq!(path.exists(), path == other, "{}", path.display());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_match_the_extension_build() {
        let build = include_str!("../../scripts/build-extension.mjs");
        assert!(build.contains(&format!(r#"geckoId = "{GECKO_ID}""#)));
        // The store-id test package (NP-037) checks its key against this id.
        assert!(build.contains(&format!(r#"chromeStoreId = "{}""#, STORE_EXTENSION_IDS[0])));
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