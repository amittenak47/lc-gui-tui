pub mod groq;
pub mod openai_compat;
pub mod prompt;

use anyhow::{bail, Context, Result};

use crate::config::Config;

pub trait LlmProvider {
    fn label(&self) -> String;
    fn chat(&self, system: &str, user: &str) -> Result<String>;
}

pub fn make_provider(cfg: &Config, name: Option<&str>) -> Result<Box<dyn LlmProvider>> {
    let name = name.unwrap_or(&cfg.llm.default_provider);
    match name {
        "local" => Ok(Box::new(openai_compat::OpenAiCompat::from_config(cfg))),
        "groq" => Ok(Box::new(groq::Groq::from_config(cfg)?)),
        other => bail!("unknown LLM provider {other:?} — expected \"local\" or \"groq\""),
    }
}

/// Shared OpenAI-compatible /chat/completions call (Groq, Ollama, vLLM, LM Studio).
pub(crate) fn chat_completions(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
    });

    let mut request = client.post(&url).json(&body);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request.send()?;
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        let snippet: String = text.chars().take(600).collect();
        bail!("LLM request to {url} failed ({status}): {snippet}");
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("non-JSON response from {url}"))?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .with_context(|| format!("unexpected response shape from {url}"))?;
    Ok(content.trim().to_string())
}
