//! The Tauri shell. One binary builds as a desktop window and as the Android
//! app; the plan's "desktop first" step is the same code pointed at localhost.

pub mod lc_client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        lc_client::lc_request,
        ink_available,
    ]);

    // The ML Kit plugin only exists on Android; everywhere else the front end's
    // `NoopRecognizer` takes over and the app falls back to typed text.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_inkrecognition::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running the whiteboard");
}

/// Whether on-device handwriting recognition exists on this platform.
///
/// The front end asks the plugin directly; this command answers the simpler
/// question for the desktop build, where the plugin isn't registered at all.
#[tauri::command]
fn ink_available() -> bool {
    cfg!(target_os = "android")
}
