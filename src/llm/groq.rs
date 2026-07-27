use anyhow::{Context, Result};

use super::{ChatReply, ChatRequest, LlmProvider};
use crate::config::Config;

pub struct Groq {
    base_url: String,
    model: String,
    vision_model: String,
    api_key: String,
}

impl Groq {
    pub fn from_config(cfg: &Config) -> Result<Self> {
        let api_key = std::env::var("GROQ_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .context(
                "GROQ_API_KEY is not set — export it (get one at https://console.groq.com/keys) \
                 or use --provider local",
            )?;
        let endpoint = cfg.llm.endpoint("groq");
        Ok(Self {
            base_url: endpoint.base_url.to_string(),
            model: endpoint.model.to_string(),
            vision_model: endpoint.vision_model_name().to_string(),
            api_key,
        })
    }

    fn model_for(&self, req: &ChatRequest) -> &str {
        if req.messages.iter().any(|m| !m.images.is_empty()) {
            &self.vision_model
        } else {
            &self.model
        }
    }
}

impl LlmProvider for Groq {
    fn label(&self) -> String {
        format!("groq/{}", self.model)
    }

    fn chat(&self, system: &str, user: &str) -> Result<String> {
        super::chat_completions(&self.base_url, Some(&self.api_key), &self.model, system, user)
    }

    fn chat_ex(&self, req: &ChatRequest) -> Result<ChatReply> {
        super::chat_completions_ex(
            &self.base_url,
            Some(&self.api_key),
            self.model_for(req),
            req,
        )
    }
}
