//! Eval a script in a labeled child webview and return the JSON result.
//!
//! The JS `Webview` API in this Tauri build has no `eval`. Capture creates the
//! offscreen view from JS, then this command reads `document.readyState` and
//! the serialize result via `eval_with_callback`.

use tauri::AppHandle;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;

#[tauri::command]
pub async fn webview_eval_json(
    app: AppHandle,
    label: String,
    script: String,
) -> Result<String, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, label, script);
        Err("page capture needs a desktop webview".into())
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
