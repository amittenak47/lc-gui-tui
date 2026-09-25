//! Eval a script in a labeled child webview and return the JSON result.
//!
//! The JS `Webview` API in this Tauri build has no `eval`. Capture creates the
//! offscreen view from JS, then this command reads `document.readyState` and
//! the serialize result via `eval_with_callback`.
//!
//! Two transports, one answer. On desktop the labeled view is wry's; on
//! Android it is the `livewebview` plugin's `android.webkit.WebView`, and
//! `evaluateJavascript` hands back the same JSON encoding `eval_with_callback`
//! does — so the label, the script and the string that comes back are the same
//! three things on both, and the serializer above has no platform branch.
//!
//! This used to answer Android with "page capture needs a desktop webview".
//! Routing it through the plugin is what gives a tablet whole-page capture and
//! Freeze; the pane was only ever half of what the missing child webview cost.

use tauri::AppHandle;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;

#[tauri::command]
pub async fn webview_eval_json(
    app: AppHandle,
    label: String,
    script: String,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = (app, label, script);
        Err("page capture needs a desktop webview".into())
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_livewebview::LiveWebViewExt;
        /*
         * Off the async runtime's worker.
         *
         * `run_mobile_plugin` blocks the calling thread until Kotlin resolves,
         * and the script it is waiting on is a page serialise — seconds, not
         * microseconds. Holding a tokio worker for that is how the rest of the
         * app's IPC starts queueing behind one Freeze.
         */
        tauri::async_runtime::spawn_blocking(move || {
            let plugin = app.live_webview().ok_or("live web view unavailable")?;
            plugin.eval(&label, &script).map_err(|err| err.to_string())
        })
        .await
        .map_err(|_| "the page script did not return".to_string())?
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("no webview named {label}"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        webview
            .eval_with_callback(script, move |value| {
                if let Ok(mut slot) = tx.lock() {
                    if let Some(sender) = slot.take() {
                        let _ = sender.send(value);
                    }
                }
            })
            .map_err(|err| err.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(8), rx)
            .await
            .map_err(|_| "the page script timed out".to_string())?
            .map_err(|_| "the page script did not return".to_string())
    }
}

/// PNG of the labeled child webview, base64, no `data:` prefix.
///
/// The page is a native view painted over the board, so a board export is the
/// hole underneath. WebView2 photographs itself. The completion is delivered
/// on the UI thread, so this waits on the async runtime, not inside the call.
#[tauri::command]
pub async fn webview_capture_png(app: AppHandle, label: String) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, label);
        Err("capturing the live page is only available on Windows".into())
    }
    #[cfg(windows)]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("no webview named {label}"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                start_preview(&platform, tx);
            })
            .map_err(|err| err.to_string())?;
        let png = tokio::time::timeout(std::time::Duration::from_secs(8), rx)
            .await
            .map_err(|_| "the page capture timed out".to_string())?
            .map_err(|_| "the page capture did not return".to_string())??;
        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            png,
        ))
    }
}

#[cfg(windows)]
fn start_preview(
    webview: &tauri::webview::PlatformWebview,
    tx: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use std::sync::{Arc, Mutex};
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let slot = Arc::new(Mutex::new(Some(tx)));
    let fail = |slot: &Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>>>, err: String| {
        if let Ok(mut guard) = slot.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(Err(err));
            }
        }
    };
    let controller = webview.controller();
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(err) => return fail(&slot, err.to_string()),
    };
    let stream = match unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) } {
        Ok(stream) => stream,
        Err(err) => return fail(&slot, err.to_string()),
    };
    let stream_for_cb = stream.clone();
    let slot_cb = slot.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
        let bytes = (|| {
            hr.map_err(|err| err.to_string())?;
            read_png_stream(&stream_for_cb)
        })();
        if let Ok(mut guard) = slot_cb.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(bytes);
            }
        }
        Ok(())
    }));
    if let Err(err) = unsafe {
        core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
    } {
        fail(&slot, err.to_string());
    }
}

#[cfg(windows)]
fn read_png_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    unsafe {
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).map_err(|err| err.to_string())?;
        let size = usize::try_from(stat.cbSize).map_err(|_| "the live page capture was empty".to_string())?;
        if size < 8 || size > 20_000_000 {
            return Err("the live page capture was empty".into());
        }
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(|err| err.to_string())?;
        let mut bytes = vec![0u8; size];
        let mut read = 0u32;
        stream
            .Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read))
            .ok()
            .map_err(|err| err.to_string())?;
        bytes.truncate(read as usize);
        if bytes.len() < 8 || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
            return Err("the live page capture was not a picture".into());
        }
        Ok(bytes)
    }
}
