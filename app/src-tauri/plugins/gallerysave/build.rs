const COMMANDS: &[&str] = &["save_png", "share_png"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
