//! The iPhone's Keychain as a place for the secrets (`secrets.rs`): one generic password per file
//! name, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. After the first unlock, because sync
//! and the plan check may run when the phone has been unlocked once and is locked again;
//! this device only, so the items are in no iCloud or computer backup and never move to another phone.
//! The app's own access group is the default: no entitlement is needed.
//!
//! The Keychain's own calls are behind [`Items`], so what this module decides (a missing item is
//! none, a write adds or updates, a delete of nothing is fine) is tested with a fake on any desktop;
//! [`System`] is the real one, on iOS.

use super::Store;
use std::io;
use std::path::Path;
use std::sync::Mutex;

#[cfg(target_os = "ios")]
const SERVICE: &str = "app.koona.pin.secrets";
/// `errSecItemNotFound`.
const NOT_FOUND: i32 = -25300;
/// Keychain calls one at a time: an add that finds the item there is turned into an update, which
/// two writers at once could cross.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// A Keychain call that failed: its `OSStatus` and what the system says of it.
#[derive(Debug)]
pub struct Failure {
    pub code: i32,
    pub message: String,
}

/// The generic passwords of [`SERVICE`], by account.
pub trait Items {
    fn get(&self, account: &str) -> Result<Vec<u8>, Failure>;
    /// Changes the value of an item that is there; it keeps the protection it was made with.
    fn update(&self, account: &str, value: &[u8]) -> Result<(), Failure>;
    /// Makes an item, readable after the first unlock and on this device only.
    fn add(&self, account: &str, value: &[u8]) -> Result<(), Failure>;
    fn remove(&self, account: &str) -> Result<(), Failure>;
}

pub struct Keychain<I: Items>(pub I);

/// The Keychain item's account: the file name, since the folder is the app's and only one.
fn account(path: &Path) -> io::Result<String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a secret needs a file name"))
}

fn failed(error: Failure) -> io::Error {
    io::Error::other(format!("Keychain: {} ({})", error.message, error.code))
}

impl<I: Items> Store for Keychain<I> {
    fn read(&self, path: &Path) -> io::Result<Option<String>> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match self.0.get(&account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.code == NOT_FOUND => Ok(None),
            Err(e) => Err(failed(e)),
        }
    }

    fn write(&self, path: &Path, text: &str) -> io::Result<()> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match self.0.get(&account) {
            Ok(_) => self.0.update(&account, text.as_bytes()).map_err(failed),
            Err(e) if e.code == NOT_FOUND => self.0.add(&account, text.as_bytes()).map_err(failed),
            Err(e) => Err(failed(e)),
        }
    }

    fn delete(&self, path: &Path) -> io::Result<()> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match self.0.remove(&account) {
            Err(e) if e.code != NOT_FOUND => Err(failed(e)),
            _ => Ok(()),
        }
    }
}

/// The iPhone's Keychain itself.
#[cfg(target_os = "ios")]
pub struct System;

#[cfg(target_os = "ios")]
impl Items for System {
    fn get(&self, account: &str) -> Result<Vec<u8>, Failure> {
        use security_framework::passwords::{generic_password, PasswordOptions};
        generic_password(PasswordOptions::new_generic_password(SERVICE, account)).map_err(failure)
    }

    fn update(&self, account: &str, value: &[u8]) -> Result<(), Failure> {
        security_framework::passwords::set_generic_password(SERVICE, account, value).map_err(failure)
    }

    fn add(&self, account: &str, value: &[u8]) -> Result<(), Failure> {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        use security_framework::passwords::{set_generic_password_options, PasswordOptions};
        let protection = SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly), 0).map_err(failure)?;
        let mut options = PasswordOptions::new_generic_password(SERVICE, account);
        options.set_access_control(protection);
        set_generic_password_options(value, options).map_err(failure)
    }

    fn remove(&self, account: &str) -> Result<(), Failure> {
        use security_framework::passwords::{delete_generic_password_options, PasswordOptions};
        delete_generic_password_options(PasswordOptions::new_generic_password(SERVICE, account)).map_err(failure)
    }
}

#[cfg(target_os = "ios")]
fn failure(error: security_framework::base::Error) -> Failure {
    Failure { code: error.code(), message: error.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// The Keychain's calls as a map, counting adds and updates; `locked` fails every call as a
    /// Keychain before the first unlock does (`errSecInteractionNotAllowed`).
    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, Vec<u8>>>,
        adds: Mutex<usize>,
        updates: Mutex<usize>,
        locked: Mutex<bool>,
    }

    const LOCKED: i32 = -25308;

    impl Fake {
        fn check(&self) -> Result<(), Failure> {
            if *self.locked.lock().unwrap() {
                return Err(Failure { code: LOCKED, message: "interaction not allowed".into() });
            }
            Ok(())
        }
    }

    impl Items for &Fake {
        fn get(&self, account: &str) -> Result<Vec<u8>, Failure> {
            self.check()?;
            self.items.lock().unwrap().get(account).cloned().ok_or(Failure { code: NOT_FOUND, message: "not found".into() })
        }
        fn update(&self, account: &str, value: &[u8]) -> Result<(), Failure> {
            self.check()?;
            *self.updates.lock().unwrap() += 1;
            self.items.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn add(&self, account: &str, value: &[u8]) -> Result<(), Failure> {
            self.check()?;
            *self.adds.lock().unwrap() += 1;
            // Adding what is there fails in the Keychain (errSecDuplicateItem).
            let mut items = self.items.lock().unwrap();
            if items.contains_key(account) {
                return Err(Failure { code: -25299, message: "duplicate".into() });
            }
            items.insert(account.into(), value.into());
            Ok(())
        }
        fn remove(&self, account: &str) -> Result<(), Failure> {
            self.check()?;
            self.items.lock().unwrap().remove(account).map(|_| ()).ok_or(Failure { code: NOT_FOUND, message: "not found".into() })
        }
    }

    fn at(name: &str) -> std::path::PathBuf {
        Path::new("/folder").join(name)
    }

    #[test]
    fn a_write_adds_once_then_updates_and_a_read_finds_it() {
        let fake = Fake::default();
        let keychain = Keychain(&fake);
        assert_eq!(keychain.read(&at("account.json")).unwrap(), None, "nothing there is none, not an error");
        keychain.write(&at("account.json"), "one").unwrap();
        keychain.write(&at("account.json"), "two").unwrap();
        assert_eq!((*fake.adds.lock().unwrap(), *fake.updates.lock().unwrap()), (1, 1));
        assert_eq!(keychain.read(&at("account.json")).unwrap().as_deref(), Some("two"));
    }

    #[test]
    fn a_delete_of_nothing_is_fine_and_a_locked_keychain_is_an_error_never_none() {
        let fake = Fake::default();
        let keychain = Keychain(&fake);
        keychain.delete(&at("sync-key.json")).unwrap();
        keychain.write(&at("sync-key.json"), "key").unwrap();
        *fake.locked.lock().unwrap() = true;
        assert!(keychain.read(&at("sync-key.json")).is_err(), "locked is not «no secret»");
        assert!(keychain.write(&at("sync-key.json"), "other").is_err());
        assert!(keychain.delete(&at("sync-key.json")).is_err());
        *fake.locked.lock().unwrap() = false;
        assert_eq!(keychain.read(&at("sync-key.json")).unwrap().as_deref(), Some("key"));
    }

    #[test]
    fn a_secret_needs_a_file_name() {
        let fake = Fake::default();
        assert!(Keychain(&fake).read(Path::new("/")).is_err());
    }
}
