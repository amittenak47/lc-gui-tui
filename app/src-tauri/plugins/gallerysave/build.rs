const COMMANDS: &[&str] = &["save_png", "share_png", "pick_folder"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
