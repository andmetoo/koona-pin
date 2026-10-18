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
    db::Source,
};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
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
        /// «Save to Reading» (NP-125). Absent from a plain save and from
        /// extensions before 0.11: the protocol stays 2.
        #[serde(default)]
        reading: bool,
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

pub(crate) fn failure(code: &str, message: &str) -> Value {
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
            reading,
            ..
        } => {
            let request = CaptureRequest {
                request_id: Some(request_id),
                url,
                title,
                collection_id: None,
                tags: None,
                reading,
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
                    // In Reading now, as asked: the extension says «Saved to Reading».
                    if saved.reading {
                        reply["reading"] = json!(true);
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

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn emit_status(app: &AppHandle, state: &ChannelState) {
    let _ = app.emit("capture-status", state.status(Utc::now()));
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db;

    pub(crate) fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        // The SQL functions the triggers call, as every connection of the app has.
        crate::db::register_functions(&c).unwrap();
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
    pub(crate) fn now() -> DateTime<Utc> {
        "2026-10-03T12:00:00Z".parse().unwrap()
    }
    pub(crate) fn capture(id: &str, url: &str, browser: &str) -> Value {
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

    /// «Save to Reading» (NP-125): a capture with the flag.
    fn to_reading(id: &str, url: &str) -> Value {
        let mut message = capture(id, url, "firefox");
        message["reading"] = json!(true);
        message
    }
    /// (in Reading, unread, waiting in the inbox) of the bookmark at `url`.
    fn placed(c: &Connection, url: &str) -> (bool, bool, bool) {
        c.query_row(
            "SELECT reading_at IS NOT NULL, read_at IS NULL, triaged_at IS NULL FROM bookmarks WHERE url = ?1",
            [url],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_page_saved_to_reading_lands_in_reading_and_still_waits_in_the_inbox() {
        let c = database();
        let mut connections = Connections::default();
        let saved = handle(&c, &mut connections, &envelope(to_reading("r1", "https://example.com/article")), now());
        assert_eq!(saved.reply["ok"], true);
        assert_eq!(saved.reply["outcome"], "created");
        assert_eq!(saved.reply["reading"], true);
        let result = saved.saved.unwrap();
        assert!(result.newly_created && result.reading);
        // The interface gets the bookmark already in Reading, and the metadata
        // request after it still matches its revision.
        let bookmark = result.bookmark.unwrap();
        assert!(bookmark.reading_at.is_some());
        assert_eq!(bookmark.revision, db::get_bookmark_by_id(&c, bookmark.id).unwrap().revision);
        assert_eq!(placed(&c, "https://example.com/article"), (true, true, true));
        let counts = db::get_counts(&c).unwrap();
        assert_eq!((counts.total, counts.inbox, crate::reading::counts(&c).unwrap()), (1, 1, (1, 1)));
        // A plain save says nothing of Reading and puts nothing there.
        let plain = handle(&c, &mut connections, &envelope(capture("r2", "https://example.com/plain", "chrome")), now());
        assert!(plain.reply.get("reading").is_none());
        assert_eq!(placed(&c, "https://example.com/plain"), (false, true, true));
    }

    #[test]
    fn an_already_saved_page_is_only_added_to_reading_where_it_is() {
        let c = database();
        let mut connections = Connections::default();
        // One sorted out of the inbox, one still waiting there.
        let sorted = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/sorted", "chrome")), now());
        let sorted_id = sorted.reply["bookmark_id"].as_i64().unwrap();
        db::apply_bulk(&c, &[sorted_id], &db::Bulk::Favorite(true)).unwrap();
        handle(&c, &mut connections, &envelope(capture("r2", "https://example.com/waiting", "chrome")), now());
        let before: (String, Option<String>) = c
            .query_row("SELECT title, triaged_at FROM bookmarks WHERE id = ?1", [sorted_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();

        let again = handle(&c, &mut connections, &envelope(to_reading("r3", "https://example.com/sorted")), now());
        assert_eq!((again.reply["outcome"].as_str(), again.reply["reading"].as_bool()), (Some("existing"), Some(true)));
        assert_eq!(again.reply["bookmark_id"], sorted_id);
        let result = again.saved.unwrap();
        assert!(!result.newly_created && result.reading_changed, "the interface hears of it");
        let waiting = handle(&c, &mut connections, &envelope(to_reading("r4", "https://example.com/waiting")), now());
        assert_eq!(waiting.reply["outcome"], "existing");
        // No duplicate; the sorted one stays sorted with its title, the other waits in the inbox.
        assert_eq!(db::get_counts(&c).unwrap().total, 2);
        assert_eq!(placed(&c, "https://example.com/sorted"), (true, true, false));
        assert_eq!(placed(&c, "https://example.com/waiting"), (true, true, true));
        let after: (String, Option<String>) = c
            .query_row("SELECT title, triaged_at FROM bookmarks WHERE id = ?1", [sorted_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(after, before);

        // Already in Reading: its place and progress stay, nothing is written.
        let at: String = c.query_row("SELECT reading_at FROM bookmarks WHERE id = ?1", [sorted_id], |r| r.get(0)).unwrap();
        crate::reading::set_progress(&c, sorted_id, 0.4).unwrap();
        let revision = db::get_bookmark_by_id(&c, sorted_id).unwrap().revision;
        let third = handle(&c, &mut connections, &envelope(to_reading("r5", "https://example.com/sorted")), now());
        assert_eq!(third.reply["reading"], true);
        assert!(!third.saved.unwrap().reading_changed);
        let now_there = db::get_bookmark_by_id(&c, sorted_id).unwrap();
        assert_eq!((now_there.reading_at.as_deref(), now_there.reading_progress, now_there.revision), (Some(at.as_str()), 0.4, revision));

        // A read one, saved to Reading again, starts over unread, as «Send to Reading» does.
        crate::reading::set_progress(&c, sorted_id, 1.0).unwrap();
        db::apply_bulk(&c, &[sorted_id], &db::Bulk::Reading(false)).unwrap();
        handle(&c, &mut connections, &envelope(to_reading("r6", "https://example.com/sorted")), now());
        assert_eq!(placed(&c, "https://example.com/sorted"), (true, true, false));
    }

    #[test]
    fn a_page_saved_to_reading_from_the_trash_comes_back_to_the_inbox_and_reading() {
        let c = database();
        let mut connections = Connections::default();
        let first = handle(&c, &mut connections, &envelope(capture("r1", "https://example.com/", "edge")), now());
        db::trash_bookmark(&c, first.reply["bookmark_id"].as_i64().unwrap()).unwrap();
        let back = handle(&c, &mut connections, &envelope(to_reading("r2", "https://example.com/")), now());
        assert_eq!(
            (back.reply["outcome"].as_str(), back.reply["restored"].as_bool(), back.reply["reading"].as_bool()),
            (Some("created"), Some(true), Some(true))
        );
        assert_eq!(placed(&c, "https://example.com/"), (true, true, true));
        assert!(back.saved.unwrap().bookmark.unwrap().reading_at.is_some());
    }

    /// The extension keeps a link saved to Reading in its queue while the app
    /// is closed (extension/src/queue.js) and sends the same line when the app
    /// starts: the library opened afresh puts it in Reading. A reply lost on
    /// the way is answered from the receipt and does not put back a link taken
    /// out of Reading since.
    #[test]
    fn a_page_saved_to_reading_while_the_app_was_closed_lands_in_reading_on_start() {
        let dir = std::env::temp_dir().join(format!("koonapin-np125-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("koonapin.db");
        let open = || {
            let mut c = Connection::open(&path).unwrap();
            crate::db::register_functions(&c).unwrap();
            c.pragma_update(None, "foreign_keys", true).unwrap();
            crate::migrations::migrate(&mut c, None).unwrap();
            c
        };
        // The library as the app left it when it closed.
        let c = open();
        handle(&c, &mut Connections::default(), &envelope(capture("r0", "https://example.com/known", "firefox")), now());
        drop(c);
        // The queued message, word for word as the host writes it to the pipe.
        let queued = json!({ "type": "capture", "protocol": PROTOCOL, "version": "0.11.0", "browser": "firefox",
                             "request_id": "queued-1", "url": "https://example.com/later", "title": "Later", "reading": true });
        let line = format!("{}\n", json!({ "caller": "pin@koona.app", "message": queued }));
        let c = open();
        let mut connections = Connections::load(&c);
        let delivered = handle(&c, &mut connections, &parse(line.as_bytes()).unwrap(), now());
        assert_eq!((delivered.reply["outcome"].as_str(), delivered.reply["reading"].as_bool()), (Some("created"), Some(true)));
        assert_eq!(placed(&c, "https://example.com/later"), (true, true, true));
        // The reply was lost; meanwhile the person took it out of Reading.
        let id = delivered.reply["bookmark_id"].as_i64().unwrap();
        db::apply_bulk(&c, &[id], &db::Bulk::Reading(false)).unwrap();
        let replay = handle(&c, &mut connections, &parse(line.as_bytes()).unwrap(), now());
        assert_eq!(replay.reply["bookmark_id"], id);
        assert!(replay.reply.get("reading").is_none());
        assert_eq!(placed(&c, "https://example.com/later"), (false, true, true));
        assert_eq!(db::get_counts(&c).unwrap().total, 2);
        drop(c);
        std::fs::remove_dir_all(&dir).unwrap();
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

    /// Safari (NP-119): its extension says hello and saves like the others,
    /// with its own source; the app records it as connected and as the
    /// browser of the last save.
    #[test]
    fn safari_says_hello_and_saves_as_safari() {
        let c = database();
        let mut connections = Connections::default();
        let hello = handle(
            &c,
            &mut connections,
            &envelope(json!({ "type": "hello", "protocol": PROTOCOL, "version": "0.9.0", "browser": "safari" })),
            now(),
        );
        assert_eq!(hello.reply["ok"], true);
        assert!(hello.contact);
        let mac = |connections: &Connections| browsers::status_on(connections, None, now(), browsers::System::Macos);
        let status = mac(&Connections::load(&c));
        assert_eq!(status.state, browsers::CaptureState::Connected);
        assert_eq!(status.browsers[0].browser, Browser::Safari);
        let saved = handle(&c, &mut connections, &envelope(capture("s1", "https://www.apple.com/safari/", "safari")), now());
        assert_eq!(saved.reply["outcome"], "created");
        assert!(saved.contact);
        let source: String = c
            .query_row("SELECT source FROM bookmarks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "safari");
        let status = mac(&connections);
        assert_eq!(status.last_capture.unwrap().browser, Browser::Safari);
    }

}
