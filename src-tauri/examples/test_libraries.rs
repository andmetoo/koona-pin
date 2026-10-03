//! Builds test libraries without personal data (NP-005).
//!
//! cargo run --example test_libraries --manifest-path src-tauri/Cargo.toml -- [output]
//!
//! The output folder (default `.test-data/libraries`) is outside version control.
//! The libraries themselves are described in `src/test_libraries.rs`.

use std::path::PathBuf;

fn main() {
    let output = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.test-data/libraries")
        });
    for line in netamipin_lib::test_libraries::build_all(&output) {
        println!("{line}");
    }
}
