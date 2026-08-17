//! In-process API for the embedded harness router and coach event bridge.
//!
//! HTTP routes are dispatched through axum without binding a port. The ambient
//! coach uses Tauri events instead of a loopback WebSocket.

use std::sync::Mutex;

use base64::Engine;
use harness::serve::{self, Shared};
use harness::serve::ws;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// One in-process HTTP request. `path` is router-relative, e.g. `/coach/review`.
#[derive(Debug, Deserialize)]
pub struct LcDispatchRequest {
    pub path: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
    /// Raw body as base64, used for `/docs/:hash/bytes` (not JSON).
    #[serde(default)]
    pub raw_base64: Option<String>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Serialize)]
pub struct LcResponse {
    pub status: u16,
    /// Parsed JSON when the handler returned any, otherwise null.
    pub body: serde_json::Value,
}

pub(crate) async fn call_router(
    state: Shared,
    method: &str,
    path: String,
    body: Option<serde_json::Value>,
    raw_base64: Option<String>,
) -> Result<LcResponse, String> {
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };

    let (body_bytes, content_type) = if let Some(raw) = &raw_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|err| format!("invalid raw_base64: {err}"))?;
        (bytes, Some("application/octet-stream".to_string()))
    } else if let Some(body) = &body {
        (
            serde_json::to_vec(body).map_err(|err| format!("cannot encode JSON body: {err}"))?,
            Some("application/json".to_string()),
        )
    } else {
        (Vec::new(), None)
    };

    let (status, bytes, response_ct) = serve::dispatch(
        state.clone(),
        method,
        &path,
        body_bytes,
        content_type.as_deref(),
    )
    .await
    .map_err(|err| format!("in-process dispatch failed: {err:#}"))?;

    Ok(LcResponse {
        status,
        body: response_body(bytes, &response_ct),
    })
}

#[tauri::command]
pub async fn lc_dispatch(
    state: State<'_, Shared>,
    request: LcDispatchRequest,
) -> Result<LcResponse, String> {
    call_router(
        state.inner().clone(),
        &request.method,
        request.path,
        request.body,
        request.raw_base64,
    )
    .await
}

fn response_body(bytes: Vec<u8>, content_type: &str) -> serde_json::Value {
    if content_type.contains("octet-stream") {
        return serde_json::json!({
            "$bytes": base64::engine::general_purpose::STANDARD.encode(&bytes)
        });
    }
    let text = String::from_utf8_lossy(&bytes);
    if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.into_owned()))
    }
}

struct CoachSession {
    incoming: mpsc::UnboundedSender<String>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

pub struct CoachHub {
    inner: Mutex<Option<CoachSession>>,
}

impl CoachHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub async fn lc_coach_connect(
    app: AppHandle,
    state: State<'_, Shared>,
    hub: State<'_, CoachHub>,
) -> Result<(), String> {
    lc_coach_disconnect_inner(&hub)?;

    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel();

    let app_emit = app.clone();
    let emit_task = tauri::async_runtime::spawn(async move {
        while let Some(frame) = outgoing_rx.recv().await {
            if let Ok(json) = serde_json::to_string(&frame) {
                let _ = app_emit.emit("lc-coach-frame", json);
            }
        }
    });

    let serve_state = state.inner().clone();
    let drive_task = tauri::async_runtime::spawn(async move {
        ws::drive_channels(serve_state, incoming_rx, outgoing_tx).await;
    });

    *hub.inner.lock().map_err(|_| "coach hub lock poisoned")? = Some(CoachSession {
        incoming: incoming_tx,
        tasks: vec![emit_task, drive_task],
    });
    Ok(())
}

#[tauri::command]
pub async fn lc_coach_send(hub: State<'_, CoachHub>, frame: String) -> Result<(), String> {
    let guard = hub.inner.lock().map_err(|_| "coach hub lock poisoned")?;
    let Some(session) = guard.as_ref() else {
        return Err("coach is not connected".into());
    };
    session
        .incoming
        .send(frame)
        .map_err(|_| "coach disconnected".into())
}

#[tauri::command]
pub async fn lc_coach_disconnect(hub: State<'_, CoachHub>) -> Result<(), String> {
    lc_coach_disconnect_inner(&hub)
}

fn lc_coach_disconnect_inner(hub: &CoachHub) -> Result<(), String> {
    let mut guard = hub.inner.lock().map_err(|_| "coach hub lock poisoned")?;
    if let Some(session) = guard.take() {
        drop(session.incoming);
        for task in session.tasks {
            task.abort();
        }
    }
    Ok(())
}

const PAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const PAGE_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const PAGE_MAX_BYTES: usize = 8_000_000;

#[derive(Debug, Serialize)]
pub struct FetchedPage {
    pub url: String,
    pub html: String,
}

/// GET an http(s) page for the annotate web pad. Same-origin overlay needs
/// the HTML as text; the WebView cannot fetch google.com (CORS / X-Frame).
#[tauri::command]
pub async fn fetch_html(url: String) -> Result<FetchedPage, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "that does not look like a URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("only http and https pages can be opened".into());
    }
    let client = reqwest::Client::builder()
        .timeout(PAGE_TIMEOUT)
        .connect_timeout(PAGE_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|err| format!("cannot build an HTTP client: {err}"))?;

    let response = client
        .get(parsed.clone())
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|err| format!("cannot reach {parsed}: {err}"))?;
    let final_url = response.url().to_string();
    let status = response.status();
    if !status.is_success() {
        return Err(format!("the page returned HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("cannot read {final_url}: {err}"))?;
    if bytes.len() > PAGE_MAX_BYTES {
        return Err("this page is too large to annotate here".into());
    }
    let html = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FetchedPage {
        url: final_url,
        html,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_defaults_to_get_and_paths_are_normalized() {
        let request: LcDispatchRequest = serde_json::from_str(r#"{"path": "problems"}"#).unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "problems");
    }

    #[test]
    fn a_body_round_trips() {
        let request: LcDispatchRequest = serde_json::from_str(
            r#"{"path": "/coach/review", "method": "POST",
                "body": {"task_id": "two-sum"}}"#,
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.body.unwrap()["task_id"], "two-sum");
    }
}
