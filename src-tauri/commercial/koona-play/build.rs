// No command the page may call: the app's Rust side (billing.rs) runs the Kotlin commands itself, so
// the purchase secret and the tokens never pass through the page.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
