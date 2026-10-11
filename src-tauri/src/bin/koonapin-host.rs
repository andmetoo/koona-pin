// No console window: the browser starts the host for every message.
#![windows_subsystem = "windows"]
//! The native messaging host (Р-17). The browser starts it for each message of
//! the extension; it passes the message to the running app over the capture
//! pipe (a Unix socket on Linux) and returns the reply. A capture starts a
//! closed app in the tray first.
//!
//! The host does not link the app: it only shares the channel's address and
//! its client with koonapin-mcp.

#[path = "../channel_client.rs"]
mod channel_client;
#[path = "../pipe_name.rs"]
mod pipe_name;

use serde_json::{json, Value};
use std::io::{self, Read, Write};

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
    channel_client::ask(&envelope, starts)
        .unwrap_or_else(|_| failure("app_unavailable", "Koona Pin is not running or does not answer"))
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
