const COMMANDS: &[&str] = &["recognize", "is_available"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        // The Kotlin half lives beside this crate; Tauri wires it into the
        // generated Android project at build time.
        .android_path("android")
        .build();
}
