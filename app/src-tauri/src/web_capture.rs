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
                let _ = tx.send(capture_webview_png(&platform));
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
fn capture_webview_png(webview: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    use std::time::{Duration, Instant};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, ICoreWebView2,
    };
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{STATFLAG, STATSTG, STREAM_SEEK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageA, PeekMessageA, TranslateMessage, MSG, PM_REMOVE,
    };

    let core: ICoreWebView2 = unsafe { webview.controller().CoreWebView2() }
        .map_err(|err| err.to_string())?;
    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
        .map_err(|err| err.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let _ = tx.send(result);
        Ok(())
    }));
    unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
        .map_err(|err| err.to_string())?;
    }

    let started = Instant::now();
    loop {
        if let Ok(result) = rx.try_recv() {
            result.map_err(|err| err.to_string())?;
            break;
        }
        if started.elapsed() > Duration::from_secs(8) {
            return Err("the page capture timed out".into());
        }
        let mut msg = MSG::default();
        let pending = unsafe { PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE) };
        if pending.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageA(&msg);
            }
        } else {
            std::thread::sleep(Duration::from_millis(8));
        }
    }

    let mut stat = STATSTG::default();
    unsafe {
        stream
            .Seek(0, STREAM_SEEK(0), None)
            .map_err(|err| err.to_string())?;
        stream
            .Stat(&mut stat, STATFLAG(0))
            .map_err(|err| err.to_string())?;
    }
    let size = usize::try_from(stat.cbSize).map_err(|_| "the page capture is too large")?;
    if size == 0 {
        return Err("the page capture was empty".into());
    }
    let mut bytes = vec![0u8; size];
    let mut read = 0u32;
    unsafe {
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                size as u32,
                Some(&mut read),
            )
            .ok()
            .map_err(|err| err.to_string())?;
    }
    bytes.truncate(read as usize);
    if bytes.is_empty() {
        return Err("the page capture was empty".into());
    }
    Ok(bytes)
}
