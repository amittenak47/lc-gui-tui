//! The coach endpoints: `POST /coach/review` (Mode A) and the gated
//! `POST /coach/reveal` (Phase 5).
//!
//! Neither handler builds a prompt itself — that is
//! [`crate::llm::coach`]'s job. What lives here is the plumbing and, in
//! `reveal`, the consent gate.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::routes::{description_for, load_meta};
use super::{blocking, board_session, AppError, Shared};
use crate::llm::coach::{
    build_bridge_prompt, build_code_review_prompt, build_layout_review_prompt, build_lazy_fill_prompt,
    build_lazy_hint_prompt, build_review_prompt, build_trace_prompt, merge_layout_and_code_reviews,
    parse_bridge, parse_lazy_fill, parse_review, parse_trace, BoardSnapshot, BridgeResponse,
    LazyFillResponse, ReviewResponse, BRIDGE_SYSTEM_PROMPT, LAZY_FILL_SYSTEM_PROMPT,
    LAZY_HINT_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, TRACE_SYSTEM_PROMPT,
};
use crate::dataset::{self, Dataset};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest};
use crate::reveal::{SolutionReveal, UserConsent};
use crate::runner;
use crate::session::Session;

/// A request's dataset slug, or a 400 naming the ones that exist.
pub(crate) fn resolve_dataset(slug: Option<&str>) -> Result<&'static Dataset, AppError> {
    dataset::resolve(slug).map_err(AppError::bad_request)
}

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
    #[serde(flatten)]
    pub board: BoardSnapshot,
}

#[derive(Debug, Serialize)]
pub struct ReviewEnvelope {
    pub task_id: String,
    pub provider: String,
    #[serde(flatten)]
    pub review: ReviewResponse,
}

pub async fn review(
    State(state): State<Shared>,
    Json(request): Json<ReviewRequest>,
) -> Result<Json<ReviewEnvelope>, AppError> {
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    // Board baselines are keyed per corpus: `two-sum` is a different board in
    // each of the three datasets that has one.
    let board_key = dataset.key(&request.task_id);
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
    let task_id_for_llm = request.task_id.clone();
    let cfg = state.cfg_snapshot();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id_for_llm)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;

        let has_layout = board_for_prompt.has_visual_evidence()
            || !board_for_prompt.recognized_text.trim().is_empty();
        let has_code = board_for_prompt
            .pseudocode
            .as_deref()
            .is_some_and(|p| p.trim().len() > 8);

        let mut review = if has_layout && has_code {
            // Two passes so a sparse code dock does not dominate a strong board
            // (or vice versa) — then merge into one card for the client.
            let layout_prompt =
                build_layout_review_prompt(&meta, description.as_deref(), &board_for_prompt);
            let layout_reply = provider.chat_ex(&ChatRequest::new(vec![
                ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                ChatMessage::user(layout_prompt).with_images(board_for_prompt.images()),
            ]).json())?;
            let layout = parse_review(&layout_reply.content, &meta.cases)?;

            let code_prompt =
                build_code_review_prompt(&meta, description.as_deref(), &board_for_prompt);
            let code_reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                    ChatMessage::user(code_prompt),
                ])
                .json(),
            )?;
            let code = parse_review(&code_reply.content, &meta.cases)?;
            merge_layout_and_code_reviews(layout, code)
        } else {
            let prompt = build_review_prompt(&meta, description.as_deref(), &board_for_prompt);
            let reply = provider.chat_ex(&ChatRequest::new(vec![
                ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                ChatMessage::user(prompt).with_images(board_for_prompt.images()),
            ]).json())?;
            parse_review(&reply.content, &meta.cases)?
        };

        retrace_counterexample(&*provider, &meta, &board_for_prompt, &mut review);

        Ok(ReviewEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            review,
        })
    })
    .await?;

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
    }

    Ok(Json(envelope))
}

/// Re-derive `why_your_approach_fails` from a prompt that shows only the cited
/// case.
///
/// A small local model reliably picks a real case index and then illustrates its
/// point with an input it invented — the student runs the cited case and sees
/// something else. Asking again with a single case in front of it removes the
/// wandering room. Best-effort: on any failure the model's original wording is
/// kept, because a wordy review beats no review.
fn retrace_counterexample(
    provider: &dyn crate::llm::LlmProvider,
    meta: &crate::generator::WorkspaceMeta,
    board: &BoardSnapshot,
    review: &mut ReviewResponse,
) {
    let Some(cited) = review.counterexample.as_ref() else {
        return;
    };
    let Some(case) = meta.cases.get(cited.case_index) else {
        return;
    };

    let prompt = build_trace_prompt(meta, board, case, cited.case_number);
    let messages = vec![
        ChatMessage::system(TRACE_SYSTEM_PROMPT),
        ChatMessage::user(prompt),
    ];
    let request = ChatRequest::new(messages)
        .json()
        // Low temperature and a tight cap: this is transcription, not invention.
        .with_temperature(0.0)
        .with_max_tokens(400);

    match provider
        .chat_ex(&request)
        .and_then(|reply| parse_trace(&reply.content))
    {
        Ok(trace) => {
            if let Some(cited) = review.counterexample.as_mut() {
                cited.why_your_approach_fails = trace;
            }
        }
        Err(_) => {
            // Keep the first-pass wording; it is still attached to a real case.
        }
    }
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
    let dataset = resolve_dataset(request.dataset.as_deref())?;
    let mut board = request.board.clone();
    let board_key = dataset.key(&request.task_id);
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
            "the board is empty — sketch an approach before asking for a lazy fill"
        )));
    }

    let cfg = state.cfg_snapshot();
    let task_id = request.task_id.clone();
    let envelope = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;
        let prompt = build_lazy_fill_prompt(&meta, description.as_deref(), &board);
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(LAZY_FILL_SYSTEM_PROMPT),
                ChatMessage::user(prompt).with_images(board.images()),
            ])
            .json(),
        )?;
        let fill = parse_lazy_fill(&reply.content)?;
        Ok(LazyEnvelope {
            task_id: meta.task_id,
            provider: provider.label(),
            fill,
        })
    })
    .await?;
    Ok(Json(envelope))
}

#[cfg(test)]
mod tests {
    /// Verification step 7: no code path from `/coach/review` or
    /// `WS /coach/session` can construct a `SolutionReveal`.
    #[test]
    fn only_the_reveal_handler_can_consent() {
        let reveal_handler = include_str!("coach.rs");
        let ambient_handler = include_str!("ws.rs");
        let corpus_routes = include_str!("routes.rs");
        let viz_handler = include_str!("viz.rs");

        let consent_call = concat!("UserConsent::from_explicit_user_action", "()");
        assert_eq!(
            reveal_handler.matches(consent_call).count(),
            1,
            "the reveal handler is the only place allowed to grant consent"
        );
        for (name, source) in [
            ("ws.rs", ambient_handler),
            ("routes.rs", corpus_routes),
            ("viz.rs", viz_handler),
        ] {
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

        let lazy_start = reveal_handler
            .find("pub async fn lazy_fill(")
            .expect("lazy_fill handler");
        assert!(
            !reveal_handler[lazy_start..].contains(consent_call),
            "lazy_fill must not grant reveal consent"
        );
    }
}
