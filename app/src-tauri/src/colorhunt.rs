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

fn validate_tags(tags: Option<&str>) -> Result<&str, String> {
    let tags = tags.unwrap_or("").trim();
    if tags.is_empty() || tags.split('-').all(|tag| ALLOWED_TAGS.contains(&tag)) {
        Ok(tags)
    } else {
        Err("ColorHunt tags must be allowed palette tags joined with hyphens".into())
    }
}

#[tauri::command]
pub async fn colorhunt_random(tags: Option<String>) -> Result<Vec<ColorHuntRow>, String> {
    let tag = validate_tags(tags.as_deref())?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("pen-island/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| format!("cannot build an HTTP client: {err}"))?;

    let response = client
        .post(FEED_URL)
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        )
        .header("Accept", "application/json, text/plain, */*")
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
        if code.len() != 24 || !code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
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

#[cfg(test)]
mod tests {
    use super::validate_tags;

    #[test]
    fn validates_single_tags_and_combinations() {
        for tags in [None, Some(""), Some("neon"), Some("neon-dark"), Some(" pastel-warm ")] {
            assert!(validate_tags(tags).is_ok());
        }
        for tags in ["any", "neon dark", "neon,dark", "neon--dark", "-neon", "neon-", "neon&step=2", "neon-unknown"] {
            assert!(validate_tags(Some(tags)).is_err(), "accepted {tags}");
        }
    }
}
