//! Address of the capture channel between koonapin-host and the app (Р-17):
//! a named pipe on Windows, a Unix socket on Linux (Р-45, п. 6) and macOS
//! (NP-050). Both binaries compile this file: the host includes it with
//! `#[path]`, so it does not link the app.

/// Overrides the pipe name (the socket name on Linux and macOS); tests use it
/// to stay away from a running app.
pub const PIPE_ENV: &str = "KOONAPIN_PIPE";

/// `\\.\pipe\koonapin-<SID>`: one pipe per Windows user.
#[cfg(windows)]
pub fn pipe_name() -> String {
    match std::env::var(PIPE_ENV) {
        Ok(name) if !name.is_empty() => format!(r"\\.\pipe\{name}"),
        _ => format!(
            r"\\.\pipe\koonapin-{}",
            user_sid().unwrap_or_else(|| "user".into())
        ),
    }
}

/// `$XDG_RUNTIME_DIR/koonapin/capture.sock`: the runtime folder belongs to the
/// user and lives as long as the session. Without it there is no private
/// place for the socket, and the channel says so rather than falling back to
/// `/tmp`.
#[cfg(target_os = "linux")]
pub fn socket_path() -> std::io::Result<std::path::PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "XDG_RUNTIME_DIR is not set: the capture socket has no private folder",
            )
        })?;
    let name = match std::env::var(PIPE_ENV) {
        Ok(name) if !name.is_empty() => format!("{name}.sock"),
        _ => "capture.sock".into(),
    };
    Ok(std::path::Path::new(&runtime).join("koonapin").join(name))
}

/// `/var/folders/…/0/koonapin/capture.sock`: the user's own folder of the
/// system (`_CS_DARWIN_USER_DIR`), `0700` and kept, unlike its `T` neighbour
/// that the system empties of files older than three days. The same folder
/// for the browser's host as for the app, whatever their `TMPDIR`.
#[cfg(target_os = "macos")]
pub fn socket_path() -> std::io::Result<std::path::PathBuf> {
    let mut buffer = vec![0u8; 1024];
    let length = unsafe {
        libc::confstr(libc::_CS_DARWIN_USER_DIR, buffer.as_mut_ptr().cast(), buffer.len())
    };
    if length == 0 || length > buffer.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the system has no folder of this user for the capture socket",
        ));
    }
    use std::os::unix::ffi::OsStringExt;
    buffer.truncate(length - 1);
    let user = std::path::PathBuf::from(std::ffi::OsString::from_vec(buffer));
    let name = match std::env::var(PIPE_ENV) {
        Ok(name) if !name.is_empty() => format!("{name}.sock"),
        _ => "capture.sock".into(),
    };
    Ok(user.join("koonapin").join(name))
}

/// The SID of the current user as a string, `S-1-5-21-…`.
#[cfg(windows)]
pub fn user_sid() -> Option<String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut length = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length);
        // u64 keeps the buffer aligned for TOKEN_USER.
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        let read = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        );
        CloseHandle(token);
        if read == 0 {
            return None;
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text: windows_sys::core::PWSTR = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return None;
        }
        let length = (0..).take_while(|&i| *text.add(i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Some(sid)
    }
}
