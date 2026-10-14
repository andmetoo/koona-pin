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
