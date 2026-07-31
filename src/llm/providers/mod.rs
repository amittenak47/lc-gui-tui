//! LLM provider registry: trait, chat types, and `make_provider*`.

mod groq;
mod http;
mod openai;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;

pub use groq::Groq;
pub use openai::OpenAi;

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
        "local" | "ollama" => Ok(Box::new(OpenAi::from_provider(cfg, name))),
        "openai" => Ok(Box::new(OpenAi::from_provider(cfg, "openai"))),
        "groq" => Ok(Box::new(Groq::from_config(cfg)?)),
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
    /// OpenAI-shaped tool definitions; see [`crate::llm::tools`].
    pub tools: Vec<serde_json::Value>,
    /// Ask the server for a JSON object. Servers vary in how strictly they
    /// honour this, so callers must still parse defensively — see
    /// [`crate::llm::coach::extract_json`].
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

/// Whether a failure means "this server will not do tool calls at all".
///
/// The one that prompted this: vLLM answers a request carrying `tools` with a
/// 400 unless it was launched with `--enable-auto-tool-choice` and a
/// `--tool-call-parser`, which is not something the user can fix from inside
/// the app — and it took out **Draw** completely, since diagrams are the one
/// mode built on tool calls.
///
/// Matching on message text is crude, and deliberately generous: a false
/// positive costs one extra JSON-mode round trip, and if that also fails the
/// caller reports the *original* error rather than the fallback's.
pub fn is_tool_calling_unsupported(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}").to_ascii_lowercase();
    [
        "enable-auto-tool-choice",
        "tool-call-parser",
        "tool choice",
        "tool_choice",
        "does not support tools",
        "tools are not supported",
        "tool calling is not supported",
        "unsupported parameter: 'tools'",
        "unrecognized request argument supplied: tools",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ChatReply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}
