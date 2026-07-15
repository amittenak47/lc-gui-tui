use anyhow::Result;

use super::LlmProvider;
use crate::config::Config;

/// Any local OpenAI-compatible server: Ollama, vLLM, LM Studio.
/// No API key is required; set LC_LOCAL_API_KEY if your server wants one.
pub struct OpenAiCompat {
    base_url: String,
    model: String,
}

impl OpenAiCompat {
    pub fn from_config(cfg: &Config) -> Self {
        Self {
            base_url: cfg.llm.local.base_url.clone(),
            model: cfg.llm.local.model.clone(),
        }
    }
}

impl LlmProvider for OpenAiCompat {
    fn label(&self) -> String {
        format!("local/{} @ {}", self.model, self.base_url)
    }

    fn chat(&self, system: &str, user: &str) -> Result<String> {
        let api_key = std::env::var("LC_LOCAL_API_KEY").ok();
        super::chat_completions(&self.base_url, api_key.as_deref(), &self.model, system, user)
            .map_err(|err| {
                let is_unreachable = err.chain().any(|cause| {
                    cause
                        .downcast_ref::<reqwest::Error>()
                        .map_or(false, |e| e.is_connect() || e.is_timeout())
                });
                if is_unreachable {
                    err.context(format!(
                        "cannot reach the local LLM at {} — start your server first \
                         (Ollama: `ollama serve`, then `ollama pull {}`)",
                        self.base_url, self.model
                    ))
                } else {
                    err
                }
            })
    }
}
