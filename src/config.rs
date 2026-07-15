use anyhow::{bail, Context, Result};
use directories::{ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub data: DataConfig,
    pub workspace: WorkspaceConfig,
    pub python: PythonConfig,
    pub llm: LlmConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DataConfig {
    /// Folder containing the 3000+ problem JSON files.
    pub json_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceConfig {
    pub dir: String,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            dir: "~/lc-workspace".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PythonConfig {
    pub executable: String,
}

impl Default for PythonConfig {
    fn default() -> Self {
        Self {
            executable: "python".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmConfig {
    /// "local" or "groq"
    pub default_provider: String,
    pub local: LocalLlmConfig,
    pub groq: GroqLlmConfig,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            default_provider: "local".into(),
            local: LocalLlmConfig::default(),
            groq: GroqLlmConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalLlmConfig {
    /// Any OpenAI-compatible server: Ollama, vLLM, LM Studio.
    pub base_url: String,
    pub model: String,
}

impl Default for LocalLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".into(),
            model: "qwen2.5-coder:7b".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GroqLlmConfig {
    pub base_url: String,
    pub model: String,
    // API key comes from the GROQ_API_KEY environment variable, never this file.
}

impl Default for GroqLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.groq.com/openai/v1".into(),
            model: "llama-3.1-8b-instant".into(),
        }
    }
}

pub fn config_dir() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("", "", "lc")
        .context("cannot determine an OS config directory for lc")?;
    Ok(dirs.config_dir().to_path_buf())
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix('~') {
        if let Some(dirs) = UserDirs::new() {
            let rest = rest.trim_start_matches(['/', '\\']);
            return if rest.is_empty() {
                dirs.home_dir().to_path_buf()
            } else {
                dirs.home_dir().join(rest)
            };
        }
    }
    PathBuf::from(path)
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = config_path()?;
        if !path.exists() {
            return Ok(Config::default());
        }
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("invalid TOML in {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, toml::to_string_pretty(self)?)
            .with_context(|| format!("cannot write config {}", path.display()))?;
        Ok(())
    }

    pub fn set(&mut self, key: &str, value: &str) -> Result<()> {
        match key {
            "data-dir" | "data.json_dir" => self.data.json_dir = Some(value.to_string()),
            "workspace" | "workspace.dir" => self.workspace.dir = value.to_string(),
            "python" | "python.executable" => self.python.executable = value.to_string(),
            "llm.provider" | "llm.default_provider" => {
                if value != "local" && value != "groq" {
                    bail!("llm.provider must be \"local\" or \"groq\", got {value:?}");
                }
                self.llm.default_provider = value.to_string();
            }
            "llm.local.base_url" => self.llm.local.base_url = value.to_string(),
            "llm.local.model" => self.llm.local.model = value.to_string(),
            "llm.groq.base_url" => self.llm.groq.base_url = value.to_string(),
            "llm.groq.model" => self.llm.groq.model = value.to_string(),
            other => bail!(
                "unknown config key {other:?}; known keys: data-dir, workspace, python, \
                 llm.provider, llm.local.base_url, llm.local.model, llm.groq.base_url, llm.groq.model"
            ),
        }
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<String> {
        Ok(match key {
            "data-dir" | "data.json_dir" => self.data.json_dir.clone().unwrap_or_default(),
            "workspace" | "workspace.dir" => self.workspace.dir.clone(),
            "python" | "python.executable" => self.python.executable.clone(),
            "llm.provider" | "llm.default_provider" => self.llm.default_provider.clone(),
            "llm.local.base_url" => self.llm.local.base_url.clone(),
            "llm.local.model" => self.llm.local.model.clone(),
            "llm.groq.base_url" => self.llm.groq.base_url.clone(),
            "llm.groq.model" => self.llm.groq.model.clone(),
            other => bail!("unknown config key {other:?}"),
        })
    }

    pub fn json_dir(&self) -> Result<PathBuf> {
        let raw = self.data.json_dir.as_deref().context(
            "problem data dir not configured — run `lc config set data-dir <path-to-json-folder>`",
        )?;
        Ok(expand_tilde(raw))
    }

    pub fn workspace_dir(&self) -> PathBuf {
        expand_tilde(&self.workspace.dir)
    }
}
