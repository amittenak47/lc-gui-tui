const COMMANDS: &[&str] = &["set_exclusions", "set_immersive"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
