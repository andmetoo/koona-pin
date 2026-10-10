//! Test-only WKWebView automation, compiled out of ordinary builds.
//! An explicit config and an isolated data directory are required even in a test bundle.
use tauri::{plugin::TauriPlugin, Runtime};

#[tauri::command]
pub fn macos_smoke_report(result: serde_json::Value) -> Result<(), String> {
    let file = std::env::var_os("KOONAPIN_MACOS_SMOKE_REPORT").ok_or("Missing report path")?;
    let bytes = serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?;
    let file = std::path::PathBuf::from(file);
    // The runner must never see an unfinished JSON document.
    let pending = file.with_extension("pending");
    std::fs::write(&pending, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(pending, file).map_err(|e| e.to_string())
}

fn plugin<R: Runtime>(config: serde_json::Value) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("macos-smoke")
        .js_init_script(format!(
            "window.__MACOS_SMOKE_CONFIG__ = {};\n{}",
            config,
            include_str!("../../tests/macos/native-smoke.js")
        ))
        .build()
}

pub fn install<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let Some(file) = std::env::var_os("KOONAPIN_MACOS_SMOKE_CONFIG") else {
        return builder;
    };
    assert!(
        std::env::var_os(crate::db::DATA_DIR_ENV).is_some(),
        "Smoke tests need isolated data"
    );
    let config = serde_json::from_slice(&std::fs::read(file).expect("Read smoke config"))
        .expect("Parse smoke config");
    builder.plugin(plugin(config))
}
