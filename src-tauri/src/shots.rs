//! The window's page driven from a script, for the macOS screenshots of koona.app/pin
//! (scripts/site-screenshots-macos.mjs): WKWebView has no CDP to attach to, as WebView2 has
//! for site-screenshots.mjs. With KOONAPIN_SHOTS_SOCKET=<path> the app listens on that Unix
//! socket; each line it reads is a JavaScript expression evaluated in the main window, and it
//! writes back one line, the result as JSON (`null` for a promise: the script keeps what it
//! needs in a global and reads it with a later line). Never in an installer build
//! (`public-release`), and off without the variable.
//!
//! A line may instead be a command of the script:
//!
//! - `!sql <statements>` runs them on the library's own connection (its functions and
//!   triggers in place); `!rows <select>` answers the rows, each an array of values;
//! - `!feeds <statements>` runs them on the feed cache's connection (`feeds.db`): the shots'
//!   posts are written there, as a fetch would leave them, since a fetch takes no local address;
//! - `!size <width> <height>` sets the window's inner size in points; `!focus` keeps it above
//!   other windows and asks for it to be the active one, as a person sees it: WebKit pauses the
//!   page of a covered window, and an inactive window has grey traffic lights.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{mpsc, Arc};
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
        let Some(state) = app.try_state::<Arc<crate::db::DbState>>() else {
            return r#"{"error":"no library"}"#.into();
        };
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        return batch(&conn, sql);
    }
    if let Some(sql) = js.strip_prefix("!rows ") {
        let Some(state) = app.try_state::<Arc<crate::db::DbState>>() else {
            return r#"{"error":"no library"}"#.into();
        };
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        return match rows(&conn, sql) {
            Ok(rows) => serde_json::json!({ "ok": rows }).to_string(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
    }
    if let Some(sql) = js.strip_prefix("!feeds ") {
        let Some(cache) = app.try_state::<Arc<crate::feeds::cache::FeedCache>>() else {
            return r#"{"error":"no feed cache"}"#.into();
        };
        let conn = cache.conn.lock().unwrap_or_else(|e| e.into_inner());
        return batch(&conn, sql);
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
    if js.trim() == "!focus" {
        return match app
            .get_webview_window("main")
            .map(|win| win.show().and_then(|()| win.set_always_on_top(true)).and_then(|()| win.set_focus()))
        {
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

fn batch(conn: &rusqlite::Connection, sql: &str) -> String {
    match conn.execute_batch(sql) {
        Ok(()) => r#"{"ok":true}"#.into(),
        Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
    }
}

/// Every row of one query, each value as JSON (a blob as null).
fn rows(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<Vec<serde_json::Value>>> {
    use rusqlite::types::ValueRef;
    let mut statement = conn.prepare(sql)?;
    let columns = statement.column_count();
    let mut rows = statement.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut values = Vec::with_capacity(columns);
        for i in 0..columns {
            values.push(match row.get_ref(i)? {
                ValueRef::Integer(n) => n.into(),
                ValueRef::Real(x) => x.into(),
                ValueRef::Text(t) => String::from_utf8_lossy(t).into(),
                ValueRef::Null | ValueRef::Blob(_) => serde_json::Value::Null,
            });
        }
        out.push(values);
    }
    Ok(out)
}
