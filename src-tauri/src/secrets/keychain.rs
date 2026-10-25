//! The iPhone's Keychain as a place for the secrets (`secrets.rs`): one generic password per file
//! name, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. After the first unlock, because sync
//! and the plan check may run when the phone has been unlocked once and is locked again;
//! this device only, so the items are in no iCloud or computer backup and never move to another phone.
//! The app's own access group is the default: no entitlement is needed.

use super::Store;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::base::Error;
use security_framework::passwords::{delete_generic_password_options, generic_password, set_generic_password, set_generic_password_options, PasswordOptions};
use std::io;
use std::path::Path;
use std::sync::Mutex;

const SERVICE: &str = "app.koona.pin.secrets";
/// `errSecItemNotFound`.
const NOT_FOUND: i32 = -25300;
/// Keychain calls one at a time: an add that finds the item there is turned into an update, which
/// two writers at once could cross.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

pub struct Keychain;

/// The Keychain item's account: the file name, since the folder is the app's and only one.
fn account(path: &Path) -> io::Result<String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a secret needs a file name"))
}

fn failed(error: Error) -> io::Error {
    io::Error::other(format!("Keychain: {error}"))
}

impl Store for Keychain {
    fn read(&self, path: &Path) -> io::Result<Option<String>> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match generic_password(PasswordOptions::new_generic_password(SERVICE, &account)) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(failed(e)),
        }
    }

    fn write(&self, path: &Path, text: &str) -> io::Result<()> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match generic_password(PasswordOptions::new_generic_password(SERVICE, &account)) {
            // Only the value changes: the item keeps the protection it was made with.
            Ok(_) => set_generic_password(SERVICE, &account, text.as_bytes()).map_err(failed),
            Err(e) if e.code() == NOT_FOUND => {
                let protection = SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly), 0).map_err(failed)?;
                let mut options = PasswordOptions::new_generic_password(SERVICE, &account);
                options.set_access_control(protection);
                set_generic_password_options(text.as_bytes(), options).map_err(failed)
            }
            Err(e) => Err(failed(e)),
        }
    }

    fn delete(&self, path: &Path) -> io::Result<()> {
        let account = account(path)?;
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        match delete_generic_password_options(PasswordOptions::new_generic_password(SERVICE, &account)) {
            Err(e) if e.code() != NOT_FOUND => Err(failed(e)),
            _ => Ok(()),
        }
    }
}
