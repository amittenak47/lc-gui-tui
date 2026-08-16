//! The Tauri shell. One binary builds as a desktop window and as the Android
//! app; the harness router runs in-process — no loopback TCP server.

pub mod capture_save;
pub mod colorhunt;
pub mod lc_client;
pub mod web_capture;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Google Search from a document footnote hands the query to whatever
        // browser the device already uses. Reading is a thing people do with
        // tabs open; an in-app webview would be a worse browser with none of
        // their logins, and would put the search result inside the annotation
        // surface it is supposed to be a detour from.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            match harness::config::Config::load() {
                Ok(cfg) => {
                    let state = harness::serve::new_state(cfg);
                    app.manage(state);
                    app.manage(lc_client::CoachHub::new());
                }
                Err(err) => {
                    eprintln!("cannot load config for embedded router: {err:#}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
        lc_client::lc_dispatch,
        lc_client::lc_coach_connect,
        lc_client::lc_coach_send,
        lc_client::lc_coach_disconnect,
        lc_client::fetch_html,
        web_capture::webview_eval_json,
        colorhunt::colorhunt_random,
        capture_save::save_png_bytes,
        capture_save::share_png_bytes,
        ink_available,
        set_gesture_exclusions,
        set_drawing_immersive,
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

#[cfg(target_os = "android")]
use tauri_plugin_gestureguard::ExclusionRect;
#[cfg(not(target_os = "android"))]
type ExclusionRect = serde_json::Value;

/// Ask Android to stop treating these rectangles as back-gesture strips.
///
/// A no-op everywhere else, and deliberately not an error there: the caller is
/// the board, which does not know or care what it is running on, and a rejected
/// promise on every desktop resize would be noise standing in for "there are no
/// gesture strips here".
#[tauri::command]
fn set_gesture_exclusions(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] rects: Vec<ExclusionRect>,
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

/// Sticky-immersive navigation bar while a drawing tool is up.
///
/// Home has no exclusion API. Hiding the bar with swipe-to-show is how a
/// writing surface stops the Home gesture eating the first stroke on the
/// bottom edge, without trapping the user in the app. A no-op off Android.
#[tauri::command]
fn set_drawing_immersive(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] enabled: bool,
) -> std::result::Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_gestureguard::GestureGuardExt;
        let guard = app.gesture_guard().ok_or("gesture guard unavailable")?;
        return guard.set_immersive(enabled).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}
