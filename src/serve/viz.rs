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
    build_draw_fix_prompt, build_draw_review_prompt, build_viz_prompt, parse_draw_review,
    validate_citation, validate_highlight, Annotation, BoardSnapshot, Citation, CoachContext,
    DrawReview, EventSink, Highlight, ToolStatus, DRAW_REVIEW_SYSTEM_PROMPT, VIZ_SYSTEM_PROMPT,
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
    let board_key = dataset.key(&request.task_id);
    // Draw is often the first thing asked on a fresh problem, so the planner
    // runs here too — and skips itself when a review already ran it.
    super::coach::ensure_catalog(state, dataset, &request.task_id, &board_key, &events).await;
    // A diagram is coaching too: it is drawn for the approach the session
    // committed to, not for whichever one the drawing model prefers. The
    // planner's viz plan rides along on the same context.
    let ctx = {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        let full = session.coach_context();
        if cfg.coach.approach_commitment {
            full
        } else {
            CoachContext {
                viz_plan: full.viz_plan,
                ..CoachContext::default()
            }
        }
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

// ---------------------------------------------------------------------------
// `POST /coach/draw_review` — the post-render check
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct DrawReviewRequest {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
    /// The program the client actually rendered.
    pub program: VizProgram,
    /// Base64 PNG of the agent-owned group for that program id.
    #[serde(default)]
    pub png: Option<String>,
    /// What the student asked for, so taste is judged against their ask.
    #[serde(default)]
    pub ask: String,
}

#[derive(Debug, Serialize)]
pub struct DrawReviewEnvelope {
    pub task_id: String,
    pub provider: String,
    #[serde(flatten)]
    pub review: DrawReview,
    /// The replacement program, when the critique found something and the redraw
    /// produced a drawable answer under the same id. `None` means leave the
    /// diagram alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<VizProgram>,
    /// Why no vision check ran, when one could not. Shown as a process line
    /// rather than an error — the schema gate already passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

pub async fn draw_review(
    State(state): State<Shared>,
    Json(request): Json<DrawReviewRequest>,
) -> Result<Json<DrawReviewEnvelope>, AppError> {
    Ok(Json(
        run_draw_review(&state, request, EventSink::none()).await?,
    ))
}

/// Look at the rendered diagram, and redraw it once if it is wrong.
///
/// Hard caps, both deliberate: one critique, one redraw. A small model asked
/// to keep improving a picture will happily make it worse three times while the
/// student watches, and the schema gate — which has teeth — has already passed.
pub async fn run_draw_review(
    state: &Shared,
    request: DrawReviewRequest,
    events: EventSink,
) -> Result<DrawReviewEnvelope, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let cfg = state.cfg_snapshot();
    if !cfg.coach.draw_review_enabled {
        return Err(AppError::bad_request(anyhow!(
            "the post-draw review is off — turn on Settings → Coach → check drawn diagrams"
        )));
    }

    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &request.task_id)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "viz")?;

        // The critique is a question about a picture. Without a vision model
        // there is no picture to ask about, and asking a text model to judge
        // the JSON it just wrote is not a second opinion.
        let vision = cfg
            .llm
            .modes
            .capabilities(&cfg.llm)?
            .into_iter()
            .find(|mode| mode.mode == "viz")
            .is_some_and(|mode| mode.vision);
        let png = request.png.as_deref().filter(|png| !png.trim().is_empty());
        let Some(png) = png.filter(|_| vision) else {
            let why = if vision {
                "draw_review skipped (no image of the diagram)"
            } else {
                "draw_review skipped (no vision)"
            };
            events.stage("draw_review", why);
            return Ok(DrawReviewEnvelope {
                task_id: meta.task_id,
                provider: provider.label(),
                review: DrawReview {
                    ok: true,
                    ..Default::default()
                },
                program: None,
                skipped: Some(why.to_string()),
            });
        };

        events.stage("draw_review", "checking the diagram against what it should show");
        let prompt =
            build_draw_review_prompt(&meta, description.as_deref(), &request.ask, &request.program);
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(DRAW_REVIEW_SYSTEM_PROMPT),
                ChatMessage::user(prompt).with_images(vec![png.to_string()]),
            ])
            .json()
            .with_temperature(0.0),
        )?;
        let review = parse_draw_review(&reply.content)?;

        if review.ok {
            events.stage("done", "the diagram says what it should");
            return Ok(DrawReviewEnvelope {
                task_id: meta.task_id,
                provider: provider.label(),
                review,
                program: None,
                skipped: None,
            });
        }

        events.stage("draw_fix", "redrawing it once");
        let fix = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(VIZ_SYSTEM_PROMPT),
                ChatMessage::user(build_draw_fix_prompt(&request.program, &review)),
            ])
            .with_tools(viz_tools()),
        );
        let replacement = fix
            .ok()
            .map(|reply| replacement_program(&reply, &request.program.id, &events))
            .unwrap_or(None);

        events.stage("done", "");
        Ok(DrawReviewEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            review,
            program: replacement,
            skipped: None,
        })
    })
    .await?;
    Ok(envelope)
}

/// The one redraw, pinned to the id it is replacing.
///
/// A fix under a different id is not a fix — it is a second diagram beside the
/// broken one. Rather than reject that outright the id is *rewritten*, because
/// the model getting the id wrong says nothing about whether the drawing is
/// better, and the client replaces a group by id.
fn replacement_program(
    reply: &ChatReply,
    original_id: &str,
    events: &EventSink,
) -> Option<VizProgram> {
    for call in &reply.tool_calls {
        if call.name != "draw_structure" && call.name != "animate_trace" {
            continue;
        }
        let Ok(mut program) = serde_json::from_value::<VizProgram>(call.arguments.clone()) else {
            continue;
        };
        program.id = original_id.to_string();
        match program.rejection() {
            None => {
                events.tool(&call.name, ToolStatus::Accepted, "redrawn", None);
                return Some(program);
            }
            Some(why) => events.tool(
                &call.name,
                ToolStatus::Rejected,
                "redraw",
                Some(format!("the redraw was dropped: {why}")),
            ),
        }
    }
    None
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
