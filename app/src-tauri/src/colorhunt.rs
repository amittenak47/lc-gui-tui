//! Random ColorHunt palettes for the ink colour wheel.
//!
//! ColorHunt has no official API. The site's own feed endpoint returns a JSON
//! list of 24-char codes (four hex colours concatenated). The WebView cannot
//! call it (CORS), so Rust fetches and the front end parses.

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct ColorHuntRow {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const FEED_URL: &str = "https://colorhunt.co/php/feed.php";

/// Tags the feed will accept, so a value from the front end cannot become an
/// arbitrary request body. Empty means no preference, which is the default.
const ALLOWED_TAGS: &[&str] = &[
    "pastel", "vintage", "retro", "neon", "light", "dark", "warm", "cold", "nature", "earth",
    "sunset", "space",
];

#[tauri::command]
pub async fn colorhunt_random(tags: Option<String>) -> Result<Vec<ColorHuntRow>, String> {
    let tag = tags
        .as_deref()
        .map(str::trim)
        .filter(|t| ALLOWED_TAGS.contains(t))
        .unwrap_or("");
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|err| format!("cannot build an HTTP client: {err}"))?;

    let response = client
        .post(FEED_URL)
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        )
        .body(format!("step=0&sort=random&tags={tag}"))
        .send()
        .await
        .map_err(|err| format!("ColorHunt request failed: {err}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("cannot read ColorHunt body: {err}"))?;
    if !status.is_success() {
        return Err(format!("ColorHunt returned {status}: {text}"));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| format!("ColorHunt JSON: {err}"))?;
    let Some(arr) = parsed.as_array() else {
        return Err("ColorHunt feed was not a list".into());
    };

    let mut rows = Vec::with_capacity(arr.len());
    for item in arr {
        let code = item
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if code.len() != 24 {
            continue;
        }
        rows.push(ColorHuntRow {
            code,
            likes: item
                .get("likes")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            date: item
                .get("date")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    if rows.is_empty() {
        return Err("ColorHunt feed had no usable palettes".into());
    }
    Ok(rows)
}
