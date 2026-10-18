//! The desktop half of capture (NP-016, NP-050, NP-099, NP-119; moved here in NP-072a): the
//! browser host's registration, and the named pipe (Windows) or Unix socket the host and
//! koonapin-mcp talk to, with the Safari socket on macOS. What a message does is shared and stays in
//! `crate::capture_channel`; a phone has neither the host nor the MCP server.

use crate::capture::{self};
use crate::browsers::Connections;
use crate::capture_channel::{emit_status, failure, handle, lock, parse, ChannelState, Envelope, Handled, MAX_MESSAGE, READ_TIMEOUT};
use crate::db::DbState;
use chrono::Utc;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Points the browsers at the host, when this build registers (see
/// `native_host::should_register`).
pub fn register_host(app: &AppHandle, state: &ChannelState) {
    if crate::desktop::native_host::should_register() {
        state.set_registration(crate::desktop::native_host::register().err());
        emit_status(app, state);
    }
}

/// Loads the records of the opened library and starts the pipe. Desktop only: a phone has
/// neither the browser host nor the MCP server (NP-151).
pub fn start(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    if let Ok(conn) = db.conn.lock() {
        *lock(&state.connections) = Connections::load(&conn);
    }
    serve(app.clone(), db.clone(), state.clone());
    #[cfg(target_os = "macos")]
    serve_safari(app, db, state);
}

#[cfg(windows)]
fn serve(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    let name = crate::desktop::pipe_name::pipe_name();
    let mut security = match security::OnlyCurrentUser::new() {
        Ok(security) => security,
        Err(error) => {
            state.set_channel(Some(error.to_string()));
            emit_status(&app, &state);
            return;
        }
    };
    // The first instance flag: if another program already holds the name,
    // the app does not share it but reports the problem.
    let mut create = move |first: bool| -> std::io::Result<NamedPipeServer> {
        let _runtime = tauri::async_runtime::handle().inner().enter();
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, security.attributes())
        }
    };
    // The first instance is created before this returns, so «Повторить» answers
    // with the real state.
    let mut server = match create(true) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Capture pipe: {error}");
            state.set_channel(Some(error.to_string()));
            emit_status(&app, &state);
            return;
        }
    };
    state.set_channel(None);
    emit_status(&app, &state);
    tauri::async_runtime::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                continue;
            }
            // The next instance waits before this one is answered.
            let connected = loop {
                match create(false) {
                    Ok(next) => break std::mem::replace(&mut server, next),
                    Err(error) => {
                        eprintln!("Capture pipe: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            };
            let (app, db, state) = (app.clone(), db.clone(), state.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = answer(connected, true, |e| respond(e, app, db, state)).await {
                    eprintln!("Capture pipe: {error}");
                }
            });
        }
    });
}
#[cfg(unix)]
fn serve(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    // Bound before this returns, so «Повторить» answers with the real state.
    let listener = crate::desktop::pipe_name::socket_path()
        .and_then(|path| socket::bind(&path))
        .and_then(|listener| {
            listener.set_nonblocking(true)?;
            let _runtime = tauri::async_runtime::handle().inner().enter();
            tokio::net::UnixListener::from_std(listener)
        });
    let listener = match listener {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Capture socket: {error}");
            state.set_channel(Some(error.to_string()));
            emit_status(&app, &state);
            return;
        }
    };
    state.set_channel(None);
    emit_status(&app, &state);
    tauri::async_runtime::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(error) => {
                    // Out of descriptors, for one: not a reason to spin.
                    eprintln!("Capture socket: {error}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            };
            if !socket::admitted(stream.peer_cred().ok().map(|peer| peer.uid())) {
                continue;
            }
            let (app, db, state) = (app.clone(), db.clone(), state.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = answer(stream, true, |e| respond(e, app, db, state)).await {
                    eprintln!("Capture socket: {error}");
                }
            });
        }
    });
}
/// The Safari socket (NP-119): opened once, and only when this bundle embeds
/// the appex. It failing to open is logged, not a failure of capture: Chrome,
/// Edge and Firefox still reach the app through the host's socket.
#[cfg(target_os = "macos")]
fn serve_safari(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    use crate::desktop::safari_socket;
    static OPENED: std::sync::Once = std::sync::Once::new();
    OPENED.call_once(|| {
        let Some(appex) = safari_socket::embedded_appex() else { return };
        let opened = safari_socket::Admission::for_appex(&appex)
            .map_err(std::io::Error::other)
            .and_then(|admission| Ok((admission, safari_socket::socket_path()?)))
            .and_then(|(admission, path)| Ok((admission, socket::bind_safari(&path)?)))
            .and_then(|(admission, listener)| {
                listener.set_nonblocking(true)?;
                let _runtime = tauri::async_runtime::handle().inner().enter();
                Ok((admission, tokio::net::UnixListener::from_std(listener)?))
            });
        match opened {
            Ok((admission, listener)) => {
                eprintln!("Safari socket: admitting {}", admission.text);
                let respond = move |e| respond(e, app.clone(), db.clone(), state.clone());
                tauri::async_runtime::spawn(serve_admitted(listener, Arc::new(admission), respond));
            }
            Err(error) => eprintln!("Safari socket: {error}"),
        }
    });
}

/// Accepts on the Safari socket: the user's own processes (as the host's
/// socket) whose code satisfies `admission`. A refused peer is dropped with
/// no reply. Only the extension's messages: `mcp` stays on the host's socket.
#[cfg(target_os = "macos")]
async fn serve_admitted<F, Fut>(
    listener: tokio::net::UnixListener,
    admission: Arc<crate::desktop::safari_socket::Admission>,
    respond: F,
) where
    F: Fn(Envelope) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = std::io::Result<Value>> + Send,
{
    use std::os::unix::io::AsRawFd;
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                eprintln!("Safari socket: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
        };
        if !socket::admitted(stream.peer_cred().ok().map(|peer| peer.uid())) {
            eprintln!("Safari socket: refused a process of another user");
            continue;
        }
        let (admission, respond) = (admission.clone(), respond.clone());
        tokio::spawn(async move {
            // The descriptor stays open: `stream` lives in this task.
            let fd = stream.as_raw_fd();
            let checked = tokio::task::spawn_blocking(move || admission.admits(fd))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            if let Err(why) = checked {
                eprintln!("Safari socket: refused a peer: {why}");
                return;
            }
            if let Err(error) = answer(stream, false, respond).await {
                eprintln!("Safari socket: {error}");
            }
        });
    }
}

/// One line in, one line out. `takes_mcp`: koonapin-mcp's messages are
/// answered only on the host's socket, never on Safari's (NP-119).
async fn answer<F, Fut>(
    pipe: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    takes_mcp: bool,
    respond: F,
) -> std::io::Result<()>
where
    F: FnOnce(Envelope) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<Value>>,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let mut reader = BufReader::new(pipe);
    let mut line = Vec::new();
    // A client that connects and says nothing does not keep a task forever.
    tokio::time::timeout(
        READ_TIMEOUT,
        (&mut reader)
            .take(MAX_MESSAGE as u64 + 1)
            .read_until(b'\n', &mut line),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "no message"))??;
    let reply = match parse(&line) {
        Some(envelope) if !takes_mcp && envelope.message["type"] == "mcp" => {
            failure("invalid_request", "Unknown message")
        }
        Some(envelope) => respond(envelope).await?,
        None => failure("invalid_request", "Unknown message"),
    };
    let pipe = reader.get_mut();
    pipe.write_all(format!("{reply}\n").as_bytes()).await?;
    pipe.flush().await
}

/// What the app does with a message: the same for every socket.
async fn respond(
    envelope: Envelope,
    app: AppHandle,
    db: Arc<DbState>,
    state: Arc<ChannelState>,
) -> std::io::Result<Value> {
    Ok(match envelope {
        // koonapin-mcp (NP-091): the journal too, as the interface's changes.
        envelope if envelope.message["type"] == "mcp" => {
            let database = db.clone();
            let (handled, status) = tauri::async_runtime::spawn_blocking(move || {
                let conn = database.conn.lock().map_err(|_| ())?;
                let mut journal = database.journal.lock().map_err(|_| ())?;
                let handled = crate::desktop::mcp::handle(&conn, &mut journal, &envelope.message, Utc::now());
                let status = handled.status.then(|| crate::desktop::mcp::status(&conn));
                Ok::<_, ()>((handled, status))
            })
            .await
            .map_err(std::io::Error::other)?
            .unwrap_or_else(|_| {
                let reply = failure("database_error", "The database is unavailable");
                (crate::desktop::mcp::Handled { reply, changed: Vec::new(), saved: None, status: false }, None)
            });
            if let Some(saved) = &handled.saved {
                capture::after_save(&app, db.clone(), saved);
            }
            capture::emit_many(&app, &handled.changed);
            if let Some(status) = status {
                let _ = app.emit("mcp-status", status);
            }
            handled.reply
        }
        envelope => {
            let (database, records) = (db.clone(), state.clone());
            let handled = tauri::async_runtime::spawn_blocking(move || {
                let Ok(conn) = database.conn.lock() else {
                    return Handled {
                        reply: failure("database_error", "The database is unavailable"),
                        saved: None,
                        contact: false,
                        show: false,
                    };
                };
                let mut connections = lock(&records.connections);
                handle(&conn, &mut connections, &envelope, Utc::now())
            })
            .await
            .map_err(std::io::Error::other)?;
            if let Some(saved) = &handled.saved {
                capture::after_save(&app, db.clone(), saved);
            }
            if handled.contact {
                emit_status(&app, &state);
            }
            if handled.show {
                crate::show_window(&app);
            }
            handled.reply
        }
    })
}

/// The capture socket on Linux (Р-45, п. 6) and macOS (NP-050): what the
/// pipe's DACL and first instance flag do on Windows.
#[cfg(unix)]
mod socket {
    use std::{
        fs, io,
        os::unix::{
            fs::{DirBuilderExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
        path::Path,
    };

    fn own_uid() -> u32 {
        unsafe { libc::geteuid() }
    }

    /// The socket's folder: created `0700`, or one already there that is a
    /// real folder of this user, closed again if someone opened it.
    pub fn private_dir(dir: &Path) -> io::Result<()> {
        match fs::DirBuilder::new().mode(0o700).create(dir) {
            Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
            _ => {}
        }
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || meta.uid() != own_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is not a folder of this user", dir.display()),
            ));
        }
        if meta.mode() & 0o777 != 0o700 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// The first instance: a socket another process answers on is not taken
    /// over but reported; a file left by an app that crashed is replaced.
    pub fn bind(path: &Path) -> io::Result<UnixListener> {
        private_dir(folder(path)?)?;
        listen(path)
    }

    fn folder(path: &Path) -> io::Result<&Path> {
        path.parent()
            .ok_or_else(|| io::Error::other("the capture socket has no folder"))
    }

    /// The Safari socket (NP-119) in the appex's container, whose folders
    /// are the system's: checked, not made private.
    #[cfg(target_os = "macos")]
    pub fn bind_safari(path: &Path) -> io::Result<UnixListener> {
        crate::desktop::safari_socket::container_dir(folder(path)?)?;
        listen(path)
    }

    fn listen(path: &Path) -> io::Result<UnixListener> {
        let listener = match UnixListener::bind(path) {
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                if UnixStream::connect(path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        format!("Another program is answering on {}", path.display()),
                    ));
                }
                fs::remove_file(path)?;
                UnixListener::bind(path)?
            }
            bound => bound?,
        };
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    /// Only processes of this user talk to the app. The folder already keeps
    /// others out; the peer's UID (`SO_PEERCRED`, `getpeereid` on macOS) is
    /// checked as well, in case the folder was opened.
    pub fn admitted(peer: Option<u32>) -> bool {
        peer == Some(own_uid())
    }
}

#[cfg(windows)]
mod security {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
    };

    /// A pipe only the current user can open, not other users of the computer
    /// and not services.
    pub struct OnlyCurrentUser {
        descriptor: PSECURITY_DESCRIPTOR,
        attributes: SECURITY_ATTRIBUTES,
    }

    // The descriptor is only read by the system after creation.
    unsafe impl Send for OnlyCurrentUser {}

    impl OnlyCurrentUser {
        pub fn new() -> std::io::Result<Box<Self>> {
            let sid = crate::desktop::pipe_name::user_sid()
                .ok_or_else(|| std::io::Error::other("cannot read the user's SID"))?;
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let converted = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            };
            if converted == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Boxed: the attributes point at the descriptor and must not move.
            let mut security = Box::new(OnlyCurrentUser {
                descriptor,
                attributes: SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: std::ptr::null_mut(),
                    bInheritHandle: 0,
                },
            });
            security.attributes.lpSecurityDescriptor = security.descriptor;
            Ok(security)
        }

        pub fn attributes(&mut self) -> *mut core::ffi::c_void {
            &mut self.attributes as *mut SECURITY_ATTRIBUTES as *mut core::ffi::c_void
        }
    }

    impl Drop for OnlyCurrentUser {
        fn drop(&mut self) {
            unsafe { LocalFree(self.descriptor) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browsers::{Connections, PROTOCOL};
    use crate::capture_channel::tests::{capture, database, now};
    use serde_json::json;
    use std::sync::Mutex;

    /// A DACL in SDDL as Windows itself writes it back.
    #[cfg(windows)]
    fn canonical(sddl: &str) -> String {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW,
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                },
                DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            },
        };
        let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let mut text: *mut u16 = std::ptr::null_mut();
        unsafe {
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                ),
                0
            );
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    std::ptr::null_mut(),
                ),
                0
            );
            let length = (0..).take_while(|&i| *text.add(i) != 0).count();
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text as _);
            LocalFree(descriptor);
            result
        }
    }

    /// Only the current user may open the pipe: a protected DACL with one
    /// entry, so other users and services are refused by Windows itself.
    #[cfg(windows)]
    #[test]
    fn the_pipe_admits_only_the_current_user() {
        use tokio::net::windows::named_pipe::ServerOptions;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                    SDDL_REVISION_1, SE_KERNEL_OBJECT,
                },
                DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            },
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let mut security = security::OnlyCurrentUser::new().unwrap();
        let name = format!(r"\\.\pipe\koonapin-dacl-test-{}", std::process::id());
        let pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, security.attributes())
                .unwrap()
        };
        use std::os::windows::io::AsRawHandle;
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                pipe.as_raw_handle() as _,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let mut text: *mut u16 = std::ptr::null_mut();
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(converted, 0);
        let sddl = unsafe {
            let length = (0..).take_while(|&i| *text.add(i) != 0).count();
            String::from_utf16_lossy(std::slice::from_raw_parts(text, length))
        };
        unsafe {
            LocalFree(text as _);
            LocalFree(descriptor);
        }
        let sid = crate::desktop::pipe_name::user_sid().unwrap();
        // GA is stored as the pipe's full access (FA). Windows writes some
        // accounts by alias (the built-in Administrator of a CI runner is
        // «LA»), so the expected text goes through the same conversion.
        assert_eq!(sddl, canonical(&format!("D:P(A;;FA;;;{sid})")));
        // A second server on the same name is refused (FILE_FLAG_FIRST_PIPE_INSTANCE).
        let second = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .create_with_security_attributes_raw(&name, security.attributes())
        };
        assert!(second.is_err());
        drop(pipe);
    }

    /// A folder of its own under the temporary one: a socket path stays far
    /// below the 108 bytes of `sun_path` (104 on macOS).
    #[cfg(unix)]
    fn runtime_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    /// The folder is `0700`, the socket `0600`; an opened folder is closed
    /// again, a folder that is a symlink is refused.
    #[cfg(unix)]
    #[test]
    fn the_socket_and_its_folder_are_only_the_users() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let runtime = runtime_dir("modes");
        let path = runtime.join("koonapin").join("capture.sock");
        let listener = socket::bind(&path).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().mode() & 0o777;
        assert_eq!(mode(&runtime.join("koonapin")), 0o700);
        assert_eq!(mode(&path), 0o600);
        assert_eq!(std::fs::metadata(&path).unwrap().uid(), unsafe { libc::geteuid() });
        drop(listener);
        std::fs::set_permissions(runtime.join("koonapin"), std::fs::Permissions::from_mode(0o755)).unwrap();
        socket::private_dir(&runtime.join("koonapin")).unwrap();
        assert_eq!(mode(&runtime.join("koonapin")), 0o700);
        // Someone else's folder put in the way as a link is not followed.
        let elsewhere = runtime_dir("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, runtime.join("linked")).unwrap();
        assert!(socket::bind(&runtime.join("linked").join("capture.sock")).is_err());
        std::fs::remove_dir_all(&runtime).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    /// A live socket is reported, not taken over; the file of a crashed app
    /// is replaced.
    #[cfg(unix)]
    #[test]
    fn a_live_socket_is_busy_and_a_leftover_is_replaced() {
        let runtime = runtime_dir("first");
        let path = runtime.join("koonapin").join("capture.sock");
        let first = socket::bind(&path).unwrap();
        let busy = socket::bind(&path).unwrap_err();
        assert_eq!(busy.kind(), std::io::ErrorKind::AddrInUse);
        assert!(busy.to_string().contains("Another program"), "{busy}");
        // Closing the listener leaves the file, as a crash does.
        drop(first);
        assert!(path.exists());
        let second = socket::bind(&path).unwrap();
        assert!(std::os::unix::net::UnixStream::connect(&path).is_ok());
        drop(second);
        std::fs::remove_dir_all(&runtime).unwrap();
    }

    /// The peer's UID decides: this process is admitted, another UID or an
    /// unknown one is not.
    #[cfg(unix)]
    #[test]
    fn only_the_users_own_processes_are_admitted() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let dir = runtime_dir("peer");
        let path = dir.join("koonapin").join("capture.sock");
        let listener = socket::bind(&path).unwrap();
        let _client = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        server.set_nonblocking(true).unwrap();
        let peer = runtime.block_on(async {
            tokio::net::UnixStream::from_std(server).unwrap().peer_cred().unwrap().uid()
        });
        assert!(socket::admitted(Some(peer)));
        assert!(!socket::admitted(Some(peer.wrapping_add(1))));
        assert!(!socket::admitted(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// No runtime folder: a clear error, not a socket in /tmp; the test
    /// name goes into the same folder.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_socket_lives_in_the_runtime_folder() {
        // The only test that touches these variables.
        let saved = (std::env::var_os("XDG_RUNTIME_DIR"), std::env::var_os(crate::desktop::pipe_name::PIPE_ENV));
        std::env::remove_var("XDG_RUNTIME_DIR");
        std::env::remove_var(crate::desktop::pipe_name::PIPE_ENV);
        let missing = crate::desktop::pipe_name::socket_path().unwrap_err();
        assert!(missing.to_string().contains("XDG_RUNTIME_DIR"), "{missing}");
        std::env::set_var("XDG_RUNTIME_DIR", "/run/user/1000");
        assert_eq!(
            crate::desktop::pipe_name::socket_path().unwrap(),
            std::path::Path::new("/run/user/1000/koonapin/capture.sock")
        );
        std::env::set_var(crate::desktop::pipe_name::PIPE_ENV, "koonapin-smoke-1");
        assert_eq!(
            crate::desktop::pipe_name::socket_path().unwrap(),
            std::path::Path::new("/run/user/1000/koonapin/koonapin-smoke-1.sock")
        );
        for (name, value) in [("XDG_RUNTIME_DIR", saved.0), (crate::desktop::pipe_name::PIPE_ENV, saved.1)] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    /// macOS: the user's own folder of the system, kept and private, the same
    /// for the host as for the app; the test name goes into the same folder.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_socket_lives_in_the_users_folder() {
        // The only test that touches this variable.
        let saved = std::env::var_os(crate::desktop::pipe_name::PIPE_ENV);
        std::env::remove_var(crate::desktop::pipe_name::PIPE_ENV);
        let path = crate::desktop::pipe_name::socket_path().unwrap();
        assert!(path.ends_with("0/koonapin/capture.sock"), "{}", path.display());
        assert!(path.starts_with("/var/folders/") || path.starts_with("/private/var/folders/"), "{}", path.display());
        // Well below the 104 bytes of `sun_path`.
        assert!(path.as_os_str().len() < 90, "{}", path.display());
        std::env::set_var(crate::desktop::pipe_name::PIPE_ENV, "koonapin-smoke-1");
        assert_eq!(crate::desktop::pipe_name::socket_path().unwrap(), path.with_file_name("koonapin-smoke-1.sock"));
        match saved {
            Some(value) => std::env::set_var(crate::desktop::pipe_name::PIPE_ENV, value),
            None => std::env::remove_var(crate::desktop::pipe_name::PIPE_ENV),
        }
    }

    /// The Safari socket (NP-119), as the app opens it but at a test path:
    /// a peer whose signature does not satisfy the requirement gets no reply,
    /// one that does gets what koonapin-host would get, and `mcp` is refused.
    /// This test binary stands in for the appex: its own designated
    /// requirement (its cdhash) admits it.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_safari_socket_admits_only_the_signed_appex() {
        use crate::desktop::safari_socket::Admission;
        use std::io::{Read, Write};
        use std::os::unix::fs::PermissionsExt;
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let dir = runtime_dir("safari");
        let library = Arc::new(Mutex::new(database()));
        let open = |name: &str, admission: Admission| {
            let path = dir.join(name).join("Data").join("capture.sock");
            let listener = socket::bind_safari(&path).unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            listener.set_nonblocking(true).unwrap();
            let _entered = runtime.enter();
            let listener = tokio::net::UnixListener::from_std(listener).unwrap();
            let library = library.clone();
            let respond = move |envelope: Envelope| {
                let library = library.clone();
                async move {
                    let conn = library.lock().unwrap();
                    Ok(handle(&conn, &mut Connections::default(), &envelope, now()).reply)
                }
            };
            runtime.spawn(serve_admitted(listener, Arc::new(admission), respond));
            path
        };
        let ask = |path: &std::path::Path, message: Value| -> String {
            let mut client = std::os::unix::net::UnixStream::connect(path).unwrap();
            client.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
            let line = json!({ "caller": "app.koona.pin.safari", "message": message });
            // A refused peer may be closed before it writes.
            let _ = client.write_all(format!("{line}\n").as_bytes());
            let mut reply = String::new();
            let _ = client.read_to_string(&mut reply);
            reply
        };
        let hello = json!({ "type": "hello", "protocol": PROTOCOL, "version": "0.9.0", "browser": "safari" });

        let zero = format!("cdhash H\"{}\"", "0".repeat(40));
        let refused = open("zero", Admission::from_text(&zero).unwrap());
        assert_eq!(ask(&refused, hello.clone()), "", "another cdhash: no reply");
        let apple = open("apple", Admission::for_appex(std::path::Path::new("/bin/ls")).unwrap());
        assert_eq!(ask(&apple, hello.clone()), "", "another program's requirement: no reply");

        let admitted = open("own", Admission::for_self().unwrap());
        let reply: Value = serde_json::from_str(&ask(&admitted, hello)).unwrap();
        assert_eq!((reply["ok"].clone(), reply["name"].clone()), (json!(true), json!("Koona Pin")));
        let saved: Value = serde_json::from_str(&ask(&admitted, capture("s1", "https://www.apple.com/", "safari"))).unwrap();
        assert_eq!(saved["outcome"], "created");
        let mcp: Value = serde_json::from_str(&ask(&admitted, json!({ "type": "mcp", "tool": "list_bookmarks" }))).unwrap();
        assert_eq!(mcp["code"], "invalid_request");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
