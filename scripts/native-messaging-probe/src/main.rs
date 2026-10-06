// Like the release app: no console window of its own.
#![windows_subsystem = "windows"]
//! NP-014 prototype. One binary, two roles:
//! - native messaging host: the browser starts it with the caller's origin
//!   (Chrome, Edge) or the manifest path and add-on id (Firefox) and talks
//!   length-prefixed JSON over stdin/stdout;
//! - `app`: a stand-in for Koona Pin that accepts captures on a named pipe.
//!
//! The host relays a capture to the app and, if asked, starts the app when the
//! pipe is missing. Every process appends JSON lines to `probe.log` next to the
//! executable; `run.mjs` registers the host, drives the browsers and reads it.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::io::FromRawHandle,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
    Storage::{
        FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
        Packaging::Appx::GetCurrentPackageFullName,
    },
    System::{
        Console::GetConsoleWindow,
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        JobObjects::{
            IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        },
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        },
        Threading::{
            CreateProcessW, GetCurrentProcess, GetCurrentProcessId, CREATE_BREAKAWAY_FROM_JOB,
            CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
        },
    },
};

const PIPE: &str = r"\\.\pipe\koonapin-probe";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("app") {
        serve();
    } else {
        host(&args);
    }
}

fn log(entry: &Value) {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("probe.log")))
        .unwrap_or_else(|| PathBuf::from("probe.log"));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{entry}");
    }
}

// --- host ---------------------------------------------------------------

fn host(args: &[String]) {
    let started = Instant::now();
    let info = host_info(args);
    log(&json!({ "role": "host", "event": "start", "info": info }));
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let mut handled = 0;
    while let Some(message) = read_message(&mut stdin) {
        handled += 1;
        let reply = handle(&message, &info, started);
        if write_message(&mut stdout, &reply).is_err() {
            break;
        }
    }
    log(&json!({
        "role": "host", "event": "exit", "pid": std::process::id(),
        "messages": handled, "alive_ms": started.elapsed().as_millis(),
    }));
}

/// Messages are UTF-8 JSON preceded by a 32-bit length in native byte order.
fn read_message(input: &mut impl Read) -> Option<Value> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length).ok()?;
    let mut body = vec![0u8; u32::from_ne_bytes(length) as usize];
    input.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_message(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()
}

fn handle(message: &Value, info: &Value, started: Instant) -> Value {
    let received_ms = started.elapsed().as_millis();
    match message["cmd"].as_str() {
        Some("ping") => json!({ "ok": true, "host": info, "received_ms": received_ms }),
        Some("capture") => {
            let relay = Instant::now();
            let spawn = message["spawn"].as_str().unwrap_or("none");
            let mut spawned = Value::Null;
            let mut reply = send_to_app(message);
            if reply.is_err() && spawn != "none" {
                spawned = start_app(spawn == "breakaway");
                let wait = Duration::from_millis(message["wait_ms"].as_u64().unwrap_or(5000));
                while reply.is_err() && relay.elapsed() < wait {
                    thread::sleep(Duration::from_millis(20));
                    reply = send_to_app(message);
                }
            }
            let (ok, outcome, app, error) = match reply {
                Ok(app) => (true, "saved", app, Value::Null),
                Err(e) => (false, "app_unavailable", Value::Null, json!(e.to_string())),
            };
            json!({
                "ok": ok, "outcome": outcome, "app": app, "error": error,
                "spawned": spawned, "host": info,
                "received_ms": received_ms, "relay_ms": relay.elapsed().as_millis(),
            })
        }
        _ => json!({ "ok": false, "error": "unknown command" }),
    }
}

fn send_to_app(message: &Value) -> io::Result<Value> {
    let pipe = OpenOptions::new().read(true).write(true).open(PIPE)?;
    (&pipe).write_all(format!("{message}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(&pipe).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(io::Error::other)
}

/// `std::process::Command` always lets the child inherit every inheritable
/// handle. Here that includes the host's ends of the browser pipes: the app
/// then keeps them open and the browser never sees the host finish (the first
/// run hung on browser exit). So the app is started without inheritance.
fn start_app(breakaway: bool) -> Value {
    let flags = DETACHED_PROCESS
        | CREATE_NEW_PROCESS_GROUP
        | if breakaway { CREATE_BREAKAWAY_FROM_JOB } else { 0 };
    let exe = std::env::current_exe().expect("own path");
    let mut command: Vec<u16> = format!("\"{}\" app", exe.display())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // bInheritHandles = FALSE
            flags,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        let error = io::Error::last_os_error();
        return json!({ "error": error.to_string(), "breakaway": breakaway });
    }
    unsafe {
        CloseHandle(process.hProcess);
        CloseHandle(process.hThread);
    }
    json!({ "pid": process.dwProcessId, "breakaway": breakaway })
}

/// A process started by a packaged (MSIX) browser may inherit its package
/// identity, and with it file and registry virtualization.
fn package() -> Option<String> {
    let mut buffer = [0u16; 256];
    let mut length = buffer.len() as u32;
    let status = unsafe { GetCurrentPackageFullName(&mut length, buffer.as_mut_ptr()) };
    (status == 0).then(|| String::from_utf16_lossy(&buffer[..length.saturating_sub(1) as usize]))
}

fn in_job() -> bool {
    let mut in_job = 0;
    unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) };
    in_job != 0
}

fn host_info(args: &[String]) -> Value {
    let (parent_pid, parent) = parent_process();
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let job_flags = unsafe {
        // A null job handle queries the job of the calling process.
        let queried = QueryInformationJobObject(
            std::ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            std::ptr::null_mut(),
        );
        (queried != 0).then_some(limits.BasicLimitInformation.LimitFlags)
    };
    json!({
        "pid": std::process::id(),
        "args": args.get(1..).unwrap_or_default(),
        "parent_pid": parent_pid,
        "parent": parent,
        "package": package(),
        "appdata": std::env::var("APPDATA").ok(),
        "console_window": unsafe { !GetConsoleWindow().is_null() },
        "in_job": in_job(),
        "job_kill_on_close": job_flags.map(|f| f & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0),
        "job_breakaway_ok": job_flags.map(|f| f & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0),
        "job_silent_breakaway": job_flags.map(|f| f & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0),
    })
}

fn parent_process() -> (u32, Option<String>) {
    let mut names = HashMap::new();
    let mut parent = 0;
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return (0, None);
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let me = GetCurrentProcessId();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            names.insert(
                entry.th32ProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..length]),
            );
            if entry.th32ProcessID == me {
                parent = entry.th32ParentProcessID;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    (parent, names.remove(&parent))
}

// --- app ----------------------------------------------------------------

fn serve() {
    let name: Vec<u16> = PIPE.encode_utf16().chain(Some(0)).collect();
    let started = Instant::now();
    log(&json!({
        "role": "app", "event": "start", "pid": std::process::id(),
        "package": package(), "parent": parent_process().1, "in_job": in_job(),
    }));
    // Where a write to %APPDATA% really lands: a packaged parent could
    // redirect it into the package's private folder.
    let marker = std::env::var("APPDATA")
        .map(|dir| PathBuf::from(dir).join("koonapin-probe").join(format!("app-{}.txt", std::process::id())));
    if let Ok(marker) = marker {
        let _ = std::fs::create_dir_all(marker.parent().unwrap());
        let _ = std::fs::write(&marker, "written by the probe app");
    }
    let mut first = true;
    loop {
        // The first instance flag makes a second app (or a squatter that came
        // first) fail here instead of silently sharing the name.
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            log(&json!({
                "role": "app", "event": "pipe_failed", "pid": std::process::id(),
                "error": unsafe { GetLastError() },
            }));
            return;
        }
        if first {
            log(&json!({
                "role": "app", "event": "listening", "pid": std::process::id(),
                "ready_ms": started.elapsed().as_millis(),
            }));
        }
        first = false;
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        let pipe = unsafe { File::from_raw_handle(handle as _) };
        if connected {
            thread::spawn(move || answer(pipe));
        }
    }
}

fn answer(pipe: File) {
    let mut line = String::new();
    if BufReader::new(&pipe).read_line(&mut line).is_err() {
        return;
    }
    let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    log(&json!({ "role": "app", "event": "capture", "pid": std::process::id(), "url": request["url"] }));
    let reply = json!({
        "saved": true, "app_pid": std::process::id(), "url": request["url"], "package": package(),
    });
    let _ = (&pipe).write_all(format!("{reply}\n").as_bytes());
}
