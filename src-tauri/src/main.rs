// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = netamipin_lib::installer_step() {
        std::process::exit(code);
    }
    netamipin_lib::run();
}
