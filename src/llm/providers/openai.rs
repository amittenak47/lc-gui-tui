use anyhow::Result;

use super::http::{chat_completions, chat_completions_ex};
use super::{ChatReply, ChatRequest, LlmProvider};
use crate::config::Config;

/// Any OpenAI-compatible server: Ollama, vLLM, LM Studio, or OpenAI itself.
/// Local/Ollama use `LC_LOCAL_API_KEY` when set; OpenAI uses `OPENAI_API_KEY`
/// then the key stored in Settings.
pub struct OpenAi {
    label: String,
    base_url: String,
    model: String,
    vision_model: String,
    api_key: Option<String>,
}

impl OpenAi {
    pub fn from_config(cfg: &Config) -> Self {
        Self::from_provider(cfg, "local")
    }

    pub fn from_provider(cfg: &Config, provider: &str) -> Self {
        let endpoint = cfg.llm.endpoint(provider);
        let api_key = if provider == "openai" {
            crate::config::resolve_api_key("OPENAI_API_KEY", cfg.llm.openai.api_key.as_deref())
        } else {
            crate::config::resolve_api_key("LC_LOCAL_API_KEY", None)
        };
        Self {
            label: provider.to_string(),
            base_url: endpoint.base_url.to_string(),
            model: endpoint.model.to_string(),
            vision_model: endpoint.vision_model_name().to_string(),
            api_key,
        }
    }

    fn model_for(&self, req: &ChatRequest) -> &str {
        let wants_vision = req.messages.iter().any(|m| !m.images.is_empty());
        if wants_vision {
            &self.vision_model
        } else {
            &self.model
        }
    }
}

impl LlmProvider for OpenAi {
    fn label(&self) -> String {
        format!("{}/{} @ {}", self.label, self.model, self.base_url)
    }

    fn chat(&self, system: &str, user: &str) -> Result<String> {
        let api_key = self.api_key.as_deref();
        self.explain_unreachable(chat_completions(
            &self.base_url,
            api_key,
            &self.model,
            system,
            user,
        ))
    }

    fn chat_ex(&self, req: &ChatRequest) -> Result<ChatReply> {
        let api_key = self.api_key.as_deref();
        self.explain_unreachable(chat_completions_ex(
            &self.base_url,
            api_key,
            self.model_for(req),
            req,
        ))
    }
}

impl OpenAi {
    /// A connect/timeout failure almost always means the server isn't running;
    /// say so instead of surfacing a bare reqwest error.
    fn explain_unreachable<T>(&self, result: Result<T>) -> Result<T> {
        result.map_err(|err| {
            let is_unreachable = err.chain().any(|cause| {
                cause
                    .downcast_ref::<reqwest::Error>()
                    .is_some_and(|e| e.is_connect() || e.is_timeout())
            });
            if is_unreachable {
                err.context(format!(
                    "cannot reach the LLM at {} — start your server first \
                     (Ollama: `ollama serve`, then `ollama pull {}`)",
                    self.base_url, self.model
                ))
            } else {
                err
            }
        })
    }
}
