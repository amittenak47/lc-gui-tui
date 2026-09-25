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
/// hole underneath. WebView2 can photograph itself.
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
                // The preview finishes on this same thread, through the window
                // loop. Waiting for it here never returns: the completion is
                // sitting behind the call that is waiting for it.
                if let Err(err) = begin_webview_capture(&platform, tx) {
                    // begin_webview_capture sends on failure when it still holds
                    // the channel. A send error means the listener is already gone.
                    let _ = err;
                }
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
fn begin_webview_capture(
    webview: &tauri::webview::PlatformWebview,
    tx: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) -> Result<(), String> {
    use std::sync::{Arc, Mutex};

    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let held = Arc::new(Mutex::new(Some(tx)));
    let fail = |held: &Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>>>, err: String| {
        if let Some(tx) = held.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = tx.send(Err(err.clone()));
        }
        err
    };
    let core = match unsafe { webview.controller().CoreWebView2() } {
        Ok(core) => core,
        Err(err) => return Err(fail(&held, err.to_string())),
    };
    let stream = match unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) } {
        Ok(stream) => stream,
        Err(err) => return Err(fail(&held, err.to_string())),
    };
    let slot = held.clone();
    let preview = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let outcome = match result {
            Ok(()) => read_preview_png(&preview),
            Err(err) => Err(err.to_string()),
        };
        if let Some(tx) = slot.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = tx.send(outcome);
        }
        Ok(())
    }));
    if let Err(err) = unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    } {
        if let Some(tx) = held.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = tx.send(Err(err.to_string()));
        }
        return Err(err.to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn read_preview_png(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK;

    let mut end = 0u64;
    unsafe {
        stream
            .Seek(0, STREAM_SEEK(2), Some(&mut end))
            .map_err(|err| err.to_string())?;
        stream
            .Seek(0, STREAM_SEEK(0), None)
            .map_err(|err| err.to_string())?;
    }
    let size = usize::try_from(end).map_err(|_| "the page capture is too large")?;
    if size == 0 {
        return Err("the page capture was empty".into());
    }
    let mut bytes = vec![0u8; size];
    let mut read = 0u32;
    unsafe {
        stream
            .Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read))
            .ok()
            .map_err(|err| err.to_string())?;
    }
    bytes.truncate(read as usize);
    if bytes.is_empty() {
        return Err("the page capture was empty".into());
    }
    Ok(bytes)
}
