// Keep the console window off the release build on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    whiteboard_lib::run();
}
