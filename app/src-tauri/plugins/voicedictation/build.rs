const COMMANDS: &[&str] = &[
    "is_available",
    "start",
    "stop",
    "record_start",
    "record_stop",
    "record_cancel",
    "cancel",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
