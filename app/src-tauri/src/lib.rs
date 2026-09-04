//! The Tauri shell. One binary builds as a desktop window and as the Android
//! app; the harness router runs in-process — no loopback TCP server.

pub mod capture_save;
pub mod colorhunt;
pub mod dlc;
pub mod lc_client;
pub mod lc_routes;
pub mod web_capture;
#[cfg(feature = "leetcode")]
pub mod seed;

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
            // Android reaches `config_dir` through the XDG rules, which resolve
            // against `$HOME` — and an Android app process has none. Left alone
            // the lookup fails, config never loads, and the whole router goes
            // with it. Tauri knows where this app may write; say so first.
            #[cfg(target_os = "android")]
            match app.path().app_config_dir() {
                Ok(dir) => harness::config::set_config_dir(dir),
                Err(err) => eprintln!("android config dir: {err}"),
            }

            // A config that will not load is a reason to start on defaults, not
            // a reason to start with no router at all. Skipping `.manage` left
            // every `lc_*` command answering with Tauri's generic "state not
            // managed for field `state`", which names the wrong thing in the
            // one place the reader would look for the right one. Carry the real
            // cause instead and let the UI say it.
            let loaded = harness::config::Config::load();
            let boot_error = loaded.as_ref().err().map(|err| format!("{err:#}"));
            if let Some(err) = &boot_error {
                eprintln!("cannot load config for embedded router: {err}");
            }
            let cfg = loaded.unwrap_or_default();

            #[cfg(feature = "leetcode")]
            let cfg = {
                let mut cfg = cfg;
                if let Err(err) = seed::ensure_corpus_root(&mut cfg, app) {
                    eprintln!("corpus root: {err}");
                }
                cfg
            };
            #[allow(unused_mut)]
            let mut cfg = cfg;
            #[cfg(not(target_os = "android"))]
            if let Err(err) = cfg.ensure_serve_token() {
                eprintln!("pad-sync token: {err:#}");
            }
            let gui_state = harness::serve::new_state(cfg.clone());
            #[cfg(not(target_os = "android"))]
            {
                let port = cfg.serve.port;
                let token = cfg.serve.token.clone();
                let lan_state = harness::serve::new_state_with_token(cfg, token);
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = harness::serve::listen_lan(lan_state, port).await {
                        eprintln!("pad-sync listener: {err:#}");
                    }
                });
            }
            app.manage(gui_state);
            #[cfg(target_os = "android")]
            let _ = cfg;
            app.manage(lc_client::CoachHub::new());
            app.manage(dlc::DlcHub::new());
            app.manage(BootNotice(boot_error));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
        lc_client::lc_dispatch,
        lc_client::lc_coach_connect,
        lc_client::lc_coach_send,
        lc_client::lc_coach_disconnect,
        lc_client::fetch_html,
        lc_routes::lc_health,
        lc_routes::lc_list_problems,
        lc_routes::lc_list_tags,
        lc_routes::lc_list_datasets,
        lc_routes::lc_random_problem,
        lc_routes::lc_get_session,
        lc_routes::lc_reset_session,
        lc_routes::lc_enqueue_session,
        lc_routes::lc_random_session,
        lc_routes::lc_get_config,
        lc_routes::lc_put_config,
        lc_routes::lc_llm_status,
        lc_routes::lc_llm_models,
        lc_routes::lc_llm_start,
        lc_routes::lc_llm_stop,
        lc_routes::lc_get_problem,
        lc_routes::lc_adjacent_problem,
        lc_routes::lc_load_problem,
        lc_routes::lc_workspace_meta,
        lc_routes::lc_run_tests,
        lc_routes::lc_open_workspace,
        lc_routes::lc_get_solution,
        lc_routes::lc_put_solution,
        lc_routes::lc_get_board,
        lc_routes::lc_put_board,
        lc_routes::lc_get_agent_session,
        lc_routes::lc_put_agent_session,
        lc_routes::lc_finish_attempt,
        lc_routes::lc_coach_capabilities,
        lc_routes::lc_coach_review,
        lc_routes::lc_coach_ask,
        lc_routes::lc_coach_viz,
        lc_routes::lc_coach_draw_review,
        lc_routes::lc_coach_reveal,
        lc_routes::lc_coach_lazy,
        lc_routes::lc_coach_scaffold,
        lc_routes::lc_docs_get_index,
        lc_routes::lc_docs_clear_local_index,
        lc_routes::lc_docs_put_index,
        lc_routes::lc_docs_embed,
        lc_routes::lc_docs_retrieve,
        lc_routes::lc_docs_get_bytes,
        lc_routes::lc_docs_put_bytes,
        lc_routes::lc_get_ink_pages,
        lc_routes::lc_get_ink_page,
        lc_routes::lc_put_ink_page,
        lc_routes::lc_put_edges,
        lc_routes::lc_tombstone_edge,
        lc_routes::lc_docs_retrieve_library,
        lc_routes::lc_docs_get_chunks,
        lc_routes::lc_docs_put_chunks,
        lc_routes::lc_docs_list_chunk_digests,
        lc_routes::lc_list_whiteboard,
        lc_routes::lc_archive_whiteboard,
        lc_routes::lc_put_whiteboard,
        lc_routes::lc_tombstone_whiteboard,
        lc_routes::lc_restore_whiteboard,
        lc_routes::lc_list_annotate,
        lc_routes::lc_archive_annotate,
        lc_routes::lc_put_annotate,
        lc_routes::lc_tombstone_annotate,
        lc_routes::lc_restore_annotate,
        lc_routes::lc_get_problem_pad,
        lc_routes::lc_put_problem,
        lc_routes::lc_tombstone_problem,
        lc_routes::lc_put_snapshot,
        lc_routes::lc_get_snapshots,
        lc_routes::lc_pads_sync,
        lc_routes::lc_list_devices,
        lc_routes::lc_get_device_prefs,
        lc_routes::lc_put_device_prefs,
        lc_routes::lc_clone_device_prefs,
        dlc::lc_dataset_dlc_status,
        dlc::lc_dataset_dlc_install,
        dlc::lc_dataset_dlc_remove,
        web_capture::webview_eval_json,
        colorhunt::colorhunt_random,
        capture_save::save_png_bytes,
        capture_save::share_png_bytes,
        ink_available,
        boot_notice,
        lan_base_url,
        set_gesture_exclusions,
        set_drawing_immersive,
        get_system_insets,
        live_webview_create,
        live_webview_place,
        live_webview_show,
        live_webview_close,
        live_webview_exists,
    ]);

    // ML Kit, the MediaStore gallery, the system gesture strips and the child
    // web view wry declines to make only exist on Android.
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_inkrecognition::init())
        .plugin(tauri_plugin_gallerysave::init())
        .plugin(tauri_plugin_gestureguard::init())
        .plugin(tauri_plugin_livewebview::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running the whiteboard");
}

/// Whether on-device handwriting recognition exists on this platform.
#[tauri::command]
fn ink_available() -> bool {
    cfg!(target_os = "android")
}

/// Why config did not load, when it did not.
///
/// `None` on a normal start. It matters most at the moment someone opens
/// Settings on an app that fell back to defaults: pressing Save there would
/// write those defaults over the file that failed to parse.
pub struct BootNotice(pub Option<String>);

#[tauri::command]
fn boot_notice(state: tauri::State<'_, BootNotice>) -> Option<String> {
    state.0.clone()
}

/// The address a tablet should type to reach this PC's pad hub.
///
/// The listener binds `0.0.0.0`, so the app knows its port but not which of the
/// machine's addresses a tablet can reach — and leaving someone to find their
/// own LAN address is most of why a device ends up unpaired. Connecting a UDP
/// socket sends no packets: it only asks the OS which interface it would route
/// from, and that interface's local address is the reachable one. `None` on
/// Android, which is the side doing the typing.
#[tauri::command]
fn lan_base_url(port: u16) -> Option<String> {
    if cfg!(target_os = "android") {
        return None;
    }
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // TEST-NET-3: reserved for documentation and never routed anywhere.
    socket.connect("203.0.113.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    Some(format!("http://{ip}:{port}"))
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

#[cfg(target_os = "android")]
use tauri_plugin_gestureguard::SystemInsets;
#[cfg(not(target_os = "android"))]
#[derive(serde::Serialize)]
struct SystemInsets {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// How far the WebView is covered by the Android status / caption / nav bars.
///
/// CSS `env(safe-area-inset-top)` is often 0 here even when the clock is drawn
/// on the in-app header. A no-op with zeros off Android.
#[tauri::command]
fn get_system_insets(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] density: f64,
) -> std::result::Result<SystemInsets, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_gestureguard::GestureGuardExt;
        let guard = app.gesture_guard().ok_or("gesture guard unavailable")?;
        return guard.get_insets(density).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(SystemInsets {
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
            left: 0.0,
        })
    }
}

#[cfg(target_os = "android")]
use tauri_plugin_livewebview::LiveRect;
#[cfg(not(target_os = "android"))]
type LiveRect = serde_json::Value;

/// The live pane and the offscreen render, on the platform wry has neither.
///
/// Deliberately loud off Android, unlike the gesture commands above. Those are
/// a hint a board can do without; this one is the surface a reader is looking
/// at, and the JS side chooses its transport before calling
/// (`liveWebviewTransport`) — so reaching these on a desktop build means the
/// choice went wrong, and a silent `Ok` would hide it behind an empty pane.
#[cfg(target_os = "android")]
macro_rules! live_webview {
    ($app:expr) => {{
        use tauri_plugin_livewebview::LiveWebViewExt;
        $app.live_webview().ok_or("live web view unavailable")?
    }};
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn live_webview_create(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] label: String,
    #[allow(unused_variables)] url: String,
    #[allow(unused_variables)] rect: LiveRect,
    #[allow(unused_variables)] density: f64,
    #[allow(unused_variables)] user_agent: Option<String>,
    #[allow(unused_variables)] behind: bool,
) -> std::result::Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = live_webview!(app);
        return plugin
            .create(&label, &url, rect, density, user_agent, behind)
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(NOT_ANDROID.into())
    }
}

#[tauri::command]
fn live_webview_place(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] label: String,
    #[allow(unused_variables)] rect: LiveRect,
    #[allow(unused_variables)] density: f64,
) -> std::result::Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = live_webview!(app);
        return plugin.place(&label, rect, density).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(NOT_ANDROID.into())
    }
}

#[tauri::command]
fn live_webview_show(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] label: String,
    #[allow(unused_variables)] visible: bool,
) -> std::result::Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = live_webview!(app);
        return plugin.show(&label, visible).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(NOT_ANDROID.into())
    }
}

#[tauri::command]
fn live_webview_close(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] label: String,
) -> std::result::Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = live_webview!(app);
        return plugin.close(&label).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(NOT_ANDROID.into())
    }
}

/// The one that answers off Android instead of complaining.
///
/// It is a question, not an instruction — "is a view open under this name" —
/// and where this transport does not exist the true answer is no. The others
/// above are asked to *do* something, and doing nothing quietly is how a pane
/// ends up empty with nothing in the log to say why.
#[tauri::command]
fn live_webview_exists(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] label: String,
) -> std::result::Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = live_webview!(app);
        return plugin.exists(&label).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

#[cfg(not(target_os = "android"))]
const NOT_ANDROID: &str = "this build has wry's own child webview; use it";
