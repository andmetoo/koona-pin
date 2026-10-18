//! The window's page driven from a script, for the macOS screenshots of koona.app/pin
//! (scripts/site-screenshots-macos.mjs): WKWebView has no CDP to attach to, as WebView2 has
//! for site-screenshots.mjs. With KOONAPIN_SHOTS_SOCKET=<path> the app listens on that Unix
//! socket; each line it reads is a JavaScript expression evaluated in the main window, and it
//! writes back one line, the result as JSON (`null` for a promise: the script keeps what it
//! needs in a global and reads it with a later line). Never in an installer build
//! (`public-release`), and off without the variable.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const SHOTS_ENV: &str = "KOONAPIN_SHOTS_SOCKET";

pub fn start(app: &AppHandle) {
    let Some(path) = std::env::var_os(SHOTS_ENV).filter(|p| !p.is_empty()) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("shots: cannot listen on {}: {e}", path.to_string_lossy());
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut writer = match stream.try_clone() {
                Ok(writer) => writer,
                Err(_) => continue,
            };
            for line in BufReader::new(stream).lines() {
                let Ok(js) = line else { break };
                let reply = evaluate(&app, js).replace('\n', " ");
                if writeln!(writer, "{reply}").is_err() {
                    break;
                }
            }
        }
    });
}

fn evaluate(app: &AppHandle, js: String) -> String {
    if let Some(sql) = js.strip_prefix("!sql ") {
        let Some(state) = app.try_state::<std::sync::Arc<crate::db::DbState>>() else {
            return r#"{"error":"no library"}"#.into();
        };
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        return match conn.execute_batch(sql) {
            Ok(()) => r#"{"ok":true}"#.into(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
    }
    if let Some(size) = js.strip_prefix("!size ") {
        let mut it = size.split_whitespace().filter_map(|n| n.parse::<f64>().ok());
        let (Some(w), Some(h)) = (it.next(), it.next()) else {
            return r#"{"error":"!size <width> <height>"}"#.into();
        };
        return match app.get_webview_window("main").map(|win| win.set_size(tauri::LogicalSize::new(w, h))) {
            Some(Ok(())) => r#"{"ok":true}"#.into(),
            Some(Err(e)) => serde_json::json!({ "error": e.to_string() }).to_string(),
            None => r#"{"error":"no window"}"#.into(),
        };
    }
    let Some(window) = app.get_webview_window("main") else {
        return r#"{"error":"no window"}"#.into();
    };
    let (tx, rx) = mpsc::channel();
    let wrapped = format!("(() => {{ try {{ return {{ ok: ({js}) }}; }} catch (e) {{ return {{ error: String(e) }}; }} }})()");
    if let Err(e) = window.eval_with_callback(wrapped, move |result| {
        let _ = tx.send(result);
    }) {
        return serde_json::json!({ "error": e.to_string() }).to_string();
    }
    rx.recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| r#"{"error":"timeout"}"#.into())
}
