//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! This device as the relay knows it (NP-059, Р-68): an id and an Ed25519 key that never change
//! once the relay saw them (`PROTOCOL.md` 2.3), and a name. Kept in `sync-device.json` next to
//! `account.json`, not in the library: a library copied to another computer, or restored there,
//! must not make it the same device.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::signature::Ed25519KeyPair;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const FILE: &str = "sync-device.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u32,
    device: Uuid,
    /// PKCS#8 of the Ed25519 key, base64.
    key: String,
    name: String,
}

#[derive(Clone)]
pub struct Identity {
    pub device: Uuid,
    pkcs8: Vec<u8>,
    pub name: String,
}

impl std::fmt::Debug for Identity {
    // The key stays out of logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity").field("device", &self.device).field("name", &self.name).finish()
    }
}

impl Identity {
    pub fn new(name: &str) -> Identity {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = koona_sync::crypto::generate_device_key(&rng).expect("the system random source works");
        Identity { device: Uuid::new_v4(), pkcs8, name: name_or_host(name) }
    }

    pub fn key_pair(&self) -> Ed25519KeyPair {
        koona_sync::crypto::device_key(&self.pkcs8).expect("the stored key was checked when read")
    }

    pub fn public_key(&self) -> [u8; 32] {
        koona_sync::crypto::public_key(&self.key_pair())
    }

    fn read(path: &Path) -> Result<Option<Identity>, ()> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        let stored: Stored = serde_json::from_str(&text).map_err(|_| ())?;
        let pkcs8 = STANDARD.decode(stored.key).map_err(|_| ())?;
        if stored.v != 1 || stored.device.is_nil() || koona_sync::crypto::device_key(&pkcs8).is_err() {
            return Err(());
        }
        Ok(Some(Identity { device: stored.device, pkcs8, name: name_or_host(&stored.name) }))
    }

    /// The device of this computer, made on first use. A damaged file is moved aside and a new
    /// device made: the relay sees a new device, which the hub pairs like any other, and the
    /// old entry stays in the directory until removed.
    pub fn load_or_create(path: &Path) -> io::Result<Identity> {
        match Identity::read(path) {
            Ok(Some(identity)) => return Ok(identity),
            Ok(None) => {}
            Err(()) => {
                let _ = fs::rename(path, damaged_path(path));
            }
        }
        let identity = Identity::new("");
        identity.save(path)?;
        Ok(identity)
    }

    /// Through a temporary file, readable by this user only: the key signs for the account.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder)?;
        }
        let stored = Stored { v: 1, device: self.device, key: STANDARD.encode(&self.pkcs8), name: self.name.clone() };
        write_private(path, &serde_json::to_string_pretty(&stored).map_err(io::Error::other)?)
    }
}

/// `text` in `path` through a temporary file, readable by this user only.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)
}

/// The library key of the account and its epoch, in `sync-key.json` beside `sync-device.json`
/// rather than in the library: every copy of the library (the daily backups, the backups to a
/// cloud folder) would carry it, and it opens what the relay passes on until the next rotation.
/// It belongs to this device's place on the account, like the device key.
pub const KEY_FILE: &str = "sync-key.json";

#[derive(Serialize, Deserialize)]
struct StoredKey {
    v: u32,
    /// The account (`sub`) the key is of: another account signed in here doesn't get it.
    #[serde(default)]
    account: Option<String>,
    epoch: u32,
    key: String,
}

/// The key of `account` kept in `path`; none when there is no file or it is another account's.
/// A file that doesn't read (cut short, edited) is set aside as `json.damaged`, as the identity
/// is: without a key the device asks the main computer for it again, instead of failing for good.
/// A file that can't be opened at all is an error, tried again later.
pub fn load_key(path: &Path, account: &str) -> io::Result<Option<(u32, koona_sync::crypto::LibraryKey)>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let parsed = serde_json::from_str::<StoredKey>(&text).ok().and_then(|stored| {
        let key: koona_sync::crypto::LibraryKey = STANDARD.decode(&stored.key).ok()?.try_into().ok()?;
        Some((stored.account, stored.epoch, key))
    });
    match parsed {
        // A file from before the account was written down holds this account's key.
        Some((owner, epoch, key)) => Ok((owner.is_none() || owner.as_deref() == Some(account)).then_some((epoch, key))),
        None => {
            eprintln!("Sync's library key file doesn't read; it is set aside and the key asked for again");
            let _ = fs::rename(path, damaged_path(path));
            Ok(None)
        }
    }
}

/// Keeps `account`'s `key` in `path`, or removes the file when there is none (a removed device
/// forgets it).
pub fn save_key(path: &Path, account: &str, key: Option<&(u32, koona_sync::crypto::LibraryKey)>) -> io::Result<()> {
    match key {
        Some((epoch, key)) => {
            let stored = StoredKey { v: 1, account: Some(account.to_string()), epoch: *epoch, key: STANDARD.encode(key) };
            write_private(path, &serde_json::to_string_pretty(&stored).map_err(io::Error::other)?)
        }
        None => match fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

fn damaged_path(path: &Path) -> PathBuf {
    path.with_extension("json.damaged")
}

/// The name given, or the computer's, cut to what the relay keeps.
fn name_or_host(name: &str) -> String {
    let name = name.trim();
    let name = if name.is_empty() { host_name() } else { name.to_string() };
    koona_sync::session::device_name(&name)
}

/// The computer's name as the system gives it; `Computer` when it gives none.
pub fn host_name() -> String {
    let name = system_host_name().unwrap_or_default();
    // macOS and some Linux names end in the local domain, which says nothing.
    let name = name.trim().trim_end_matches(".local").trim_end_matches(".lan").to_string();
    if name.is_empty() {
        "Computer".to_string()
    } else {
        name
    }
}

#[cfg(windows)]
fn system_host_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn system_host_name() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its length; the name is NUL-terminated within it or cut.
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
    if !ok {
        return None;
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn system_host_name() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-sync-identity-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_device_is_made_once_and_read_back_the_same() {
        let dir = folder("create");
        let path = dir.join(FILE);
        let first = Identity::load_or_create(&path).unwrap();
        assert!(!first.name.is_empty(), "named after the computer");
        let again = Identity::load_or_create(&path).unwrap();
        assert_eq!(again.device, first.device);
        assert_eq!(again.public_key(), first.public_key());
        assert_eq!(again.name, first.name);
        assert!(!dir.join("sync-device.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_rename_is_kept_and_cut_to_what_the_relay_keeps() {
        let dir = folder("rename");
        let path = dir.join(FILE);
        let mut identity = Identity::load_or_create(&path).unwrap();
        identity.name = name_or_host(&"x".repeat(300));
        identity.save(&path).unwrap();
        let read = Identity::load_or_create(&path).unwrap();
        assert_eq!(read.name.encode_utf16().count(), koona_sync::session::MAX_NAME_UTF16);
        assert_eq!(read.device, identity.device);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_file_is_moved_aside_and_a_new_device_made() {
        let dir = folder("damaged");
        let path = dir.join(FILE);
        fs::write(&path, "{\"v\": 1, \"device\": \"not a uuid\"").unwrap();
        let identity = Identity::load_or_create(&path).unwrap();
        assert!(dir.join("sync-device.json.damaged").exists(), "kept for a look");
        assert_eq!(Identity::load_or_create(&path).unwrap().device, identity.device);
        // A key that is not one is damage too.
        let stored = Stored { v: 1, device: Uuid::new_v4(), key: STANDARD.encode(b"short"), name: "Mac".into() };
        fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        assert_ne!(Identity::load_or_create(&path).unwrap().device, stored.device);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_empty_name_is_the_computer_name() {
        assert_eq!(name_or_host("  "), koona_sync::session::device_name(&host_name()));
        assert_eq!(name_or_host(" Studio Mac "), "Studio Mac");
    }
}
