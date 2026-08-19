//! The coach endpoints: `POST /coach/review` (Mode A) and the gated
//! `POST /coach/reveal` (Phase 5).
//!
//! Neither handler builds a prompt itself — that is
//! [`crate::llm::coach`]'s job. What lives here is the HTTP plumbing and, in
//! `reveal`, the consent gate. Review staging gates live in
//! [`crate::llm::coach::review_submission`].

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::common::{description_for, load_meta, resolve_dataset};
use super::{blocking, board_session, AppError, Shared};
use crate::llm::coach::{
    build_ask_prompt, build_bridge_prompt, build_lazy_fill_prompt, build_lazy_hint_prompt,
    build_planner_prompt, build_scaffold_prompt, parse_board_scaffold, parse_bridge,
    parse_lazy_fill, parse_plan, perceive_and_claim, review_submission_with_events,
    ApproachCandidate, ApproachOutcome, ApproachPlan, ApproachTransition, BoardScaffold,
    BoardSnapshot, BridgeResponse, Claim, CoachContext, EventSink, LazyFillResponse,
    ReviewResponse, ASK_SYSTEM_PROMPT, BRIDGE_SYSTEM_PROMPT, LAZY_FILL_SYSTEM_PROMPT,
    LAZY_HINT_SYSTEM_PROMPT, PLANNER_SYSTEM_PROMPT, SCAFFOLD_SYSTEM_PROMPT,
};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest};
use crate::llm::docs::{preset_system, run_document_ask, AskContext};
use crate::llm::reasoning::ReasoningEffort;
use crate::llm::helpers::clip;
use crate::pad::AgentSurface;
use crate::reveal::{SolutionReveal, UserConsent};
use crate::runner;
use crate::session::Session;

// ---------------------------------------------------------------------------
// Capabilities (vision / provider per mode)
// ---------------------------------------------------------------------------

pub async fn capabilities(State(state): State<Shared>) -> Result<Json<serde_json::Value>, AppError> {
    let cfg = state.cfg_snapshot();
    let modes = cfg
        .llm
        .modes
        .capabilities(&cfg.llm)
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "modes": modes })))
}

// ---------------------------------------------------------------------------
// Mode A — submit for review
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    pub task_id: String,
    /// Which corpus `task_id` belongs to. Absent = the default LeetCode one.
    #[serde(default)]
    pub dataset: Option<String>,
    /// Composer Lazy: the student is drawing — ignore the code dock for review.
    #[serde(default)]
    pub layout_only: bool,
    #[serde(flatten)]
    pub board: BoardSnapshot,
}

#[derive(Debug, Serialize)]
pub struct ReviewEnvelope {
    pub task_id: String,
    pub provider: String,
    #[serde(flatten)]
    pub review: ReviewResponse,
    /// Set when this review moved the session's committed approach. The card
    /// shows it as a note: a switch the student was not told about is the
    /// flip-flop the commitment model exists to prevent, and a switch they
    /// *were* told about is the coach being honest about a board that changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approach_transition: Option<ApproachTransition>,
    /// Alternatives worth naming when the board has not settled which approach
    /// it is arguing for. Offered as text under the confirming question —
    /// never picked for the student.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidate_approaches: Vec<ApproachCandidate>,
}

pub async fn review(
    State(state): State<Shared>,
    Json(request): Json<ReviewRequest>,
) -> Result<Json<ReviewEnvelope>, AppError> {
    Ok(Json(run_review(&state, request, EventSink::none()).await?))
}

/// The review, without the HTTP wrapper.
///
/// Both entry points land here: `POST /coach/review` passes
/// [`EventSink::none`], and the socket's `run` frame passes a live sink so the
/// chat can show each stage as it starts. Nothing else differs — one code path
/// means the two transports cannot drift.
pub async fn run_review(
    state: &Shared,
    request: ReviewRequest,
    events: EventSink,
) -> Result<ReviewEnvelope, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    // Board baselines are keyed per corpus: `two-sum` is a different board in
    // each of the three datasets that has one.
    let board_key = dataset.key(&request.task_id);
    let commitment_enabled = state.cfg_snapshot().coach.approach_commitment;
    let mut board = request.board.clone();
    {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        board = board_session::resolve_board_snapshot(session, board);
        if let Some(pseudo) = board_session::resolve_pseudocode(session, &board) {
            board.pseudocode = Some(pseudo);
        }
    }

    if board.is_empty() {
        return Err(AppError::bad_request(anyhow!(
            "the board is empty — sketch an approach before submitting"
        )));
    }

    let board_for_prompt = board.clone();
    let layout_only = request.layout_only;
    let task_id_for_llm = request.task_id.clone();
    let cfg = state.cfg_snapshot();
    ensure_catalog(state, dataset, &request.task_id, &board_key, &events).await;
    // What the session already decided, read before the model runs so every
    // stage after the claim is handed the same committed approach.
    let ctx = if cfg.coach.approach_commitment {
        let mut store = state.board_sessions.lock().await;
        store.entry(&board_key).coach_context()
    } else {
        CoachContext::default()
    };
    let outcome = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id_for_llm)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;

        let outcome = review_submission_with_events(
            &*provider,
            &meta,
            description.as_deref(),
            &board_for_prompt,
            /* include_code */ !layout_only,
            &ctx,
            &events,
        )?;

        Ok(ReviewHttpOutcome {
            envelope: ReviewEnvelope {
                task_id: meta.task_id,
                provider: provider.label(),
                review: outcome.review,
                approach_transition: None,
                candidate_approaches: Vec::new(),
            },
            claim: outcome.claim,
        })
    })
    .await?;
    let ReviewHttpOutcome {
        mut envelope,
        claim,
    } = outcome;

    // Advance the server baseline only after a successful review.
    {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        if let Some(structure) = board.scene_structure.as_ref() {
            let ids: Vec<String> = structure
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.get("id").and_then(|id| id.as_str()).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            session.acknowledge_review(ids);
        }
        if let Some(pseudo) = board.pseudocode.as_deref() {
            session.acknowledge_pseudocode(pseudo);
        }
        // Hand the frozen claim to whatever comes next for this board — Lazy
        // fill arrives as its own request a moment later, and it should write
        // code for the claim the student just read, not for a second reading.
        if let Some(claim) = claim {
            let fingerprint = board_session::drawn_board_fingerprint(&board);
            if commitment_enabled {
                let outcome = session.observe_claim(fingerprint, &claim);
                if let ApproachOutcome::Transitioned(transition) = outcome {
                    envelope.approach_transition = Some(transition);
                }
                envelope.candidate_approaches = session.approach().candidates_for(&claim);
                // A commitment that held against drift is the *committed*
                // approach the student is coaching, not the one this reading
                // named — say so on the card rather than silently disagreeing
                // with the sentence right above it.
                if let Some(committed) = session.approach().committed.as_ref() {
                    envelope.review.understood_approach = committed.name.clone();
                }
            }
            session.remember_claim(fingerprint, claim);
        }
    }

    Ok(envelope)
}

/// Run the planner once per task, if it is enabled and has not run yet.
///
/// Deliberately best-effort: a planner that is down, misconfigured, or answers
/// with something unusable must cost nothing but the call. The whole coach
/// works with an empty catalog — that is the default — so a failure here is a
/// missing hint, not a failed review.
///
/// The skip rules are what keep it to one call: the catalog is per board
/// session, a task switch clears the session, and a non-empty catalog is never
/// rebuilt.
pub(crate) async fn ensure_catalog(
    state: &Shared,
    dataset: &'static crate::dataset::Dataset,
    task_id: &str,
    board_key: &str,
    events: &EventSink,
) {
    let cfg = state.cfg_snapshot();
    if !cfg.coach.planner_enabled {
        return;
    }
    {
        let mut store = state.board_sessions.lock().await;
        if store.entry(board_key).approach().has_catalog() {
            return;
        }
    }

    events.stage("plan_approaches", "cataloging the approaches this problem admits");
    let task_id = task_id.to_string();
    let planned: Option<ApproachPlan> = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "planner")?;
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(PLANNER_SYSTEM_PROMPT),
                ChatMessage::user(build_planner_prompt(&meta, description.as_deref())),
            ])
            .json()
            .with_temperature(0.2),
        )?;
        parse_plan(&reply.content)
    })
    .await
    .ok();

    let Some(plan) = planned else {
        events.stage("plan_approaches", "no usable plan — coaching from the board alone");
        return;
    };
    let named = plan.candidate_approaches.len();
    {
        let mut store = state.board_sessions.lock().await;
        store.entry(board_key).approach_mut().set_plan(plan);
    }
    events.stage(
        "plan_approaches",
        format!("{named} approach families worth recognizing"),
    );
}

/// A review, plus the claim it froze (when the staged path ran).
struct ReviewHttpOutcome {
    envelope: ReviewEnvelope,
    claim: Option<Claim>,
}

// ---------------------------------------------------------------------------
// Phase 5 — opt-in reveal
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RevealRequest {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
    /// Must be `true`. The client sets this from a confirmation dialog, and
    /// there is no config, header, or default that can stand in for it.
    #[serde(default)]
    pub confirm_reveal: bool,
    /// `bridge` (default) = stepwise path; `lazy` = fill earned solution code.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub board: BoardSnapshot,
}

#[derive(Debug, Serialize)]
pub struct RevealEnvelope {
    pub task_id: String,
    pub provider: String,
    /// How many times this problem has been revealed, across sessions.
    pub reveal_count: u32,
    #[serde(flatten)]
    pub bridge: BridgeResponse,
    /// Present when `mode` was `lazy` — full solution.py text to write back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lazy_note: Option<String>,
}

/// The only caller of [`UserConsent::from_explicit_user_action`] in the whole
/// crate. Guarded on an explicit request flag, never on config or a tool call.
pub async fn reveal(
    State(state): State<Shared>,
    Json(request): Json<RevealRequest>,
) -> Result<Json<RevealEnvelope>, AppError> {
    if !request.confirm_reveal {
        return Err(AppError::bad_request(anyhow!(
            "revealing the reference solution needs an explicit confirmation — \
             set \"confirm_reveal\": true from the confirmation dialog"
        )));
    }

    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let lazy_mode = request
        .mode
        .as_deref()
        .is_some_and(|m| m.eq_ignore_ascii_case("lazy"));
    let cfg = state.cfg_snapshot();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &request.task_id)?;
        let description = description_for(&meta);

        let failing = runner::load_last_run()?
            .filter(|run| run.task_id == meta.task_id)
            .map(|run| {
                run.results
                    .into_iter()
                    .filter(|result| !result.pass)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let reference = SolutionReveal::load(
            Path::new(&meta.json_path),
            &meta.task_id,
            UserConsent::from_explicit_user_action(),
        )
        .with_context(|| format!("cannot reveal the reference for {}", meta.task_id))?;

        let provider = make_provider_for_mode(&cfg, "bridge")?;
        let (bridge, filled_code, lazy_note) = if lazy_mode {
            let prompt = build_lazy_hint_prompt(
                &meta,
                description.as_deref(),
                &request.board,
                reference.text(),
            );
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(LAZY_HINT_SYSTEM_PROMPT),
                    ChatMessage::user(prompt),
                ])
                .json(),
            )?;
            let fill = parse_lazy_fill(&reply.content)?;
            (
                BridgeResponse {
                    already_yours: fill.note.clone(),
                    missing_piece: "Lazy fill wrote the parts your board already justified — finish the TODOs yourself.".into(),
                    steps: vec![],
                    smallest_edit: "Run the tests on the filled stubs, then tackle the TODOs.".into(),
                },
                Some(fill.filled_code),
                Some(fill.note),
            )
        } else {
            let prompt = build_bridge_prompt(
                &meta,
                description.as_deref(),
                &request.board,
                reference.text(),
                &failing,
            );
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(BRIDGE_SYSTEM_PROMPT),
                    ChatMessage::user(prompt),
                ])
                .json(),
            )?;
            (parse_bridge(&reply.content)?, None, None)
        };

        let mut session = Session::load_or_new()?;
        let reveal_count = session.mark_revealed(&meta.key())?;

        Ok(RevealEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            reveal_count,
            bridge,
            filled_code,
            lazy_note,
        })
    })
    .await?;
    Ok(Json(envelope))
}

/// Composer Lazy flag — fill earned code from the board only (no reference).
#[derive(Debug, Deserialize)]
pub struct LazyRequest {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
    #[serde(default)]
    pub board: BoardSnapshot,
}

#[derive(Debug, Serialize)]
pub struct LazyEnvelope {
    pub task_id: String,
    pub provider: String,
    #[serde(flatten)]
    pub fill: LazyFillResponse,
}

pub async fn lazy_fill(
    State(state): State<Shared>,
    Json(request): Json<LazyRequest>,
) -> Result<Json<LazyEnvelope>, AppError> {
    Ok(Json(run_lazy_fill(&state, request, EventSink::none()).await?))
}

/// Lazy fill without the HTTP wrapper — see [`run_review`] for why.
///
/// Lazy is deliberately thin on stages: it reads the claim a review already
/// froze rather than forming a new opinion of the board, so there is nothing
/// between "start" and "wrote the code" worth narrating.
pub async fn run_lazy_fill(
    state: &Shared,
    request: LazyRequest,
    events: EventSink,
) -> Result<LazyEnvelope, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let mut board = request.board.clone();
    let board_key = dataset.key(&request.task_id);
    let commitment_enabled = state.cfg_snapshot().coach.approach_commitment;
    let (frozen_claim, ctx) = {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        board = board_session::resolve_board_snapshot(session, board);
        if let Some(pseudo) = board_session::resolve_pseudocode(session, &board) {
            board.pseudocode = Some(pseudo);
        }
        (
            session.claim_for(board_session::drawn_board_fingerprint(&board)),
            if commitment_enabled {
                session.coach_context()
            } else {
                CoachContext::default()
            },
        )
    };
    if board.is_empty() {
        return Err(AppError::bad_request(anyhow!(
            "the board is empty — sketch an approach before asking for a lazy fill"
        )));
    }

    let cfg = state.cfg_snapshot();
    let task_id = request.task_id.clone();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;
        // Normally the review that just ran left the claim behind, and Lazy
        // implements exactly what the student saw on their card. When Lazy is
        // used without a review — or after redrawing — derive one, so the fill
        // still works from a stated claim rather than a fresh guess at the ink.
        let claim = match frozen_claim {
            Some(claim) => {
                events.stage("lazy", "implementing the claim your review froze");
                Some(claim)
            }
            None => {
                events.stage("claim", "no frozen claim for this board — re-reading it");
                perceive_and_claim(&*provider, &meta, description.as_deref(), &board)
                    .ok()
                    .map(|(claim, _)| claim)
            }
        };
        if let Some(err) = events.cancelled_error() {
            return Err(err);
        }
        events.stage("lazy", "writing the parts the board already justifies");
        let prompt =
            build_lazy_fill_prompt(&meta, description.as_deref(), &board, claim.as_ref(), &ctx);
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(LAZY_FILL_SYSTEM_PROMPT),
                ChatMessage::user(prompt).with_images(board.images()),
            ])
            .json(),
        )?;
        let fill = parse_lazy_fill(&reply.content)?;
        events.stage("done", "");
        Ok(LazyEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            fill,
        })
    })
    .await?;
    Ok(envelope)
}

// ---------------------------------------------------------------------------
// Fresh-board region scaffolding (problem load)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ScaffoldRequest {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScaffoldEnvelope {
    pub task_id: String,
    pub provider: String,
    #[serde(flatten)]
    pub scaffold: BoardScaffold,
}

pub async fn scaffold(
    State(state): State<Shared>,
    Json(request): Json<ScaffoldRequest>,
) -> Result<Json<ScaffoldEnvelope>, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let task_id = request.task_id.clone();
    let cfg = state.cfg_snapshot();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;
        let prompt = build_scaffold_prompt(&meta, description.as_deref());
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(SCAFFOLD_SYSTEM_PROMPT),
                ChatMessage::user(prompt),
            ])
            .json(),
        )?;
        let scaffold = parse_board_scaffold(&reply.content)?;
        Ok(ScaffoldEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            scaffold,
        })
    })
    .await?;
    Ok(Json(envelope))
}

// ---------------------------------------------------------------------------
// Ask — single-turn Q&A (no staged perceive → claim → verdict pipeline)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AskRequest {
    /// What is open: `whiteboard` | `annotate` | `problem`.
    ///
    /// Older clients omit this and put a fake corpus slug in [`dataset`].
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub task_id: String,
    /// Corpus slug when [`surface`] is `problem`. Ignored for pads.
    #[serde(default)]
    pub dataset: Option<String>,
    pub question: String,
    /// Base64 PNGs the student attached to this question.
    ///
    /// A photo of a page, a screenshot, a diagram from somewhere else — things
    /// the board cannot hold because they were never drawn. Unlike the board
    /// PNGs the review pipeline sends, these are attached explicitly and are
    /// the whole reason the question is being asked, so they go up whatever the
    /// provider is: the endpoint picks its vision model when a message carries
    /// images and falls back to the plain one when no vision model is set.
    #[serde(default)]
    pub images: Vec<String>,
    /// Content hash of the open document. Present on annotate Asks that should
    /// prefetch RAG chunks and offer document tools.
    #[serde(default)]
    pub document_hash: Option<String>,
    /// 1-based page the reader is on.
    #[serde(default)]
    pub page: Option<u32>,
    /// Exact highlighted string, if any.
    #[serde(default)]
    pub highlight: String,
    /// Text of the current page, already clipped by the client.
    #[serde(default)]
    pub page_text: String,
    /// Packed mark prose for `list_document_marks`.
    #[serde(default)]
    pub marks_prose: String,
    /// Slash preset: `de_jargon` | `explain_math` | `analyze_methodology` | `reverse_engineer`.
    #[serde(default)]
    pub preset: Option<String>,
    /// Ask the model to think out loud. Local servers get think-mode flags;
    /// the full text lands in [`AskEnvelope::reasoning`] and a WS `reasoning` frame.
    #[serde(default)]
    pub reasoning: bool,
    /// `low` / `medium` / `high`. Absent with `reasoning: true` means on, no budget.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEventDto {
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub ts: u64,
}

impl From<&crate::llm::coach::CoachEvent> for ProcessEventDto {
    fn from(event: &crate::llm::coach::CoachEvent) -> Self {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        match event {
            crate::llm::coach::CoachEvent::Stage { stage, detail } => Self {
                kind: "stage".into(),
                label: stage.clone(),
                detail: if detail.is_empty() {
                    None
                } else {
                    Some(detail.clone())
                },
                status: None,
                ts,
            },
            crate::llm::coach::CoachEvent::Tool {
                name,
                status,
                summary,
                ..
            } => Self {
                kind: "tool".into(),
                label: name.clone(),
                detail: Some(summary.clone()),
                status: Some(status.as_str().to_string()),
                ts,
            },
            crate::llm::coach::CoachEvent::Reasoning { text } => Self {
                kind: "reasoning".into(),
                label: "reasoning".into(),
                detail: Some(text.clone()),
                status: None,
                ts,
            },
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AskEnvelope {
    pub task_id: String,
    pub provider: String,
    pub reply: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposed_annotations: Vec<crate::llm::docs::ProposedAnnotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub process_events: Vec<ProcessEventDto>,
}

pub async fn ask(
    State(state): State<Shared>,
    Json(request): Json<AskRequest>,
) -> Result<Json<AskEnvelope>, AppError> {
    let bag = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = EventSink::new({
        let bag = bag.clone();
        move |ev| {
            if let Ok(mut lock) = bag.lock() {
                lock.push(ProcessEventDto::from(&ev));
            }
        }
    });
    let mut envelope = run_ask(&state, request, events).await?;
    let (process, reasoning) = split_process_and_reasoning(&bag);
    envelope.process_events = process;
    envelope.reasoning = reasoning;
    Ok(Json(envelope))
}

fn split_process_and_reasoning(
    bag: &std::sync::Mutex<Vec<ProcessEventDto>>,
) -> (Vec<ProcessEventDto>, String) {
    let all = bag.lock().map(|g| g.clone()).unwrap_or_default();
    let mut reasoning = String::new();
    let mut process = Vec::new();
    for event in all {
        if event.kind == "reasoning" {
            if let Some(text) = event.detail.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if !reasoning.is_empty() {
                    reasoning.push_str("\n\n");
                }
                reasoning.push_str(text);
            }
        } else {
            process.push(event);
        }
    }
    (process, reasoning)
}

/// Ask without the HTTP wrapper — see [`run_review`] for why.
pub async fn run_ask(
    state: &Shared,
    request: AskRequest,
    events: EventSink,
) -> Result<AskEnvelope, AppError> {
    let question = request.question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::bad_request(anyhow!("type a question first")));
    }
    let task_id = request.task_id.clone();
    let dataset_slug = request.dataset.clone();
    let images = request.images.clone();
    let surface = crate::pad::parse_surface(
        request.surface.as_deref(),
        dataset_slug.as_deref(),
        &task_id,
    );
    let document_hash = request
        .document_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let document_ask = matches!(surface, AgentSurface::Annotate) && document_hash.is_some();
    let page = request.page;
    let highlight = request.highlight.clone();
    let page_text = request.page_text.clone();
    let marks_prose = request.marks_prose.clone();
    let preset = request.preset.clone();
    let effort = request
        .reasoning_effort
        .as_deref()
        .and_then(ReasoningEffort::parse);
    let want_reasoning = request.reasoning || effort.is_some();
    let local_pad = surface.is_pad();
    let dataset = if local_pad {
        None
    } else {
        let AgentSurface::Problem { dataset: slug } = &surface else {
            unreachable!("non-pad is Problem");
        };
        Some(resolve_dataset(Some(slug))?)
    };
    let board_key = crate::pad::session_key(&surface, &task_id);
    let cfg = state.cfg_snapshot();
    let ctx = {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        let full = session.coach_context();
        if cfg.coach.approach_commitment {
            full
        } else {
            CoachContext {
                catalog: full.catalog,
                ..CoachContext::default()
            }
        }
    };
    let envelope = blocking(move || {
        let (meta, description) = match &surface {
            AgentSurface::Whiteboard => (
                crate::pad::whiteboard_meta(),
                Some(crate::pad::WHITEBOARD_DESCRIPTION.to_string()),
            ),
            AgentSurface::Annotate => (
                crate::pad::annotate_meta(),
                Some(crate::pad::ANNOTATE_DESCRIPTION.to_string()),
            ),
            AgentSurface::Problem { .. } => {
                let dataset = dataset.expect("dataset resolved before blocking");
                let meta = load_meta(&cfg, dataset, &task_id)?;
                let description = description_for(&meta);
                (meta, description)
            }
        };
        let provider = make_provider_for_mode(&cfg, "review")?;
        events.stage(
            "ask",
            if document_ask {
                "answering from the document"
            } else {
                "answering from the problem statement and your code"
            },
        );
        let mut prompt = build_ask_prompt(&meta, description.as_deref(), &question, &ctx);
        if document_ask {
            let hash = document_hash.as_deref().expect("document_ask implies hash");
            let query = if highlight.trim().is_empty() {
                question.as_str()
            } else {
                highlight.as_str()
            };
            events.stage("prefetch", "looking up earlier pages");
            let retrieved = match crate::docs_index::db_path()
                .and_then(|path| crate::docs_index::open(&path))
                .and_then(|conn| {
                    crate::docs_index::retrieve(
                        &conn,
                        hash,
                        query,
                        crate::docs_index::prefetch_k(),
                        &cfg,
                    )
                }) {
                Ok(chunks) => crate::docs_index::format_retrieval(&chunks),
                Err(_) => String::new(),
            };
            if !retrieved.is_empty() {
                prompt.push('\n');
                prompt.push_str(&retrieved);
            }
            if !highlight.trim().is_empty() {
                prompt.push_str("\n## Highlighted passage\n\n");
                prompt.push_str(&clip(highlight.trim(), 2000));
                prompt.push('\n');
            }
            if !page_text.trim().is_empty() {
                prompt.push_str("\n## Current page\n\n");
                prompt.push_str(&clip(page_text.trim(), 2000));
                prompt.push('\n');
            }
            let ask_ctx = AskContext {
                document_hash: document_hash.clone(),
                page,
                highlight,
                page_text,
                marks_prose,
                retrieved,
            };
            let (reply, proposed) = run_document_ask(
                provider.as_ref(),
                &cfg,
                preset_system(preset.as_deref()),
                prompt,
                images,
                &ask_ctx,
                &events,
                want_reasoning,
                effort,
            )?;
            events.stage("done", "");
            return Ok(AskEnvelope {
                task_id: meta.task_id,
                provider: provider.label(),
                reply,
                reasoning: String::new(),
                proposed_annotations: proposed,
                process_events: Vec::new(),
            });
        }
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(ASK_SYSTEM_PROMPT),
                ChatMessage::user(prompt).with_images(images),
            ])
            .with_reasoning(want_reasoning)
            .with_reasoning_effort(effort),
        )?;
        events.emit_reasoning(&reply.reasoning);
        events.stage("done", "");
        Ok(AskEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            reply: reply.content.trim().to_string(),
            reasoning: String::new(),
            proposed_annotations: Vec::new(),
            process_events: Vec::new(),
        })
    })
    .await?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::generator::WorkspaceMeta;
    use crate::llm::coach::{
        merge_layout_and_code_reviews, retrace_counterexample, staged_board_review, Rating,
        ReviewResponse, Verdict, CLAIM_CODE_SYSTEM_PROMPT, CLAIM_SYSTEM_PROMPT,
        PERCEIVE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, TRACE_SYSTEM_PROMPT, VERDICT_SYSTEM_PROMPT,
    };
    use crate::llm::{ChatReply, ChatRequest, LlmProvider};
    use crate::problem::IoCase;

    /// A provider that hands back canned replies in order and remembers every
    /// system prompt it was called with. The gates are the point of the staged
    /// pipeline, so what the tests assert is *which stages ran* — a live model
    /// cannot tell you that, and a mock can.
    struct ScriptedProvider {
        replies: RefCell<Vec<String>>,
        systems: RefCell<Vec<String>>,
    }

    impl ScriptedProvider {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: RefCell::new(replies.iter().rev().map(|r| r.to_string()).collect()),
                systems: RefCell::new(Vec::new()),
            }
        }

        /// Which stages ran, in order, named by the system prompt each used.
        fn stages(&self) -> Vec<&'static str> {
            self.systems
                .borrow()
                .iter()
                .map(|system| match system.as_str() {
                    s if s == PERCEIVE_SYSTEM_PROMPT => "perceive",
                    s if s == CLAIM_SYSTEM_PROMPT => "claim",
                    s if s == VERDICT_SYSTEM_PROMPT => "verdict",
                    s if s == CLAIM_CODE_SYSTEM_PROMPT => "code",
                    s if s == TRACE_SYSTEM_PROMPT => "retrace",
                    s if s == REVIEW_SYSTEM_PROMPT => "one-shot",
                    _ => "other",
                })
                .collect()
        }
    }

    impl LlmProvider for ScriptedProvider {
        fn label(&self) -> String {
            "scripted".into()
        }

        fn chat(&self, _system: &str, _user: &str) -> Result<String> {
            unreachable!("the coach only uses chat_ex")
        }

        fn chat_ex(&self, req: &ChatRequest) -> Result<ChatReply> {
            self.systems.borrow_mut().push(
                req.messages
                    .first()
                    .map(|m| m.content.clone())
                    .unwrap_or_default(),
            );
            let reply = self
                .replies
                .borrow_mut()
                .pop()
                .ok_or_else(|| anyhow!("the scripted provider ran out of replies"))?;
            Ok(ChatReply {
                content: reply,
                tool_calls: Vec::new(),
                reasoning: String::new(),
            })
        }
    }

    fn meta() -> WorkspaceMeta {
        WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: "reverse-integer".into(),
            question_id: Some("7".into()),
            difficulty: Some("Medium".into()),
            tags: vec![],
            entry_point: Some("reverse".into()),
            json_path: "corpus.jsonl".into(),
            cases: (0..3)
                .map(|i| IoCase {
                    input: format!("x = {i}0"),
                    output: format!("{i}"),
                })
                .collect(),
            test: None,
        }
    }

    fn drawn_board() -> BoardSnapshot {
        BoardSnapshot {
            recognized_text: "reverse twice, trailing zero is lost".into(),
            ..Default::default()
        }
    }

    const SUFFICIENT_CLAIM: &str = r#"{
        "understood_approach": "a trailing zero cannot survive a double reversal",
        "key_steps": ["reverse once", "the zero is gone and cannot come back"],
        "claim_sufficient": true,
        "why_sufficient_or_not": "the argument decides every allowed input",
        "confirming_question": "which case shows the zero disappearing?"
    }"#;

    /// Acceptance criteria 1 and 4: a claim that decides the answer never reaches
    /// a stage that hunts for flaws, and there is nothing left to re-trace.
    #[test]
    fn a_sufficient_claim_short_circuits_before_anything_looks_for_a_flaw() {
        let provider = ScriptedProvider::new(&[SUFFICIENT_CLAIM]);
        let meta = meta();
        let (claim, review) =
            staged_board_review(&provider, &meta, None, &drawn_board()).expect("staged");

        assert_eq!(provider.stages(), vec!["claim"], "no verdict call, no second look");
        assert!(claim.decides_the_answer());
        assert_eq!(review.verdict, Verdict::OnTrack);
        assert!(review.gaps.is_empty());
        assert!(review.counterexample.is_none());

        // And with no counterexample there is nothing for the re-trace to do, so
        // it makes no call either.
        let mut review = review;
        retrace_counterexample(&provider, &meta, &drawn_board(), &mut review);
        assert_eq!(provider.stages(), vec!["claim"], "re-trace only runs on a real citation");
    }

    /// The other side of the gate: when the claim says it is not enough, the
    /// verdict stage runs — and the claim it was handed survives the round trip
    /// even though the model tried to rename their idea.
    #[test]
    fn an_insufficient_claim_runs_the_verdict_stage_with_the_claim_frozen() {
        let provider = ScriptedProvider::new(&[
            r#"{"understood_approach": "reverse the digits and compare",
                "claim_sufficient": false,
                "why_sufficient_or_not": "nothing decides what happens past 32 bits",
                "unresolved": ["overflow"]}"#,
            r#"{"understood_approach": "SOMETHING THEY NEVER WROTE",
                "verdict": "subtly_wrong", "rating": {"correctness": 3},
                "gaps": ["overflow is undecided"],
                "counterexample": {"case_index": 1, "why_your_approach_fails": "case 1 overflows"},
                "socratic_question": "what does the range allow?"}"#,
        ]);
        let (claim, review) =
            staged_board_review(&provider, &meta(), None, &drawn_board()).expect("staged");

        assert_eq!(provider.stages(), vec!["claim", "verdict"]);
        assert!(!claim.decides_the_answer());
        assert_eq!(review.verdict, Verdict::SubtlyWrong);
        assert_eq!(
            review.understood_approach, "reverse the digits and compare",
            "the claim is frozen — the verdict stage does not get to rename their idea"
        );
        assert_eq!(review.counterexample.expect("cited").case_number, 2);
    }

    /// Stage 1 exists for the image. With a PNG attached it runs; without one the
    /// layout and the ink are already text and the two stages collapse into one
    /// call, which is the difference between two calls and three on the build
    /// where calls are most expensive.
    #[test]
    fn the_describe_pass_runs_only_when_there_is_an_image_to_describe() {
        let seen = r#"{"observations": ["a box with 120 above an arrow"]}"#;

        let with_png = ScriptedProvider::new(&[seen, SUFFICIENT_CLAIM]);
        let board = BoardSnapshot {
            png: Some("base64".into()),
            ..drawn_board()
        };
        staged_board_review(&with_png, &meta(), None, &board).expect("staged");
        assert_eq!(with_png.stages(), vec!["perceive", "claim"]);

        let text_only = ScriptedProvider::new(&[SUFFICIENT_CLAIM]);
        staged_board_review(&text_only, &meta(), None, &drawn_board()).expect("staged");
        assert_eq!(text_only.stages(), vec!["claim"]);

        // A malformed description is not worth failing a review over: stage 2
        // runs anyway, and gets the image itself instead.
        let bad_describe = ScriptedProvider::new(&["not json at all", SUFFICIENT_CLAIM]);
        staged_board_review(&bad_describe, &meta(), None, &board).expect("staged");
        assert_eq!(bad_describe.stages(), vec!["perceive", "claim"]);
    }

    /// Acceptance criterion 3, end to end through the merge: the code pass runs,
    /// disagrees, and still cannot drag an on-track board claim down.
    #[test]
    fn the_code_pass_cannot_downgrade_an_on_track_board_claim() {
        let provider = ScriptedProvider::new(&[SUFFICIENT_CLAIM]);
        let (claim, board_review) =
            staged_board_review(&provider, &meta(), None, &drawn_board()).expect("staged");

        let code = ReviewResponse {
            understood_approach: "an empty stub".into(),
            verdict: Verdict::WrongTrack,
            rating: Rating {
                correctness: 1,
                complexity: 1,
                clarity: 1,
            },
            gaps: vec!["does not implement the actual reversal logic".into()],
            offer_bridge: true,
            ..Default::default()
        };
        let merged = merge_layout_and_code_reviews(board_review, code);

        assert_eq!(merged.verdict, Verdict::OnTrack);
        assert_eq!(merged.layout_verdict, Some(Verdict::OnTrack));
        assert_eq!(merged.code_verdict, Some(Verdict::WrongTrack), "still reported to the UI");
        assert!(
            merged.gaps.is_empty(),
            "a half-typed dock does not owe the student invented gaps: {:?}",
            merged.gaps
        );
        assert!(merged.counterexample.is_none());
        assert!(merged.understood_approach.contains(&claim.understood_approach));
    }

    /// A claim the parser cannot use must not cost the student their review — the
    /// caller degrades to the single-call path instead.
    #[test]
    fn an_unusable_claim_fails_the_staged_path_rather_than_the_review() {
        let provider = ScriptedProvider::new(&[r#"{"claim_sufficient": true}"#]);
        assert!(
            staged_board_review(&provider, &meta(), None, &drawn_board()).is_err(),
            "a claim with no approach named is not something to build a card from"
        );
        assert_eq!(provider.stages(), vec!["claim"]);
    }

    /// Lazy reads the claim the review froze, and asks for no stages of its own.
    #[test]
    fn lazy_reuses_a_frozen_claim_instead_of_re_reading_the_board() {
        let provider = ScriptedProvider::new(&[SUFFICIENT_CLAIM]);
        let (claim, _) =
            staged_board_review(&provider, &meta(), None, &drawn_board()).expect("staged");

        let mut store = board_session::BoardSessionStore::default();
        let session = store.entry("leetcode/reverse-integer");
        let board = board_session::resolve_board_snapshot(session, drawn_board());
        let fingerprint = board_session::drawn_board_fingerprint(&board);
        session.remember_claim(fingerprint, claim.clone());

        // The Lazy request arrives with the code dock omitted; the drawing is
        // what the fingerprint is taken over, so the claim still matches.
        let lazy_send = board_session::resolve_board_snapshot(
            session,
            BoardSnapshot {
                pseudocode: None,
                ..drawn_board()
            },
        );
        let found = session
            .claim_for(board_session::drawn_board_fingerprint(&lazy_send))
            .expect("the claim the review just froze");
        assert_eq!(found.understood_approach, claim.understood_approach);

        let prompt = build_lazy_fill_prompt(&meta(), None, &lazy_send, Some(&found), &Default::default());
        assert!(prompt.contains("full working Python for the claim above"));
    }

    /// What the socket relays is the pipeline's own shape, not a schedule: the
    /// perceive pass only reports when there was an image to describe, and the
    /// verdict stage reports either way — including the on-track path, where
    /// what it says is that no fault-finding call was made.
    #[test]
    fn the_stage_events_match_the_stages_that_actually_ran() {
        use std::sync::{Arc, Mutex};
        use crate::llm::coach::{review_submission_with_events, CoachEvent, EventSink};

        fn record() -> (EventSink, Arc<Mutex<Vec<String>>>) {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = {
                let seen = Arc::clone(&seen);
                EventSink::new(move |event| {
                    if let CoachEvent::Stage { stage, .. } = event {
                        seen.lock().unwrap().push(stage);
                    }
                })
            };
            (sink, seen)
        }

        let seen_image = r#"{"observations": ["a box with 120 above an arrow"]}"#;
        let board_with_png = BoardSnapshot {
            png: Some("base64".into()),
            ..drawn_board()
        };

        let (sink, events) = record();
        let provider = ScriptedProvider::new(&[seen_image, SUFFICIENT_CLAIM]);
        review_submission_with_events(
            &provider,
            &meta(),
            None,
            &board_with_png,
            false,
            &Default::default(),
            &sink,
        )
            .expect("staged");
        assert_eq!(provider.stages(), vec!["perceive", "claim"]);
        assert_eq!(
            *events.lock().unwrap(),
            vec!["perceive", "claim", "verdict", "done"],
            "the verdict event is how the student learns nothing went looking for a flaw"
        );

        // Insufficient claim + a code dock: the two extra model calls each get
        // their own stage, and the cited case adds the re-trace.
        let (sink, events) = record();
        let provider = ScriptedProvider::new(&[
            r#"{"understood_approach": "reverse the digits and compare",
                "claim_sufficient": false, "why_sufficient_or_not": "overflow undecided"}"#,
            r#"{"verdict": "subtly_wrong", "rating": {"correctness": 3},
                "gaps": ["overflow is undecided"],
                "counterexample": {"case_index": 1, "why_your_approach_fails": "case 1 overflows"},
                "socratic_question": "what does the range allow?"}"#,
            r#"{"verdict": "subtly_wrong", "rating": {"correctness": 3}}"#,
            r#"{"walks_through": true, "still_fails": true, "why": "still overflows"}"#,
        ]);
        let board = BoardSnapshot {
            pseudocode: Some("def reverse(x):\n    return int(str(x)[::-1])".into()),
            ..drawn_board()
        };
        review_submission_with_events(&provider, &meta(), None, &board, true, &Default::default(), &sink)
            .expect("staged");
        assert_eq!(
            *events.lock().unwrap(),
            vec!["claim", "verdict", "code", "retrace", "done"],
            "no perceive event without a PNG, and no retrace event without a citation"
        );
    }

    /// Cancelling is checked between stages, so a run the student walked away
    /// from stops before it spends the next call rather than after the last.
    #[test]
    fn a_cancelled_sink_stops_the_pipeline_at_the_next_stage_boundary() {
        use std::sync::atomic::Ordering;
        use crate::llm::coach::{review_submission_with_events, EventSink};

        let sink = EventSink::new(|_| {});
        sink.cancel_handle().unwrap().store(true, Ordering::Relaxed);

        let provider = ScriptedProvider::new(&[SUFFICIENT_CLAIM]);
        let failed = review_submission_with_events(
            &provider,
            &meta(),
            None,
            &drawn_board(),
            false,
            &Default::default(),
            &sink,
        );
        assert!(failed.is_err(), "a cancelled run must not return a card");
        assert!(
            provider.stages().is_empty(),
            "and must not have spent a model call: {:?}",
            provider.stages()
        );
    }

    /// Verification step 7: no code path from `/coach/review` or
    /// `WS /coach/session` can construct a `SolutionReveal`.
    #[test]
    fn only_the_reveal_handler_can_consent() {
        let reveal_handler = include_str!("coach.rs");
        let ambient_handler = include_str!("ws.rs");
        let route_sources = [
            ("routes/corpus.rs", include_str!("routes/corpus.rs")),
            ("routes/practice.rs", include_str!("routes/practice.rs")),
            ("routes/workspace.rs", include_str!("routes/workspace.rs")),
            ("routes/config.rs", include_str!("routes/config.rs")),
            ("routes/attempt.rs", include_str!("routes/attempt.rs")),
        ];
        let viz_handler = include_str!("viz.rs");
        // The planner is the newest way a model could learn the answer, and the
        // one most likely to be pointed at a frontier API. It reads the same
        // redacted sources `lc ask` does and nothing else.
        let planner = include_str!("../llm/coach/planner.rs");
        // The draw review is the only path that sends a rendered picture back
        // to a model. It gets the diagram and the problem, never the answer.
        let draw_review = include_str!("../llm/coach/actions/draw_review.rs");

        let consent_call = concat!("UserConsent::from_explicit_user_action", "()");
        assert_eq!(
            reveal_handler.matches(consent_call).count(),
            1,
            "the reveal handler is the only place allowed to grant consent"
        );
        for (name, source) in route_sources.into_iter().chain([
            ("ws.rs", ambient_handler),
            ("viz.rs", viz_handler),
            ("llm/coach/planner.rs", planner),
            ("llm/coach/actions/draw_review.rs", draw_review),
        ]) {
            assert!(
                !source.contains("SolutionReveal") && !source.contains("UserConsent"),
                "{name} must not be able to reach the reveal path"
            );
        }

        let review_start = reveal_handler.find("pub async fn review(").expect("review handler");
        let review_end = reveal_handler[review_start..]
            .find("// Phase 5")
            .expect("Phase 5 banner follows review")
            + review_start;
        let review_body = &reveal_handler[review_start..review_end];
        assert!(
            !review_body.contains("Reveal") && !review_body.contains("Consent"),
            "the review handler must not touch the reveal path"
        );

        // `ensure_catalog` builds the planner call. Its inputs are the same
        // three the review path uses; a `SolutionReveal` cannot appear in it
        // without the whole-file assertion above failing, but the prompt it
        // hands over must not carry the corpus's answer either.
        let planner_start = reveal_handler
            .find("pub(crate) async fn ensure_catalog(")
            .expect("the planner runner");
        let planner_end = reveal_handler[planner_start..]
            .find("/// A review, plus the claim")
            .expect("the outcome struct follows")
            + planner_start;
        let planner_body = &reveal_handler[planner_start..planner_end];
        assert!(
            !planner_body.contains("solution") && !planner_body.contains("completion"),
            "the planner is built from the redacted problem, nothing else"
        );

        let lazy_start = reveal_handler
            .find("pub async fn lazy_fill(")
            .expect("lazy_fill handler");
        assert!(
            !reveal_handler[lazy_start..].contains(consent_call),
            "lazy_fill must not grant reveal consent"
        );
    }
}
