//! What models a provider can actually be pointed at.
//!
//! Two sources, deliberately kept apart in the answer:
//!
//! - **the server**, asked over `/models` (or Ollama's `/api/tags`). This is
//!   the authority: an id the server does not know is an id the chat call will
//!   400 on, whatever is sitting on disk.
//! - **a folder on disk**, for the local case where the weights are downloaded
//!   but the server is pointed at one of them at a time. Scanning it is what
//!   lets Settings offer a list before anything is running.
//!
//! ## Vision
//!
//! Nothing here sets `llm.<provider>.vision`. That flag stays the user's, for
//! the reason the commit that introduced it gives: a model name is not a
//! capability, and guessing wrong means every Draw quietly ships a PNG to a
//! server that will refuse it. What this module does is *report evidence* —
//! `llama-server` advertises `multimodal` in its capability list, and a GGUF
//! folder carrying an `mmproj-*.gguf` holds the projector a vision build needs
//! — so the UI can say what it found and let the reader decide.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{expand_tilde, Config};

/// Where an entry came from, so the UI can say why an id is on the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSource {
    /// Listed by the running server.
    Server,
    /// Found in the models folder. May not be the one the server has loaded.
    Disk,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelEntry {
    /// What goes in `llm.<provider>.model`.
    pub id: String,
    pub source: ModelSource,
    /// `Some(true)` only when the server said so. Never inferred from the name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advertises_vision: Option<bool>,
    /// A projector file sits beside these weights, so the model *can* do
    /// vision if the server was launched with it. Evidence, not a capability.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_mmproj: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelCatalog {
    pub provider: String,
    pub base_url: String,
    /// Empty for a provider with no folder, or when none is configured.
    pub models_dir: String,
    pub server_reachable: bool,
    pub models: Vec<ModelEntry>,
    /// Why the list is short or empty, in the reader's terms. Never an error:
    /// a provider that will not list its models is normal, and typing the id
    /// by hand still works.
    pub notes: Vec<String>,
}

/// Everything `provider` could be pointed at, from the server and from disk.
pub fn catalog(cfg: &Config, provider: &str) -> Result<ModelCatalog> {
    let endpoint = cfg.llm.endpoint(provider);
    let base_url = endpoint.base_url.to_string();
    let api_key = api_key_for(cfg, provider);

    let mut models = Vec::new();
    let mut notes = Vec::new();

    let listed = list_from_server(&base_url, api_key.as_deref());
    let server_reachable = listed.is_ok();
    match listed {
        Ok(rows) if rows.is_empty() => {
            notes.push(format!("{base_url} answered, but listed no models."));
        }
        Ok(rows) => models.extend(rows),
        Err(err) => notes.push(format!("Could not list models from {base_url}: {err:#}")),
    }

    // The folder is a local-weights idea; a cloud provider has no such thing.
    let models_dir = if matches!(provider, "local" | "ollama") {
        cfg.llm.local.models_dir.trim().to_string()
    } else {
        String::new()
    };
    if !models_dir.is_empty() {
        match scan_dir(&expand_tilde(&models_dir)) {
            Ok(rows) if rows.is_empty() => {
                notes.push(format!("No .gguf files under {models_dir}."))
            }
            Ok(rows) => {
                // The server's own list wins on a collision: it knows what is
                // loaded, and disk only knows what was downloaded. The disk
                // evidence still merges in, because a projector beside the
                // weights is the only vision hint a server that advertises
                // nothing will ever give us.
                for row in rows {
                    match models.iter_mut().find(|seen| seen.id == row.id) {
                        Some(seen) => {
                            seen.has_mmproj |= row.has_mmproj;
                            seen.path = seen.path.take().or(row.path);
                            seen.size_bytes = seen.size_bytes.or(row.size_bytes);
                        }
                        None => models.push(row),
                    }
                }
            }
            Err(err) => notes.push(format!("Could not read {models_dir}: {err:#}")),
        }
    }

    if models.is_empty() && notes.is_empty() {
        notes.push("Nothing to list — type the model id by hand.".into());
    }
    models.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));

    Ok(ModelCatalog {
        provider: provider.to_string(),
        base_url,
        models_dir,
        server_reachable,
        models,
        notes,
    })
}

fn api_key_for(cfg: &Config, provider: &str) -> Option<String> {
    match provider {
        "openai" => crate::config::resolve_api_key("OPENAI_API_KEY", cfg.llm.openai.api_key.as_deref()),
        "groq" => crate::config::resolve_api_key("GROQ_API_KEY", cfg.llm.groq.api_key.as_deref()),
        _ => crate::config::resolve_api_key("LC_LOCAL_API_KEY", None),
    }
}

/// `GET {base_url}/models`, falling back to Ollama's native `/api/tags`.
///
/// Three shapes in the wild, all handled: OpenAI's `data[].id`, Ollama's
/// `models[].name`, and llama.cpp's `models[]` — which is the only one that
/// says anything about images, via `capabilities: ["completion", "multimodal"]`.
pub fn list_from_server(base_url: &str, api_key: Option<&str>) -> Result<Vec<ModelEntry>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let root = base_url.trim_end_matches('/');
    // The *first* failure is the one worth reporting. `/api/tags` is a fallback
    // for a bare Ollama URL; letting its 404 overwrite the real answer told a
    // Groq user their key problem was a missing Ollama endpoint.
    let mut first_error: Option<anyhow::Error> = None;

    for url in [
        format!("{root}/models"),
        format!("{}/api/tags", root.trim_end_matches("/v1")),
    ] {
        let mut request = client.get(&url);
        if let Some(key) = api_key {
            request = request.bearer_auth(key);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value = response
                    .json()
                    .with_context(|| format!("{url} did not answer with JSON"))?;
                return Ok(parse_model_list(&body));
            }
            Ok(response) => {
                let status = response.status();
                let hint = if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    " — check the API key"
                } else {
                    ""
                };
                first_error
                    .get_or_insert_with(|| anyhow::anyhow!("{url} answered {status}{hint}"));
            }
            Err(err) => {
                first_error.get_or_insert_with(|| anyhow::anyhow!("{url}: {err}"));
            }
        }
    }
    Err(first_error.unwrap_or_else(|| anyhow::anyhow!("no model list endpoint answered")))
}

/// Read whichever of the three list shapes the body happens to be.
pub fn parse_model_list(body: &serde_json::Value) -> Vec<ModelEntry> {
    let mut out: Vec<ModelEntry> = Vec::new();

    // llama.cpp / Ollama: `models[]`, with names and sometimes capabilities.
    if let Some(rows) = body.get("models").and_then(|m| m.as_array()) {
        for row in rows {
            let Some(id) = row
                .get("name")
                .or_else(|| row.get("model"))
                .or_else(|| row.get("id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let advertises_vision = row
                .get("capabilities")
                .and_then(|c| c.as_array())
                .map(|caps| {
                    caps.iter()
                        .filter_map(|c| c.as_str())
                        .any(|c| c.eq_ignore_ascii_case("multimodal") || c.eq_ignore_ascii_case("vision"))
                });
            out.push(ModelEntry {
                id: id.to_string(),
                source: ModelSource::Server,
                advertises_vision,
                has_mmproj: false,
                size_bytes: row.get("size").and_then(|s| s.as_u64()),
                path: None,
            });
        }
    }

    // OpenAI-compatible: `data[].id`. llama.cpp sends both, so merge rather
    // than choose — `data` carries ids `models` sometimes spells differently.
    if let Some(rows) = body.get("data").and_then(|d| d.as_array()) {
        for row in rows {
            let Some(id) = row
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if out.iter().any(|seen| seen.id == id) {
                continue;
            }
            out.push(ModelEntry {
                id: id.to_string(),
                source: ModelSource::Server,
                advertises_vision: None,
                has_mmproj: false,
                size_bytes: row.pointer("/meta/size").and_then(|s| s.as_u64()),
                path: None,
            });
        }
    }
    out
}

/// One entry per `.gguf` under `dir`, looking one level into subfolders.
///
/// The layout this is written for is a folder per model — weights plus an
/// optional `mmproj-*.gguf` projector beside them — but a flat folder of
/// `.gguf` files reads the same way. A projector is never itself an entry:
/// it is not something you can point `model` at.
pub fn scan_dir(dir: &Path) -> Result<Vec<ModelEntry>> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        anyhow::bail!("{} is not a folder", dir.display());
    }
    scan_one(dir, &mut out)?;
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("cannot read {}", dir.display()))?
        .flatten()
    {
        if entry.path().is_dir() {
            let _ = scan_one(&entry.path(), &mut out);
        }
    }
    Ok(out)
}

fn scan_one(dir: &Path, out: &mut Vec<ModelEntry>) -> Result<()> {
    let mut weights: Vec<(String, u64, std::path::PathBuf)> = Vec::new();
    let mut has_mmproj = false;
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("cannot read {}", dir.display()))?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        if is_projector(name) {
            has_mmproj = true;
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        weights.push((name.to_string(), size, path));
    }
    for (name, size, path) in weights {
        out.push(ModelEntry {
            id: name,
            source: ModelSource::Disk,
            advertises_vision: None,
            has_mmproj,
            size_bytes: Some(size),
            path: Some(path.display().to_string()),
        });
    }
    Ok(())
}

/// A CLIP/vision projector, not a chat model. `mmproj-F16.gguf` is the usual
/// spelling; some packagers put the prefix in the middle.
fn is_projector(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("mmproj") || lower.contains("mmproj-") || lower.contains("-mmproj")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Verbatim from `llama-server` b9591, which answers both shapes at once.
    #[test]
    fn llama_cpp_lists_the_model_and_says_it_is_multimodal() {
        let body = json!({
            "models": [{
                "name": "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf",
                "model": "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf",
                "capabilities": ["completion", "multimodal"]
            }],
            "object": "list",
            "data": [{"id": "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf", "object": "model"}]
        });
        let rows = parse_model_list(&body);
        assert_eq!(rows.len(), 1, "the two shapes name one model, not two");
        assert_eq!(rows[0].id, "Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf");
        assert_eq!(rows[0].advertises_vision, Some(true));
    }

    #[test]
    fn a_server_that_lists_no_capabilities_claims_nothing_either_way() {
        let openai = json!({"object": "list", "data": [
            {"id": "gpt-4o-mini", "object": "model"},
            {"id": "gpt-4o", "object": "model"},
        ]});
        let rows = parse_model_list(&openai);
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter().all(|row| row.advertises_vision.is_none()),
            "gpt-4o reads images, but the list does not say so and we do not guess"
        );

        let ollama = json!({"models": [
            {"name": "qwen2.5-coder:7b", "size": 4_700_000_000u64},
            {"name": "llava:13b", "size": 8_000_000_000u64},
        ]});
        let rows = parse_model_list(&ollama);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].size_bytes, Some(4_700_000_000));
        assert!(
            rows.iter().all(|row| row.advertises_vision.is_none()),
            "'llava' in the name is still not a capability"
        );
    }

    #[test]
    fn an_unreadable_body_lists_nothing_rather_than_failing() {
        assert!(parse_model_list(&json!({"error": "nope"})).is_empty());
        assert!(parse_model_list(&json!([1, 2, 3])).is_empty());
        assert!(parse_model_list(&json!({"models": [{"size": 1}]})).is_empty());
    }

    #[test]
    fn a_folder_per_model_lists_the_weights_and_notes_the_projector() {
        let root = tempfile::tempdir().expect("tmp");
        let with_vision = root.path().join("Dirk-Qwen3.8-27B-Q4");
        std::fs::create_dir_all(&with_vision).unwrap();
        std::fs::write(with_vision.join("Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf"), b"weights").unwrap();
        std::fs::write(with_vision.join("mmproj-F16.gguf"), b"projector").unwrap();
        // Text-only model, and a stray file that is not weights at all.
        let text_only = root.path().join("granite-doc-stack");
        std::fs::create_dir_all(&text_only).unwrap();
        std::fs::write(text_only.join("granite-3b.gguf"), b"weights").unwrap();
        std::fs::write(text_only.join("README.md"), b"notes").unwrap();

        let mut rows = scan_dir(root.path()).expect("scan");
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["Dirk-Qwen3.8-27B-UD-Q4_K_XL.gguf", "granite-3b.gguf"],
            "the projector is not something you can point `model` at"
        );
        assert!(rows[0].has_mmproj, "a projector sits beside these weights");
        assert!(!rows[1].has_mmproj);
        assert!(rows.iter().all(|row| row.source == ModelSource::Disk));
    }

    #[test]
    fn loose_gguf_files_in_the_folder_itself_are_found_too() {
        let root = tempfile::tempdir().expect("tmp");
        std::fs::write(root.path().join("phi-4.gguf"), b"weights").unwrap();
        let rows = scan_dir(root.path()).expect("scan");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "phi-4.gguf");
    }

    #[test]
    fn a_missing_folder_is_an_error_the_caller_can_show() {
        let err = scan_dir(Path::new("C:/no/such/models/folder")).expect_err("must fail");
        assert!(format!("{err:#}").contains("not a folder"));
    }
}
