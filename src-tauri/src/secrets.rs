//! Where the account and the sync secrets are kept (NP-153): `account.json`, `sync-device.json`
//! and `sync-key.json` beside the library. One seam for them: read, write (atomically), delete.
//!
//! On a computer and on Android they are files, as they always were. On an iPhone they live in the
//! Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`keychain.rs`), so they never reach
//! an iCloud or computer backup: a phone restored from a backup signs in and pairs again. A build
//! that kept them in files (TestFlight) moves them into the Keychain at the first start and
//! deletes the files.
//!
//! The Keychain may outlive the app on iOS. A fresh install is told from an update by a marker
//! file in the app's folder, which a delete takes along: a Keychain with no marker and no old files
//! beside it belongs to a deleted install, and is cleared before anything is read.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "ios", test))]
mod keychain;

/// The secrets, by the file name they have on a computer.
pub const NAMES: [&str; 3] = [crate::billing::FILE, crate::commercial::sync::identity::FILE, crate::commercial::sync::identity::KEY_FILE];

/// Written in the app's folder once the Keychain is the owner of the secrets (iOS).
const MARKER: &str = ".secrets-in-keychain";

/// A place the secrets are kept. `path` is where the file would be; a store that is no file uses
/// its name.
pub trait Store {
    fn read(&self, path: &Path) -> io::Result<Option<String>>;
    fn write(&self, path: &Path, text: &str) -> io::Result<()>;
    /// Nothing there is not an error.
    fn delete(&self, path: &Path) -> io::Result<()>;
    /// Keeps what is at `path` under `to` for a look (a secret that does not read) and removes it
    /// from `path`.
    fn set_aside(&self, path: &Path, to: &Path) -> io::Result<()> {
        if let Some(text) = self.read(path)? {
            self.write(to, &text)?;
        }
        self.delete(path)
    }
}

/// Files, readable by this user only, written through a temporary file: a crash mid-write never
/// leaves half a secret.
pub struct Files;

impl Store for Files {
    fn read(&self, path: &Path) -> io::Result<Option<String>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write(&self, path: &Path, text: &str) -> io::Result<()> {
        use std::fs;
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

    fn delete(&self, path: &Path) -> io::Result<()> {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn set_aside(&self, path: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(path, to)
    }
}

/// `primary` is where the secrets live; `legacy` is where an older build kept them. A read that
/// finds a secret only in `legacy` moves it to `primary` and removes it there.
pub struct Moving<P, L> {
    pub primary: P,
    pub legacy: L,
}

impl<P: Store, L: Store> Store for Moving<P, L> {
    fn read(&self, path: &Path) -> io::Result<Option<String>> {
        if let Some(text) = self.primary.read(path)? {
            return Ok(Some(text));
        }
        let Some(text) = self.legacy.read(path)? else { return Ok(None) };
        // Moved only once it is safe in `primary`; until then the old copy stays, and is read.
        match self.primary.write(path, &text) {
            Ok(()) => {
                if let Err(error) = self.legacy.delete(path) {
                    eprintln!("Koona Pin: the old copy of a secret could not be removed yet: {error}");
                }
            }
            Err(error) => eprintln!("Koona Pin: a secret could not be moved to the Keychain yet: {error}"),
        }
        Ok(Some(text))
    }

    fn write(&self, path: &Path, text: &str) -> io::Result<()> {
        self.primary.write(path, text)?;
        // A copy left behind would come back as the secret if `primary` were ever cleared; one that
        // can't be removed now is removed by the next write. The secret itself is saved.
        if let Err(error) = self.legacy.delete(path) {
            eprintln!("Koona Pin: the old copy of a secret could not be removed yet: {error}");
        }
        Ok(())
    }

    fn delete(&self, path: &Path) -> io::Result<()> {
        let primary = self.primary.delete(path);
        let legacy = self.legacy.delete(path);
        primary.and(legacy)
    }
}

impl<P: Store, L: Store> Moving<P, L> {
    /// At the start of the app, before the secrets are read: clears the leftovers of a deleted
    /// install, then moves what the files hold into `primary`.
    pub fn prepare(&self, folder: &Path, names: &[&str]) {
        let marker = folder.join(MARKER);
        if !marker.exists() {
            let old_files = names.iter().any(|name| matches!(self.legacy.read(&folder.join(name)), Ok(Some(_))));
            // The marker first: one that can't be written would make every start look like a fresh
            // install, clearing the secrets again each time. Without it nothing is cleared.
            let written = std::fs::create_dir_all(folder).and_then(|()| std::fs::write(&marker, b"1"));
            if let Err(error) = &written {
                eprintln!("Koona Pin: the Keychain marker could not be written: {error}");
            }
            if !old_files && written.is_ok() {
                // No marker and nothing to move: a first start, or the first after a reinstall,
                // which leaves the Keychain behind. Nothing in it is this install's.
                for name in names {
                    let path = folder.join(name);
                    for gone in [path.clone(), damaged(&path)] {
                        if let Err(error) = self.primary.delete(&gone) {
                            eprintln!("Koona Pin: a secret of a deleted install could not be cleared: {error}");
                        }
                    }
                }
            }
        }
        for name in names {
            if let Err(error) = self.read(&folder.join(name)) {
                eprintln!("Koona Pin: {name} could not be read yet: {error}");
            }
        }
    }
}

/// `sync-device.json` → `sync-device.json.damaged`, as the sync code names a file set aside.
fn damaged(path: &Path) -> PathBuf {
    path.with_extension("json.damaged")
}

#[cfg(target_os = "ios")]
fn store() -> Moving<keychain::Keychain<keychain::System>, Files> {
    Moving { primary: keychain::Keychain(keychain::System), legacy: Files }
}

#[cfg(not(target_os = "ios"))]
fn store() -> Files {
    Files
}

/// The secret at `path`; none when there is none.
pub fn read(path: &Path) -> io::Result<Option<String>> {
    store().read(path)
}

/// Keeps `text` at `path`, replacing what was there.
pub fn write(path: &Path, text: &str) -> io::Result<()> {
    store().write(path, text)
}

/// Removes the secret at `path`; none there is fine.
pub fn delete(path: &Path) -> io::Result<()> {
    store().delete(path)
}

/// Whether there is a secret at `path`; one that cannot be read is still there.
pub fn exists(path: &Path) -> bool {
    !matches!(read(path), Ok(None))
}

/// Keeps the secret at `path` under `to` and removes it from `path`.
pub fn set_aside(path: &Path, to: &Path) -> io::Result<()> {
    store().set_aside(path, to)
}

/// Called in `setup`, before the account or sync is read: the iPhone's Keychain takes over the
/// files of an older build and forgets a deleted install's. Nothing on other platforms.
pub fn prepare(folder: &Path) {
    #[cfg(target_os = "ios")]
    store().prepare(folder, &NAMES);
    #[cfg(not(target_os = "ios"))]
    let _ = folder;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// The Keychain as a map by file name; `broken` makes every write fail.
    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, String>>,
        broken: Mutex<bool>,
    }

    fn name(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    impl Store for &Fake {
        fn read(&self, path: &Path) -> io::Result<Option<String>> {
            Ok(self.items.lock().unwrap().get(&name(path)).cloned())
        }
        fn write(&self, path: &Path, text: &str) -> io::Result<()> {
            if *self.broken.lock().unwrap() {
                return Err(io::Error::other("the Keychain is locked"));
            }
            self.items.lock().unwrap().insert(name(path), text.to_string());
            Ok(())
        }
        fn delete(&self, path: &Path) -> io::Result<()> {
            self.items.lock().unwrap().remove(&name(path));
            Ok(())
        }
    }

    fn folder() -> PathBuf {
        let folder = std::env::temp_dir().join(format!("koonapin-secrets-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn keys(fake: &Fake) -> Vec<String> {
        let mut keys: Vec<String> = fake.items.lock().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn the_names_are_the_files_the_app_keeps() {
        assert_eq!(NAMES, ["account.json", "sync-device.json", "sync-key.json"]);
    }

    #[test]
    fn files_are_written_whole_and_private() {
        let folder = folder();
        let path = folder.join("account.json");
        assert_eq!(Files.read(&path).unwrap(), None);
        Files.write(&path, "one").unwrap();
        Files.write(&path, "two").unwrap();
        assert_eq!(Files.read(&path).unwrap().as_deref(), Some("two"));
        assert!(!folder.join("account.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        Files.delete(&path).unwrap();
        Files.delete(&path).unwrap();
        assert_eq!(Files.read(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_first_start_moves_the_files_into_the_keychain_and_deletes_them() {
        let (fake, folder) = (Fake::default(), folder());
        std::fs::write(folder.join("account.json"), "account").unwrap();
        std::fs::write(folder.join("sync-device.json"), "device").unwrap();
        let store = Moving { primary: &fake, legacy: Files };

        store.prepare(&folder, &NAMES);

        assert_eq!(keys(&fake), ["account.json", "sync-device.json"]);
        assert!(!folder.join("account.json").exists() && !folder.join("sync-device.json").exists());
        assert!(folder.join(MARKER).exists());
        assert_eq!(store.read(&folder.join("account.json")).unwrap().as_deref(), Some("account"));
        // And the next start finds nothing to do.
        store.prepare(&folder, &NAMES);
        assert_eq!(keys(&fake), ["account.json", "sync-device.json"]);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_reinstall_clears_what_the_deleted_install_left_in_the_keychain() {
        let (fake, folder) = (Fake::default(), folder());
        for stale in ["account.json", "sync-key.json", "sync-device.json.damaged"] {
            fake.items.lock().unwrap().insert(stale.into(), "old".into());
        }
        let store = Moving { primary: &fake, legacy: Files };

        store.prepare(&folder, &NAMES);

        assert!(keys(&fake).is_empty());
        assert_eq!(store.read(&folder.join("account.json")).unwrap(), None);
        // The install now owns the Keychain: what it stores stays through restarts and updates.
        store.write(&folder.join("account.json"), "new").unwrap();
        store.prepare(&folder, &NAMES);
        assert_eq!(store.read(&folder.join("account.json")).unwrap().as_deref(), Some("new"));
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_marker_that_cannot_be_written_clears_nothing() {
        let fake = Fake::default();
        fake.items.lock().unwrap().insert("account.json".into(), "signed in".into());
        // The folder is a file: the marker can't be written in it, start after start.
        let folder = folder();
        std::fs::remove_dir(&folder).unwrap();
        std::fs::write(&folder, b"not a folder").unwrap();
        let store = Moving { primary: &fake, legacy: Files };
        store.prepare(&folder, &NAMES);
        store.prepare(&folder, &NAMES);
        assert_eq!(keys(&fake), ["account.json"]);
        let _ = std::fs::remove_file(folder);
    }

    #[test]
    fn old_files_next_to_a_keychain_with_no_marker_are_not_a_reinstall() {
        // A start cut between the first item moved and the marker: nothing may be cleared.
        let (fake, folder) = (Fake::default(), folder());
        fake.items.lock().unwrap().insert("account.json".into(), "moved".into());
        std::fs::write(folder.join("sync-key.json"), "key").unwrap();
        let store = Moving { primary: &fake, legacy: Files };

        store.prepare(&folder, &NAMES);

        assert_eq!(keys(&fake), ["account.json", "sync-key.json"]);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_move_that_fails_keeps_the_file_and_still_reads_it() {
        let (fake, folder) = (Fake::default(), folder());
        let path = folder.join("sync-key.json");
        std::fs::write(&path, "key").unwrap();
        *fake.broken.lock().unwrap() = true;
        let store = Moving { primary: &fake, legacy: Files };

        assert_eq!(store.read(&path).unwrap().as_deref(), Some("key"));
        assert!(path.exists(), "nothing is lost while the Keychain refuses");

        *fake.broken.lock().unwrap() = false;
        assert_eq!(store.read(&path).unwrap().as_deref(), Some("key"));
        assert!(!path.exists());
        assert_eq!(keys(&fake), ["sync-key.json"]);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_write_leaves_no_old_copy_and_a_delete_leaves_nothing() {
        let (fake, folder) = (Fake::default(), folder());
        let path = folder.join("account.json");
        std::fs::write(&path, "old").unwrap();
        let store = Moving { primary: &fake, legacy: Files };

        store.write(&path, "new").unwrap();
        assert!(!path.exists());
        assert_eq!(store.read(&path).unwrap().as_deref(), Some("new"));

        store.delete(&path).unwrap();
        assert_eq!(store.read(&path).unwrap(), None);
        assert!(keys(&fake).is_empty());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_secret_that_does_not_read_is_kept_aside_for_a_look() {
        let (fake, folder) = (Fake::default(), folder());
        let (path, aside) = (folder.join("sync-device.json"), folder.join("sync-device.json.damaged"));
        let store = Moving { primary: &fake, legacy: Files };
        store.write(&path, "{broken").unwrap();

        store.set_aside(&path, &aside).unwrap();

        assert_eq!(store.read(&path).unwrap(), None);
        assert_eq!(store.read(&aside).unwrap().as_deref(), Some("{broken"));
        let _ = std::fs::remove_dir_all(folder);
    }
}
