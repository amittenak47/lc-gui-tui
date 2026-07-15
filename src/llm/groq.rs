use anyhow::{Context, Result};

use super::LlmProvider;
use crate::config::Config;

pub struct Groq {
    base_url: String,
    model: String,
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
        Ok(Self {
            base_url: cfg.llm.groq.base_url.clone(),
            model: cfg.llm.groq.model.clone(),
            api_key,
        })
    }
}

impl LlmProvider for Groq {
    fn label(&self) -> String {
        format!("groq/{}", self.model)
    }

    fn chat(&self, system: &str, user: &str) -> Result<String> {
        super::chat_completions(&self.base_url, Some(&self.api_key), &self.model, system, user)
    }
}
