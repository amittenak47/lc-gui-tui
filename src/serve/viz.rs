//! `POST /coach/viz` — Phase 4's diagram endpoint.
//!
//! The model answers by calling tools, and this handler turns those calls into
//! viz programs the client can render deterministically. Two things are enforced
//! here rather than trusted:
//!
//! - an unknown structure kind or a frameless program is dropped, because there
//!   is no renderer for it;
//! - a `cite_test_case` call is resolved against `meta.cases`, so a fabricated
//!   index never reaches the board.

use anyhow::{anyhow, Result};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::routes::{description_for, load_meta};
use super::{blocking, AppError, Shared};
use crate::llm::coach::{
    build_viz_prompt, validate_citation, Annotation, BoardSnapshot, Citation, VIZ_SYSTEM_PROMPT,
};
use crate::llm::tools::{viz_tools, VizProgram};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest};

#[derive(Debug, Deserialize)]
pub struct VizRequest {
    pub task_id: String,
    #[serde(default)]
    pub board: BoardSnapshot,
    /// What to draw. Empty means "pick whatever would help most".
    #[serde(default)]
    pub ask: String,
}

#[derive(Debug, Default, Serialize)]
pub struct VizEnvelope {
    pub task_id: String,
    pub provider: String,
    pub programs: Vec<VizProgram>,
    pub annotations: Vec<Annotation>,
    pub citations: Vec<Citation>,
    /// Any prose the model added alongside its tool calls.
    pub message: String,
    /// Tool calls dropped as unrenderable or unverifiable, for the UI to note.
    pub rejected: Vec<String>,
}

pub async fn viz(
    State(state): State<Shared>,
    Json(request): Json<VizRequest>,
) -> Result<Json<VizEnvelope>, AppError> {
    let cfg = state.cfg.clone();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, &request.task_id)?;
        let description = description_for(&meta);
        let prompt = build_viz_prompt(&meta, description.as_deref(), &request.board, &request.ask);

        let provider = make_provider_for_mode(&cfg, "viz")?;
        let messages = vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(request.board.images()),
        ];
        let reply = provider.chat_ex(&ChatRequest::new(messages).with_tools(viz_tools()))?;

        let mut envelope = VizEnvelope {
            task_id: meta.task_id.clone(),
            provider: provider.label(),
            message: reply.content.clone(),
            ..Default::default()
        };

        for call in &reply.tool_calls {
            match call.name.as_str() {
                "draw_structure" | "animate_trace" => {
                    match serde_json::from_value::<VizProgram>(call.arguments.clone()) {
                        // `rejection` covers unknown kinds, missing frames, and
                        // frames with nothing in them — the last is what a small
                        // model actually produces, and drawing an empty box is
                        // worse than saying nothing.
                        Ok(program) => match program.rejection() {
                            None => envelope.programs.push(program),
                            Some(why) => envelope.rejected.push(format!("dropped a diagram: {why}")),
                        },
                        Err(err) => envelope
                            .rejected
                            .push(format!("unreadable {} call: {err}", call.name)),
                    }
                }
                "annotate_region" => {
                    match serde_json::from_value::<Annotation>(call.arguments.clone()) {
                        Ok(annotation) if !annotation.text.trim().is_empty() => {
                            envelope.annotations.push(annotation)
                        }
                        _ => envelope
                            .rejected
                            .push("dropped an empty annotation".to_string()),
                    }
                }
                "cite_test_case" => match validate_citation(&call.arguments, &meta.cases) {
                    Some(citation) => envelope.citations.push(citation),
                    None => envelope.rejected.push(format!(
                        "dropped a citation: no such case (this problem has {} sample cases)",
                        meta.cases.len()
                    )),
                },
                other => envelope
                    .rejected
                    .push(format!("ignored an unknown tool call {other:?}")),
            }
        }

        if envelope.programs.is_empty()
            && envelope.annotations.is_empty()
            && envelope.citations.is_empty()
            && envelope.message.trim().is_empty()
        {
            return Err(anyhow!(
                "the {} model produced nothing drawable — it may not support tool calling",
                provider.label()
            ));
        }
        Ok(envelope)
    })
    .await?;
    Ok(Json(envelope))
}
