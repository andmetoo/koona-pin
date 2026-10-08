//! Capture over native messaging (Р-17). The browser starts koonapin-host.exe,
//! the host passes each message over a named pipe (a Unix socket on Linux),
//! the app answers it. The app stays the only process that writes the library.
//!
//! One JSON line per connection each way. The host sends
//! `{ "caller": "chrome-extension://…/", "message": { … } }`, where `message`
//! comes from the extension unchanged; the reply goes back to the extension.

use crate::{
    browsers::{self, Browser, CaptureProblem, CaptureStatus, Connections, PROTOCOL},
    capture::{self, CaptureRequest, CaptureResult},
    db::{DbState, Source},
};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// The browser limits a message from the extension to the host; a line larger
/// than this is not a message of ours.
pub const MAX_MESSAGE: usize = 1024 * 1024;
/// The host writes its line right after connecting.
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Deserialize)]
pub struct Envelope {
    /// What the browser told the host about the extension: its origin
    /// (Chrome, Edge) or its id (Firefox). Kept for reports.
    #[serde(default)]
    pub caller: Option<String>,
    pub message: Value,
}

/// One line from the pipe; anything too long or not our JSON is refused.
pub fn parse(line: &[u8]) -> Option<Envelope> {
    if line.len() > MAX_MESSAGE {
        return None;
    }
    serde_json::from_slice(line).ok()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Hello {
        #[serde(default)]
        protocol: Option<u32>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        browser: Option<String>,
    },
    Capture {
        #[serde(default)]
        protocol: Option<u32>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        browser: Option<String>,
        request_id: String,
        url: String,
        #[serde(default)]
        title: Option<String>,
    },
    /// The quick search of the extension's popup (NP-082).
    Search {
        #[serde(default)]
        protocol: Option<u32>,
        #[serde(default)]
        query: String,
        #[serde(default)]
        filter: crate::quick_search::Filter,
    },
    /// «Open Koona Pin» in the popup: the main window comes up.
    Show {
        #[serde(default)]
        protocol: Option<u32>,
    },
    /// Is this page in the library? Asked on every page load when the person
    /// turned it on (NP-083).
    Lookup {
        #[serde(default)]
        protocol: Option<u32>,
        url: String,
    },
}

pub struct Handled {
    pub reply: Value,
    pub saved: Option<CaptureResult>,
    /// A browser's record changed: the status may change too.
    pub contact: bool,
    /// The extension asked to show the main window.
    pub show: bool,
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// Everything the app does with one message, inside the caller's database lock.
pub fn handle(
    conn: &Connection,
    connections: &mut Connections,
    envelope: &Envelope,
    now: DateTime<Utc>,
) -> Handled {
    let message = match serde_json::from_value::<Message>(envelope.message.clone()) {
        Ok(message) => message,
        Err(_) => {
            return Handled {
                reply: failure("invalid_request", "Unknown message"),
                saved: None,
                contact: false,
                show: false,
            }
        }
    };
    // Searching is not a contact to record: a popup sends a message for
    // every key, and the record would be written each time.
    let (protocol, version, browser) = match &message {
        Message::Hello {
            protocol,
            version,
            browser,
        }
        | Message::Capture {
            protocol,
            version,
            browser,
            ..
        } => (*protocol, version.clone(), browser.as_deref().and_then(Browser::parse)),
        Message::Search { protocol, .. } | Message::Show { protocol } | Message::Lookup { protocol, .. } => {
            (*protocol, None, None)
        }
    };
    let stamp = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    // An incompatible extension is recorded too: the status tells the user to update.
    if let Some(browser) = browser {
        connections.contact(browser, version, protocol, &stamp);
    }
    let contact = browser.is_some();
    if protocol != Some(PROTOCOL) {
        let mut reply = failure(
            "incompatible_protocol",
            "Koona Pin and the extension versions do not match",
        );
        reply["protocol"] = json!(PROTOCOL);
        reply["version"] = json!(env!("CARGO_PKG_VERSION"));
        if contact {
            let _ = connections.save(conn);
        }
        return Handled {
            reply,
            saved: None,
            contact,
            show: false,
        };
    }
    let handled = match message {
        Message::Hello { .. } => Handled {
            reply: json!({
                "ok": true,
                "name": "Koona Pin",
                "protocol": PROTOCOL,
                "version": env!("CARGO_PKG_VERSION"),
            }),
            saved: None,
            contact,
            show: false,
        },
        Message::Search { query, filter, .. } => Handled {
            reply: crate::quick_search::search(conn, &query, &filter)
                .unwrap_or_else(|error| failure("database_error", &error.to_string())),
            saved: None,
            contact,
            show: false,
        },
        Message::Show { .. } => Handled {
            reply: json!({ "ok": true }),
            saved: None,
            contact,
            show: true,
        },
        Message::Lookup { url, .. } => Handled {
            reply: crate::quick_search::lookup(conn, &url)
                .unwrap_or_else(|error| failure("database_error", &error.to_string())),
            saved: None,
            contact,
            show: false,
        },
        Message::Capture {
            request_id,
            url,
            title,
            ..
        } => {
            let request = CaptureRequest {
                request_id: Some(request_id),
                url,
                title,
                collection_id: None,
                tags: None,
            };
            let source = browser.map_or(Source::Extension, Browser::source);
            match capture::save(conn, &request, source) {
                Ok(saved) => {
                    if let Some(browser) = browser {
                        connections.captured(browser, &stamp);
                    }
                    let mut reply = json!({
                        "ok": true,
                        "bookmark_id": saved.bookmark_id,
                        "outcome": saved.outcome,
                    });
                    // Back from the trash: older extensions see a plain `created`.
                    if saved.restored {
                        reply["restored"] = json!(true);
                    }
                    Handled {
                        reply,
                        saved: Some(saved),
                        contact,
                        show: false,
                    }
                }
                Err(error) => Handled {
                    reply: failure(error.code, &error.message),
                    saved: None,
                    contact,
                    show: false,
                },
            }
        }
    };
    // The record is a convenience: a read-only (damaged) library keeps it in memory.
    if contact {
        let _ = connections.save(conn);
    }
    handled
}

/// What the interface needs besides the library: browser records and problems.
#[derive(Default)]
pub struct ChannelState {
    pub connections: Mutex<Connections>,
    channel: Mutex<Option<String>>,
    registration: Mutex<Option<(CaptureProblem, String)>>,
}

impl ChannelState {
    pub fn status(&self, now: DateTime<Utc>) -> CaptureStatus {
        let problem = lock(&self.channel)
            .clone()
            .map(|detail| (CaptureProblem::Channel, detail))
            .or_else(|| lock(&self.registration).clone());
        browsers::status(&lock(&self.connections), problem, now)
    }

    pub fn set_registration(&self, problem: Option<(CaptureProblem, String)>) {
        *lock(&self.registration) = problem;
    }

    pub fn set_channel(&self, problem: Option<String>) {
        *lock(&self.channel) = problem;
    }

    pub fn channel_failed(&self) -> bool {
        lock(&self.channel).is_some()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn emit_status(app: &AppHandle, state: &ChannelState) {
    let _ = app.emit("capture-status", state.status(Utc::now()));
}

/// Points the browsers at the host, when this build registers (see
/// `native_host::should_register`).
pub fn register_host(app: &AppHandle, state: &ChannelState) {
    if crate::native_host::should_register() {
        state.set_registration(crate::native_host::register().err());
        emit_status(app, state);
    }
}

/// Loads the records of the opened library and starts the pipe.
pub fn start(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    if let Ok(conn) = db.conn.lock() {
        *lock(&state.connections) = Connections::load(&conn);
    }
    serve(app, db, state);
}

#[cfg(windows)]
fn serve(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    let name = crate::pipe_name::pipe_name();
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
                if let Err(error) = answer(connected, app, db, state).await {
                    eprintln!("Capture pipe: {error}");
                }
            });
        }
    });
}
#[cfg(target_os = "linux")]
fn serve(app: AppHandle, db: Arc<DbState>, state: Arc<ChannelState>) {
    // Bound before this returns, so «Повторить» answers with the real state.
    let listener = crate::pipe_name::socket_path()
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
                if let Err(error) = answer(stream, app, db, state).await {
                    eprintln!("Capture socket: {error}");
                }
            });
        }
    });
}
#[cfg(not(any(windows, target_os = "linux")))]
fn serve(app: AppHandle, _db: Arc<DbState>, state: Arc<ChannelState>) {
    // macOS gets its channel with its release (NP-048).
    state.set_channel(Some("Native messaging is not available on this system yet".into()));
    emit_status(&app, &state);
}

#[cfg(any(windows, target_os = "linux"))]
async fn answer(
    pipe: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    app: AppHandle,
    db: Arc<DbState>,
    state: Arc<ChannelState>,
) -> std::io::Result<()> {
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
        Some(envelope) => {
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
        _ => failure("invalid_request", "Unknown message"),
    };
    let pipe = reader.get_mut();
    pipe.write_all(format!("{reply}\n").as_bytes()).await?;
    pipe.flush().await
}

/// The capture socket on Linux (Р-45, п. 6): what the pipe's DACL and first
/// instance flag do on Windows.
#[cfg(target_os = "linux")]
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
        let dir = path
            .parent()
            .ok_or_else(|| io::Error::other("the capture socket has no folder"))?;
        private_dir(dir)?;
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
    /// others out; the peer's UID (`SO_PEERCRED`) is checked as well, in case
    /// the folder was opened.
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
            let sid = crate::pipe_name::user_sid()
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
    use crate::db;

    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }
    fn envelope(message: Value) -> Envelope {
        Envelope {
            caller: Some("chrome-extension://iibgiagcbediajombmkohanobgicbepn/".into()),
            message,
        }
    }
    fn now() -> DateTime<Utc> {
        "2026-10-03T12:00:00Z".parse().unwrap()
    }
    fn capture(id: &str, url: &str, browser: &str) -> Value {
        json!({ "type": "capture", "protocol": PROTOCOL, "version": "0.5.0", "browser": browser,
                "request_id": id, "url": url, "title": "Title" })
    }

    #[test]
    fn oversized_and_foreign_lines_are_refused() {
        let ok = br#"{"caller":null,"message":{"type":"hello"}}"#;
        assert!(parse(ok).is_some());
        assert!(parse(b"not json\n").is_none());
        assert!(parse(br#"{"message_missing":true}"#).is_none());
        assert!(parse(b"").is_none());
        let mut huge = br#"{"caller":null,"message":{"type":"capture","title":""#.to_vec();
        huge.resize(MAX_MESSAGE, b'x');
        huge.extend_from_slice(br#""}}"#);
        assert!(serde_json::from_slice::<Envelope>(&huge).is_ok(), "valid JSON, only too long");
        assert!(parse(&huge).is_none());
    }

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
        let sid = crate::pipe_name::user_sid().unwrap();
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
    /// below the 108 bytes of `sun_path`.
    #[cfg(target_os = "linux")]
    fn runtime_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    /// The folder is `0700`, the socket `0600`; an opened folder is closed
    /// again, a folder that is a symlink is refused.
    #[cfg(target_os = "linux")]
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
    #[cfg(target_os = "linux")]
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
    #[cfg(target_os = "linux")]
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
        let saved = (std::env::var_os("XDG_RUNTIME_DIR"), std::env::var_os(crate::pipe_name::PIPE_ENV));
        std::env::remove_var("XDG_RUNTIME_DIR");
        std::env::remove_var(crate::pipe_name::PIPE_ENV);
        let missing = crate::pipe_name::socket_path().unwrap_err();
        assert!(missing.to_string().contains("XDG_RUNTIME_DIR"), "{missing}");
        std::env::set_var("XDG_RUNTIME_DIR", "/run/user/1000");
        assert_eq!(
            crate::pipe_name::socket_path().unwrap(),
            std::path::Path::new("/run/user/1000/koonapin/capture.sock")
        );
        std::env::set_var(crate::pipe_name::PIPE_ENV, "koonapin-smoke-1");
        assert_eq!(
            crate::pipe_name::socket_path().unwrap(),
            std::path::Path::new("/run/user/1000/koonapin/koonapin-smoke-1.sock")
        );
        for (name, value) in [("XDG_RUNTIME_DIR", saved.0), (crate::pipe_name::PIPE_ENV, saved.1)] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn hello_answers_and_records_the_browser() {
        let c = database();
        let mut connections = Connections::default();
        let handled = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "hello", "protocol": PROTOCOL, "version": "0.5.0", "browser": "edge" })),
            now(),
        );
        assert_eq!(handled.reply["ok"], true);
        assert_eq!(handled.reply["name"], "Koona Pin");
        assert_eq!(handled.reply["protocol"], PROTOCOL);
        assert!(handled.contact);
        let status = browsers::status(&Connections::load(&c), None, now());
        assert_eq!(status.state, browsers::CaptureState::Connected);
        assert_eq!(status.browsers[0].browser, Browser::Edge);
        assert_eq!(status.browsers[0].extension_version.as_deref(), Some("0.5.0"));
    }

    #[test]
    fn capture_saves_with_the_source_and_keeps_the_receipt_rules() {
        let c = database();
        let mut connections = Connections::default();
        let first = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/", "firefox")), now());
        assert_eq!(first.reply["ok"], true);
        assert_eq!(first.reply["outcome"], "created");
        assert!(first.saved.as_ref().unwrap().newly_created);
        let source: String = c
            .query_row("SELECT source FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "firefox");
        // The same request again: the receipt, nothing new.
        let replay = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/", "firefox")), now());
        assert_eq!(replay.reply["bookmark_id"], first.reply["bookmark_id"]);
        assert_eq!(replay.reply["outcome"], "created");
        // Another request for the same address: existing.
        let duplicate = handle(&c, &mut connections, &envelope(capture("r2", "https://example.com/", "chrome")), now());
        assert_eq!(duplicate.reply["outcome"], "existing");
        // The request id of another address: the HTTP v1 conflict code.
        let conflict = handle(&c, &mut connections, &envelope(capture("r1", "https://other.example/", "chrome")), now());
        assert_eq!(conflict.reply["code"], "request_id_conflict");
        let invalid = handle(&c, &mut connections, &envelope(capture("r3", "chrome://settings", "chrome")), now());
        assert_eq!(invalid.reply["code"], "invalid_request");
        assert!(duplicate.reply.get("restored").is_none());
        // From the trash: `created` for older extensions, `restored` for new ones.
        db::trash_bookmark(&c, first.reply["bookmark_id"].as_i64().unwrap()).unwrap();
        let back = handle(&c, &mut connections, &envelope(capture("r4", "https://example.com/", "edge")), now());
        assert_eq!((back.reply["outcome"].as_str(), back.reply["restored"].as_bool()), (Some("created"), Some(true)));
        let status = browsers::status(&connections, None, now());
        assert_eq!(status.last_capture.unwrap().browser, Browser::Edge);
    }

    #[test]
    fn another_protocol_is_refused_but_recorded() {
        let c = database();
        let mut connections = Connections::default();
        let mut old = capture("r1", "https://example.com/", "chrome");
        old["protocol"] = json!(1);
        let handled = handle(&c, &mut connections, &envelope(old), now());
        assert_eq!(handled.reply["code"], "incompatible_protocol");
        assert_eq!(handled.reply["protocol"], PROTOCOL);
        assert!(handled.saved.is_none());
        assert_eq!(db::get_counts(&c).unwrap().total, 0);
        assert_eq!(
            browsers::status(&connections, None, now()).state,
            browsers::CaptureState::Incompatible
        );
    }

    #[test]
    fn unknown_messages_and_browsers_are_handled() {
        let c = database();
        let mut connections = Connections::default();
        let unknown = handle(&c, &mut connections, &envelope(json!({ "type": "delete" })), now());
        assert_eq!(unknown.reply["code"], "invalid_request");
        // A browser the app does not know still saves, as "extension".
        let other = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/", "opera")), now());
        assert_eq!(other.reply["ok"], true);
        assert!(!other.contact);
        let source: String = c
            .query_row("SELECT source FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "extension");
    }

    #[test]
    fn a_read_only_library_refuses_capture_but_answers_hello() {
        let c = database();
        c.pragma_update(None, "query_only", true).unwrap();
        let mut connections = Connections::default();
        let hello = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "hello", "protocol": PROTOCOL, "browser": "chrome" })),
            now(),
        );
        assert_eq!(hello.reply["ok"], true);
        let saved = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/", "chrome")), now());
        assert_eq!(saved.reply["code"], "database_error");
        // The record stays in memory.
        assert_eq!(browsers::status(&connections, None, now()).state, browsers::CaptureState::Connected);
    }

    #[test]
    fn the_popup_searches_and_shows_the_window_without_writing_records() {
        let c = database();
        let mut connections = Connections::default();
        handle(&c, &mut connections, &envelope(capture("r1", "https://blog.rust-lang.org/", "chrome")), now());
        let before = connections.clone();
        let found = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "search", "protocol": PROTOCOL, "query": "rust-lang", "filter": { "kind": "inbox" } })),
            now(),
        );
        assert_eq!(found.reply["ok"], true);
        assert_eq!(found.reply["items"][0]["url"], "https://blog.rust-lang.org/");
        assert_eq!(found.reply["counts"]["inbox"], 1);
        assert!(!found.contact && !found.show);
        assert_eq!(connections, before, "a search is not a contact to record");
        // No query and no filter: the latest saved, every filter counted.
        let recent = handle(&c, &mut connections, &envelope(json!({ "type": "search", "protocol": PROTOCOL })), now());
        assert_eq!(recent.reply["counts"]["all"], 1);
        let known = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "lookup", "protocol": PROTOCOL, "url": "https://blog.rust-lang.org/" })),
            now(),
        );
        assert_eq!((known.reply["saved"].clone(), known.contact), (json!(true), false));
        assert_eq!(connections, before, "a lookup is not a contact to record");
        let show = handle(&c, &mut connections, &envelope(json!({ "type": "show", "protocol": PROTOCOL })), now());
        assert_eq!((show.reply["ok"].clone(), show.show), (json!(true), true));
        // An extension of another protocol is told to update, as for a capture.
        let old = handle(&c, &mut connections, &envelope(json!({ "type": "search", "protocol": 1, "query": "x" })), now());
        assert_eq!(old.reply["code"], "incompatible_protocol");
        let bad = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "search", "protocol": PROTOCOL, "filter": { "kind": "trash" } })),
            now(),
        );
        assert_eq!(bad.reply["code"], "invalid_request");
    }
}
