// No commands: the page talks to the plugin only through its bridge script (src/bridge.js), and
// the Kotlin and Swift parts call into the page.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
