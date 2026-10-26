// No command the page may call: the app's Rust side asks the Kotlin or Swift side for the queue folder once.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios").build();
}
