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

use super::common::{description_for, load_meta, resolve_dataset};
use super::{blocking, AppError, Shared};
use crate::llm::coach::{
    build_viz_prompt, validate_citation, validate_highlight, Annotation, BoardSnapshot, Citation,
    CoachContext, EventSink, Highlight, ToolStatus, VIZ_SYSTEM_PROMPT,
};
use crate::llm::tools::{parse_tool_calls, viz_tools, viz_tools_as_prompt, VizProgram};
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
    Ok(Json(run_viz(&state, request, EventSink::none()).await?))
}

/// The diagram request without the HTTP wrapper.
///
/// The socket path passes a live sink, which is where the per-tool
/// accepted/rejected events come from: a student who asked for a drawing and
/// got three of five calls dropped should see that as it happens, not infer it
/// from a short diagram.
pub async fn run_viz(
    state: &Shared,
    request: VizRequest,
    events: EventSink,
) -> Result<VizEnvelope, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let cfg = state.cfg_snapshot();
    // A diagram is coaching too: it is drawn for the approach the session
    // committed to, not for whichever one the drawing model prefers.
    let ctx = if cfg.coach.approach_commitment {
        let mut store = state.board_sessions.lock().await;
        store.entry(&dataset.key(&request.task_id)).coach_context()
    } else {
        CoachContext::default()
    };
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &request.task_id)?;
        let description = description_for(&meta);
        let prompt = build_viz_prompt(
            &meta,
            description.as_deref(),
            &request.board,
            &request.ask,
            &ctx,
        );

        let provider = make_provider_for_mode(&cfg, "viz")?;
        events.stage("draw_tools", "choosing which diagram tools to call");
        let mut messages = vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(prompt.clone()).with_images(request.board.images()),
        ];
        let reply = match provider.chat_ex(&ChatRequest::new(messages.clone()).with_tools(viz_tools()))
        {
            Ok(reply) if !reply.tool_calls.is_empty() => reply,
            // Either the server refused `tools` outright (vLLM without
            // `--enable-auto-tool-choice`) or the model ignored them. Ask again
            // in plain JSON rather than telling the student the coach "produced
            // nothing drawable" — the model can describe a diagram either way.
            other => draw_without_tool_calls(&*provider, &prompt, &request.board, other)?,
        };

        events.stage("validate", "checking each call against the renderer's schema");
        let mut envelope = collect_envelope(
            &meta.task_id,
            provider.label(),
            &reply,
            &meta.cases,
            &request.board,
            &events,
        );

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
            events.stage("draw_fix", "every call was dropped — asking once more with the reasons");
            messages.push(assistant_with_tools(&reply));
            messages.push(ChatMessage::user(format!(
                "Your previous tool calls were rejected:\n- {}\n\n\
                 Fix the mistakes named above and call the tools again.",
                envelope.rejected.join("\n- ")
            )));
            if let Ok(retry) = provider.chat_ex(&ChatRequest::new(messages).with_tools(viz_tools())) {
                let retried = collect_envelope(
                    &meta.task_id,
                    provider.label(),
                    &retry,
                    &meta.cases,
                    &request.board,
                    &events,
                );
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
                "the {} model produced nothing drawable, with or without tool calls — \
                 try pointing `llm.modes.viz` at a stronger model",
                provider.label()
            ));
        }
        events.stage("done", "");
        Ok(envelope)
    })
    .await?;
    Ok(envelope)
}

/// Re-ask for the diagram as JSON, for a server that will not tool-call.
///
/// `first` is what the tools attempt produced — an error, or a reply with no
/// tool calls in it. Its content (or its error) is what comes back if the
/// fallback also comes up empty, so a genuine failure is never replaced by a
/// misleading "the model can't tool-call".
fn draw_without_tool_calls(
    provider: &dyn crate::llm::LlmProvider,
    prompt: &str,
    board: &BoardSnapshot,
    first: Result<ChatReply>,
) -> Result<ChatReply> {
    let messages = vec![
        ChatMessage::system(VIZ_SYSTEM_PROMPT),
        ChatMessage::user(format!("{prompt}\n\n{}", viz_tools_as_prompt()))
            .with_images(board.images()),
    ];
    let retried = provider.chat_ex(&ChatRequest::new(messages).json());

    match retried {
        Ok(reply) => {
            let calls = parse_tool_calls(&reply.content);
            if !calls.is_empty() {
                return Ok(ChatReply {
                    // The JSON envelope is the answer, not prose to show.
                    content: String::new(),
                    tool_calls: calls,
                });
            }
            // Nothing usable either way: prefer the first attempt's outcome,
            // which is the one that describes what actually went wrong.
            first.map(|original| {
                if original.content.trim().is_empty() {
                    reply
                } else {
                    original
                }
            })
        }
        Err(fallback_error) => first.map_err(|original| {
            if crate::llm::is_tool_calling_unsupported(&original) {
                // The server told us it cannot tool-call, and the plain-JSON
                // path failed too — that second failure is the informative one.
                fallback_error
            } else {
                original
            }
        }),
    }
}

fn collect_envelope(
    task_id: &str,
    provider: String,
    reply: &ChatReply,
    cases: &[crate::problem::IoCase],
    board: &BoardSnapshot,
    events: &EventSink,
) -> VizEnvelope {
    let mut envelope = VizEnvelope {
        task_id: task_id.to_string(),
        provider,
        message: reply.content.clone(),
        ..Default::default()
    };

    /// Accepting is quiet — the drawing itself is the evidence — but a drop
    /// gets its reason, which is the same string the envelope carries.
    fn drop_call(envelope: &mut VizEnvelope, events: &EventSink, name: &str, why: String) {
        events.tool(name, ToolStatus::Rejected, name.to_string(), Some(why.clone()));
        envelope.rejected.push(why);
    }

    for call in &reply.tool_calls {
        events.tool(&call.name, ToolStatus::Proposed, call.name.clone(), None);
        match call.name.as_str() {
            "draw_structure" | "animate_trace" => {
                match serde_json::from_value::<VizProgram>(call.arguments.clone()) {
                    Ok(program) => match program.rejection() {
                        None => {
                            events.tool(
                                &call.name,
                                ToolStatus::Accepted,
                                summarize_program(&program),
                                None,
                            );
                            envelope.programs.push(program);
                        }
                        Some(why) => drop_call(
                            &mut envelope,
                            events,
                            &call.name,
                            format!("dropped a diagram: {why}"),
                        ),
                    },
                    Err(err) => drop_call(
                        &mut envelope,
                        events,
                        &call.name,
                        format!("unreadable {} call: {err}", call.name),
                    ),
                }
            }
            "annotate_region" => {
                match serde_json::from_value::<Annotation>(call.arguments.clone()) {
                    Ok(annotation) if !annotation.text.trim().is_empty() => {
                        events.tool(
                            &call.name,
                            ToolStatus::Accepted,
                            format!("note on {}", annotation.region),
                            None,
                        );
                        envelope.annotations.push(annotation);
                    }
                    _ => drop_call(
                        &mut envelope,
                        events,
                        &call.name,
                        "dropped an empty annotation".to_string(),
                    ),
                }
            }
            "cite_test_case" => match validate_citation(&call.arguments, cases) {
                Some(citation) => {
                    events.tool(
                        &call.name,
                        ToolStatus::Accepted,
                        format!("case {}", citation.case_number),
                        None,
                    );
                    envelope.citations.push(citation);
                }
                None => drop_call(
                    &mut envelope,
                    events,
                    &call.name,
                    format!(
                        "dropped a citation: no such case (this problem has {} sample cases)",
                        cases.len()
                    ),
                ),
            },
            "highlight_student_work" => match validate_highlight(&call.arguments, board) {
                Some(highlight) => {
                    events.tool(
                        &call.name,
                        ToolStatus::Accepted,
                        format!("{} element(s)", highlight.ids.len()),
                        None,
                    );
                    envelope.highlights.push(highlight);
                }
                None => drop_call(
                    &mut envelope,
                    events,
                    &call.name,
                    "dropped a highlight: no matching element ids on the board".to_string(),
                ),
            },
            other => drop_call(
                &mut envelope,
                events,
                &call.name,
                format!("ignored an unknown tool call {other:?}"),
            ),
        }
    }
    envelope
}

fn summarize_program(program: &VizProgram) -> String {
    let title = program.title.trim();
    if title.is_empty() {
        program.id.clone()
    } else {
        title.to_string()
    }
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
