//! Shareable lists, the `.kpin` format (NP-136, NP-137, Р-71): a list of
//! links and feeds someone published, read, previewed and imported.
//!
//! - [`format`]: the envelope, versions and payload, text and address checks;
//! - [`preview`]: what a list would do to this library, writing nothing;
//! - [`apply`]: the import, one transaction by the rules of Р-29.
//!
//! The interface sends the text it has (a dropped or picked file, a
//! download) with both commands; nothing is kept between them.

pub mod apply;
pub mod format;
pub mod preview;

use crate::{
    commands::{blocking, ImportProgress},
    db::DbState,
    error::{CommandError, ErrorCode, ErrorDetail},
    feeds::{self, cache},
    refresh,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

/// `bookmarks.source` of a link imported from a list; `source_name` is the list's title.
pub const SOURCE: &str = "list";

/// Why a text is not a list this app can import. Each is a state of the dialog (K3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    /// Not JSON, not an object, the wrong `format`, a broken envelope or structure, no title.
    NotAList,
    /// A MAJOR newer than this reader's, or a `kind` it does not know.
    NeedsNewerApp,
    /// A list for another Koona app, named by its `app`.
    OtherApp(String),
    /// More than 2 MB, or more than 5 000 items.
    TooBig,
    /// No items at all.
    Empty,
    /// The file could not be read.
    Unreadable,
}

impl ListError {
    fn message(&self) -> String {
        match self {
            ListError::NotAList => "This file isn't a Koona list".into(),
            ListError::NeedsNewerApp => "This list needs a newer Koona Pin".into(),
            ListError::OtherApp(app) => format!("This list is for Koona app \"{app}\""),
            ListError::TooBig => "A list is at most 2 MB and 5,000 items".into(),
            ListError::Empty => "This list is empty".into(),
            ListError::Unreadable => "The file could not be read".into(),
        }
    }
}

impl From<ListError> for CommandError {
    fn from(error: ListError) -> Self {
        CommandError::new(ErrorCode::InvalidRequest, error.message())
    }
}

/// Reads a `.kpin` file for the entry points (a path from the system): at
/// most 2 MB, checked before reading, and UTF-8.
pub fn read_file(path: &std::path::Path) -> Result<String, ListError> {
    let size = std::fs::metadata(path).map_err(|_| ListError::Unreadable)?.len();
    if size > format::MAX_BYTES as u64 {
        return Err(ListError::TooBig);
    }
    let bytes = std::fs::read(path).map_err(|_| ListError::Unreadable)?;
    if bytes.len() > format::MAX_BYTES {
        return Err(ListError::TooBig);
    }
    String::from_utf8(bytes).map_err(|_| ListError::NotAList)
}

/// The list's own description of itself, cleaned and capped.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ListMeta {
    pub title: String,
    pub description: Option<String>,
    pub author_name: Option<String>,
    /// http(s) only; anything else is dropped.
    pub author_url: Option<String>,
    /// An SPDX id as the file gives it, e.g. `CC0-1.0`.
    pub license: Option<String>,
    pub language: Option<String>,
    /// `YYYY-MM-DD`.
    pub updated: Option<String>,
    pub homepage: Option<String>,
    /// The slug that marks the same list across updates.
    pub id: Option<String>,
    /// What wrote the file, for diagnostics only.
    pub generator: Option<String>,
    /// `MAJOR.MINOR` of the file.
    pub version: String,
}

/// A feed of the list not followed yet: a row of «Follow N feeds».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ListFeedEntry {
    /// The address to send back in `ListImportOptions::follow_feeds`.
    pub url: String,
    pub title: Option<String>,
    pub site: Option<String>,
    /// Shown only: feeds have no tags or collection.
    pub section: Option<String>,
}

/// A collection whose name is the list's title, case aside (Р-29).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct CollectionMatch {
    pub id: i64,
    pub name: String,
}

/// What importing the list would do (K1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ListPreview {
    pub meta: ListMeta,
    /// Where it came from: a file name or a host, as the interface gave it.
    pub source: String,
    /// Made in a newer Koona Pin (a newer MINOR): show what was skipped.
    pub newer: bool,
    /// Links and feeds that can be imported, repeats counted once.
    pub links: u32,
    pub feeds: u32,
    pub sections: u32,
    /// Links that are not in the library yet.
    pub new_links: u32,
    /// The same address is saved, out of the trash: left as it is, or given the list's tags.
    pub already_saved: u32,
    /// The same address is in the trash: it stays there.
    pub in_trash: u32,
    /// The same address (`url_key`) earlier in the file: merged into the first.
    pub repeated: u32,
    pub not_web: u32,
    pub invalid: u32,
    pub feeds_followed: u32,
    /// Fields this reader does not know, counted in a newer MINOR only.
    pub skipped_details: u32,
    /// Items of a type this reader does not know.
    pub skipped_items: u32,
    pub new_feeds: Vec<ListFeedEntry>,
    pub existing_collection: Option<CollectionMatch>,
}

/// The answer of `preview_list`: a preview, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum ListCheck {
    Ready { preview: ListPreview },
    NotAList,
    NeedsNewerApp,
    OtherApp { app: String },
    TooBig,
    Empty,
    Unreadable,
}

impl From<ListError> for ListCheck {
    fn from(error: ListError) -> Self {
        match error {
            ListError::NotAList => ListCheck::NotAList,
            ListError::NeedsNewerApp => ListCheck::NeedsNewerApp,
            ListError::OtherApp(app) => ListCheck::OtherApp { app },
            ListError::TooBig => ListCheck::TooBig,
            ListError::Empty => ListCheck::Empty,
            ListError::Unreadable => ListCheck::Unreadable,
        }
    }
}

/// «Put links into».
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ListCollection {
    /// A collection of this name; one with the same name, case aside, is reused.
    New { name: String },
    Existing { id: i64 },
    None,
}

/// «Links you already have».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExistingLinks {
    Leave,
    /// They get the list's tags; their collection never changes.
    AddTags,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
pub struct ListImportOptions {
    pub collection: ListCollection,
    /// «Keep new links in Inbox»: off, they count as sorted.
    pub to_inbox: bool,
    /// Sections become tags.
    pub sections_as_tags: bool,
    pub existing_links: ExistingLinks,
    /// The feeds to follow, from `ListPreview::new_feeds`; an address not in the list is ignored.
    pub follow_feeds: Vec<String>,
}

/// What an import did (K3, state 7).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ListImportReport {
    pub added: u32,
    pub already_saved: u32,
    pub in_trash: u32,
    pub repeated: u32,
    pub not_web: u32,
    pub invalid: u32,
    pub skipped_items: u32,
    pub feeds_followed: u32,
    pub feeds_already: u32,
    /// Where the new links went, for «Show collection»; none without a collection
    /// or when no new link needed the new one.
    pub collection_id: Option<i64>,
}

/// The list's preview (K1). Writes nothing.
#[tauri::command]
pub async fn preview_list(state: State<'_, Arc<DbState>>, text: String, source: String) -> Result<ListCheck, CommandError> {
    let parsed = tauri::async_runtime::spawn_blocking(move || format::parse(&text)).await.map_err(CommandError::internal)?;
    let list = match parsed {
        Ok(list) => list,
        Err(error) => return Ok(error.into()),
    };
    let preview = blocking(&state, move |conn| Ok(preview::preview(conn, &list, &source)?)).await?;
    Ok(ListCheck::Ready { preview })
}

/// Imports the list in one transaction off the main thread; the dialog
/// follows `import-progress`, as for a bookmarks file.
#[tauri::command]
pub async fn import_list(
    app: AppHandle,
    state: State<'_, Arc<DbState>>,
    text: String,
    options: ListImportOptions,
) -> Result<ListImportReport, CommandError> {
    if let ListCollection::New { name } = &options.collection {
        if name.trim().is_empty() {
            return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyCollectionName, "Enter a collection name"));
        }
    }
    let list = tauri::async_runtime::spawn_blocking(move || format::parse(&text)).await.map_err(CommandError::internal)??;
    let progress = app.clone();
    let applied = blocking(&state, move |conn| {
        Ok(apply::apply(conn, &list, &options, |done, total| {
            let _ = progress.emit("import-progress", ImportProgress { done: done as u32, total: total as u32 });
        })?)
    })
    .await?;
    let _ = app.emit("library-invalidated", ());
    if applied.report.feeds_followed > 0 {
        if let Some(feed_cache) = app.try_state::<Arc<cache::FeedCache>>() {
            let named = applied.named;
            cache::blocking(&feed_cache, move |conn| Ok(cache::name_feeds(conn, &named)?)).await?;
        }
        let mut list = blocking(&state, |conn| Ok(feeds::feeds(conn)?)).await?;
        if let Some(feed_cache) = app.try_state::<Arc<cache::FeedCache>>() {
            list = cache::blocking(&feed_cache, move |conn| {
                cache::merge_state(conn, &mut list, chrono::Utc::now())?;
                Ok(list)
            })
            .await?;
        }
        feeds::emit_changed(&app, list);
        feeds::schedule::fetch_soon(&app, None);
    }
    // The new bookmarks have only their addresses and the list's words:
    // their pages are read for pictures and icons in the background.
    if !applied.created.is_empty() {
        let (state, ids) = (state.inner().clone(), applied.created);
        let _ = tauri::async_runtime::spawn_blocking(move || refresh::start(app, state, refresh::Target::Ids(ids), true)).await;
    }
    Ok(applied.report)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rusqlite::Connection;

    /// An empty library at the current schema, without starter collections.
    pub(crate) fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        crate::db::register_functions(&c).unwrap();
        crate::migrations::migrate(&mut c, None).unwrap();
        c
    }

    #[test]
    fn read_file_caps_the_size_and_wants_utf8() {
        let dir = std::env::temp_dir().join(format!("kpin-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.kpin");
        std::fs::write(&good, include_str!("../../tests/fixtures/kpin/valid.kpin")).unwrap();
        assert!(format::parse(&read_file(&good).unwrap()).is_ok());
        let big = dir.join("big.kpin");
        std::fs::write(&big, vec![b' '; format::MAX_BYTES + 1]).unwrap();
        assert_eq!(read_file(&big), Err(ListError::TooBig));
        let latin = dir.join("latin.kpin");
        std::fs::write(&latin, [b'{', 0xe9, b'}']).unwrap();
        assert_eq!(read_file(&latin), Err(ListError::NotAList));
        assert_eq!(read_file(&dir.join("missing.kpin")), Err(ListError::Unreadable));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refusals_reach_the_interface_as_outcomes() {
        let json = |check: ListCheck| serde_json::to_value(check).unwrap();
        assert_eq!(json(ListError::OtherApp("note".into()).into()), serde_json::json!({ "outcome": "other_app", "app": "note" }));
        assert_eq!(json(ListError::NeedsNewerApp.into()), serde_json::json!({ "outcome": "needs_newer_app" }));
        let options: ListImportOptions = serde_json::from_value(serde_json::json!({
            "collection": { "kind": "new", "name": "Rust" },
            "to_inbox": false,
            "sections_as_tags": true,
            "existing_links": "add_tags",
            "follow_feeds": []
        }))
        .unwrap();
        assert_eq!(options.collection, ListCollection::New { name: "Rust".into() });
        let none: ListCollection = serde_json::from_value(serde_json::json!({ "kind": "none" })).unwrap();
        assert_eq!(none, ListCollection::None);
    }
}
