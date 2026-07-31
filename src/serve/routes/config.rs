//! Config and local LLM lifecycle routes.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError, Shared};
use crate::config::Config;
use crate::dataset;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderConfigDto {
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModesConfigDto {
    pub ambient: String,
    pub review: String,
    pub bridge: String,
    pub viz: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigDto {
    pub data_json_dir: Option<String>,
    /// Per-dataset corpus folders, keyed by dataset slug. Only the ones the
    /// user overrode are present.
    #[serde(default)]
    pub dataset_dirs: std::collections::BTreeMap<String, String>,
    pub workspace_dir: String,
    pub python_executable: String,
    /// Settings → Tests: stop at the first failing case instead of running
    /// every case.
    #[serde(default)]
    pub stop_on_first_failure: bool,
    pub default_provider: String,
    pub local: ProviderConfigDto,
    pub ollama: ProviderConfigDto,
    pub openai: ProviderConfigDto,
    pub groq: ProviderConfigDto,
    pub modes: ModesConfigDto,
    pub serve_port: u16,
    /// Present on GET only — never echo the secret.
    #[serde(default)]
    pub token_set: bool,
}

fn config_dto(cfg: &Config) -> ConfigDto {
    ConfigDto {
        data_json_dir: cfg.data.json_dir.clone(),
        dataset_dirs: cfg.data.datasets.clone(),
        workspace_dir: cfg.workspace.dir.clone(),
        python_executable: cfg.python.executable.clone(),
        stop_on_first_failure: cfg.tests.stop_on_first_failure,
        default_provider: cfg.llm.default_provider.clone(),
        local: ProviderConfigDto {
            base_url: cfg.llm.local.base_url.clone(),
            model: cfg.llm.local.model.clone(),
            vision_model: cfg.llm.local.vision_model.clone(),
        },
        ollama: ProviderConfigDto {
            base_url: cfg.llm.ollama.base_url.clone(),
            model: cfg.llm.ollama.model.clone(),
            vision_model: cfg.llm.ollama.vision_model.clone(),
        },
        openai: ProviderConfigDto {
            base_url: cfg.llm.openai.base_url.clone(),
            model: cfg.llm.openai.model.clone(),
            vision_model: cfg.llm.openai.vision_model.clone(),
        },
        groq: ProviderConfigDto {
            base_url: cfg.llm.groq.base_url.clone(),
            model: cfg.llm.groq.model.clone(),
            vision_model: cfg.llm.groq.vision_model.clone(),
        },
        modes: ModesConfigDto {
            ambient: cfg.llm.modes.ambient.clone(),
            review: cfg.llm.modes.review.clone(),
            bridge: cfg.llm.modes.bridge.clone(),
            viz: cfg.llm.modes.viz.clone(),
        },
        serve_port: cfg.serve.port,
        token_set: cfg
            .serve
            .token
            .as_ref()
            .is_some_and(|t| !t.trim().is_empty()),
    }
}

fn apply_config_dto(cfg: &mut Config, dto: &ConfigDto) -> anyhow::Result<()> {
    cfg.data.json_dir = dto
        .data_json_dir
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    cfg.data.datasets = dto
        .dataset_dirs
        .iter()
        .filter(|(slug, dir)| dataset::get(slug).is_ok() && !dir.trim().is_empty())
        .map(|(slug, dir)| (slug.clone(), dir.trim().to_string()))
        .collect();
    cfg.workspace.dir = dto.workspace_dir.clone();
    cfg.python.executable = dto.python_executable.clone();
    cfg.tests.stop_on_first_failure = dto.stop_on_first_failure;
    cfg.set("llm.default_provider", &dto.default_provider)?;
    cfg.llm.local.base_url = dto.local.base_url.clone();
    cfg.llm.local.model = dto.local.model.clone();
    cfg.llm.local.vision_model = dto.local.vision_model.clone();
    cfg.llm.ollama.base_url = dto.ollama.base_url.clone();
    cfg.llm.ollama.model = dto.ollama.model.clone();
    cfg.llm.ollama.vision_model = dto.ollama.vision_model.clone();
    cfg.llm.openai.base_url = dto.openai.base_url.clone();
    cfg.llm.openai.model = dto.openai.model.clone();
    cfg.llm.openai.vision_model = dto.openai.vision_model.clone();
    cfg.llm.groq.base_url = dto.groq.base_url.clone();
    cfg.llm.groq.model = dto.groq.model.clone();
    cfg.llm.groq.vision_model = dto.groq.vision_model.clone();
    cfg.set("llm.modes.ambient", &dto.modes.ambient)?;
    cfg.set("llm.modes.review", &dto.modes.review)?;
    cfg.set("llm.modes.bridge", &dto.modes.bridge)?;
    cfg.set("llm.modes.viz", &dto.modes.viz)?;
    cfg.serve.port = dto.serve_port;
    Ok(())
}

pub async fn get_config(State(state): State<Shared>) -> Result<Json<ConfigDto>, AppError> {
    Ok(Json(config_dto(&state.cfg_snapshot())))
}

pub async fn put_config(
    State(state): State<Shared>,
    Json(dto): Json<ConfigDto>,
) -> Result<Json<ConfigDto>, AppError> {
    let mut cfg = state.cfg_snapshot();
    let updated = blocking(move || {
        apply_config_dto(&mut cfg, &dto)?;
        cfg.save()?;
        Ok(cfg)
    })
    .await?;
    {
        let mut guard = state.cfg.write().unwrap_or_else(|e| e.into_inner());
        *guard = updated.clone();
    }
    Ok(Json(config_dto(&updated)))
}

pub async fn llm_status(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(blocking(move || Ok(crate::llm::lifecycle::status(&cfg))).await?))
}

pub async fn llm_start(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(
        blocking(move || crate::llm::lifecycle::start_local_llm(&cfg)).await?,
    ))
}

pub async fn llm_stop(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(
        blocking(move || crate::llm::lifecycle::stop_local_llm(&cfg)).await?,
    ))
}
