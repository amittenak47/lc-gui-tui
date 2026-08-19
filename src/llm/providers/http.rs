use anyhow::{bail, Context, Result};

use super::{ChatMessage, ChatReply, ChatRequest, ToolCall};

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

    let value = post_chat(&client, &url, api_key, &body)?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .with_context(|| format!("unexpected response shape from {url}"))?;
    Ok(content.trim().to_string())
}

/// Multi-turn variant with tool calls, image parts, and JSON-object output.
/// Added alongside [`chat_completions`] rather than replacing it.
pub(crate) fn chat_completions_ex(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    req: &ChatRequest,
) -> Result<ChatReply> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let messages: Vec<serde_json::Value> = req.messages.iter().map(ChatMessage::to_json).collect();
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": req.temperature,
    });
    let map = body.as_object_mut().expect("object literal");
    if req.json_object {
        map.insert(
            "response_format".into(),
            serde_json::json!({"type": "json_object"}),
        );
        // Ollama's native field; harmless to servers that ignore unknown keys.
        map.insert("format".into(), serde_json::json!("json"));
    }
    if !req.tools.is_empty() {
        map.insert("tools".into(), serde_json::json!(req.tools));
        map.insert("tool_choice".into(), serde_json::json!("auto"));
    }
    if let Some(limit) = req.max_tokens {
        map.insert("max_tokens".into(), serde_json::json!(limit));
    }
    crate::llm::reasoning::apply_thinking_request(
        map,
        base_url,
        req.reasoning,
        req.reasoning_effort,
    );

    let value = post_chat(&client, &url, api_key, &body)?;
    let message = value
        .pointer("/choices/0/message")
        .with_context(|| format!("unexpected response shape from {url}"))?;

    let raw_content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    let reasoning_field = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let split = crate::llm::reasoning::split_think(raw_content, reasoning_field);
    let content = split.content;

    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            let Some(name) = call.pointer("/function/name").and_then(|n| n.as_str()) else {
                continue;
            };
            // Arguments arrive as a JSON *string* per the OpenAI wire format,
            // but some servers inline the object; accept both.
            let raw = call.pointer("/function/arguments");
            let arguments = match raw {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
                }
                Some(other) => other.clone(),
                None => serde_json::Value::Null,
            };
            tool_calls.push(ToolCall {
                name: name.to_string(),
                arguments,
            });
        }
    }

    Ok(ChatReply {
        content,
        tool_calls,
        reasoning: split.reasoning,
    })
}

fn post_chat(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: Option<&str>,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    let mut request = client.post(url).json(body);
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
    serde_json::from_str(&text).with_context(|| format!("non-JSON response from {url}"))
}
