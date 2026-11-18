//! Tests only: reading the public conformance suite of `.kpin`
//! (`docs/kpin/conformance`, CC0, its README says how) for the reader's
//! tests (`format.rs`) and the one-click link's (`open_requests.rs`).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The suite's folder.
pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/kpin/conformance")
}

/// A file of the suite, by its path in the suite.
pub fn text(name: &str) -> String {
    std::fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// The `vectors` of one of the suite's vector files.
pub fn vectors(name: &str) -> Vec<Value> {
    let doc: Value = serde_json::from_str(&text(name)).unwrap();
    doc["vectors"].as_array().unwrap_or_else(|| panic!("{name}: no vectors")).clone()
}

/// The files of `lists/`, as a case names them (`lists/<name>.kpin`).
pub fn list_files() -> Vec<String> {
    let entries = std::fs::read_dir(dir().join("lists")).unwrap();
    let names = entries.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned());
    names.filter(|name| name.to_ascii_lowercase().ends_with(".kpin")).map(|name| format!("lists/{name}")).collect()
}

/// A vector's text grown by its `pad`: `with` appended until it is `to_bytes` bytes in UTF-8.
pub fn padded(text: &str, pad: &Value) -> String {
    let mut text = text.to_owned();
    if let (Some(with), Some(to)) = (pad["with"].as_str(), pad["to_bytes"].as_u64()) {
        while text.len() < to as usize {
            text.push_str(with);
        }
    }
    text
}

/// A case's file: as it is, or made from another by its `generate`.
pub fn case_text(case: &Value) -> String {
    if let Some(file) = case["file"].as_str() {
        return text(file);
    }
    let generate = &case["generate"];
    let base = text(generate["from"].as_str().expect("a file or a generate.from"));
    if let Some(bytes) = generate["pad_to_bytes"].as_u64() {
        return padded(&base, &json!({ "with": " ", "to_bytes": bytes }));
    }
    let mut list: Value = serde_json::from_str(&base).unwrap();
    let root = list.as_object_mut().unwrap();
    for key in generate["remove"].as_array().into_iter().flatten() {
        root.remove(key.as_str().unwrap());
    }
    for (key, value) in generate["set"].as_object().into_iter().flatten() {
        root.insert(key.clone(), value.clone());
    }
    for i in 0..generate["add_links"].as_u64().unwrap_or(0) {
        let items = root.entry("items").or_insert(json!([])).as_array_mut().unwrap();
        items.push(json!({ "type": "link", "url": format!("https://example.com/added/{i}") }));
    }
    for i in 0..generate["add_sections"].as_u64().unwrap_or(0) {
        let sections = root.entry("sections").or_insert(json!([])).as_array_mut().unwrap();
        sections.push(json!({ "name": format!("Added {i}"), "items": [{ "type": "link", "url": format!("https://example.com/section/{i}") }] }));
    }
    serde_json::to_string_pretty(&list).unwrap()
}
