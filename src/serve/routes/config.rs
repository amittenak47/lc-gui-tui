//! Config and local LLM lifecycle routes.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError, Shared};
use crate::config::{Config, VoiceConfig};
use crate::dataset;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderConfigDto {
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
    /// None on PUT = leave the stored flag (older clients). Some(true/false) persists.
    #[serde(default)]
    pub vision: Option<bool>,
    /// None on PUT = leave toml (older Settings). Some("") = match on words.
    #[serde(default)]
    pub embed_model: Option<String>,
    #[serde(default)]
    pub embed_base_url: Option<String>,
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
pub struct VoiceConfigDto {
    pub engine: String,
    pub openai_model: String,
    pub groq_model: String,
    pub deepgram_model: String,
    pub local_base_url: String,
    pub local_model: String,
    pub vocabulary: String,
    /// `"off"` or an LLM provider. Missing or blank on PUT becomes `"off"`.
    #[serde(default)]
    pub cleanup: String,
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
    /// Folder of downloaded weights, scanned to offer a Local model list.
    #[serde(default)]
    pub models_dir: String,
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
    /// LAN pad-sync ping token. GET shows it so a tablet can type it; PUT ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_token: Option<String>,
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
    /// GET always sends the stored voice settings. PUT `None` leaves them
    /// (older clients); `Some` replaces them.
    #[serde(default)]
    pub voice: Option<VoiceConfigDto>,
    /// Write-only. `None` leaves the stored key. `Some("")` clears it. GET omits this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deepgram_api_key: Option<String>,
    /// Env or stored Deepgram key is present. The secret itself is never returned.
    #[serde(default)]
    pub deepgram_key_set: bool,
}

fn config_dto(cfg: &Config) -> ConfigDto {
    ConfigDto {
        data_json_dir: cfg.data.json_dir.clone(),
        dataset_dirs: cfg.data.datasets.clone(),
        workspace_dir: cfg.workspace.dir.clone(),
        stop_on_first_failure: cfg.tests.stop_on_first_failure,
        default_provider: cfg.llm.default_provider.clone(),
        models_dir: cfg.llm.local.models_dir.clone(),
        local: ProviderConfigDto {
            base_url: cfg.llm.local.base_url.clone(),
            model: cfg.llm.local.model.clone(),
            vision_model: cfg.llm.local.vision_model.clone(),
            vision: cfg.llm.local.vision,
            embed_model: Some(cfg.llm.local.embed_model.clone()),
            embed_base_url: Some(cfg.llm.local.embed_base_url.clone()),
        },
        ollama: ProviderConfigDto {
            base_url: cfg.llm.ollama.base_url.clone(),
            model: cfg.llm.ollama.model.clone(),
            vision_model: cfg.llm.ollama.vision_model.clone(),
            vision: cfg.llm.ollama.vision,
            embed_model: None,
            embed_base_url: None,
        },
        openai: ProviderConfigDto {
            base_url: cfg.llm.openai.base_url.clone(),
            model: cfg.llm.openai.model.clone(),
            vision_model: cfg.llm.openai.vision_model.clone(),
            vision: cfg.llm.openai.vision,
            embed_model: None,
            embed_base_url: None,
        },
        groq: ProviderConfigDto {
            base_url: cfg.llm.groq.base_url.clone(),
            model: cfg.llm.groq.model.clone(),
            vision_model: cfg.llm.groq.vision_model.clone(),
            vision: cfg.llm.groq.vision,
            embed_model: None,
            embed_base_url: None,
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
        serve_token: cfg
            .serve
            .token
            .as_ref()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()),
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
        voice: Some(VoiceConfigDto {
            engine: cfg.voice.engine.clone(),
            openai_model: cfg.voice.openai_model.clone(),
            groq_model: cfg.voice.groq_model.clone(),
            deepgram_model: cfg.voice.deepgram_model.clone(),
            local_base_url: cfg.voice.local_base_url.clone(),
            local_model: cfg.voice.local_model.clone(),
            vocabulary: cfg.voice.vocabulary.clone(),
            cleanup: cfg.voice.cleanup.clone(),
        }),
        deepgram_api_key: None,
        deepgram_key_set: crate::config::resolve_api_key(
            "DEEPGRAM_API_KEY",
            cfg.voice.deepgram_api_key.as_deref(),
        )
        .is_some(),
    }
}

fn trimmed_or_default(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
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
    if let Some(flag) = dto.local.vision {
        cfg.llm.local.vision = Some(flag);
    }
    if let Some(model) = &dto.local.embed_model {
        cfg.llm.local.embed_model = model.trim().to_string();
    }
    if let Some(url) = &dto.local.embed_base_url {
        cfg.llm.local.embed_base_url = url.trim().to_string();
    }
    cfg.llm.ollama.base_url = dto.ollama.base_url.clone();
    cfg.llm.ollama.model = dto.ollama.model.clone();
    cfg.llm.ollama.vision_model = dto.ollama.vision_model.clone();
    if let Some(flag) = dto.ollama.vision {
        cfg.llm.ollama.vision = Some(flag);
    }
    cfg.llm.local.models_dir = dto.models_dir.clone();
    cfg.llm.openai.base_url = dto.openai.base_url.clone();
    cfg.llm.openai.model = dto.openai.model.clone();
    cfg.llm.openai.vision_model = dto.openai.vision_model.clone();
    if let Some(flag) = dto.openai.vision {
        cfg.llm.openai.vision = Some(flag);
    }
    cfg.llm.groq.base_url = dto.groq.base_url.clone();
    cfg.llm.groq.model = dto.groq.model.clone();
    cfg.llm.groq.vision_model = dto.groq.vision_model.clone();
    if let Some(flag) = dto.groq.vision {
        cfg.llm.groq.vision = Some(flag);
    }
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
    if let Some(voice) = &dto.voice {
        cfg.set("voice.engine", voice.engine.trim())?;
        let defaults = VoiceConfig::default();
        cfg.voice.openai_model = trimmed_or_default(&voice.openai_model, &defaults.openai_model);
        cfg.voice.groq_model = trimmed_or_default(&voice.groq_model, &defaults.groq_model);
        cfg.voice.deepgram_model =
            trimmed_or_default(&voice.deepgram_model, &defaults.deepgram_model);
        cfg.voice.local_base_url = voice.local_base_url.trim().to_string();
        cfg.voice.local_model = trimmed_or_default(&voice.local_model, &defaults.local_model);
        cfg.voice.vocabulary = voice.vocabulary.trim().to_string();
        let cleanup = voice.cleanup.trim();
        cfg.set("voice.cleanup", if cleanup.is_empty() { "off" } else { cleanup })?;
    }
    apply_stored_key(
        &mut cfg.voice.deepgram_api_key,
        dto.deepgram_api_key.as_deref(),
    );
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

/// What `?provider=` could be pointed at. Never changes config, and never
/// sets the vision flag — see [`crate::llm::catalog`].
pub async fn llm_models(
    State(state): State<Shared>,
    Query(query): Query<ModelsQuery>,
) -> Result<Json<crate::llm::catalog::ModelCatalog>, AppError> {
    let cfg = state.cfg_snapshot();
    let provider = query.provider.unwrap_or_else(|| cfg.llm.default_provider.clone());
    if !crate::config::LLM_PROVIDERS.contains(&provider.as_str()) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "provider must be one of {}, got {provider:?}",
            crate::config::LLM_PROVIDERS.join(", ")
        )));
    }
    Ok(Json(
        blocking(move || crate::llm::catalog::catalog(&cfg, &provider)).await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    #[serde(default)]
    pub provider: Option<String>,
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
        // Older Settings omitted these fields. Changing chat must not blank them.
        dto.local.embed_model = None;
        dto.local.embed_base_url = None;
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.local.model, "other-chat");
        assert_eq!(cfg.llm.local.embed_model, "nomic");
        assert_eq!(cfg.llm.local.embed_base_url, "http://127.0.0.1:8081/v1");
        assert_eq!(cfg.serve.searxng_url, "http://127.0.0.1:8888");
    }

    #[test]
    fn apply_config_dto_writes_embed_from_settings() {
        let mut cfg = Config::default();
        let mut dto = config_dto(&cfg);
        dto.local.embed_model = Some("nomic-embed-text".into());
        dto.local.embed_base_url = Some("http://127.0.0.1:8081/v1".into());
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.local.embed_model, "nomic-embed-text");
        assert_eq!(cfg.llm.local.embed_base_url, "http://127.0.0.1:8081/v1");
        let echoed = config_dto(&cfg);
        assert_eq!(echoed.local.embed_model.as_deref(), Some("nomic-embed-text"));
        assert_eq!(
            echoed.local.embed_base_url.as_deref(),
            Some("http://127.0.0.1:8081/v1")
        );
    }

    #[test]
    fn apply_config_dto_clears_embed_when_settings_sends_empty() {
        let mut cfg = Config::default();
        cfg.llm.local.embed_model = "nomic".into();
        let mut dto = config_dto(&cfg);
        dto.local.embed_model = Some("".into());
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.local.embed_model, "");
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

    #[test]
    fn apply_config_dto_persists_vision_false_and_keeps_omitted() {
        let mut cfg = Config::default();
        cfg.llm.local.vision = Some(true);
        cfg.llm.openai.vision = Some(true);
        let mut dto = config_dto(&cfg);
        dto.local.vision = Some(false);
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.local.vision, Some(false));
        assert_eq!(cfg.llm.openai.vision, Some(true));

        dto = config_dto(&cfg);
        dto.openai.vision = None;
        dto.ollama.vision = Some(true);
        dto.groq.vision = Some(false);
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.openai.vision, Some(true), "omitted flag leaves stored");
        assert_eq!(cfg.llm.ollama.vision, Some(true));
        assert_eq!(cfg.llm.groq.vision, Some(false));
    }

    #[test]
    fn voice_settings_round_trip_and_empty_models_fall_back() {
        let mut cfg = Config::default();
        let mut dto = config_dto(&cfg);
        let voice = dto.voice.as_mut().expect("GET always includes voice");
        voice.engine = "groq".into();
        voice.openai_model = "  ".into();
        voice.groq_model = " whisper-large-v3 ".into();
        voice.deepgram_model = "nova-2".into();
        voice.local_base_url = " http://127.0.0.1:9000/v1/ ".into();
        voice.local_model = "".into();
        voice.vocabulary = "  BFS, DFS \n".into();
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.voice.engine, "groq");
        assert_eq!(cfg.voice.openai_model, "gpt-4o-mini-transcribe");
        assert_eq!(cfg.voice.groq_model, "whisper-large-v3");
        assert_eq!(cfg.voice.deepgram_model, "nova-2");
        assert_eq!(cfg.voice.local_base_url, "http://127.0.0.1:9000/v1/");
        assert_eq!(cfg.voice.local_model, "whisper-large-v3-turbo");
        assert_eq!(cfg.voice.vocabulary, "BFS, DFS");

        let echoed = config_dto(&cfg);
        assert!(echoed.voice.is_some());
        apply_config_dto(&mut cfg, &echoed).unwrap();
        assert_eq!(cfg.voice.engine, "groq");
        assert_eq!(cfg.voice.groq_model, "whisper-large-v3");
        assert_eq!(cfg.voice.vocabulary, "BFS, DFS");

        let mut bad = config_dto(&cfg);
        bad.voice.as_mut().unwrap().engine = "whisper".into();
        assert!(apply_config_dto(&mut cfg, &bad).is_err());
        assert_eq!(cfg.voice.engine, "groq");
    }

    #[test]
    fn omitted_voice_leaves_stored_voice_settings() {
        let mut cfg = Config::default();
        cfg.voice.engine = "openai".into();
        cfg.voice.openai_model = "whisper-1".into();
        cfg.voice.vocabulary = "two sum".into();
        let mut dto = config_dto(&cfg);
        dto.voice = None;
        dto.default_provider = "groq".into();
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.llm.default_provider, "groq");
        assert_eq!(cfg.voice.engine, "openai");
        assert_eq!(cfg.voice.openai_model, "whisper-1");
        assert_eq!(cfg.voice.vocabulary, "two sum");
    }

    #[test]
    fn deepgram_key_sets_clears_and_keeps() {
        let mut cfg = Config::default();
        let mut dto = config_dto(&cfg);
        assert!(dto.deepgram_api_key.is_none());
        dto.deepgram_api_key = Some(" dg-test ".into());
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.voice.deepgram_api_key.as_deref(), Some("dg-test"));
        let echoed = config_dto(&cfg);
        assert!(echoed.deepgram_api_key.is_none());
        assert!(echoed.deepgram_key_set);
        apply_config_dto(&mut cfg, &echoed).unwrap();
        assert_eq!(cfg.voice.deepgram_api_key.as_deref(), Some("dg-test"));
        let mut clearing = echoed;
        clearing.deepgram_api_key = Some(String::new());
        apply_config_dto(&mut cfg, &clearing).unwrap();
        assert!(cfg.voice.deepgram_api_key.is_none());
    }

    #[test]
    fn voice_cleanup_round_trips_and_blank_means_off() {
        let mut cfg = Config::default();
        assert_eq!(config_dto(&cfg).voice.unwrap().cleanup, "off");

        let mut dto = config_dto(&cfg);
        dto.voice.as_mut().unwrap().cleanup = " local ".into();
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.voice.cleanup, "local");
        assert_eq!(config_dto(&cfg).voice.unwrap().cleanup, "local");

        dto = config_dto(&cfg);
        dto.voice.as_mut().unwrap().cleanup = "  ".into();
        apply_config_dto(&mut cfg, &dto).unwrap();
        assert_eq!(cfg.voice.cleanup, "off");

        dto = config_dto(&cfg);
        dto.voice.as_mut().unwrap().cleanup = "whisper".into();
        let err = apply_config_dto(&mut cfg, &dto).unwrap_err().to_string();
        assert!(err.contains("off"), "{err}");
        assert!(err.contains("local"), "{err}");
        assert!(err.contains("ollama"), "{err}");
        assert!(err.contains("openai"), "{err}");
        assert!(err.contains("groq"), "{err}");
        assert_eq!(cfg.voice.cleanup, "off");
    }
}
