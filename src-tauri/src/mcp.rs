//! AI assistants over MCP (NP-091, Р-67). koonapin-mcp speaks MCP to the
//! assistant over stdio and passes each tool call to the app over the capture
//! channel, so only this user's processes reach it (`capture_channel.rs`).
//! Here the app decides: whether access is on, what the tool may do, and how
//! much of the library goes back.
//!
//! - Off by default; off, every call gets an error and nothing is read.
//! - «Read only» offers the reading tools; «Read and add» also adds links to
//!   the inbox and tags, moves and stars bookmarks. Each change is a command
//!   of the undo journal, so `Ctrl Z` takes it back, and none sorts a
//!   bookmark out of the inbox. Nothing is ever deleted.
//! - Every text of the library is the person's or a web page's: it goes back
//!   as data, cleared of control characters, cut to a length, at most
//!   [`MAX_RESULTS`] bookmarks and [`MAX_REPLY`] bytes an answer.

use crate::{
    browsers::PROTOCOL,
    capture::{self, CaptureResult},
    db::{self, AssistantChange, Bookmark, BookmarkQuery},
    journal::{Action, Journal},
    mcp_tools::{self as tools, Access, Filter},
};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use ts_rs::TS;

pub const ACCESS_KEY: &str = "mcp_access";
const LAST_CLIENT_KEY: &str = "mcp_last_client";
const LAST_AT_KEY: &str = "mcp_last_at";

/// Bookmarks one search returns at most, and when the assistant names none.
pub const MAX_RESULTS: u32 = 50;
pub const DEFAULT_RESULTS: u32 = 20;
/// The result of one call, as JSON; a longer list is cut and says so.
pub const MAX_REPLY: usize = 64 * 1024;
/// Collections and tags one list returns at most.
const MAX_NAMES: usize = 500;
/// A longer query is not a search.
const MAX_QUERY: usize = 500;
const MAX_TAGS: usize = 10;
const MAX_TAG: usize = 60;

/// Lengths a text field is cut to, in characters.
const TITLE: usize = 300;
const DESCRIPTION: usize = 1_000;
const NOTES: usize = 4_000;
const ADDRESS: usize = 2_048;
const NAME: usize = 100;

/// Settings → AI assistants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum McpAccess {
    Off,
    Read,
    ReadAndAdd,
}

impl From<Access> for McpAccess {
    fn from(access: Access) -> Self {
        match access {
            Access::Off => McpAccess::Off,
            Access::Read => McpAccess::Read,
            Access::ReadAndAdd => McpAccess::ReadAndAdd,
        }
    }
}

impl From<McpAccess> for Access {
    fn from(access: McpAccess) -> Self {
        match access {
            McpAccess::Off => Access::Off,
            McpAccess::Read => Access::Read,
            McpAccess::ReadAndAdd => Access::ReadAndAdd,
        }
    }
}

/// What the settings show, also pushed as the `mcp-status` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct McpStatus {
    pub access: McpAccess,
    /// The assistant of the last tool call and when it came; none before the first.
    pub last_client: Option<String>,
    pub last_at: Option<String>,
}

pub fn access(conn: &Connection) -> Access {
    db::setting(conn, ACCESS_KEY)
        .ok()
        .and_then(|value| Access::parse(&value))
        .unwrap_or(Access::Off)
}

pub fn set_access(conn: &Connection, access: Access) -> rusqlite::Result<()> {
    db::set_setting(conn, ACCESS_KEY, access.as_str())
}

pub fn status(conn: &Connection) -> McpStatus {
    McpStatus {
        access: access(conn).into(),
        last_client: db::setting(conn, LAST_CLIENT_KEY).ok().filter(|v| !v.is_empty()),
        last_at: db::setting(conn, LAST_AT_KEY).ok(),
    }
}

/// How triage and the settings name the assistant: the known ones by their
/// product name, any other by the name it gave, cleaned and cut.
pub fn assistant_name(client: &str) -> String {
    let lower = client.trim().to_lowercase();
    let known = match lower.as_str() {
        "claude-ai" | "claude" | "claude-desktop" | "claude desktop" => Some("Claude"),
        "claude-code" | "claude code" => Some("Claude Code"),
        "visual studio code" | "vscode" | "visual-studio-code" => Some("VS Code"),
        name if name.starts_with("cursor") => Some("Cursor"),
        _ => None,
    };
    known.map_or_else(|| clip(client.trim(), NAME), str::to_owned)
}

/// A text of the library as it goes to an assistant: control characters and
/// the marks that reorder text (bidi overrides, zero-width joiners) dropped,
/// cut to `max` characters with «…».
pub fn clip(text: &str, max: usize) -> String {
    let clean: String = text
        .chars()
        .filter(|&c| {
            (!c.is_control() || c == '\n' || c == '\t')
                && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
        .collect();
    match clean.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &clean[..at]),
        None => clean,
    }
}

/// What the app does with one message from koonapin-mcp.
pub struct Handled {
    pub reply: Value,
    /// Bookmarks a tool changed: the interface hears of them.
    pub changed: Vec<Bookmark>,
    /// A link added to the inbox: its page is read afterwards, as for a capture.
    pub saved: Option<CaptureResult>,
    /// The last request moved on: the settings hear of it.
    pub status: bool,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    protocol: Option<u32>,
    /// The assistant's own name, from MCP `initialize`.
    #[serde(default)]
    client: String,
    /// None asks only what is allowed: the tool list.
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    arguments: Value,
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// Everything the app does with one message, inside the database lock and
/// then the journal's.
pub fn handle(conn: &Connection, journal: &mut Journal, message: &Value, now: DateTime<Utc>) -> Handled {
    let none = |reply| Handled { reply, changed: Vec::new(), saved: None, status: false };
    let Ok(message) = serde_json::from_value::<Message>(message.clone()) else {
        return none(failure("invalid_request", "Unknown message"));
    };
    if message.protocol != Some(PROTOCOL) {
        let mut reply = failure("incompatible_protocol", "Koona Pin and its MCP server versions do not match");
        reply["protocol"] = json!(PROTOCOL);
        reply["version"] = json!(env!("CARGO_PKG_VERSION"));
        return none(reply);
    }
    let access = access(conn);
    let Some(tool) = message.tool else {
        return none(json!({ "ok": true, "access": access.as_str() }));
    };
    let Some(spec) = tools::spec(&tool) else {
        return none(failure("unknown_tool", &format!("Koona Pin has no tool {tool}")));
    };
    // The last request is a convenience: a read-only (damaged) library keeps none.
    let name = assistant_name(&message.client);
    let stamp = db::stamp(now);
    let status = db::set_setting(conn, LAST_CLIENT_KEY, &name).is_ok()
        && db::set_setting(conn, LAST_AT_KEY, &stamp).is_ok();
    let answer = |outcome: Result<Value, String>| match outcome {
        Ok(result) => json!({ "ok": true, "access": access.as_str(), "result": result }),
        Err(error) => json!({ "ok": true, "access": access.as_str(), "error": error }),
    };
    if access == Access::Off {
        let error = "Koona Pin has access for AI assistants turned off. The person can turn it on in Koona Pin: Settings → AI assistants.";
        return Handled { reply: answer(Err(error.into())), changed: Vec::new(), saved: None, status };
    }
    if !access.offers(spec) {
        let error = "Koona Pin lets AI assistants only read the library. The person can allow adding in Koona Pin: Settings → AI assistants.";
        return Handled { reply: answer(Err(error.into())), changed: Vec::new(), saved: None, status };
    }
    let mut call = Call { conn, journal, assistant: &name, changed: Vec::new(), saved: None };
    match call.run(spec.name, message.arguments) {
        Ok(outcome) => Handled { reply: answer(outcome), changed: call.changed, saved: call.saved, status },
        Err(invalid) => Handled { reply: failure("invalid_params", &invalid), changed: Vec::new(), saved: None, status },
    }
}

struct Call<'a> {
    conn: &'a Connection,
    journal: &'a mut Journal,
    assistant: &'a str,
    changed: Vec<Bookmark>,
    saved: Option<CaptureResult>,
}

/// Arguments that do not fit the schema are a protocol error (`Err`); a call
/// that cannot be done is the tool's answer (`Ok(Err)`).
type Outcome = Result<Result<Value, String>, String>;

fn args<T: DeserializeOwned>(arguments: Value) -> Result<T, String> {
    let arguments = if arguments.is_null() { json!({}) } else { arguments };
    serde_json::from_value(arguments).map_err(|e| e.to_string())
}

fn library_error(error: rusqlite::Error) -> String {
    match error {
        rusqlite::Error::QueryReturnedNoRows => "Koona Pin has no such bookmark outside the trash.".into(),
        error => format!("Koona Pin could not use its library ({:?}). Try again later.", crate::error::code_of(&error)),
    }
}

impl Call<'_> {
    fn run(&mut self, tool: &str, arguments: Value) -> Outcome {
        match tool {
            tools::SEARCH => Ok(self.search(args(arguments)?)),
            tools::GET => Ok(self.get(args::<tools::IdArgs>(arguments)?.id)),
            tools::COLLECTIONS => args::<tools::NoArgs>(arguments).map(|_| self.collections()),
            tools::TAGS => args::<tools::NoArgs>(arguments).map(|_| self.tags()),
            tools::ADD => Ok(self.add(args(arguments)?)),
            tools::TAG => {
                let a: tools::TagArgs = args(arguments)?;
                let tags: Vec<String> = a.tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
                if tags.is_empty() || tags.len() > MAX_TAGS || tags.iter().any(|t| t.chars().count() > MAX_TAG) {
                    return Err(format!("tags: 1 to {MAX_TAGS} tags of at most {MAX_TAG} characters"));
                }
                Ok(self.change(a.id, Action::Tag, AssistantChange::Tag(tags)))
            }
            tools::MOVE => {
                let a: tools::MoveArgs = args(arguments)?;
                Ok(self.collection_id(&a.collection).and_then(|id| self.change(a.id, Action::Move, AssistantChange::Move(id))))
            }
            tools::FAVORITE => {
                let a: tools::FavoriteArgs = args(arguments)?;
                Ok(self.change(a.id, Action::Favorite, AssistantChange::Favorite(a.favorite)))
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    fn names(&self) -> Result<HashMap<i64, String>, String> {
        Ok(db::get_collections(self.conn)
            .map_err(library_error)?
            .into_iter()
            .map(|c| (c.id, c.name))
            .collect())
    }

    /// A collection named by the assistant: the name as the sidebar shows it,
    /// case aside.
    fn collection_id(&self, name: &str) -> Result<i64, String> {
        let wanted = db::fold(name.trim());
        db::get_collections(self.conn)
            .map_err(library_error)?
            .into_iter()
            .find(|c| db::fold(&c.name) == wanted)
            .map(|c| c.id)
            .ok_or_else(|| format!("Koona Pin has no collection named «{}»; list_collections names them.", clip(name, NAME)))
    }

    fn search(&self, a: tools::SearchArgs) -> Result<Value, String> {
        let collection_id = match a.collection.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(name) => Some(self.collection_id(name)?),
            None => None,
        };
        let after = match a.cursor.as_deref().filter(|c| !c.is_empty()) {
            Some(cursor) => Some(serde_json::from_str(cursor).map_err(|_| "cursor: not a next_cursor of Koona Pin".to_string())?),
            None => None,
        };
        let query: String = a.query.unwrap_or_default().trim().chars().take(MAX_QUERY).collect();
        let page = db::get_bookmarks(
            self.conn,
            &BookmarkQuery {
                search: (!query.is_empty()).then_some(query),
                collection_id,
                tag: a.tag.map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()),
                only_inbox: a.filter == Filter::Inbox,
                only_favorites: a.filter == Filter::Favorites,
                limit: Some(a.limit.unwrap_or(DEFAULT_RESULTS).clamp(1, MAX_RESULTS)),
                after,
                ..Default::default()
            },
        )
        .map_err(library_error)?;
        let names = self.names()?;
        let mut items: Vec<Value> = page.items.iter().map(|b| summary(b, &names)).collect();
        let mut next = page.next.map(|cursor| json!(serde_json::to_string(&cursor).unwrap_or_default()));
        let mut truncated = false;
        let reply = loop {
            let reply = json!({ "bookmarks": items, "total": page.total, "next_cursor": next, "truncated": truncated });
            if items.is_empty() || reply.to_string().len() <= MAX_REPLY {
                break reply;
            }
            // Cut from the end; the next page starts after the last one kept.
            items.pop();
            truncated = true;
            next = page.items.get(items.len().wrapping_sub(1)).and_then(cursor_of).map(|c| json!(c));
        };
        Ok(reply)
    }

    fn get(&self, id: i64) -> Result<Value, String> {
        let b = db::get_bookmark_by_id(self.conn, id).map_err(library_error)?;
        if b.deleted_at.is_some() {
            return Err(library_error(rusqlite::Error::QueryReturnedNoRows));
        }
        let mut item = summary(&b, &self.names()?);
        item["description"] = json!(b.description.as_deref().map(|d| clip(d, DESCRIPTION)));
        item["notes"] = json!(b.notes.as_deref().map(|n| clip(n, NOTES)));
        item["updated_at"] = json!(b.updated_at);
        Ok(json!({ "bookmark": item }))
    }

    fn collections(&self) -> Result<Value, String> {
        let all = db::get_collections(self.conn).map_err(library_error)?;
        let truncated = all.len() > MAX_NAMES;
        let collections: Vec<Value> = all
            .iter()
            .take(MAX_NAMES)
            .map(|c| json!({ "id": c.id, "name": clip(&c.name, NAME), "bookmarks": c.count.unwrap_or(0) }))
            .collect();
        Ok(json!({ "collections": collections, "truncated": truncated }))
    }

    fn tags(&self) -> Result<Value, String> {
        let all = db::get_tags(self.conn).map_err(library_error)?;
        let truncated = all.len() > MAX_NAMES;
        let tags: Vec<Value> = all
            .iter()
            .take(MAX_NAMES)
            .map(|t| json!({ "name": clip(&t.name, NAME), "bookmarks": t.count.unwrap_or(0) }))
            .collect();
        Ok(json!({ "tags": tags, "truncated": truncated }))
    }

    fn add(&mut self, a: tools::AddArgs) -> Result<Value, String> {
        let title = a.title.map(|t| clip(t.trim(), TITLE)).filter(|t| !t.is_empty());
        let saved = capture::save_by_assistant(self.conn, &a.url, title, self.assistant).map_err(|e| match e.code {
            "invalid_request" => "url: only http and https addresses with a host can be saved".to_string(),
            _ => format!("Koona Pin could not save the link ({}). Try again later.", e.code),
        })?;
        let outcome = if saved.restored {
            "restored"
        } else if saved.outcome == "existing" {
            "existing"
        } else {
            "created"
        };
        let bookmark = saved.bookmark.as_ref().map(|b| summary(b, &self.names().unwrap_or_default()));
        self.saved = Some(saved);
        Ok(json!({ "outcome": outcome, "bookmark": bookmark }))
    }

    /// One change, recorded in the journal so `Ctrl Z` takes it back.
    fn change(&mut self, id: i64, action: Action, change: AssistantChange) -> Result<Value, String> {
        let (mut bookmarks, command) = self
            .journal
            .record(self.conn, action, &[id], |conn| db::assistant_update(conn, id, &change).map(|b| vec![b]))
            .map_err(library_error)?;
        let bookmark = bookmarks.remove(0);
        let item = summary(&bookmark, &self.names()?);
        if command.is_some() {
            self.changed.push(bookmark);
        }
        Ok(json!({ "bookmark": item, "changed": command.is_some() }))
    }
}

/// The server on Windows; on Linux it is `koonapin-mcp`.
#[cfg(windows)]
pub const SERVER_EXE: &str = "koonapin-mcp.exe";
#[cfg(not(windows))]
pub const SERVER_EXE: &str = "koonapin-mcp";
/// The server's name in the assistants' settings.
pub const SERVER_NAME: &str = "koona-pin";

/// «How to connect…»: what the person copies into an assistant, with the
/// real path of the server on this computer.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct McpSetup {
    pub server: String,
    /// The server is next to the app: a broken installation otherwise.
    pub installed: bool,
    /// For a terminal: `claude mcp add …`.
    pub claude_code: String,
    /// `mcpServers` as Claude Desktop, Cursor, Windsurf and most others read it.
    pub json: String,
}

pub fn server_path() -> std::io::Result<std::path::PathBuf> {
    // An AppImage's own folder lasts until it is closed: the copy beside the host stays (NP-116).
    if let Some(server) = crate::appimage::server() {
        return Ok(server);
    }
    let app = std::env::current_exe()?;
    let folder = app.parent().ok_or_else(|| std::io::Error::other("the app has no folder"))?;
    Ok(folder.join(SERVER_EXE))
}

pub fn setup(server: &std::path::Path) -> McpSetup {
    let path = server.display().to_string();
    let json = serde_json::to_string_pretty(&json!({ "mcpServers": { SERVER_NAME: { "command": path } } })).unwrap_or_default();
    McpSetup {
        installed: server.is_file(),
        claude_code: format!("claude mcp add --scope user {SERVER_NAME} -- \"{path}\""),
        json,
        server: path,
    }
}

/// The manifest of the Claude Desktop package (MCPB 0.3). It runs the server
/// installed with the app, not the copy inside: the app's updates replace
/// that one, and the copy only satisfies the format. The command goes without
/// `.exe`, which Claude Desktop adds to binaries itself.
pub fn manifest(server: &std::path::Path) -> Value {
    let command = server.with_extension("").display().to_string();
    let tools: Vec<Value> = tools::TOOLS
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.title }))
        .collect();
    json!({
        "manifest_version": "0.3",
        "name": SERVER_NAME,
        "display_name": "Koona Pin",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Search your Koona Pin bookmarks and save links to Inbox.",
        "author": { "name": "Koona", "url": "https://koona.app/pin/" },
        "homepage": "https://koona.app/pin/",
        "license": "GPL-3.0-only",
        "icon": "icon.png",
        "server": {
            "type": "binary",
            "entry_point": format!("server/{SERVER_EXE}"),
            "mcp_config": { "command": command, "args": [] },
        },
        "tools": tools,
        "compatibility": { "platforms": [if cfg!(windows) { "win32" } else { "linux" }] },
    })
}

/// Writes `koona-pin.mcpb`: a zip of the manifest, the icon and the server.
pub fn write_bundle(server: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let manifest = serde_json::to_vec_pretty(&manifest(server)).map_err(std::io::Error::other)?;
    let files: [(String, Vec<u8>); 3] = [
        ("manifest.json".into(), manifest),
        ("icon.png".into(), include_bytes!("../icons/128x128.png").to_vec()),
        (format!("server/{SERVER_EXE}"), std::fs::read(server)?),
    ];
    let partial = to.with_extension("partial");
    std::fs::write(&partial, zip(&files)?)?;
    std::fs::rename(&partial, to)
}

/// A zip of `files`, deflated: what an `.mcpb` is. No timestamps, no extras.
fn zip(files: &[(String, Vec<u8>)]) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        deflate.write_all(data)?;
        let packed = deflate.finish()?;
        let crc = crc32fast::hash(data);
        let at = out.len() as u32;
        let header = |signature: u32, central: bool| {
            let mut h = Vec::new();
            h.extend(signature.to_le_bytes());
            if central {
                h.extend(20u16.to_le_bytes()); // made by
            }
            h.extend(20u16.to_le_bytes()); // needed
            h.extend(0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend(8u16.to_le_bytes()); // deflate
            h.extend(0u32.to_le_bytes()); // time and date
            h.extend(crc.to_le_bytes());
            h.extend((packed.len() as u32).to_le_bytes());
            h.extend((data.len() as u32).to_le_bytes());
            h.extend((name.len() as u16).to_le_bytes());
            h.extend(0u16.to_le_bytes()); // extra
            if central {
                h.extend([0u8; 8]); // comment, disk, internal attributes
                h.extend(0u32.to_le_bytes()); // external attributes
                h.extend(at.to_le_bytes());
            }
            h.extend(name.as_bytes());
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend(&packed);
        central.extend(header(0x0201_4b50, true));
    }
    let start = out.len() as u32;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]); // disks
    out.extend((files.len() as u16).to_le_bytes());
    out.extend((files.len() as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    Ok(out)
}

fn cursor_of(b: &Bookmark) -> Option<String> {
    serde_json::to_string(&db::PageCursor { at: b.created_at.clone(), id: b.id, key: None }).ok()
}

/// A bookmark as a list shows it.
fn summary(b: &Bookmark, collections: &HashMap<i64, String>) -> Value {
    let tags: Vec<String> = b.tags.iter().flatten().take(20).map(|t| clip(t, MAX_TAG)).collect();
    json!({
        "id": b.id,
        "url": clip(&b.url, ADDRESS),
        "title": clip(&b.title, TITLE),
        "site": clip(&b.domain, NAME),
        "collection": b.collection_id.and_then(|id| collections.get(&id)).map(|n| clip(n, NAME)),
        "tags": tags,
        "favorite": b.is_favorite,
        "inbox": b.triaged_at.is_none(),
        "saved_at": b.created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }
    fn now() -> DateTime<Utc> {
        "2026-10-11T12:00:00Z".parse().unwrap()
    }
    fn call(conn: &Connection, journal: &mut Journal, tool: &str, arguments: Value) -> Handled {
        handle(conn, journal, &json!({ "type": "mcp", "protocol": PROTOCOL, "client": "claude-code", "tool": tool, "arguments": arguments }), now())
    }
    fn result(handled: &Handled) -> &Value {
        assert_eq!(handled.reply["ok"], true, "{}", handled.reply);
        assert!(handled.reply.get("error").is_none(), "{}", handled.reply);
        &handled.reply["result"]
    }
    fn error(handled: &Handled) -> String {
        handled.reply["error"].as_str().unwrap_or_else(|| panic!("no error in {}", handled.reply)).to_owned()
    }
    fn saved(conn: &Connection, url: &str, title: &str) -> i64 {
        let request = capture::CaptureRequest { request_id: None, url: url.into(), title: Some(title.into()), collection_id: None, tags: None };
        capture::save(conn, &request, db::Source::Chrome).unwrap().bookmark_id
    }

    #[test]
    fn off_by_default_answers_an_error_and_reads_nothing() {
        let conn = library();
        let mut journal = Journal::default();
        saved(&conn, "https://sqlite.org/fts5.html", "SQLite FTS5 Extension");
        assert_eq!(access(&conn), Access::Off);
        let listed = handle(&conn, &mut journal, &json!({ "type": "mcp", "protocol": PROTOCOL }), now());
        assert_eq!(listed.reply, json!({ "ok": true, "access": "off" }));
        let off = call(&conn, &mut journal, tools::SEARCH, json!({ "query": "fts5" }));
        assert!(error(&off).contains("turned off"));
        assert!(off.reply.get("result").is_none(), "no data while off");
        assert!(!off.reply.to_string().contains("sqlite.org"));
        // The attempt is the last request the settings show.
        let shown = status(&conn);
        assert_eq!((shown.last_client.as_deref(), shown.last_at.as_deref()), (Some("Claude Code"), Some("2026-10-11T12:00:00.000Z")));
    }

    #[test]
    fn read_only_finds_by_a_word_and_refuses_to_add() {
        let conn = library();
        let mut journal = Journal::default();
        set_access(&conn, Access::Read).unwrap();
        let dev = db::create_collection(&conn, "Development", None, None).unwrap();
        let id = saved(&conn, "https://sqlite.org/fts5.html", "SQLite FTS5 Extension");
        db::update_bookmark(&conn, id, None, Some("trigram!".into()), None, Some(Some(dev.id)), Some(vec!["sqlite".into()])).unwrap();
        saved(&conn, "https://example.com/", "Something else");

        let found = call(&conn, &mut journal, tools::SEARCH, json!({ "query": "FTS5" }));
        let items = result(&found)["bookmarks"].as_array().unwrap().clone();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["url"], "https://sqlite.org/fts5.html");
        assert_eq!(items[0]["collection"], "Development");
        assert_eq!(items[0]["tags"], json!(["sqlite"]));
        assert!(items[0].get("notes").is_none(), "notes only in get_bookmark");
        let one = call(&conn, &mut journal, tools::GET, json!({ "id": id }));
        assert_eq!(result(&one)["bookmark"]["notes"], "trigram!");
        let by_collection = call(&conn, &mut journal, tools::SEARCH, json!({ "collection": "development" }));
        assert_eq!(result(&by_collection)["total"], 1);
        let unknown = call(&conn, &mut journal, tools::SEARCH, json!({ "collection": "Nope" }));
        assert!(error(&unknown).contains("list_collections"));
        let collections = call(&conn, &mut journal, tools::COLLECTIONS, json!({}));
        assert!(result(&collections)["collections"].as_array().unwrap().iter().any(|c| c["name"] == "Development" && c["bookmarks"] == 1));
        let tags = call(&conn, &mut journal, tools::TAGS, Value::Null);
        assert_eq!(result(&tags)["tags"], json!([{ "name": "sqlite", "bookmarks": 1 }]));

        let add = call(&conn, &mut journal, tools::ADD, json!({ "url": "https://tokio.rs/" }));
        assert!(error(&add).contains("only read"));
        assert_eq!(db::get_counts(&conn).unwrap().total, 2, "nothing added");
        let star = call(&conn, &mut journal, tools::FAVORITE, json!({ "id": id, "favorite": true }));
        assert!(error(&star).contains("only read"));
    }

    #[test]
    fn read_and_add_saves_to_the_inbox_once_and_names_the_assistant() {
        let conn = library();
        let mut journal = Journal::default();
        set_access(&conn, Access::ReadAndAdd).unwrap();
        let first = call(&conn, &mut journal, tools::ADD, json!({ "url": "https://tokio.rs/", "title": "Tokio" }));
        assert_eq!(result(&first)["outcome"], "created");
        assert_eq!(result(&first)["bookmark"]["inbox"], true);
        assert!(first.saved.as_ref().unwrap().newly_created, "its page is read afterwards");
        let id = result(&first)["bookmark"]["id"].as_i64().unwrap();
        let b = db::get_bookmark_by_id(&conn, id).unwrap();
        assert_eq!((b.source.as_deref(), b.source_name.as_deref(), b.triaged_at), (Some("mcp"), Some("Claude Code"), None));

        let again = call(&conn, &mut journal, tools::ADD, json!({ "url": "https://tokio.rs/" }));
        assert_eq!(result(&again)["outcome"], "existing");
        assert_eq!(db::get_counts(&conn).unwrap().total, 1, "a duplicate, not a second record");
        let bad = call(&conn, &mut journal, tools::ADD, json!({ "url": "file:///etc/passwd" }));
        assert!(error(&bad).contains("http"));
        let wrong = call(&conn, &mut journal, tools::ADD, json!({ "address": "https://tokio.rs/" }));
        assert_eq!(wrong.reply["code"], "invalid_params");
    }

    #[test]
    fn changes_stay_in_the_inbox_and_ctrl_z_takes_them_back() {
        let conn = library();
        let mut journal = Journal::default();
        set_access(&conn, Access::ReadAndAdd).unwrap();
        let reading = db::create_collection(&conn, "Reading", None, None).unwrap();
        let id = saved(&conn, "https://example.com/a", "A page");

        let tagged = call(&conn, &mut journal, tools::TAG, json!({ "id": id, "tags": [" Rust ", "async"] }));
        assert_eq!(result(&tagged)["bookmark"]["tags"], json!(["rust", "async"]));
        assert_eq!(tagged.changed.len(), 1);
        let moved = call(&conn, &mut journal, tools::MOVE, json!({ "id": id, "collection": "reading" }));
        assert_eq!(result(&moved)["bookmark"]["collection"], "Reading");
        let starred = call(&conn, &mut journal, tools::FAVORITE, json!({ "id": id, "favorite": true }));
        assert_eq!(result(&starred)["changed"], true);
        let b = db::get_bookmark_by_id(&conn, id).unwrap();
        assert_eq!((b.collection_id, b.is_favorite, b.triaged_at.clone()), (Some(reading.id), true, None), "still in the inbox");
        // Again: nothing changes, nothing to undo.
        let same = call(&conn, &mut journal, tools::FAVORITE, json!({ "id": id, "favorite": true }));
        assert_eq!((result(&same)["changed"].clone(), same.changed.len()), (json!(false), 0));

        for _ in 0..3 {
            assert!(matches!(journal.undo(&conn, None).unwrap(), crate::journal::Undo::Undone { .. }));
        }
        let back = db::get_bookmark_by_id(&conn, id).unwrap();
        assert_eq!((back.collection_id, back.is_favorite, back.tags.unwrap_or_default().len()), (None, false, 0));

        let missing = call(&conn, &mut journal, tools::MOVE, json!({ "id": id, "collection": "Nope" }));
        assert!(error(&missing).contains("no collection"));
        db::trash_bookmark(&conn, id).unwrap();
        let trashed = call(&conn, &mut journal, tools::FAVORITE, json!({ "id": id, "favorite": false }));
        assert!(error(&trashed).contains("no such bookmark"));
        let too_many = call(&conn, &mut journal, tools::TAG, json!({ "id": id, "tags": (0..11).map(|i| i.to_string()).collect::<Vec<_>>() }));
        assert_eq!(too_many.reply["code"], "invalid_params");
    }

    #[test]
    fn results_are_capped_and_texts_cleaned() {
        let conn = library();
        let mut journal = Journal::default();
        set_access(&conn, Access::Read).unwrap();
        let long = "x".repeat(5_000);
        for i in 0..60 {
            saved(&conn, &format!("https://example.com/{i}"), &format!("Page {i} \u{202E}evil\u{200B} {long}"));
        }
        let all = call(&conn, &mut journal, tools::SEARCH, json!({ "limit": 500 }));
        let reply = result(&all);
        let items = reply["bookmarks"].as_array().unwrap();
        assert!(items.len() <= MAX_RESULTS as usize);
        assert!(reply.to_string().len() <= MAX_REPLY);
        let title = items[0]["title"].as_str().unwrap();
        assert!(!title.contains('\u{202E}') && !title.contains('\u{200B}'));
        assert_eq!(title.chars().count(), TITLE + 1, "cut with an ellipsis");
        assert!(reply["next_cursor"].is_string());
        let next = call(&conn, &mut journal, tools::SEARCH, json!({ "limit": 50, "cursor": reply["next_cursor"] }));
        let first_next = result(&next)["bookmarks"][0]["id"].as_i64().unwrap();
        let last_kept = items.last().unwrap()["id"].as_i64().unwrap();
        assert!(first_next < last_kept, "the next page goes on after the last one kept");
        let default = call(&conn, &mut journal, tools::SEARCH, json!({}));
        assert_eq!(result(&default)["bookmarks"].as_array().unwrap().len(), DEFAULT_RESULTS as usize);
    }

    #[test]
    fn assistants_are_named_and_other_protocols_refused() {
        assert_eq!(assistant_name("claude-ai"), "Claude");
        assert_eq!(assistant_name("claude-code"), "Claude Code");
        assert_eq!(assistant_name("Visual Studio Code"), "VS Code");
        assert_eq!(assistant_name("cursor-vscode"), "Cursor");
        assert_eq!(assistant_name(" Zed\u{202E} "), "Zed");
        assert_eq!(assistant_name(&"z".repeat(300)).chars().count(), NAME + 1);
        let conn = library();
        let old = handle(&conn, &mut Journal::default(), &json!({ "type": "mcp", "protocol": 1, "tool": "list_tags" }), now());
        assert_eq!(old.reply["code"], "incompatible_protocol");
        let unknown = handle(&conn, &mut Journal::default(), &json!({ "type": "mcp", "protocol": PROTOCOL, "tool": "delete_bookmark" }), now());
        assert_eq!(unknown.reply["code"], "unknown_tool");
    }

    /// The package Claude Desktop opens: a zip whose manifest runs the server
    /// installed with the app, and the server inside for the format.
    #[test]
    fn the_package_runs_the_installed_server() {
        use std::io::Read;
        let dir = std::env::temp_dir().join(format!("koonapin-mcpb-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let server = dir.join(SERVER_EXE);
        std::fs::write(&server, b"binary").unwrap();
        let bundle = dir.join("koona-pin.mcpb");
        write_bundle(&server, &bundle).unwrap();
        let zip = std::fs::read(&bundle).unwrap();
        assert!(!dir.join("koona-pin.partial").exists());
        // Each local entry: its name, then the deflated data.
        let mut entries = HashMap::new();
        let mut at = 0;
        while zip[at..].starts_with(&0x0403_4b50u32.to_le_bytes()) {
            let field = |offset: usize, size: usize| zip[at + offset..at + offset + size].iter().rev().fold(0usize, |n, b| n << 8 | *b as usize);
            let (packed, length, name) = (field(18, 4), field(22, 4), field(26, 2));
            let start = at + 30 + name;
            let mut data = Vec::new();
            flate2::read::DeflateDecoder::new(&zip[start..start + packed]).read_to_end(&mut data).unwrap();
            assert_eq!(data.len(), length);
            entries.insert(String::from_utf8(zip[at + 30..start].to_vec()).unwrap(), data);
            at = start + packed;
        }
        assert!(zip[at..].starts_with(&0x0201_4b50u32.to_le_bytes()), "the central directory follows");
        let manifest: Value = serde_json::from_slice(&entries["manifest.json"]).unwrap();
        assert_eq!(entries[&format!("server/{SERVER_EXE}")], b"binary");
        assert!(entries["icon.png"].starts_with(b"\x89PNG"));
        assert_eq!(manifest["server"]["type"], "binary");
        assert_eq!(manifest["server"]["mcp_config"]["command"], server.with_extension("").display().to_string());
        assert_eq!(manifest["tools"].as_array().unwrap().len(), tools::TOOLS.len());
        assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));
        std::fs::remove_dir_all(&dir).unwrap();

        let shown = setup(std::path::Path::new(r"C:\Users\Anna\AppData\Local\Koona Pin\koonapin-mcp.exe"));
        assert!(!shown.installed);
        assert_eq!(shown.claude_code, r#"claude mcp add --scope user koona-pin -- "C:\Users\Anna\AppData\Local\Koona Pin\koonapin-mcp.exe""#);
        let json: Value = serde_json::from_str(&shown.json).unwrap();
        assert_eq!(json["mcpServers"]["koona-pin"]["command"], shown.server);
    }

    #[test]
    fn the_server_speaks_the_channel_protocol_of_the_app() {
        let server = include_str!("bin/koonapin-mcp.rs");
        assert!(server.contains(&format!("const PROTOCOL: u32 = {PROTOCOL};")), "koonapin-mcp sends another protocol");
    }
}
