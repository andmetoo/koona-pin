//! The capture socket of the Safari extension (NP-119). Safari's handler runs
//! in a sandboxed appex that can reach a Unix socket only inside its own data
//! container, so the app listens there too, beside the `DARWIN_USER_DIR`
//! socket of koonapin-host. Any process of the user can connect to a socket
//! in that folder, so a peer is admitted by its code signature: it has to be
//! the appex embedded in this very bundle.
//!
//! What a Developer ID signature adds (once there is a team): the appex's
//! designated requirement becomes `anchor apple generic and identifier
//! "app.koona.pin.safari" and certificate leaf[subject.OU] = "<TEAM>"` with
//! no code change here. Then the requirement can also be pinned in the code,
//! `… and certificate leaf[subject.OU] = "<TEAM>"`, so a bundle whose appex
//! was swapped for one signed by someone else is refused even though its
//! designated requirement is read from disk; and the app can check its own
//! signature (`SecCodeCopySelf`) against the same team before it opens the
//! socket.

use core_foundation::{
    base::TCFType,
    data::CFData,
    string::{CFString, CFStringRef},
    url::CFURL,
};
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
};
use std::{
    ffi::{c_void, CStr, OsStr},
    fs, io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt, io::RawFd},
    path::{Path, PathBuf},
};

/// The appex's bundle id: its container is named after it.
pub const APPEX_ID: &str = "app.koona.pin.safari";
/// Where the build embeds it: `Koona Pin.app/Contents/PlugIns/…`.
const APPEX: &str = "Koona Pin Safari.appex";
/// `sun_path` on macOS, the terminating zero included.
const SUN_PATH: usize = 104;

// Not wrapped by security-framework 3.7.
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecCodeCopyDesignatedRequirement(
        code: *const c_void,
        flags: u32,
        requirement: *mut *const c_void,
    ) -> i32;
    fn SecRequirementCopyString(requirement: *const c_void, flags: u32, text: *mut CFStringRef) -> i32;
}

/// The appex of the running bundle, from the executable's own path
/// (`<bundle>/Contents/MacOS/<exe>`). A build without it opens no Safari
/// socket.
pub fn embedded_appex() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let appex = exe.parent()?.parent()?.join("PlugIns").join(APPEX);
    appex.is_dir().then_some(appex)
}

/// `~/Library/Containers/app.koona.pin.safari/Data/capture.sock`: inside the
/// appex's sandbox that is `NSHomeDirectory() + "/capture.sock"`. The home
/// folder of the user's record, not `$HOME`, which the appex does not share.
pub fn socket_path() -> io::Result<PathBuf> {
    let path = home()?
        .join("Library/Containers")
        .join(APPEX_ID)
        .join("Data/capture.sock");
    if path.as_os_str().len() >= SUN_PATH {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is {} bytes, longer than a socket path may be ({})",
                path.display(),
                path.as_os_str().len(),
                SUN_PATH - 1
            ),
        ));
    }
    Ok(path)
}

fn home() -> io::Result<PathBuf> {
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            record.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || unsafe { (*found).pw_dir.is_null() } {
        return Err(io::Error::new(io::ErrorKind::NotFound, "the user has no home folder"));
    }
    let dir = unsafe { CStr::from_ptr((*found).pw_dir) };
    Ok(PathBuf::from(OsStr::from_bytes(dir.to_bytes())))
}

/// The container and its `Data`: containermanagerd's folders, created when
/// missing (it adopts them) but never chmodded; only checked to be real
/// folders of this user, not links put in the way.
pub fn container_dir(data: &Path) -> io::Result<()> {
    fs::create_dir_all(data)?;
    for dir in [data.parent(), Some(data)].into_iter().flatten() {
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is not a folder of this user", dir.display()),
            ));
        }
    }
    Ok(())
}

/// The code signing requirement a peer must satisfy, computed once.
pub struct Admission {
    requirement: SecRequirement,
    /// The requirement's text, for the log.
    pub text: String,
}

// A requirement is an immutable CF object; CF retains and releases are
// thread-safe.
unsafe impl Send for Admission {}
unsafe impl Sync for Admission {}

fn failed(what: &str, error: security_framework::base::Error) -> String {
    format!("{what}: {error} ({})", error.code())
}

impl Admission {
    /// The designated requirement of the appex on disk: its cdhash when
    /// signed ad hoc, the team's requirement under Developer ID.
    pub fn for_appex(appex: &Path) -> Result<Self, String> {
        let url = CFURL::from_path(appex, true).ok_or_else(|| format!("{} is not a path", appex.display()))?;
        let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|e| failed("the appex's signature", e))?;
        Self::designated(code.as_concrete_TypeRef() as *const c_void)
    }

    /// The designated requirement of this process; tests stand in for the appex.
    #[cfg(test)]
    pub fn for_self() -> Result<Self, String> {
        let code = SecCode::for_self(Flags::NONE).map_err(|e| failed("own signature", e))?;
        Self::designated(code.as_concrete_TypeRef() as *const c_void)
    }

    /// A requirement in the language of `csreq`.
    pub fn from_text(text: &str) -> Result<Self, String> {
        let requirement = text.parse::<SecRequirement>().map_err(|e| failed("the requirement", e))?;
        Ok(Admission { requirement, text: text.into() })
    }

    fn designated(code: *const c_void) -> Result<Self, String> {
        let mut requirement: *const c_void = std::ptr::null();
        let status = unsafe { SecCodeCopyDesignatedRequirement(code, 0, &mut requirement) };
        if status != 0 || requirement.is_null() {
            return Err(format!("no designated requirement (OSStatus {status})"));
        }
        let requirement = unsafe { SecRequirement::wrap_under_create_rule(requirement as _) };
        let mut text: CFStringRef = std::ptr::null();
        let status = unsafe {
            SecRequirementCopyString(requirement.as_concrete_TypeRef() as *const c_void, 0, &mut text)
        };
        let text = if status == 0 && !text.is_null() {
            unsafe { CFString::wrap_under_create_rule(text) }.to_string()
        } else {
            String::new()
        };
        Ok(Admission { requirement, text })
    }

    /// The process on the other end of `fd` satisfies the requirement. Its
    /// audit token, not its pid, names it: a pid can be reused by the time it
    /// is checked.
    pub fn admits(&self, fd: RawFd) -> Result<(), String> {
        let mut token = [0u8; 32];
        let mut length = token.len() as libc::socklen_t;
        let status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != 0 || length as usize != token.len() {
            return Err(format!("no audit token: {}", io::Error::last_os_error()));
        }
        let token = CFData::from_buffer(&token);
        let mut attributes = GuestAttributes::new();
        attributes.set_audit_token(token.as_concrete_TypeRef());
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|e| failed("the peer's code", e))?;
        code.check_validity(Flags::NONE, &self.requirement)
            .map_err(|e| failed("the peer's signature", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_in_the_appex_container() {
        let path = socket_path().unwrap();
        assert!(path.ends_with("Library/Containers/app.koona.pin.safari/Data/capture.sock"), "{}", path.display());
        assert!(path.starts_with(home().unwrap()));
    }

    /// The requirement of this test binary is its own cdhash (linker-signed
    /// ad hoc), and a requirement that does not parse is an error.
    #[test]
    fn requirements_are_read_from_code_and_text() {
        let own = Admission::for_self().unwrap();
        assert!(own.text.contains("cdhash"), "{}", own.text);
        assert!(Admission::from_text("cdhash H\"").is_err());
        let ls = Admission::for_appex(Path::new("/bin/ls")).unwrap();
        assert!(ls.text.contains("com.apple.ls"), "{}", ls.text);
    }

    #[test]
    fn container_folders_are_checked_not_changed() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("koonapin-container-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let data = root.join(APPEX_ID).join("Data");
        container_dir(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        container_dir(&data).unwrap();
        assert_eq!(fs::metadata(&data).unwrap().mode() & 0o777, 0o755, "not chmodded");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(elsewhere.join("Data")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("linked")).unwrap();
        assert!(container_dir(&root.join("linked").join("Data")).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
