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
    /// Absent on a client older than the planner; defaults to `local`.
    #[serde(default = "default_mode")]
    pub planner: String,
}

fn default_mode() -> String {
    "local".to_string()
}

/// Streaming-coach feature flags. Serialized flat so an older client that does
/// not know about them simply leaves them at their defaults.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CoachFlagsDto {
    pub ws_runs: bool,
    pub process_events_ui: bool,
    pub planner_enabled: bool,
    pub draw_review_enabled: bool,
    pub approach_commitment: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigDto {
    pub data_json_dir: Option<String>,
    /// Per-dataset corpus folders, keyed by dataset slug. Only the ones the
    /// user overrode are present.
    #[serde(default)]
    pub dataset_dirs: std::collections::BTreeMap<String, String>,
    pub workspace_dir: String,
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
    #[serde(default)]
    pub coach: CoachFlagsDto,
    /// Present on GET only — never echo the secret.
    #[serde(default)]
    pub token_set: bool,
    /// Write-only. `None` leaves the stored key. `Some("")` clears it. GET omits this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groq_api_key: Option<String>,
    /// Env or stored key is present. The secret itself is never returned.
    #[serde(default)]
    pub openai_key_set: bool,
    #[serde(default)]
    pub groq_key_set: bool,
}

fn config_dto(cfg: &Config) -> ConfigDto {
    ConfigDto {
        data_json_dir: cfg.data.json_dir.clone(),
        dataset_dirs: cfg.data.datasets.clone(),
        workspace_dir: cfg.workspace.dir.clone(),
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
            planner: cfg.llm.modes.planner.clone(),
        },
        serve_port: cfg.serve.port,
        coach: CoachFlagsDto {
            ws_runs: cfg.coach.ws_runs,
            process_events_ui: cfg.coach.process_events_ui,
            planner_enabled: cfg.coach.planner_enabled,
            draw_review_enabled: cfg.coach.draw_review_enabled,
            approach_commitment: cfg.coach.approach_commitment,
        },
        token_set: cfg
            .serve
            .token
            .as_ref()
            .is_some_and(|t| !t.trim().is_empty()),
        openai_api_key: None,
        groq_api_key: None,
        openai_key_set: crate::config::resolve_api_key(
            "OPENAI_API_KEY",
            cfg.llm.openai.api_key.as_deref(),
        )
        .is_some(),
        groq_key_set: crate::config::resolve_api_key(
            "GROQ_API_KEY",
            cfg.llm.groq.api_key.as_deref(),
        )
        .is_some(),
    }
}

fn apply_stored_key(slot: &mut Option<String>, incoming: Option<&str>) {
    match incoming {
        None => {}
        Some(value) if value.trim().is_empty() => *slot = None,
        Some(value) => *slot = Some(value.trim().to_string()),
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
    apply_stored_key(
        &mut cfg.llm.openai.api_key,
        dto.openai_api_key.as_deref(),
    );
    apply_stored_key(&mut cfg.llm.groq.api_key, dto.groq_api_key.as_deref());
    cfg.set("llm.modes.ambient", &dto.modes.ambient)?;
    cfg.set("llm.modes.review", &dto.modes.review)?;
    cfg.set("llm.modes.bridge", &dto.modes.bridge)?;
    cfg.set("llm.modes.viz", &dto.modes.viz)?;
    cfg.set("llm.modes.planner", &dto.modes.planner)?;
    cfg.serve.port = dto.serve_port;
    cfg.coach.ws_runs = dto.coach.ws_runs;
    cfg.coach.process_events_ui = dto.coach.process_events_ui;
    cfg.coach.planner_enabled = dto.coach.planner_enabled;
    cfg.coach.draw_review_enabled = dto.coach.draw_review_enabled;
    cfg.coach.approach_commitment = dto.coach.approach_commitment;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn apply_config_dto_does_not_wipe_embed_or_searxng() {
        let mut cfg = Config::default();
        cfg.llm.local.embed_model = "nomic".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:8081/v1".into();
        cfg.serve.searxng_url = "http://127.0.0.1:8888".into();
        let mut dto = config_dto(&cfg);
        dto.local.model = "other-chat".into();
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.local.model, "other-chat");
        assert_eq!(cfg.llm.local.embed_model, "nomic");
        assert_eq!(cfg.llm.local.embed_base_url, "http://127.0.0.1:8081/v1");
        assert_eq!(cfg.serve.searxng_url, "http://127.0.0.1:8888");
    }

    #[test]
    fn put_config_sets_and_clears_stored_api_keys_without_echoing() {
        let mut cfg = Config::default();
        let mut dto = config_dto(&cfg);
        assert!(!dto.openai_key_set);
        dto.openai_api_key = Some(" sk-test ".into());
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.openai.api_key.as_deref(), Some("sk-test"));
        let echoed = config_dto(&cfg);
        assert!(echoed.openai_key_set);
        assert!(echoed.openai_api_key.is_none());
        dto = echoed;
        dto.openai_api_key = Some(String::new());
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert!(cfg.llm.openai.api_key.is_none());
    }

    #[test]
    fn omitted_api_key_field_leaves_stored_key() {
        let mut cfg = Config::default();
        cfg.llm.groq.api_key = Some("gsk-keep".into());
        let dto = config_dto(&cfg);
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.groq.api_key.as_deref(), Some("gsk-keep"));
    }
}
