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

/// Names Windows keeps for devices, whatever the extension.
const RESERVED: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Whether Windows takes a file whose name before its first dot is `stem`
/// for a device, trailing spaces dropped as Windows drops them: `con`,
/// `prn`, `aux`, `nul`, or `com`/`lpt` with a digit or a superscript ¹ ² ³,
/// in any case.
fn is_device(stem: &str) -> bool {
    let lower = stem.trim_end_matches(' ').to_lowercase();
    if RESERVED.contains(&lower.as_str()) {
        return true;
    }
    let chars: Vec<char> = lower.chars().collect();
    match chars.as_slice() {
        ['c', 'o', 'm', n] | ['l', 'p', 't', n] => n.is_ascii_digit() || "¹²³".contains(*n),
        _ => false,
    }
}

/// An invisible format character (Unicode Cf) that may hide or reorder what
/// a name shows: zero-width ones, bidi marks, embeddings, overrides and
/// isolates, word joiners and invisible operators, the BOM.
fn is_format(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// The file name the app suggests (`listText.ts` makes it from the title),
/// made safe on every system: no `/ \ : * ? " < > |`, control or invisible
/// format characters (`is_format`), no trailing dots or spaces, at most 64 characters, a device
/// name of Windows given `-list` before its first dot (`con.backup` →
/// `con-list.backup`), else `list`; always with `.kpin`, in any case.
pub fn safe_file_name(name: &str) -> String {
    let cut = name.len().checked_sub(5).filter(|&at| name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(".kpin"));
    let base = cut.map_or(name, |at| &name[..at]);
    let kept: String = base.chars().filter(|c| !c.is_control() && !is_format(*c) && !r#"/\:*?"<>|"#.contains(*c)).collect();
    let capped: String = kept.trim_start().chars().take(ID_LEN).collect();
    let mut base = capped.trim_end_matches(['.', ' ']).to_owned();
    if base.is_empty() {
        base = "list".to_owned();
    }
    let stem = &base[..base.find('.').unwrap_or(base.len())];
    if is_device(stem) {
        let at = stem.trim_end_matches(' ').len();
        base.insert_str(at, "-list");
        // Still at most `ID_LEN`: what is cut is past the stem and its `-list`.
        let capped: String = base.chars().take(ID_LEN).collect();
        base = capped.trim_end_matches(['.', ' ']).to_owned();
    }
    format!("{base}.kpin")
}

/// «Save .kpin…»: the text the preview shows, checked as a reader would
/// read it, through the system Save dialog, written as an export is. The
/// `name` the app suggests names the file in any script; without it, `id`.
#[tauri::command]
pub async fn save_list(
    app: AppHandle,
    last: State<'_, LastExport>,
    text: String,
    id: String,
    name: Option<String>,
) -> Result<ExportOutcome, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let checked = text.clone();
    let list = tauri::async_runtime::spawn_blocking(move || format::parse(&checked)).await.map_err(CommandError::internal)??;
    let count = (list.links.len() + list.feeds.len()) as u32;
    let dialog = app.dialog().file().set_file_name(name.as_deref().map_or_else(|| file_name(&id), safe_file_name)).add_filter("Koona list", &["kpin"]);
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

    #[test]
    fn the_suggested_file_name_is_kept_in_any_script_and_made_safe() {
        assert_eq!(safe_file_name("мои-ссылки.kpin"), "мои-ссылки.kpin");
        assert_eq!(safe_file_name("मेरी-सूची"), "मेरी-सूची.kpin");
        assert_eq!(safe_file_name("a/b\\c:d*e?f\"g<h>i|j\u{7}k\n.kpin"), "abcdefghijk.kpin");
        assert_eq!(safe_file_name(" notes. . "), "notes.kpin");
        assert_eq!(safe_file_name("..."), "list.kpin");
        assert_eq!(safe_file_name(""), "list.kpin");
        let long = safe_file_name(&"я".repeat(100));
        assert_eq!(long.trim_end_matches(".kpin").chars().count(), ID_LEN);
        // The id in the file stays ASCII.
        assert_eq!(slug("Мои ссылки"), None);
    }

    #[test]
    fn a_device_name_of_windows_gets_a_suffix() {
        for name in ["con", "PRN", "Aux", "nul.kpin", "com1", "COM0", "lpt9"] {
            let safe = safe_file_name(name);
            assert!(safe.ends_with("-list.kpin"), "{name} → {safe}");
        }
        assert_eq!(safe_file_name("CON"), "CON-list.kpin");
        for name in ["console", "com", "com10", "lptx", "nulls", "com⁴", "lpt¹¹", "backup.con"] {
            assert_eq!(safe_file_name(name), format!("{name}.kpin"));
        }
    }

    #[test]
    fn a_device_name_before_the_first_dot_or_with_a_superscript_gets_a_suffix() {
        assert_eq!(safe_file_name("con.backup"), "con-list.backup.kpin");
        assert_eq!(safe_file_name("NUL.tar.gz"), "NUL-list.tar.gz.kpin");
        assert_eq!(safe_file_name("Aux .txt"), "Aux-list .txt.kpin");
        assert_eq!(safe_file_name("COM¹"), "COM¹-list.kpin");
        assert_eq!(safe_file_name("lpt³.old"), "lpt³-list.old.kpin");
        assert_eq!(safe_file_name("com²"), "com²-list.kpin");
        // The suffix does not push the name past the cap.
        let long = safe_file_name(&format!("con.{}", "x".repeat(100)));
        assert!(long.starts_with("con-list."), "{long}");
        assert_eq!(long.trim_end_matches(".kpin").chars().count(), ID_LEN);
        let dotted = safe_file_name(&format!("con.{}.y", "x".repeat(ID_LEN - 9)));
        assert_eq!(dotted, format!("con-list.{}.kpin", "x".repeat(ID_LEN - 9)));
    }

    #[test]
    fn the_kpin_suffix_is_dropped_in_any_case() {
        assert_eq!(safe_file_name("Notes.KPIN"), "Notes.kpin");
        assert_eq!(safe_file_name("notes.Kpin"), "notes.kpin");
        assert_eq!(safe_file_name("con.KPIN"), "con-list.kpin");
        assert_eq!(safe_file_name("я.kpin"), "я.kpin");
        assert_eq!(safe_file_name("kpin"), "kpin.kpin");
    }

    #[test]
    fn invisible_format_characters_leave_the_suggested_file_name() {
        // A right-to-left override would show `evil\u{202E}nipk.exe` as `evilexe.kpin`.
        assert_eq!(safe_file_name("evil\u{202E}nipk.exe"), "evilnipk.exe.kpin");
        assert_eq!(safe_file_name("\u{FEFF}notes\u{200B}"), "notes.kpin");
        assert_eq!(safe_file_name("a\u{200C}b\u{200D}c\u{200E}d\u{200F}e\u{061C}f"), "abcdef.kpin");
        assert_eq!(safe_file_name("a\u{202A}b\u{202B}c\u{202C}d\u{202D}e"), "abcde.kpin");
        assert_eq!(safe_file_name("a\u{2060}b\u{2061}c\u{2062}d\u{2063}e\u{2064}f"), "abcdef.kpin");
        assert_eq!(safe_file_name("a\u{2066}b\u{2067}c\u{2068}d\u{2069}e"), "abcde.kpin");
        // Nothing but them, or them past a trailing dot or a device name: as if they were not there.
        assert_eq!(safe_file_name("\u{200B}\u{2066}\u{FEFF}"), "list.kpin");
        assert_eq!(safe_file_name("notes.\u{200B}"), "notes.kpin");
        assert_eq!(safe_file_name("con\u{200B}"), "con-list.kpin");
        // Other characters around them stay.
        assert_eq!(safe_file_name("👩\u{200D}💻 notes"), "👩💻 notes.kpin");
    }
}
