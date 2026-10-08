fn main() {
    // The icons are embedded at build time (EXE resource here, window and taskbar icon by
    // generate_context!); without this, replaced icons stay old until `cargo clean`.
    println!("cargo:rerun-if-changed=icons");
    feedback_url_from_dotenv();
    collation_version();
    tauri_build::build()
}

/// The version of the collation data the sort keys are made with (NP-114, `sorting.rs`): new
/// CLDR data may order some strings otherwise, and keys of two versions must not mix. Read from
/// Cargo.lock, so an update of the crate rewrites the keys without anyone remembering to.
fn collation_version() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    let mut package = "";
    let mut version = "unknown";
    for line in lock.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix("name = ") {
            package = name;
        } else if let (r#""icu_collator_data""#, Some(found)) = (package, line.strip_prefix("version = ")) {
            version = found.trim_matches('"');
            break;
        }
    }
    println!("cargo:rustc-env=KOONAPIN_COLLATION_DATA={version}");
}

/// The feedback address (`option_env!` in feedback.rs, NP-088) from `.env` in the repository
/// root when the environment does not set it, so `bun run tauri build`, `tauri dev` and
/// `cargo build` get it just like `bun run build:installer`. The environment wins.
fn feedback_url_from_dotenv() {
    const NAME: &str = "KOONAPIN_FEEDBACK_URL";
    println!("cargo:rerun-if-env-changed={NAME}");
    // Watched even while missing, so a new .env is noticed by the next build.
    println!("cargo:rerun-if-changed=../.env");
    if std::env::var_os(NAME).is_some() {
        return;
    }
    let Ok(text) = std::fs::read_to_string("../.env") else {
        return;
    };
    if let Some(value) = dotenv_value(&text, NAME) {
        println!("cargo:rustc-env={NAME}={value}");
    }
}

/// `KEY=VALUE` as process.loadEnvFile of the scripts reads it (checked on Node 26 and
/// Bun 1.4): comments, an optional `export `, quotes around the value, an unquoted value
/// ends at its first `#`, the last line of a name wins.
fn dotenv_value(text: &str, name: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (key, value) = line.split_once('=')?;
        if key.trim() != name {
            return None;
        }
        let value = value.trim();
        let quoted = value.len() >= 2
            && (value.starts_with('"') && value.ends_with('"')
                || value.starts_with('\'') && value.ends_with('\''));
        let value = if quoted {
            &value[1..value.len() - 1]
        } else {
            value.split('#').next().unwrap_or("").trim()
        };
        (!value.is_empty()).then(|| value.to_string())
    })
}
