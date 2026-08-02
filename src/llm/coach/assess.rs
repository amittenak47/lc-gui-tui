//! Mode A staged review orchestration: perceive → claim → (verdict | on-track) → optional code pass.
//!
//! Why this exists: one call that perceives, names, judges, and cites all at
//! once gives a small VLM every reason to invent a flaw — the schema has a
//! `gaps` array in it, so it fills the array. Splitting the work means the stage
//! that decides "is this enough?" is never the stage that was asked to find
//! something wrong, and the daemon — not the model — owns the gate between them.
//!
//! Stage 1 describes the board. Stage 2 names the claim and says whether it
//! decides the answer. Stage 3 runs *only* when stage 2 said no.

use anyhow::Result;

use crate::generator::WorkspaceMeta;
use crate::llm::{ChatMessage, ChatRequest, LlmProvider};

use super::approach::CoachContext;
use super::board::BoardSnapshot;
use super::events::EventSink;
use super::modes::review::{merge_layout_and_code_reviews, parse_review, ReviewResponse};
use super::prompts::{
    build_claim_code_review_prompt, build_claim_prompt, build_perceive_prompt,
    build_review_prompt, build_verdict_prompt, CLAIM_CODE_SYSTEM_PROMPT, CLAIM_SYSTEM_PROMPT,
    PERCEIVE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, VERDICT_SYSTEM_PROMPT,
};
use super::stages::{
    on_track_review_from_claim, parse_claim, parse_perception, Claim, Perception,
};
use super::trace::retrace_counterexample;

/// Result of [`review_submission`]: the card to show, plus the frozen claim
/// when the staged path ran (Lazy / follow-ups can reuse it).
#[derive(Debug, Clone)]
pub struct ReviewOutcome {
    pub review: ReviewResponse,
    pub claim: Option<Claim>,
}

/// Terminal coach: question + `solution.py` only — no whiteboard layout pass,
/// no `[layout]` / `[code]` merge prefixes.
pub fn review_submission_text_only(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    question: &str,
    solution: &str,
    app_messages: &[String],
    turn_index: u32,
) -> Result<ReviewOutcome> {
    let board = BoardSnapshot {
        recognized_text: if question.trim().is_empty() {
            String::new()
        } else {
            format!("Student question (terminal):\n{}", question.trim())
        },
        pseudocode: Some(solution.to_string()),
        app_messages: app_messages.to_vec(),
        turn_index,
        ..Default::default()
    };

    let has_approach = !question.trim().is_empty() || solution.trim().len() > 8;

    let (mut review, claim) = if has_approach {
        if let Ok((claim, review)) = staged_board_review(provider, meta, description, &board) {
            (review, Some(claim))
        } else {
            let prompt = build_review_prompt(meta, description, &board);
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                    ChatMessage::user(prompt),
                ])
                .json(),
            )?;
            (parse_review(&reply.content, &meta.cases)?, None)
        }
    } else {
        let prompt = build_review_prompt(meta, description, &board);
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                ChatMessage::user(prompt),
            ])
            .json(),
        )?;
        (parse_review(&reply.content, &meta.cases)?, None)
    };

    retrace_counterexample(provider, meta, &board, &mut review);
    Ok(ReviewOutcome { review, claim })
}

/// Run Mode A against a board snapshot.
///
/// - With layout/ink/question text: perceive (if PNG) → claim → verdict only
///   when the claim is insufficient; optional code pass when `include_code`.
/// - Otherwise: single-call [`REVIEW_SYSTEM_PROMPT`] fallback.
///
/// GUI callers attach PNG / scene structure on `board`; TUI leaves those unset
/// and puts the typed question in `recognized_text` plus `solution.py` in
/// `pseudocode`.
pub fn review_submission(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    include_code: bool,
) -> Result<ReviewOutcome> {
    review_submission_with_events(
        provider,
        meta,
        description,
        board,
        include_code,
        &CoachContext::default(),
        &EventSink::none(),
    )
}

/// [`review_submission`], reporting each stage boundary to `events`.
///
/// The stages are the same ones and in the same order; the sink only observes.
/// A cancelled sink stops the sequence between stages rather than mid-call —
/// the provider is blocking HTTP and owns its own timeout.
pub fn review_submission_with_events(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    include_code: bool,
    ctx: &CoachContext,
    events: &EventSink,
) -> Result<ReviewOutcome> {
    let has_layout =
        board.has_visual_evidence() || !board.recognized_text.trim().is_empty();
    let has_code = include_code
        && board
            .pseudocode
            .as_deref()
            .is_some_and(|p| p.trim().len() > 8);

    let staged = if has_layout {
        staged_board_review_with_events(provider, meta, description, board, ctx, events).ok()
    } else {
        None
    };

    let (mut review, claim) = match staged {
        Some((claim, board_review)) => {
            let review = if has_code {
                if let Some(err) = events.cancelled_error() {
                    return Err(err);
                }
                events.stage("code", "checking solution.py against that claim");
                let code_prompt =
                    build_claim_code_review_prompt(meta, description, board, &claim, ctx);
                let code_reply = provider.chat_ex(
                    &ChatRequest::new(vec![
                        ChatMessage::system(CLAIM_CODE_SYSTEM_PROMPT),
                        ChatMessage::user(code_prompt),
                    ])
                    .json(),
                )?;
                let code = parse_review(&code_reply.content, &meta.cases)?;
                merge_layout_and_code_reviews(board_review, code)
            } else {
                board_review
            };
            (review, Some(claim))
        }
        None => {
            // The staged path degrades to one call when a stage came back
            // unusable — but a *cancelled* run must not degrade into spending
            // another call on an answer nobody is waiting for.
            if let Some(err) = events.cancelled_error() {
                return Err(err);
            }
            events.stage("verdict", "reading it in one pass");
            let prompt = build_review_prompt(meta, description, board);
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                    ChatMessage::user(prompt).with_images(board.images()),
                ])
                .json(),
            )?;
            (parse_review(&reply.content, &meta.cases)?, None)
        }
    };

    if review.counterexample.is_some() {
        events.stage("retrace", "re-tracing the case it cited");
    }
    retrace_counterexample(provider, meta, board, &mut review);
    events.stage("done", "");
    Ok(ReviewOutcome { review, claim })
}

/// Stages 1–3: describe the board, name its claim, and judge only when the
/// claim does not already decide the answer.
pub fn staged_board_review(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, ReviewResponse)> {
    staged_board_review_with_events(
        provider,
        meta,
        description,
        board,
        &CoachContext::default(),
        &EventSink::none(),
    )
}

/// [`staged_board_review`] with stage reporting.
pub fn staged_board_review_with_events(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    ctx: &CoachContext,
    events: &EventSink,
) -> Result<(Claim, ReviewResponse)> {
    let (claim, _) =
        perceive_and_claim_with_events(provider, meta, description, board, ctx, events)?;

    if claim.decides_the_answer() {
        // The gate the whole pipeline turns on: a claim that decides the answer
        // never reaches a stage that was asked to find something wrong.
        events.stage("verdict", "the claim already decides it — no fault-finding pass");
        return Ok((claim.clone(), on_track_review_from_claim(&claim)));
    }

    if let Some(err) = events.cancelled_error() {
        return Err(err);
    }
    events.stage("verdict", "judging that claim against the sample cases");
    let prompt = build_verdict_prompt(meta, description, board, &claim, ctx);
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![
            ChatMessage::system(VERDICT_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(board.images()),
        ])
        .json(),
    )?;
    let mut review = parse_review(&reply.content, &meta.cases)?;
    review.understood_approach = claim.understood_approach.clone();
    Ok((claim, review))
}

/// Stages 1 and 2. Stage 1 runs only when there is a PNG; text-only boards go
/// straight to the claim.
pub fn perceive_and_claim(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, Option<Perception>)> {
    perceive_and_claim_with_events(
        provider,
        meta,
        description,
        board,
        &CoachContext::default(),
        &EventSink::none(),
    )
}

/// [`perceive_and_claim`] with stage reporting.
pub fn perceive_and_claim_with_events(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    ctx: &CoachContext,
    events: &EventSink,
) -> Result<(Claim, Option<Perception>)> {
    let perception = if board.png.is_some() {
        events.stage("perceive", "describing what is on the board");
        let prompt = build_perceive_prompt(meta, board);
        provider
            .chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(PERCEIVE_SYSTEM_PROMPT),
                    ChatMessage::user(prompt).with_images(board.images()),
                ])
                .json()
                .with_temperature(0.0),
            )
            .and_then(|reply| parse_perception(&reply.content))
            .ok()
    } else {
        None
    };

    if let Some(err) = events.cancelled_error() {
        return Err(err);
    }
    events.stage("claim", "naming the approach your board argues for");
    let prompt = build_claim_prompt(meta, description, board, perception.as_ref(), ctx);
    let mut message = ChatMessage::user(prompt);
    if perception.is_none() {
        message = message.with_images(board.images());
    }
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![ChatMessage::system(CLAIM_SYSTEM_PROMPT), message]).json(),
    )?;
    let claim = parse_claim(&reply.content)?;
    Ok((claim, perception))
}
