//! `POST /coach/viz` — Phase 4's diagram endpoint.
//!
//! The model answers by calling tools, and this handler turns those calls into
//! viz programs the client can render deterministically. Two things are enforced
//! here rather than trusted:
//!
//! - an unknown structure kind or a frameless program is dropped, because there
//!   is no renderer for it;
//! - a `cite_test_case` / `highlight_student_work` call is resolved against real
//!   data, so a fabricated index or id never reaches the board.

use anyhow::{anyhow, Result};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::coach::resolve_dataset;
use super::routes::{description_for, load_meta};
use super::{blocking, AppError, Shared};
use crate::llm::coach::{
    build_viz_prompt, validate_citation, validate_highlight, Annotation, BoardSnapshot, Citation,
    Highlight, VIZ_SYSTEM_PROMPT,
};
use crate::llm::tools::{viz_tools, VizProgram};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest, ChatReply, ToolCall};

#[derive(Debug, Deserialize)]
pub struct VizRequest {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
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
    pub highlights: Vec<Highlight>,
    /// Any prose the model added alongside its tool calls.
    pub message: String,
    /// Tool calls dropped as unrenderable or unverifiable, for the UI to note.
    pub rejected: Vec<String>,
}

pub async fn viz(
    State(state): State<Shared>,
    Json(request): Json<VizRequest>,
) -> Result<Json<VizEnvelope>, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let cfg = state.cfg_snapshot();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &request.task_id)?;
        let description = description_for(&meta);
        let prompt = build_viz_prompt(&meta, description.as_deref(), &request.board, &request.ask);

        let provider = make_provider_for_mode(&cfg, "viz")?;
        let mut messages = vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(request.board.images()),
        ];
        let reply = provider.chat_ex(&ChatRequest::new(messages.clone()).with_tools(viz_tools()))?;

        let mut envelope = collect_envelope(&meta.task_id, provider.label(), &reply, &meta.cases, &request.board);

        let drawable_rejected = !envelope.programs.is_empty()
            || !envelope.annotations.is_empty()
            || !envelope.citations.is_empty()
            || !envelope.highlights.is_empty();

        // One corrective retry when every drawable call failed but we have reasons.
        if !drawable_rejected
            && envelope.message.trim().is_empty()
            && !envelope.rejected.is_empty()
            && !reply.tool_calls.is_empty()
        {
            messages.push(assistant_with_tools(&reply));
            messages.push(ChatMessage::user(format!(
                "Your previous tool calls were rejected:\n- {}\n\n\
                 Fix the mistakes named above and call the tools again.",
                envelope.rejected.join("\n- ")
            )));
            if let Ok(retry) = provider.chat_ex(&ChatRequest::new(messages).with_tools(viz_tools())) {
                let retried =
                    collect_envelope(&meta.task_id, provider.label(), &retry, &meta.cases, &request.board);
                if retried.programs.is_empty()
                    && retried.annotations.is_empty()
                    && retried.citations.is_empty()
                    && retried.highlights.is_empty()
                    && retried.message.trim().is_empty()
                {
                    envelope.rejected = envelope
                        .rejected
                        .into_iter()
                        .map(|reason| format!("after a retry: {reason}"))
                        .collect();
                } else {
                    envelope = retried;
                }
            }
        }

        if envelope.programs.is_empty()
            && envelope.annotations.is_empty()
            && envelope.citations.is_empty()
            && envelope.highlights.is_empty()
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

fn collect_envelope(
    task_id: &str,
    provider: String,
    reply: &ChatReply,
    cases: &[crate::problem::IoCase],
    board: &BoardSnapshot,
) -> VizEnvelope {
    let mut envelope = VizEnvelope {
        task_id: task_id.to_string(),
        provider,
        message: reply.content.clone(),
        ..Default::default()
    };

    for call in &reply.tool_calls {
        match call.name.as_str() {
            "draw_structure" | "animate_trace" => {
                match serde_json::from_value::<VizProgram>(call.arguments.clone()) {
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
            "cite_test_case" => match validate_citation(&call.arguments, cases) {
                Some(citation) => envelope.citations.push(citation),
                None => envelope.rejected.push(format!(
                    "dropped a citation: no such case (this problem has {} sample cases)",
                    cases.len()
                )),
            },
            "highlight_student_work" => match validate_highlight(&call.arguments, board) {
                Some(highlight) => envelope.highlights.push(highlight),
                None => envelope
                    .rejected
                    .push("dropped a highlight: no matching element ids on the board".to_string()),
            },
            other => envelope
                .rejected
                .push(format!("ignored an unknown tool call {other:?}")),
        }
    }
    envelope
}

fn assistant_with_tools(reply: &ChatReply) -> ChatMessage {
    // Best-effort: providers that echo tool calls need an assistant turn before
    // the corrective user message. Content alone is enough for most local models.
    let mut summary = reply.content.clone();
    if summary.trim().is_empty() && !reply.tool_calls.is_empty() {
        summary = format!(
            "(called tools: {})",
            reply
                .tool_calls
                .iter()
                .map(|call: &ToolCall| call.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    ChatMessage::assistant(summary)
}
