pub mod coach;
pub mod groq;
pub mod lifecycle;
pub mod openai_compat;
pub mod prompt;
pub mod tools;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;

pub trait LlmProvider {
    fn label(&self) -> String;
    fn chat(&self, system: &str, user: &str) -> Result<String>;
    /// Multi-turn call with optional tools, images, and JSON-object output.
    /// Kept separate from [`LlmProvider::chat`] so `lc ask` is unaffected.
    fn chat_ex(&self, req: &ChatRequest) -> Result<ChatReply>;
}

pub fn make_provider(cfg: &Config, name: Option<&str>) -> Result<Box<dyn LlmProvider>> {
    let name = name.unwrap_or(&cfg.llm.default_provider);
    match name {
        "local" | "ollama" => Ok(Box::new(openai_compat::OpenAiCompat::from_provider(
            cfg, name,
        ))),
        "openai" => Ok(Box::new(openai_compat::OpenAiCompat::from_provider(
            cfg, "openai",
        ))),
        "groq" => Ok(Box::new(groq::Groq::from_config(cfg)?)),
        other => bail!(
            "unknown LLM provider {other:?} — expected one of local, ollama, openai, groq"
        ),
    }
}

/// Provider for one coach mode (`ambient`, `review`, `bridge`, `viz`), so a
/// single config line can send `review` to Groq while `ambient` stays local.
pub fn make_provider_for_mode(cfg: &Config, mode: &str) -> Result<Box<dyn LlmProvider>> {
    let name = cfg.llm.modes.get(mode)?;
    make_provider(cfg, Some(name))
        .with_context(|| format!("resolving the provider for coach mode {mode:?}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    fn as_str(&self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Base64 PNG payloads, attached as OpenAI `image_url` content parts.
    /// Only populated when the caller knows the model is vision-capable.
    pub images: Vec<String>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self::new(Role::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new(Role::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new(Role::Assistant, content)
    }

    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            images: Vec::new(),
        }
    }

    pub fn with_images(mut self, images: Vec<String>) -> Self {
        self.images = images;
        self
    }

    fn to_json(&self) -> serde_json::Value {
        if self.images.is_empty() {
            return serde_json::json!({"role": self.role.as_str(), "content": self.content});
        }
        let mut parts = vec![serde_json::json!({"type": "text", "text": self.content})];
        for png in &self.images {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": {"url": format!("data:image/png;base64,{png}")},
            }));
        }
        serde_json::json!({"role": self.role.as_str(), "content": parts})
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    /// OpenAI-shaped tool definitions; see [`tools`].
    pub tools: Vec<serde_json::Value>,
    /// Ask the server for a JSON object. Servers vary in how strictly they
    /// honour this, so callers must still parse defensively — see
    /// [`coach::extract_json`].
    pub json_object: bool,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
}

impl ChatRequest {
    pub fn new(messages: Vec<ChatMessage>) -> Self {
        Self {
            messages,
            tools: Vec::new(),
            json_object: false,
            temperature: 0.2,
            max_tokens: None,
        }
    }

    pub fn json(mut self) -> Self {
        self.json_object = true;
        self
    }

    pub fn with_tools(mut self, tools: Vec<serde_json::Value>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = temperature;
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ChatReply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
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

    let value = post_chat(&client, &url, api_key, &body)?;
    let message = value
        .pointer("/choices/0/message")
        .with_context(|| format!("unexpected response shape from {url}"))?;

    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

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
