//! Name of the capture pipe between netamipin-host.exe and the app (Р-17).
//! Both binaries compile this file: the host includes it with `#[path]`, so it
//! does not link the app.

/// Overrides the pipe name; tests use it to stay away from a running app.
pub const PIPE_ENV: &str = "NETAMIPIN_PIPE";

/// `\\.\pipe\netamipin-<SID>`: one pipe per Windows user.
pub fn pipe_name() -> String {
    match std::env::var(PIPE_ENV) {
        Ok(name) if !name.is_empty() => format!(r"\\.\pipe\{name}"),
        _ => format!(
            r"\\.\pipe\netamipin-{}",
            user_sid().unwrap_or_else(|| "user".into())
        ),
    }
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

#[cfg(not(windows))]
pub fn user_sid() -> Option<String> {
    None
}
