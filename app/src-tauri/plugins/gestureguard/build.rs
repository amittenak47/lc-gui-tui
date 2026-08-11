const COMMANDS: &[&str] = &["set_exclusions"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
