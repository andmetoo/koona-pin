fn main() {
    // The icons are embedded at build time (EXE resource here, window and taskbar icon by
    // generate_context!); without this, replaced icons stay old until `cargo clean`.
    println!("cargo:rerun-if-changed=icons");
    feedback_url_from_dotenv();
    tauri_build::build()
}

/// The feedback address (`option_env!` in feedback.rs, NP-088) from `.env` in the repository
/// root when the environment does not set it, so `npm run tauri build`, `tauri dev` and
/// `cargo build` get it just like `npm run build:installer`. The environment wins.
fn feedback_url_from_dotenv() {
    const NAME: &str = "NETAMIPIN_FEEDBACK_URL";
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

/// `KEY=VALUE` as node's process.loadEnvFile reads it: comments, an optional `export `,
/// quotes around the value, a ` # comment` after an unquoted one.
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
            value.split(" #").next().unwrap_or("").trim()
        };
        (!value.is_empty()).then(|| value.to_string())
    })
}
