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
use base64::Engine;

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
    /// Parsed JSON when the daemon returned any, otherwise null.
    pub body: serde_json::Value,
}

/// The coach's review call can take a while on a local model; the daemon's own
/// LLM timeout is 180s, so stay above it rather than cutting it short here.
const TIMEOUT: Duration = Duration::from_secs(200);
/// Fail fast when the host is down / blackholed — do not wait for the full
/// request timeout just to discover TCP will never connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[tauri::command]
pub async fn lc_request(request: LcRequest) -> Result<LcResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
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
    if let Some(raw) = &request.raw_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|err| format!("invalid raw_base64: {err}"))?;
        builder = builder
            .header("Content-Type", "application/octet-stream")
            .body(bytes);
    } else if let Some(body) = &request.body {
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
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("cannot read the response from {url}: {err}"))?;
    let body = if content_type.contains("octet-stream") {
        serde_json::json!({
            "$bytes": base64::engine::general_purpose::STANDARD.encode(&bytes)
        })
    } else {
        let text = String::from_utf8_lossy(&bytes);
        if text.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.into_owned()))
        }
    };

    Ok(LcResponse { status, body })
}

const PAGE_TIMEOUT: Duration = Duration::from_secs(20);
const PAGE_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
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
