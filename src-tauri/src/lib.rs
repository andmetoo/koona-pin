pub mod backup;
pub mod billing;
pub mod commercial;
pub mod browsers;
pub mod capabilities;
pub mod capture;
pub mod charset;
pub mod capture_channel;
pub mod channel;
pub mod commands;
pub mod db;
pub mod dedupe;
#[cfg(desktop)]
pub mod desktop;
pub mod error;
pub mod export;
pub mod feedback;
pub mod feeds;
pub mod hash;
pub mod import;
pub mod ipc;
pub mod journal;
pub mod library;
pub mod library_state;
pub mod lifecycle;
pub mod linkcheck;
pub mod lists;
pub mod metadata;
#[cfg(mobile)]
pub mod mobile;
pub mod migrations;
pub mod net_guard;
pub mod offline;
pub mod open_requests;
pub mod position_keys;
pub mod quick_search;
pub mod reader;
pub mod reading;
pub mod refresh;
pub mod restore;
pub mod secrets;
pub mod share_queue;
#[cfg(all(desktop, not(feature = "public-release")))]
pub mod shot_previews;
#[cfg(all(unix, desktop, not(feature = "public-release")))]
pub mod shots;
pub mod sorting;
pub mod sync_library;
#[doc(hidden)]
pub mod test_libraries;
pub mod thumbs;
pub mod trash;

// What only a desktop or only a phone has (NP-072a): both export the same functions for `run()`.
#[cfg(desktop)]
use desktop as platform;
#[cfg(mobile)]
use mobile as platform;

use std::sync::Arc;
use tauri::Manager;

#[cfg(desktop)]
pub use desktop::installer_step;

pub(crate) fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show(&window);
    }
}

pub(crate) fn show(window: &tauri::WebviewWindow) {
    // Off since desktop::hide.
    #[cfg(windows)]
    desktop::transitions(&window.as_ref().window(), true);
    let _ = window.show();
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    if platform::hand_over(&context) {
        std::process::exit(0);
    }
    let channel_state = Arc::new(capture_channel::ChannelState::default());
    platform::plugins(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        // File dialogs of export and backups, called from Rust only (NP-032, NP-034): no permission for the interface.
        .plugin(tauri_plugin_dialog::init())
        // What this build can do, read by the page before its first render (NP-072a).
        .plugin(capabilities::plugin())
        // Previews and icons from the cache beside the library (NP-146), off the main thread.
        .register_asynchronous_uri_scheme_protocol(thumbs::SCHEME, thumbs::protocol)
        .manage(channel_state.clone())
        .manage(open_requests::PendingOpens::default())
        .manage(commands::LastExport::default())
        .manage(commands::PickedBackup::default())
        .manage(commands::PickedImportFile::default())
        .manage(linkcheck::Checker::default())
        .manage(refresh::Refresher::default())
        .manage(lifecycle::Lifecycle::default())
        .setup(move |app| {
            platform::prepare(app);
            // Before anything that reads or writes beside the library.
            app.manage(Arc::new(library_state::Library::new(platform::library_paths(app)?)));
            // The iPhone's Keychain takes over the account and sync files before they are read (NP-153).
            secrets::prepare(&app.state::<Arc<library_state::Library>>().paths.folder());
            // Before the library: its first daily copy goes to a Supporter's folder too, which
            // needs both states managed.
            billing::start(app.handle());
            commercial::backup_folder::start(app.handle());
            // After billing: it waits for the plan and the library, woken by their events.
            commercial::sync::start(app.handle());
            library_state::start(app.handle().clone());
            platform::setup(app, channel_state)?;
            // The feeds' refresh loop (NP-129): it waits for the library and the feed cache.
            feeds::schedule::start(app.handle());
            Ok(())
        })
        .on_window_event(platform::on_window_event)
        .invoke_handler(ipc::handler())
        .build(context)
        .expect("error while running Koona Pin")
        .run(|app, event| platform::on_run_event(app, &event));
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;

    pub(crate) fn memory_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }
}

#[cfg(test)]
mod english_source {
    //! Rust speaks English; what people read comes from `src/locales` (NP-085,
    //! Р-8). A Russian string in the app's code would show up in an English
    //! interface, so none may come back: test modules and comments aside, no
    //! string or character literal holds Cyrillic. The search folds `ё` to `е`,
    //! so those two letters are allowed.

    use std::fs;
    use std::path::{Path, PathBuf};

    const FOLDED: [char; 4] = ['ё', 'Ё', 'е', 'Е'];
    /// Russian words of the test libraries: data, not text for people.
    const DATA: [&str; 1] = ["test_libraries.rs"];

    fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, found);
            } else if path.extension().is_some_and(|e| e == "rs") {
                found.push(path);
            }
        }
    }

    /// String and character literals outside comments and `#[cfg(test)]` items,
    /// with their line numbers.
    fn literals(code: &str) -> Vec<(usize, String)> {
        let chars: Vec<char> = code.chars().collect();
        let mut found = Vec::new();
        let (mut i, mut line) = (0, 1);
        // Inside a `#[cfg(test)]` item: the depth of braces it opened.
        let (mut skipping, mut depth) = (false, 0usize);
        let at = |i: usize, text: &str| {
            text.chars()
                .enumerate()
                .all(|(k, c)| chars.get(i + k) == Some(&c))
        };
        while i < chars.len() {
            let c = chars[i];
            if c == '\n' {
                line += 1;
            }
            if at(i, "//") {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if at(i, "/*") {
                while i < chars.len() && !at(i, "*/") {
                    line += (chars[i] == '\n') as usize;
                    i += 1;
                }
                i += 2;
                continue;
            }
            if at(i, "#[cfg(test)]") {
                skipping = true;
                i += "#[cfg(test)]".len();
                continue;
            }
            let ident_before = i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_');
            // Raw strings: r"…", r#"…"#, br"…".
            if c == 'r' && !ident_before || c == 'b' && chars.get(i + 1) == Some(&'r') && !ident_before
            {
                let mut j = i + if c == 'b' { 2 } else { 1 };
                let hashes = chars[j..].iter().take_while(|&&h| h == '#').count();
                j += hashes;
                if chars.get(j) == Some(&'"') {
                    let close: String = std::iter::once('"')
                        .chain(std::iter::repeat('#').take(hashes))
                        .collect();
                    let (start, mut text) = (line, String::new());
                    j += 1;
                    while j < chars.len() && !at(j, &close) {
                        line += (chars[j] == '\n') as usize;
                        text.push(chars[j]);
                        j += 1;
                    }
                    if !skipping {
                        found.push((start, text));
                    }
                    i = j + close.chars().count();
                    continue;
                }
            }
            if c == '"' {
                let (start, mut text) = (line, String::new());
                let mut j = i + 1;
                while j < chars.len() && chars[j] != '"' {
                    if chars[j] == '\\' {
                        text.push(chars[j]);
                        j += 1;
                    }
                    line += (chars[j] == '\n') as usize;
                    text.push(chars[j]);
                    j += 1;
                }
                if !skipping {
                    found.push((start, text));
                }
                i = j + 1;
                continue;
            }
            if c == '\'' {
                // A character literal, or a lifetime: 'a, 'static.
                let end = if chars.get(i + 1) == Some(&'\\') {
                    chars[i + 2..]
                        .iter()
                        .position(|&q| q == '\'')
                        .map(|p| i + 2 + p)
                } else if chars.get(i + 2) == Some(&'\'') {
                    Some(i + 2)
                } else {
                    None
                };
                if let Some(end) = end {
                    if !skipping {
                        found.push((line, chars[i + 1..end].iter().collect()));
                    }
                    i = end + 1;
                    continue;
                }
            }
            if skipping {
                if c == '{' {
                    depth += 1;
                } else if c == '}' {
                    depth -= 1;
                    if depth == 0 {
                        skipping = false;
                    }
                } else if c == ';' && depth == 0 {
                    skipping = false;
                }
            }
            i += 1;
        }
        found
    }

    fn cyrillic(text: &str) -> bool {
        text.chars()
            .any(|c| ('\u{0400}'..='\u{04FF}').contains(&c) && !FOLDED.contains(&c))
    }

    #[test]
    fn the_app_has_no_russian_strings() {
        // The app and the commercial crates beside it (the sync engine, Р-68).
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), &mut files);
        sources(&root.join("commercial"), &mut files);
        assert!(files.len() > 10, "the sources are where they were");
        let mut russian = Vec::new();
        for file in files {
            let name = file.file_name().unwrap().to_string_lossy().to_string();
            if DATA.contains(&name.as_str()) {
                continue;
            }
            for (line, text) in literals(&fs::read_to_string(&file).unwrap()) {
                if cyrillic(&text) {
                    russian.push(format!(
                        "{}:{line}: {text}",
                        file.strip_prefix(&root).unwrap().display()
                    ));
                }
            }
        }
        assert!(
            russian.is_empty(),
            "Russian text in Rust; move it to src/locales:\n{}",
            russian.join("\n")
        );
    }

    #[test]
    fn the_scanner_sees_strings_and_skips_tests_and_comments() {
        let code = r##"
        // «Выйти» in a comment
        /// «Открыть» in a doc comment
        fn f<'a>(x: &'a str) -> char { let _ = "Выйти"; let _ = r#"Тест"#; 'ё' }
        #[cfg(test)]
        mod tests {
            fn g() { let _ = "Проверка {"; }
        }
        fn h() { let _ = "after"; }
    "##;
        let found: Vec<String> = literals(code).into_iter().map(|(_, text)| text).collect();
        assert_eq!(found, ["Выйти", "Тест", "ё", "after"]);
        assert!(cyrillic("Выйти") && !cyrillic("ё е") && !cyrillic("Quit"));
    }
}
