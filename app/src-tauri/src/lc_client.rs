//! Rust-side client for the `lc serve` daemon.
//!
//! The WebView normally reaches the daemon with plain `fetch`, and on desktop
//! that is all that is needed. This module exists for the Android case: an
//! Android 14 WebView refuses cleartext HTTP unless the app ships a
//! `network_security_config.xml` permitting the LAN subnet. Proxying through
//! Rust sidesteps that entirely — `reqwest` is not subject to the WebView's
//! policy — so if the tablet blocks the direct call, the front end can route
//! the same requests through {@link lc_request} without any other change.
//!
//! It is a transparent proxy on purpose: no request shaping, no caching, and no
//! knowledge of the coach protocol. The daemon stays the only place that
//! understands `lc`.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// One proxied request. `path` is daemon-relative, e.g. `/coach/review`.
#[derive(Debug, Deserialize)]
pub struct LcRequest {
    pub base_url: String,
    pub path: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Serialize)]
pub struct LcResponse {
    pub status: u16,
    /// Parsed JSON when the daemon returned any, otherwise null.
    pub body: serde_json::Value,
}

/// The coach's review call can take a while on a local model; the daemon's own
/// LLM timeout is 180s, so stay above it rather than cutting it short here.
const TIMEOUT: Duration = Duration::from_secs(200);

#[tauri::command]
pub async fn lc_request(request: LcRequest) -> Result<LcResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|err| format!("cannot build an HTTP client: {err}"))?;

    let url = format!(
        "{}{}",
        request.base_url.trim_end_matches('/'),
        if request.path.starts_with('/') {
            request.path.clone()
        } else {
            format!("/{}", request.path)
        }
    );
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("unsupported HTTP method {:?}", request.method))?;

    let mut builder = client.request(method, &url);
    if let Some(token) = &request.token {
        builder = builder.header("X-LC-Token", token);
    }
    if let Some(body) = &request.body {
        builder = builder.json(body);
    }

    let response = builder.send().await.map_err(|err| {
        if err.is_connect() || err.is_timeout() {
            format!("cannot reach lc serve at {url} — is the daemon running, and are you on the same network?")
        } else {
            format!("request to {url} failed: {err}")
        }
    })?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|err| format!("cannot read the response from {url}: {err}"))?;
    let body = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        // Pass non-JSON through as a string rather than failing: the caller
        // shows the daemon's message either way.
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
    };

    Ok(LcResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_defaults_to_get_and_paths_are_normalized() {
        let request: LcRequest = serde_json::from_str(
            r#"{"base_url": "http://host:7878/", "path": "problems"}"#,
        )
        .unwrap();
        assert_eq!(request.method, "GET");
        assert!(request.token.is_none());
        assert_eq!(
            format!("{}/{}", request.base_url.trim_end_matches('/'), request.path),
            "http://host:7878/problems"
        );
    }

    #[test]
    fn a_body_and_token_round_trip() {
        let request: LcRequest = serde_json::from_str(
            r#"{"base_url": "http://h", "path": "/coach/review", "method": "POST",
                "token": "t", "body": {"task_id": "two-sum"}}"#,
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.token.as_deref(), Some("t"));
        assert_eq!(request.body.unwrap()["task_id"], "two-sum");
    }
}
