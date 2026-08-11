//! The Tauri shell. One binary builds as a desktop window and as the Android
//! app; the plan's "desktop first" step is the same code pointed at localhost.

pub mod capture_save;
pub mod colorhunt;
pub mod lc_client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Google Search from a document footnote hands the query to whatever
        // browser the device already uses. Reading is a thing people do with
        // tabs open; an in-app webview would be a worse browser with none of
        // their logins, and would put the search result inside the annotation
        // surface it is supposed to be a detour from.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
        lc_client::lc_request,
        colorhunt::colorhunt_random,
        capture_save::save_png_bytes,
        capture_save::share_png_bytes,
        ink_available,
        set_gesture_exclusions,
    ]);

    // ML Kit, the MediaStore gallery and the system gesture strips only exist
    // on Android.
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_inkrecognition::init())
        .plugin(tauri_plugin_gallerysave::init())
        .plugin(tauri_plugin_gestureguard::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running the whiteboard");
}

/// Whether on-device handwriting recognition exists on this platform.
#[tauri::command]
fn ink_available() -> bool {
    cfg!(target_os = "android")
}

/// Ask Android to stop treating these rectangles as back-gesture strips.
///
/// A no-op everywhere else, and deliberately not an error there: the caller is
/// the board, which does not know or care what it is running on, and a rejected
/// promise on every desktop resize would be noise standing in for "there are no
/// gesture strips here".
#[tauri::command]
fn set_gesture_exclusions(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] rects: Vec<tauri_plugin_gestureguard::ExclusionRect>,
    #[allow(unused_variables)] density: f64,
) -> std::result::Result<u32, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_gestureguard::GestureGuardExt;
        let guard = app.gesture_guard().ok_or("gesture guard unavailable")?;
        return guard.set_exclusions(rects, density).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(0)
    }
}
