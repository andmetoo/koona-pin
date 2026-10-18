//! Writing a list: the file a builder writes ([`super::bundle`] builds the
//! bundle into it), the list's `id`, and «Save .kpin…», which checks the text
//! as a reader would and writes it through the system Save dialog.

use super::format::{self, ID_LEN};
use crate::{
    commands::{ExportOutcome, LastExport},
    error::CommandError,
};
use serde::Serialize;
use tauri::{AppHandle, State};

/// The version a builder writes.
pub const WRITER_VERSION: &str = "1.0";

/// A followed feed as the builder writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedRow {
    pub uid: String,
    pub url: String,
    /// The name the person sees: their own, else the feed's.
    pub title: Option<String>,
    pub site: Option<String>,
}

impl From<&crate::feeds::Feed> for FeedRow {
    fn from(feed: &crate::feeds::Feed) -> Self {
        FeedRow {
            uid: feed.uid.clone(),
            url: feed.url.clone(),
            title: feed.title.clone().or_else(|| feed.feed_title.clone()),
            site: feed.site_url.clone(),
        }
    }
}

/// The file a builder writes; [`super::bundle`] writes it too.
#[derive(Serialize)]
pub(super) struct ListFile {
    pub(super) format: &'static str,
    pub(super) app: &'static str,
    pub(super) kind: &'static str,
    pub(super) version: &'static str,
    pub(super) generator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id: Option<String>,
    pub(super) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) author: Option<Author>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) license: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) updated: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) sections: Vec<Section>,
    pub(super) items: Vec<Item>,
}

#[derive(Serialize)]
pub(super) struct Author {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) url: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Section {
    pub(super) name: String,
    pub(super) items: Vec<Item>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Item {
    Link {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tags: Vec<String>,
    },
    Feed {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        site: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

/// The list's `id`: lowercase ASCII letters and digits, anything else a
/// dash, at most 64 characters. A title in another script has none.
pub fn slug(raw: &str) -> Option<String> {
    let mut slug = String::new();
    for c in raw.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let capped: String = slug.chars().take(ID_LEN).collect();
    let capped = capped.trim_end_matches('-');
    (!capped.is_empty()).then(|| capped.to_owned())
}

/// The name Save offers: the list's id, else `list`, with `.kpin`.
pub fn file_name(id: &str) -> String {
    format!("{}.kpin", slug(id).unwrap_or_else(|| "list".to_owned()))
}

/// «Save .kpin…»: the text the preview shows, checked as a reader would
/// read it, through the system Save dialog, written as an export is.
#[tauri::command]
pub async fn save_list(app: AppHandle, last: State<'_, LastExport>, text: String, id: String) -> Result<ExportOutcome, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let checked = text.clone();
    let list = tauri::async_runtime::spawn_blocking(move || format::parse(&checked)).await.map_err(CommandError::internal)??;
    let count = (list.links.len() + list.feeds.len()) as u32;
    let dialog = app.dialog().file().set_file_name(file_name(&id)).add_filter("Koona list", &["kpin"]);
    let dialog = crate::commands::over_main_window(&app, dialog);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(CommandError::internal)?;
    let Some(picked) = picked else {
        return Ok(ExportOutcome::Cancelled);
    };
    let path = picked.into_path().map_err(CommandError::internal)?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let folder = path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let target = path.clone();
    let written = tauri::async_runtime::spawn_blocking(move || crate::export::write_atomically(&target, text.as_bytes()))
        .await
        .map_err(CommandError::internal)?;
    Ok(match written {
        Ok(()) => {
            *last.0.lock().map_err(CommandError::internal)? = Some(path);
            ExportOutcome::Saved { file_name, count }
        }
        Err(error) => ExportOutcome::Failed { file_name, folder, problem: crate::export::problem_of(&error), detail: error.to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_a_slug_of_the_title_and_names_the_file() {
        assert_eq!(slug("Rust blogs, worth following!").as_deref(), Some("rust-blogs-worth-following"));
        assert_eq!(slug("Блоги о Rust").as_deref(), Some("rust"));
        assert_eq!(slug("Блоги"), None);
        assert_eq!(slug(&"a".repeat(100)).map(|s| s.len()), Some(ID_LEN));
        assert_eq!(file_name("Rust blogs"), "rust-blogs.kpin");
        assert_eq!(file_name(""), "list.kpin");
    }
}
