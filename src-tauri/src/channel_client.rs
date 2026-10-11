//! The client side of the capture channel (Р-17): one JSON line to the running
//! app and its answer, and starting a closed app in the tray. koonapin-host
//! and koonapin-mcp (NP-091) include this file with `#[path]` next to
//! `pipe_name.rs`; the app does not compile it.

use serde_json::Value;
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    thread,
    time::{Duration, Instant},
};

/// The app takes a capture 0.35–0.45 s after a hidden start (NP-014); the rest
/// is room for a slow disk or the first start of WebView2.
pub const START_WAIT: Duration = Duration::from_secs(10);
/// The app refuses a longer line; an answer is never longer either.
pub const MAX_LINE: usize = 1024 * 1024;

/// One exchange; when `start` and the app does not answer, it is started
/// hidden and asked again until [`START_WAIT`] runs out.
pub fn ask(envelope: &Value, start: bool) -> io::Result<Value> {
    let first = send(envelope);
    if first.is_ok() || !start {
        return first;
    }
    start_app()?;
    let started = Instant::now();
    while started.elapsed() < START_WAIT {
        thread::sleep(Duration::from_millis(50));
        if let Ok(reply) = send(envelope) {
            return Ok(reply);
        }
    }
    first
}

#[cfg(windows)]
pub fn send(envelope: &Value) -> io::Result<Value> {
    let name = crate::pipe_name::pipe_name();
    let mut attempts = 0;
    let pipe = loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&name) {
            Ok(pipe) => break pipe,
            // ERROR_PIPE_BUSY: the app is about to offer the next instance.
            Err(error) if error.raw_os_error() == Some(231) && attempts < 40 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    };
    exchange(pipe, envelope)
}

#[cfg(target_os = "linux")]
pub fn send(envelope: &Value) -> io::Result<Value> {
    exchange(std::os::unix::net::UnixStream::connect(crate::pipe_name::socket_path()?)?, envelope)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn send(_envelope: &Value) -> io::Result<Value> {
    Err(io::Error::other("not available on this system yet"))
}

/// One line each way, as the app reads it.
#[cfg(any(windows, target_os = "linux"))]
fn exchange(mut channel: impl Read + Write, envelope: &Value) -> io::Result<Value> {
    channel.write_all(format!("{envelope}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(channel.take(MAX_LINE as u64)).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(io::Error::other)
}

/// `koonapin.exe --autostart` next to this binary: hidden, in the tray.
///
/// Firefox kills the host's job when it is done, so the app leaves the job
/// (`CREATE_BREAKAWAY_FROM_JOB`); where the job forbids that, it starts inside.
/// No handles are inherited: the app must not hold the caller's pipes, or the
/// browser waits for it (NP-014).
#[cfg(windows)]
pub fn start_app() -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
            PROCESS_INFORMATION, STARTUPINFOW,
        },
    };
    let host = std::env::current_exe()?;
    let folder = host.parent().ok_or_else(|| io::Error::other("no folder"))?;
    let app = folder.join("koonapin.exe");
    let mut last = io::Error::other("not started");
    for breakaway in [true, false] {
        let mut command: Vec<u16> = format!("\"{}\" --autostart", app.display())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let directory: Vec<u16> = folder
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let flags = DETACHED_PROCESS
            | CREATE_NEW_PROCESS_GROUP
            | if breakaway { CREATE_BREAKAWAY_FROM_JOB } else { 0 };
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                directory.as_ptr(),
                &startup,
                &mut process,
            )
        };
        if created != 0 {
            unsafe {
                CloseHandle(process.hProcess);
                CloseHandle(process.hThread);
            }
            return Ok(());
        }
        last = io::Error::last_os_error();
    }
    Err(last)
}

/// `koonapin --autostart` next to this binary (`/usr/bin` in the package):
/// hidden, in the tray.
#[cfg(target_os = "linux")]
pub fn start_app() -> io::Result<()> {
    let host = std::env::current_exe()?;
    let folder = host.parent().ok_or_else(|| io::Error::other("no folder"))?;
    launch(&folder.join("koonapin"))
}

/// In a scope of its own when the user's systemd runs (Р-53, п. 6): otherwise
/// the app lives in the cgroup of whoever started the host — the browser, or
/// for the Snap Firefox the portal's service — and goes when that unit stops,
/// as a Firefox job took the app along on Windows (NP-014). `systemd-run`
/// becomes the app once the scope exists; when it cannot make one it ends at
/// once with an error, and the app starts without it.
#[cfg(target_os = "linux")]
pub fn launch(app: &std::path::Path) -> io::Result<()> {
    use std::process::Command;
    let direct = {
        let app = app.to_path_buf();
        move || detached(Command::new(&app).arg("--autostart")).spawn().map(drop)
    };
    if user_systemd() {
        let unit = format!(
            "--unit=app-app.koona.pin-{:x}.scope",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |t| t.as_nanos())
                ^ u128::from(std::process::id())
        );
        let mut command = Command::new("systemd-run");
        command
            .args(["--user", "--scope", "--collect", "--quiet", "--slice=app.slice"])
            .args(["--description=Koona Pin", &unit, "--"])
            .arg(app)
            .arg("--autostart");
        if let Ok(mut scoped) = detached(&mut command).spawn() {
            thread::spawn(move || {
                if scoped.wait().is_ok_and(|status| !status.success()) {
                    let _ = direct();
                }
            });
            return Ok(());
        }
    }
    direct()
}

/// The user's manager answers on `$XDG_RUNTIME_DIR/systemd/private`;
/// containers have none.
#[cfg(target_os = "linux")]
fn user_systemd() -> bool {
    std::env::var_os("XDG_RUNTIME_DIR")
        .is_some_and(|dir| std::path::Path::new(&dir).join("systemd/private").exists())
}

/// A new session (`setsid`), so the caller's signals to the host and its
/// group do not reach the app. Nothing of the caller is inherited: stdin,
/// stdout and stderr are `/dev/null`, every other descriptor closes at exec —
/// on Windows an inherited pipe kept Chrome from finishing (Р-17, п. 3).
#[cfg(target_os = "linux")]
fn detached(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    command
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Between fork and exec: only calls that are safe there. Close-on-exec
    // rather than close, so Rust still hears about a failed exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            let all = libc::syscall(
                libc::SYS_close_range,
                3 as libc::c_uint,
                libc::c_uint::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            );
            if all != 0 {
                // A kernel older than 5.11.
                for fd in 3..1024 {
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
            }
            Ok(())
        });
    }
    command
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn start_app() -> io::Result<()> {
    Err(io::Error::other("not available on this system yet"))
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// The app starts in its own scope; when systemd-run cannot make one, or
    /// there is no user manager, it starts directly (Р-53, п. 6). A script
    /// stands in for systemd-run.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_app_starts_in_a_scope_or_without_one() {
        use std::{os::unix::fs::PermissionsExt, path::Path};
        let dir = std::env::temp_dir().join(format!("koonapin-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (bin, runtime) = (dir.join("bin"), dir.join("run"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(runtime.join("systemd")).unwrap();
        std::fs::write(runtime.join("systemd/private"), "").unwrap();
        let script = |path: &Path, body: String| {
            std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let (app, app_args, scope_args) = (dir.join("koonapin"), dir.join("app.args"), dir.join("scope.args"));
        script(&app, format!("echo \"$@\" > {}", app_args.display()));
        // The only test in this binary that touches these variables.
        std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()));
        std::env::set_var("XDG_RUNTIME_DIR", &runtime);
        let started = |file: &Path| {
            (0..100).any(|_| {
                thread::sleep(Duration::from_millis(50));
                std::fs::read_to_string(file).is_ok_and(|text| text.ends_with('\n'))
            })
        };
        let read = |file: &Path| std::fs::read_to_string(file).unwrap().trim().to_owned();

        // systemd-run makes the scope and becomes the app.
        script(
            &bin.join("systemd-run"),
            format!("echo \"$@\" > {}\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"", scope_args.display()),
        );
        launch(&app).unwrap();
        assert!(started(&app_args), "the app did not start in the scope");
        let scope = read(&scope_args);
        assert!(scope.starts_with("--user --scope --collect --quiet --slice=app.slice"), "{scope}");
        assert!(scope.contains("--unit=app-app.koona.pin-"), "{scope}");
        assert!(scope.ends_with(&format!("-- {} --autostart", app.display())), "{scope}");
        assert_eq!(read(&app_args), "--autostart");

        // It cannot make one: the app starts without it.
        std::fs::remove_file(&app_args).unwrap();
        script(&bin.join("systemd-run"), "exit 1".into());
        launch(&app).unwrap();
        assert!(started(&app_args), "no fallback after systemd-run failed");

        // No user manager: systemd-run is not asked at all.
        std::fs::remove_file(&app_args).unwrap();
        std::fs::remove_file(runtime.join("systemd/private")).unwrap();
        script(&bin.join("systemd-run"), format!("touch {}", dir.join("asked").display()));
        launch(&app).unwrap();
        assert!(started(&app_args));
        assert!(!dir.join("asked").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
