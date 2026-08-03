//! The Tauri shell. One binary builds as a desktop window and as the Android
//! app; the plan's "desktop first" step is the same code pointed at localhost.

pub mod capture_save;
pub mod lc_client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        lc_client::lc_request,
        capture_save::save_png_bytes,
        ink_available,
    ]);

    // ML Kit + MediaStore gallery only exist on Android.
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_inkrecognition::init())
        .plugin(tauri_plugin_gallerysave::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running the whiteboard");
}

/// Whether on-device handwriting recognition exists on this platform.
#[tauri::command]
fn ink_available() -> bool {
    cfg!(target_os = "android")
}
