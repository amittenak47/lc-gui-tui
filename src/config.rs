use anyhow::{bail, Context, Result};
use directories::{ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub data: DataConfig,
    pub workspace: WorkspaceConfig,
    pub python: PythonConfig,
    pub tests: TestsConfig,
    pub llm: LlmConfig,
    pub serve: ServeConfig,
    pub coach: CoachConfig,
}

/// Feature flags for the streaming coach loops.
///
/// The two Phase 1 flags default on because they only change *how* an answer
/// arrives (a socket run with stage frames instead of a blocking POST). The
/// planner and the post-draw review both spend extra model calls, so they stay
/// off until the user opts in from Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CoachConfig {
    /// UI drives Ask/Review/Draw/Lazy over `WS /coach/session` `run` frames
    /// instead of the blocking `POST /coach/*` endpoints.
    pub ws_runs: bool,
    /// Show the per-stage process blocks in the chat thread.
    pub process_events_ui: bool,
    /// Run the frontier/local planner once per task to catalog approaches.
    pub planner_enabled: bool,
    /// Vision-check a rendered diagram and allow one corrective tool call.
    pub draw_review_enabled: bool,
    /// Freeze one approach per board session and require an explicit,
    /// reasoned transition to leave it.
    pub approach_commitment: bool,
}

impl Default for CoachConfig {
    fn default() -> Self {
        Self {
            ws_runs: true,
            process_events_ui: true,
            planner_enabled: false,
            draw_review_enabled: false,
            approach_commitment: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DataConfig {
    /// Folder containing the 3000+ problem JSON files.
    pub json_dir: Option<String>,
    /// Per-dataset corpus folders, keyed by the slugs in [`crate::dataset`].
    ///
    /// Empty is the normal case: a dataset without an entry reads
    /// `<json_dir>/<slug>/`, and the default corpus falls back to `<json_dir>`
    /// itself so a single-corpus install needs no config at all.
    pub datasets: BTreeMap<String, String>,
}

/// How `lc test` and the whiteboard's **Run tests** walk the case list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TestsConfig {
    /// Stop at the first failing case instead of running every case.
    ///
    /// Off by default: the coach's counterexample picking, and the results
    /// panel's "3/12 passed", both want the whole picture. Turning it on is
    /// for corpora with hundreds of cases per problem, where the first failure
    /// is the only one worth waiting for.
    pub stop_on_first_failure: bool,
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
    /// "local", "ollama", "openai", or "groq"
    pub default_provider: String,
    pub local: LocalLlmConfig,
    pub ollama: OllamaLlmConfig,
    pub openai: OpenAiLlmConfig,
    pub groq: GroqLlmConfig,
    /// Per-coach-mode provider overrides.
    pub modes: LlmModes,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            default_provider: "local".into(),
            local: LocalLlmConfig::default(),
            ollama: OllamaLlmConfig::default(),
            openai: OpenAiLlmConfig::default(),
            groq: GroqLlmConfig::default(),
            modes: LlmModes::default(),
        }
    }
}

/// Which provider each coach mode talks to. Every mode defaults to `local`, so
/// the whole whiteboard loop runs offline until the user points one at Groq.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmModes {
    /// Cheap local model; ambient WebSocket loop (client cadence ~120s).
    pub ambient: String,
    /// Deeper analysis when the user submits the board.
    pub review: String,
    /// Solution refactor path, after an explicit reveal.
    pub bridge: String,
    /// Tool-calling for diagrams and animations.
    pub viz: String,
    /// One structured call per problem that catalogs the approaches it admits.
    /// Point this at a frontier model to have it guide the local executor;
    /// leaving it `local` is fine and still gated by `coach.planner_enabled`.
    pub planner: String,
}

impl Default for LlmModes {
    fn default() -> Self {
        Self {
            ambient: "local".into(),
            review: "local".into(),
            bridge: "local".into(),
            viz: "local".into(),
            planner: "local".into(),
        }
    }
}

pub const COACH_MODES: [&str; 5] = ["ambient", "review", "bridge", "viz", "planner"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeCapability {
    pub mode: String,
    pub provider: String,
    pub model: String,
    pub vision: bool,
}

impl LlmModes {
    pub fn get(&self, mode: &str) -> Result<&str> {
        Ok(match mode {
            "ambient" => &self.ambient,
            "review" => &self.review,
            "bridge" => &self.bridge,
            "viz" => &self.viz,
            "planner" => &self.planner,
            other => bail!(
                "unknown coach mode {other:?} — expected one of {}",
                COACH_MODES.join(", ")
            ),
        })
    }

    /// Provider name + model + vision capability for every coach mode.
    pub fn capabilities(&self, llm: &LlmConfig) -> Result<Vec<ModeCapability>> {
        let mut out = Vec::with_capacity(COACH_MODES.len());
        for mode in COACH_MODES {
            let provider = self.get(mode)?;
            let endpoint = llm.endpoint(provider);
            out.push(ModeCapability {
                mode: mode.to_string(),
                provider: provider.to_string(),
                model: endpoint.model.to_string(),
                vision: endpoint.vision == Some(true),
            });
        }
        Ok(out)
    }

    fn set(&mut self, mode: &str, provider: &str) -> Result<()> {
        validate_provider(provider)?;
        match mode {
            "ambient" => self.ambient = provider.to_string(),
            "review" => self.review = provider.to_string(),
            "bridge" => self.bridge = provider.to_string(),
            "viz" => self.viz = provider.to_string(),
            "planner" => self.planner = provider.to_string(),
            other => bail!(
                "unknown coach mode {other:?} — expected one of {}",
                COACH_MODES.join(", ")
            ),
        }
        Ok(())
    }
}

pub const LLM_PROVIDERS: [&str; 4] = ["local", "ollama", "openai", "groq"];

/// `lc config set` hands everything over as a string, so booleans arrive in
/// whichever spelling the caller reached for.
fn parse_bool(value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        other => bail!("expected true or false, got {other:?}"),
    }
}

fn validate_provider(value: &str) -> Result<()> {
    if !LLM_PROVIDERS.contains(&value) {
        bail!(
            "provider must be one of {}, got {value:?}",
            LLM_PROVIDERS.join(", ")
        );
    }
    Ok(())
}

/// Resolved endpoint settings for one named provider.
#[derive(Debug, Clone)]
pub struct LlmEndpoint<'a> {
    pub base_url: &'a str,
    pub model: &'a str,
    /// Optional dedicated vision model; empty means reuse [`Self::model`].
    pub vision_model: &'a str,
    /// `Some(true)` = this endpoint accepts images. Name is ignored.
    pub vision: Option<bool>,
}

impl<'a> LlmEndpoint<'a> {
    pub fn vision_model_name(&self) -> &str {
        if self.vision_model.trim().is_empty() {
            self.model
        } else {
            self.vision_model
        }
    }
}

impl LlmConfig {
    pub fn endpoint(&self, provider: &str) -> LlmEndpoint<'_> {
        match provider {
            "ollama" => LlmEndpoint {
                base_url: &self.ollama.base_url,
                model: &self.ollama.model,
                vision_model: &self.ollama.vision_model,
                vision: self.ollama.vision,
            },
            "openai" => LlmEndpoint {
                base_url: &self.openai.base_url,
                model: &self.openai.model,
                vision_model: &self.openai.vision_model,
                vision: self.openai.vision,
            },
            "groq" => LlmEndpoint {
                base_url: &self.groq.base_url,
                model: &self.groq.model,
                vision_model: &self.groq.vision_model,
                vision: self.groq.vision,
            },
            _ => LlmEndpoint {
                base_url: &self.local.base_url,
                model: &self.local.model,
                vision_model: &self.local.vision_model,
                vision: self.local.vision,
            },
        }
    }
}

/// Harness HTTP settings (port/token retained for a possible future `lc sync` hub).
/// The old `lc serve --lan` pairing daemon is gone — desktop and APK embed the router.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServeConfig {
    pub port: u16,
    /// 6-digit LAN pad-hub pairing code. Desktop generates it; the tablet sends
    /// it as `x-lc-token`.
    pub token: Option<String>,
    /// Optional SearXNG JSON endpoint for the document Ask `search_web` tool.
    /// Empty = the tool is not offered.
    #[serde(default)]
    pub searxng_url: String,
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            port: 7878,
            token: None,
            searxng_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalLlmConfig {
    /// Any OpenAI-compatible server: Ollama, vLLM, LM Studio.
    pub base_url: String,
    pub model: String,
    /// Dedicated vision model. Empty → reuse [`Self::model`].
    #[serde(default)]
    pub vision_model: String,
    /// Whether this endpoint accepts image inputs. `None` / `false` = do not
    /// send PNGs. Never inferred from the model name.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Folder of downloaded weights, scanned to offer a model list before the
    /// server is up. A folder per model or a flat pile of `.gguf` both read.
    #[serde(default)]
    pub models_dir: String,
    /// Small embedding model. Empty → hashed bag-of-words fallback (no extra VRAM).
    #[serde(default)]
    pub embed_model: String,
    /// OpenAI-compatible `/embeddings` base. Empty → reuse [`Self::base_url`].
    #[serde(default)]
    pub embed_base_url: String,
}

impl Default for LocalLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".into(),
            model: "qwen2.5-coder:7b".into(),
            vision_model: String::new(),
            vision: None,
            models_dir: String::new(),
            embed_model: String::new(),
            embed_base_url: String::new(),
        }
    }
}

/// Ollama via its OpenAI-compatible API (defaults match Local).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OllamaLlmConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub vision_model: String,
    /// Same gate as Local / OpenAI / Groq. `None` / `false` = no PNGs.
    #[serde(default)]
    pub vision: Option<bool>,
}

impl Default for OllamaLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".into(),
            model: "qwen2.5-coder:7b".into(),
            vision_model: String::new(),
            vision: None,
        }
    }
}

/// Env `OPENAI_API_KEY` / `GROQ_API_KEY` wins. Settings stores a fallback in
/// toml so the APK can call cloud APIs without a process environment.
pub fn resolve_api_key(env_name: &str, stored: Option<&str>) -> Option<String> {
    std::env::var(env_name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            stored
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
}

fn stored_api_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// OpenAI (or compatible) remote API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenAiLlmConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub vision_model: String,
    /// Same gate as Local / Ollama / Groq. `None` / `false` = no PNGs.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Fallback when `OPENAI_API_KEY` is unset. Never sent on GET /config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

impl Default for OpenAiLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o-mini".into(),
            vision_model: String::new(),
            vision: None,
            api_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GroqLlmConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub vision_model: String,
    /// Same gate as Local / Ollama / OpenAI. `None` / `false` = no PNGs.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Fallback when `GROQ_API_KEY` is unset. Never sent on GET /config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

impl Default for GroqLlmConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.groq.com/openai/v1".into(),
            model: "llama-3.1-8b-instant".into(),
            vision_model: String::new(),
            vision: None,
            api_key: None,
        }
    }
}


static CONFIG_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Point config at a directory the host has actually given us.
///
/// `ProjectDirs` routes every non-Windows, non-Apple target through the XDG
/// rules, which resolve against `$HOME`. An Android app process has no `$HOME`,
/// so the lookup returns `None`, [`config_dir`] fails, and — because the Tauri
/// shell only manages router state on a successful load — every `lc_*` command
/// on the device answers "state not managed for field `state`". The shell knows
/// the app's own config directory and sets it here before the first read.
///
/// First call wins: the path is chosen once at startup, and a later caller
/// changing it would leave the two halves of the app reading different files.
pub fn set_config_dir(dir: PathBuf) {
    let _ = CONFIG_DIR_OVERRIDE.set(dir);
}

pub fn config_dir() -> Result<PathBuf> {
    if let Some(dir) = CONFIG_DIR_OVERRIDE.get() {
        return Ok(dir.clone());
    }
    let dirs = ProjectDirs::from("", "", "lc")
        .context("cannot determine an OS config directory for lc")?;
    Ok(dirs.config_dir().to_path_buf())
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

/// Ways a config file might spell "my home directory".
///
/// `~` alone is not enough in practice: a shell that doesn't expand `$HOME`
/// (`cmd.exe`, PowerShell for POSIX-style names) passes it through literally,
/// and the result is a directory *named* `$HOME` next to wherever the command
/// ran. Recognizing the spellings here means such a config self-heals instead of
/// silently creating one.
const HOME_PREFIXES: [&str; 5] = ["~", "$HOME", "${HOME}", "%USERPROFILE%", "$USERPROFILE"];

pub fn expand_tilde(path: &str) -> PathBuf {
    for prefix in HOME_PREFIXES {
        if let Some(rest) = strip_home_prefix(path, prefix) {
            if let Some(dirs) = UserDirs::new() {
                return if rest.is_empty() {
                    dirs.home_dir().to_path_buf()
                } else {
                    dirs.home_dir().join(rest)
                };
            }
        }
    }
    PathBuf::from(path)
}

/// The remainder after a home prefix, or `None` if `path` doesn't start with
/// one. Requires the prefix to be followed by a separator or nothing, so
/// `$HOMEWORK/notes` is left alone.
fn strip_home_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    // Windows environment variables are case-insensitive.
    if path.len() < prefix.len() || !path[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = &path[prefix.len()..];
    if rest.is_empty() {
        return Some(rest);
    }
    if rest.starts_with('/') || rest.starts_with('\\') {
        return Some(rest.trim_start_matches(['/', '\\']));
    }
    None
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
            "tests.stop_on_first_failure" => {
                self.tests.stop_on_first_failure = parse_bool(value)?
            }
            "coach.ws_runs" => self.coach.ws_runs = parse_bool(value)?,
            "coach.process_events_ui" => self.coach.process_events_ui = parse_bool(value)?,
            "coach.planner_enabled" => self.coach.planner_enabled = parse_bool(value)?,
            "coach.draw_review_enabled" => self.coach.draw_review_enabled = parse_bool(value)?,
            "coach.approach_commitment" => self.coach.approach_commitment = parse_bool(value)?,
            _ if key.starts_with("data.datasets.") => {
                let slug = &key["data.datasets.".len()..];
                crate::dataset::get(slug)?;
                if value.trim().is_empty() {
                    self.data.datasets.remove(slug);
                } else {
                    self.data
                        .datasets
                        .insert(slug.to_string(), value.to_string());
                }
            }
            "llm.provider" | "llm.default_provider" => {
                validate_provider(value)?;
                self.llm.default_provider = value.to_string();
            }
            "llm.local.base_url" => self.llm.local.base_url = value.to_string(),
            "llm.local.model" => self.llm.local.model = value.to_string(),
            "llm.local.vision_model" => self.llm.local.vision_model = value.to_string(),
            "llm.local.vision" => self.llm.local.vision = Some(parse_bool(value)?),
            "llm.local.models_dir" => self.llm.local.models_dir = value.to_string(),
            "llm.local.embed_model" => self.llm.local.embed_model = value.to_string(),
            "llm.local.embed_base_url" => self.llm.local.embed_base_url = value.to_string(),
            "llm.ollama.base_url" => self.llm.ollama.base_url = value.to_string(),
            "llm.ollama.model" => self.llm.ollama.model = value.to_string(),
            "llm.ollama.vision_model" => self.llm.ollama.vision_model = value.to_string(),
            "llm.ollama.vision" => self.llm.ollama.vision = Some(parse_bool(value)?),
            "llm.openai.base_url" => self.llm.openai.base_url = value.to_string(),
            "llm.openai.model" => self.llm.openai.model = value.to_string(),
            "llm.openai.vision_model" => self.llm.openai.vision_model = value.to_string(),
            "llm.openai.vision" => self.llm.openai.vision = Some(parse_bool(value)?),
            "llm.openai.api_key" => self.llm.openai.api_key = stored_api_key(value),
            "llm.groq.base_url" => self.llm.groq.base_url = value.to_string(),
            "llm.groq.model" => self.llm.groq.model = value.to_string(),
            "llm.groq.vision_model" => self.llm.groq.vision_model = value.to_string(),
            "llm.groq.vision" => self.llm.groq.vision = Some(parse_bool(value)?),
            "llm.groq.api_key" => self.llm.groq.api_key = stored_api_key(value),
            "serve.port" => {
                self.serve.port = value
                    .parse()
                    .with_context(|| format!("serve.port must be a port number, got {value:?}"))?
            }
            "serve.token" => {
                self.serve.token = if value.trim().is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            }
            "serve.searxng_url" => self.serve.searxng_url = value.to_string(),
            _ if key.starts_with("llm.modes.") => {
                self.llm.modes.set(&key["llm.modes.".len()..], value)?
            }
            other => bail!(
                "unknown config key {other:?}; known keys: data-dir, workspace, python, \
                 data.datasets.<{}>, tests.stop_on_first_failure, \
                 llm.provider, llm.local.{{base_url,model,vision_model,vision,models_dir,embed_model,embed_base_url}}, \
                 llm.ollama.{{base_url,model,vision_model,vision}}, \
                 llm.openai.{{base_url,model,vision_model,vision,api_key}}, \
                 llm.groq.{{base_url,model,vision_model,vision,api_key}}, llm.modes.<{}>, serve.port, serve.token, serve.searxng_url, \
                 coach.{{ws_runs,process_events_ui,planner_enabled,draw_review_enabled,approach_commitment}}",
                crate::dataset::DATASETS
                    .iter()
                    .map(|d| d.id)
                    .collect::<Vec<_>>()
                    .join("|"),
                COACH_MODES.join("|")
            ),
        }
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<String> {
        Ok(match key {
            "data-dir" | "data.json_dir" => self.data.json_dir.clone().unwrap_or_default(),
            "workspace" | "workspace.dir" => self.workspace.dir.clone(),
            "python" | "python.executable" => self.python.executable.clone(),
            "tests.stop_on_first_failure" => self.tests.stop_on_first_failure.to_string(),
            "coach.ws_runs" => self.coach.ws_runs.to_string(),
            "coach.process_events_ui" => self.coach.process_events_ui.to_string(),
            "coach.planner_enabled" => self.coach.planner_enabled.to_string(),
            "coach.draw_review_enabled" => self.coach.draw_review_enabled.to_string(),
            "coach.approach_commitment" => self.coach.approach_commitment.to_string(),
            _ if key.starts_with("data.datasets.") => {
                let slug = &key["data.datasets.".len()..];
                crate::dataset::get(slug)?;
                self.data.datasets.get(slug).cloned().unwrap_or_default()
            }
            "llm.provider" | "llm.default_provider" => self.llm.default_provider.clone(),
            "llm.local.base_url" => self.llm.local.base_url.clone(),
            "llm.local.model" => self.llm.local.model.clone(),
            "llm.local.vision_model" => self.llm.local.vision_model.clone(),
            "llm.local.vision" => self
                .llm
                .local
                .vision
                .map(|flag| flag.to_string())
                .unwrap_or_default(),
            "llm.local.models_dir" => self.llm.local.models_dir.clone(),
            "llm.local.embed_model" => self.llm.local.embed_model.clone(),
            "llm.local.embed_base_url" => self.llm.local.embed_base_url.clone(),
            "llm.ollama.base_url" => self.llm.ollama.base_url.clone(),
            "llm.ollama.model" => self.llm.ollama.model.clone(),
            "llm.ollama.vision_model" => self.llm.ollama.vision_model.clone(),
            "llm.ollama.vision" => self
                .llm
                .ollama
                .vision
                .map(|flag| flag.to_string())
                .unwrap_or_default(),
            "llm.openai.base_url" => self.llm.openai.base_url.clone(),
            "llm.openai.model" => self.llm.openai.model.clone(),
            "llm.openai.vision_model" => self.llm.openai.vision_model.clone(),
            "llm.openai.vision" => self
                .llm
                .openai
                .vision
                .map(|flag| flag.to_string())
                .unwrap_or_default(),
            "llm.openai.api_key" => self
                .llm
                .openai
                .api_key
                .as_ref()
                .map(|_| "set".to_string())
                .unwrap_or_default(),
            "llm.groq.base_url" => self.llm.groq.base_url.clone(),
            "llm.groq.model" => self.llm.groq.model.clone(),
            "llm.groq.vision_model" => self.llm.groq.vision_model.clone(),
            "llm.groq.vision" => self
                .llm
                .groq
                .vision
                .map(|flag| flag.to_string())
                .unwrap_or_default(),
            "llm.groq.api_key" => self
                .llm
                .groq
                .api_key
                .as_ref()
                .map(|_| "set".to_string())
                .unwrap_or_default(),
            "serve.port" => self.serve.port.to_string(),
            "serve.token" => self.serve.token.clone().unwrap_or_default(),
            "serve.searxng_url" => self.serve.searxng_url.clone(),
            _ if key.starts_with("llm.modes.") => {
                self.llm.modes.get(&key["llm.modes.".len()..])?.to_string()
            }
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

    /// Embedding model name. Empty means hashed lexical vectors (no extra GPU).
    pub fn embed_model(&self) -> Option<&str> {
        let m = self.llm.local.embed_model.trim();
        if m.is_empty() {
            None
        } else {
            Some(m)
        }
    }

    pub fn embed_base_url(&self) -> &str {
        let extra = self.llm.local.embed_base_url.trim();
        if extra.is_empty() {
            self.llm.local.base_url.as_str()
        } else {
            extra
        }
    }

    pub fn searxng_url(&self) -> Option<&str> {
        let u = self.serve.searxng_url.trim();
        if u.is_empty() {
            None
        } else {
            Some(u)
        }
    }

    /// Explicit corpus folder for one dataset, if the user set one.
    /// [`crate::dataset::Dataset::corpus_dir`] owns the fallback rules.
    pub fn dataset_dir(&self, id: &str) -> Option<String> {
        self.data
            .datasets
            .get(id)
            .map(|dir| dir.trim().to_string())
            .filter(|dir| !dir.is_empty())
    }

    /// 6-digit LAN pad-hub code, generated and persisted on first desktop launch
    /// (and again if an old 32-char token is still in config).
    pub fn ensure_serve_token(&mut self) -> Result<String> {
        if let Some(token) = self.serve.token.as_deref().filter(|t| is_pair_code(t)) {
            return Ok(token.to_string());
        }
        let token = random_token();
        self.serve.token = Some(token.clone());
        self.save()?;
        Ok(token)
    }
}

fn is_pair_code(token: &str) -> bool {
    let t = token.trim();
    t.len() == 6 && t.bytes().all(|b| b.is_ascii_digit())
}

fn random_token() -> String {
    use rand::Rng as _;
    let n: u32 = rand::thread_rng().gen_range(0..1_000_000);
    format!("{n:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        UserDirs::new().expect("a home directory").home_dir().to_path_buf()
    }

    #[test]
    fn tilde_expands() {
        assert_eq!(expand_tilde("~/lc-workspace"), home().join("lc-workspace"));
        assert_eq!(expand_tilde("~\\lc-workspace"), home().join("lc-workspace"));
        assert_eq!(expand_tilde("~"), home());
    }

    /// The bug this guards: a shell that doesn't expand `$HOME` passes it
    /// through, and `lc` used to create a directory literally named `$HOME`.
    #[test]
    fn unexpanded_home_variables_are_recognized_not_taken_literally() {
        for spelling in [
            "$HOME/lc-workspace",
            "$HOME\\lc-workspace",
            "${HOME}/lc-workspace",
            "%USERPROFILE%\\lc-workspace",
            "$USERPROFILE/lc-workspace",
        ] {
            assert_eq!(
                expand_tilde(spelling),
                home().join("lc-workspace"),
                "{spelling} should resolve to the home directory"
            );
        }
    }

    #[test]
    fn windows_variable_names_are_case_insensitive() {
        assert_eq!(expand_tilde("%userprofile%/lc"), home().join("lc"));
        assert_eq!(expand_tilde("$home/lc"), home().join("lc"));
    }

    #[test]
    fn a_path_that_merely_starts_with_a_prefix_is_left_alone() {
        // Without the separator check, these would be mangled into the home dir.
        for literal in ["$HOMEWORK/notes", "~backup/x", "/srv/$HOME/x", "C:\\lc"] {
            assert_eq!(expand_tilde(literal), PathBuf::from(literal), "{literal}");
        }
    }

    #[test]
    fn absolute_paths_pass_through() {
        assert_eq!(
            expand_tilde("C:\\Users\\Example\\lc-workspace"),
            PathBuf::from("C:\\Users\\Example\\lc-workspace")
        );
        assert_eq!(expand_tilde("/var/lc"), PathBuf::from("/var/lc"));
    }

    #[test]
    fn coach_modes_default_to_local_and_reject_unknown_providers() {
        let mut cfg = Config::default();
        for mode in COACH_MODES {
            assert_eq!(cfg.llm.modes.get(mode).unwrap(), "local");
        }
        cfg.set("llm.modes.review", "groq").unwrap();
        assert_eq!(cfg.get("llm.modes.review").unwrap(), "groq");
        assert_eq!(cfg.get("llm.modes.ambient").unwrap(), "local", "modes are independent");

        assert!(cfg.set("llm.modes.review", "gpt5").is_err());
        assert!(cfg.set("llm.modes.telepathy", "local").is_err());
        assert!(cfg.get("llm.modes.telepathy").is_err());
    }

    #[test]
    fn resolve_api_key_uses_stored_when_env_missing() {
        assert_eq!(
            resolve_api_key("LC_TEST_NO_SUCH_KEY_XYZ", Some(" stored ")).as_deref(),
            Some("stored")
        );
        assert_eq!(resolve_api_key("LC_TEST_NO_SUCH_KEY_XYZ", Some("  ")), None);
        assert_eq!(resolve_api_key("LC_TEST_NO_SUCH_KEY_XYZ", None), None);
    }

    #[test]
    fn cli_get_api_key_says_set_not_the_secret() {
        let mut cfg = Config::default();
        cfg.set("llm.openai.api_key", " sk-secret ").unwrap();
        assert_eq!(cfg.get("llm.openai.api_key").unwrap(), "set");
        cfg.set("llm.openai.api_key", "").unwrap();
        assert_eq!(cfg.get("llm.openai.api_key").unwrap(), "");
    }

    /// The two flags that only change *how* an answer arrives ship on; the two
    /// that spend extra model calls ship off. Getting that backwards would have
    /// every install quietly paying for a planner it never asked for.
    #[test]
    fn the_coach_flags_that_cost_model_calls_are_off_by_default() {
        let mut cfg = Config::default();
        assert!(cfg.coach.ws_runs);
        assert!(cfg.coach.process_events_ui);
        assert!(cfg.coach.approach_commitment);
        assert!(!cfg.coach.planner_enabled);
        assert!(!cfg.coach.draw_review_enabled);

        for key in [
            "coach.ws_runs",
            "coach.process_events_ui",
            "coach.planner_enabled",
            "coach.draw_review_enabled",
            "coach.approach_commitment",
        ] {
            cfg.set(key, "on").unwrap();
            assert_eq!(cfg.get(key).unwrap(), "true", "{key}");
            cfg.set(key, "no").unwrap();
            assert_eq!(cfg.get(key).unwrap(), "false", "{key}");
        }
        assert!(cfg.set("coach.planner_enabled", "sometimes").is_err());
        assert!(cfg.get("coach.telepathy").is_err());
    }

    #[test]
    fn serve_port_must_be_a_port() {
        let mut cfg = Config::default();
        assert_eq!(cfg.serve.port, 7878);
        cfg.set("serve.port", "9000").unwrap();
        assert_eq!(cfg.serve.port, 9000);
        assert!(cfg.set("serve.port", "not-a-port").is_err());
        assert!(cfg.set("serve.port", "70000").is_err(), "must not overflow u16");
    }

    #[test]
    fn pair_code_is_six_digits() {
        for _ in 0..20 {
            let token = random_token();
            assert!(is_pair_code(&token), "{token}");
        }
        assert!(is_pair_code("000000"));
        assert!(is_pair_code("849201"));
        assert!(!is_pair_code("84920"));
        assert!(!is_pair_code("8492010"));
        assert!(!is_pair_code("abc123"));
    }

    #[test]
    fn clearing_the_serve_token_stores_none_not_an_empty_string() {
        let mut cfg = Config::default();
        cfg.set("serve.token", "abc").unwrap();
        assert_eq!(cfg.serve.token.as_deref(), Some("abc"));
        cfg.set("serve.token", "").unwrap();
        assert!(cfg.serve.token.is_none());
    }

    #[test]
    fn the_test_walk_defaults_to_running_every_case() {
        let mut cfg = Config::default();
        assert!(!cfg.tests.stop_on_first_failure);
        for spelling in ["true", "1", "yes", "ON"] {
            cfg.set("tests.stop_on_first_failure", spelling).unwrap();
            assert!(cfg.tests.stop_on_first_failure, "{spelling}");
        }
        cfg.set("tests.stop_on_first_failure", "no").unwrap();
        assert_eq!(cfg.get("tests.stop_on_first_failure").unwrap(), "false");
        assert!(cfg.set("tests.stop_on_first_failure", "maybe").is_err());
    }

    #[test]
    fn dataset_dirs_are_per_slug_and_reject_unknown_ones() {
        let mut cfg = Config::default();
        assert!(cfg.dataset_dir("kodcode").is_none());
        cfg.set("data.datasets.kodcode", "~/corpora/kodcode").unwrap();
        assert_eq!(cfg.dataset_dir("kodcode").as_deref(), Some("~/corpora/kodcode"));
        assert_eq!(
            cfg.get("data.datasets.kodcode").unwrap(),
            "~/corpora/kodcode"
        );
        // Clearing removes the entry rather than storing an empty path.
        cfg.set("data.datasets.kodcode", "  ").unwrap();
        assert!(cfg.dataset_dir("kodcode").is_none());
        assert!(cfg.set("data.datasets.nope", "/tmp").is_err());
    }

    /// An existing config predates every new section, so all of them must
    /// default in rather than failing the parse.
    #[test]
    fn an_older_config_still_loads() {
        let older = r#"
            [data]
            json_dir = 'C:\corpus'
            [llm]
            default_provider = "local"
            [llm.local]
            base_url = "http://localhost:8080/"
            model = "granite"
        "#;
        let cfg: Config = toml::from_str(older).expect("older config still parses");
        assert_eq!(cfg.llm.local.model, "granite");
        assert_eq!(cfg.llm.modes.ambient, "local");
        assert_eq!(cfg.serve.port, 7878);
        assert!(cfg.serve.token.is_none());
        assert!(cfg.data.datasets.is_empty(), "no dataset overrides implied");
        assert!(!cfg.tests.stop_on_first_failure);
        assert_eq!(cfg.llm.modes.planner, "local");
        assert!(cfg.coach.ws_runs, "a config written before the flags existed gets the defaults");
        assert!(!cfg.coach.planner_enabled);
    }

    #[test]
    fn vision_flag_is_the_only_gate() {
        let mut cfg = Config::default();
        cfg.llm.modes.viz = "local".into();
        cfg.llm.local.model = "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf".into();
        cfg.llm.local.vision = None;
        let viz = |cfg: &Config| {
            cfg.llm
                .modes
                .capabilities(&cfg.llm)
                .unwrap()
                .into_iter()
                .find(|row| row.mode == "viz")
                .expect("viz")
                .vision
        };
        assert!(!viz(&cfg), "unset flag means no images");
        cfg.llm.local.model = "llava".into();
        assert!(!viz(&cfg), "model name is not a capability");
        cfg.llm.local.vision = Some(true);
        cfg.llm.local.model = "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf".into();
        assert!(viz(&cfg), "explicit true sends images regardless of name");
        cfg.llm.local.vision = Some(false);
        assert!(!viz(&cfg));

        cfg.llm.modes.viz = "openai".into();
        cfg.llm.openai.model = "gpt-4o-mini".into();
        cfg.llm.openai.vision = None;
        assert!(!viz(&cfg), "OpenAI id is not a capability either");
        cfg.llm.openai.vision = Some(true);
        assert!(viz(&cfg));

        cfg.llm.modes.viz = "ollama".into();
        cfg.llm.ollama.model = "llava".into();
        cfg.llm.ollama.vision = None;
        assert!(!viz(&cfg));
        cfg.llm.ollama.vision = Some(true);
        assert!(viz(&cfg));

        cfg.llm.modes.viz = "groq".into();
        cfg.llm.groq.model = "llama-4-scout".into();
        cfg.llm.groq.vision = None;
        assert!(!viz(&cfg));
        cfg.llm.groq.vision = Some(true);
        assert!(viz(&cfg));
    }
}
