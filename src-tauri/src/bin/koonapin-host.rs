// No console window: the browser starts the host for every message.
#![windows_subsystem = "windows"]
//! The native messaging host (Р-17). The browser starts it for each message of
//! the extension; it passes the message to the running app over the capture
//! pipe (a Unix socket on Linux) and returns the reply. A capture starts a
//! closed app in the tray first.
//!
//! The host does not link the app: it only shares the channel's address.

#[path = "../pipe_name.rs"]
mod pipe_name;

use serde_json::{json, Value};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    thread,
    time::{Duration, Instant},
};

/// The app takes a capture 0.35–0.45 s after a hidden start (NP-014); the rest
/// is room for a slow disk or the first start of WebView2.
const START_WAIT: Duration = Duration::from_secs(10);
/// A message from the extension is far smaller; anything larger is refused.
const MAX_MESSAGE: usize = 1024 * 1024;

fn main() {
    let caller = caller(&std::env::args().skip(1).collect::<Vec<_>>());
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(message) = read_message(&mut input) {
        let reply = match message {
            Ok(message) => relay(caller.as_deref(), message),
            Err(error) => failure("invalid_request", &error),
        };
        if write_message(&mut output, &reply).is_err() {
            break;
        }
    }
}

/// Chrome and Edge pass the extension's origin first; Firefox passes the
/// manifest path and then the add-on id.
fn caller(args: &[String]) -> Option<String> {
    match args {
        [first, ..] if first.starts_with("chrome-extension://") => Some(first.clone()),
        [_, id, ..] => Some(id.clone()),
        _ => None,
    }
}

/// UTF-8 JSON preceded by its length, a 32-bit number in native byte order.
fn read_message(input: &mut impl Read) -> Option<Result<Value, String>> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length).ok()?;
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_MESSAGE {
        // Skip it whole, so the next message is read from its start.
        io::copy(&mut input.take(length as u64), &mut io::sink()).ok()?;
        return Some(Err("message too large".into()));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice(&body).map_err(|e| e.to_string()))
}

fn write_message(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

fn relay(caller: Option<&str>, message: Value) -> Value {
    // What the person asked for starts the app: saving, searching from the
    // popup (NP-082) and «Open Koona Pin». A hello does not open an app the
    // user closed.
    let starts = matches!(message["type"].as_str(), Some("capture" | "search" | "show"));
    let envelope = json!({ "caller": caller, "message": message });
    if let Ok(reply) = send(&envelope) {
        return reply;
    }
    if starts && start_app().is_ok() {
        let started = Instant::now();
        while started.elapsed() < START_WAIT {
            thread::sleep(Duration::from_millis(50));
            if let Ok(reply) = send(&envelope) {
                return reply;
            }
        }
    }
    failure("app_unavailable", "Koona Pin is not running or does not answer")
}

#[cfg(windows)]
fn send(envelope: &Value) -> io::Result<Value> {
    let name = pipe_name::pipe_name();
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
fn send(envelope: &Value) -> io::Result<Value> {
    exchange(std::os::unix::net::UnixStream::connect(pipe_name::socket_path()?)?, envelope)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn send(_envelope: &Value) -> io::Result<Value> {
    Err(io::Error::other("not available on this system yet"))
}

/// One line each way, as the app reads it.
#[cfg(any(windows, target_os = "linux"))]
fn exchange(mut channel: impl Read + Write, envelope: &Value) -> io::Result<Value> {
    channel.write_all(format!("{envelope}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(channel.take(MAX_MESSAGE as u64)).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(io::Error::other)
}

/// `koonapin.exe --autostart` next to the host: hidden, in the tray.
///
/// Firefox kills the host's job when it is done, so the app leaves the job
/// (`CREATE_BREAKAWAY_FROM_JOB`); where the job forbids that, it starts inside.
/// No handles are inherited: the app must not hold the browser's pipes, or the
/// browser waits for it (NP-014).
#[cfg(windows)]
fn start_app() -> io::Result<()> {
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

/// `koonapin --autostart` next to the host (`/usr/bin` in the package): hidden,
/// in the tray.
#[cfg(target_os = "linux")]
fn start_app() -> io::Result<()> {
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
fn launch(app: &std::path::Path) -> io::Result<()> {
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

/// A new session (`setsid`), so the browser's signals to the host and its
/// group do not reach the app. Nothing of the browser is inherited: stdin,
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
fn start_app() -> io::Result<()> {
    Err(io::Error::other("not available on this system yet"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_is_the_origin_or_the_add_on_id() {
        let chrome = ["chrome-extension://abc/".to_string(), "--parent-window=0".into()];
        assert_eq!(caller(&chrome).as_deref(), Some("chrome-extension://abc/"));
        let firefox = [r"C:\Koona Pin\app.koona.pin.firefox.json".to_string(), "pin@koona.app".into()];
        assert_eq!(caller(&firefox).as_deref(), Some("pin@koona.app"));
        assert_eq!(caller(&[]), None);
    }

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

    #[test]
    fn messages_are_length_prefixed_and_oversized_ones_are_skipped() {
        let mut stream = Vec::new();
        write_message(&mut stream, &json!({ "type": "hello" })).unwrap();
        stream.extend_from_slice(&((MAX_MESSAGE + 1) as u32).to_ne_bytes());
        stream.extend(std::iter::repeat_n(b' ', MAX_MESSAGE + 1));
        write_message(&mut stream, &json!({ "type": "capture" })).unwrap();
        let mut input = stream.as_slice();
        assert_eq!(read_message(&mut input).unwrap().unwrap()["type"], "hello");
        assert!(read_message(&mut input).unwrap().is_err());
        assert_eq!(read_message(&mut input).unwrap().unwrap()["type"], "capture");
        assert!(read_message(&mut input).is_none());
    }
}
