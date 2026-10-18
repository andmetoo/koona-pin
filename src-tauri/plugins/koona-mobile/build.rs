// One command, the page's haptics (src/platform/haptics.ts), played by the Kotlin and Swift parts.
// The rest goes through the bridge script (src/bridge.js): the Kotlin and Swift parts call into
// the page, and the page reads what it needs synchronously from Android's JavaScript interface.
const COMMANDS: &[&str] = &["haptic"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
