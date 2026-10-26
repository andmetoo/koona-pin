// No command the page may call: the app's Rust side (billing/appstore.rs) runs the Swift commands
// itself, so the purchase secret and the signed transactions never pass through the page.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
