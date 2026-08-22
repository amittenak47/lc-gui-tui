/// The Kotlin side's command names, which are also the permission names.
///
/// `eval` is the one that is not about the pane: routing `webview_eval_json`
/// through it is what gives the tablet page capture and Freeze, not only live
/// browsing.
const COMMANDS: &[&str] = &["create", "place", "show", "close", "exists", "eval"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
