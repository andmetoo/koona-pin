fn main() {
    // The icons are embedded at build time (EXE resource here, window and taskbar icon by
    // generate_context!); without this, replaced icons stay old until `cargo clean`.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
