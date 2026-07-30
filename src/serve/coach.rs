//! The coach endpoints: `POST /coach/review` (Mode A) and the gated
//! `POST /coach/reveal` (Phase 5).
//!
//! Neither handler builds a prompt itself — that is
//! [`crate::llm::coach`]'s job. What lives here is the plumbing, the staged
//! review pipeline's gates (`staged_board_review`), and, in `reveal`, the
//! consent gate. Both kinds of gate are the same idea: the decision is Rust
//! reading a parsed value, never a rule a prompt asks a model to respect.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::routes::{description_for, load_meta};
use super::{blocking, board_session, AppError, Shared};
use crate::llm::coach::{
    build_bridge_prompt, build_claim_code_review_prompt, build_claim_prompt, build_lazy_fill_prompt,
    build_lazy_hint_prompt, build_perceive_prompt, build_review_prompt, build_trace_prompt,
    build_verdict_prompt, merge_layout_and_code_reviews, on_track_review_from_claim, parse_bridge,
    parse_claim, parse_lazy_fill, parse_perception, parse_review, parse_trace, BoardSnapshot,
    BridgeResponse, Claim, LazyFillResponse, Perception, ReviewResponse, BRIDGE_SYSTEM_PROMPT,
    CLAIM_CODE_SYSTEM_PROMPT, CLAIM_SYSTEM_PROMPT, LAZY_FILL_SYSTEM_PROMPT, LAZY_HINT_SYSTEM_PROMPT,
    PERCEIVE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, TRACE_SYSTEM_PROMPT, VERDICT_SYSTEM_PROMPT,
};
use crate::dataset::{self, Dataset};
use crate::generator::WorkspaceMeta;
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest, LlmProvider};
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
    let layout_only = request.layout_only;
    let task_id_for_llm = request.task_id.clone();
    let cfg = state.cfg_snapshot();
    let outcome = blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id_for_llm)?;
        let description = description_for(&meta);
        let provider = make_provider_for_mode(&cfg, "review")?;

        let has_layout = board_for_prompt.has_visual_evidence()
            || !board_for_prompt.recognized_text.trim().is_empty();
        let has_code = !layout_only
            && board_for_prompt
                .pseudocode
                .as_deref()
                .is_some_and(|p| p.trim().len() > 8);

        let staged = if has_layout {
            // The gated path: perceive, claim, and judge only what the claim
            // leaves open. Falls back below if a stage returns nothing usable —
            // a broken pipeline should cost the student a plainer review, not
            // their whole submission.
            staged_board_review(&*provider, &meta, description.as_deref(), &board_for_prompt).ok()
        } else {
            // Nothing drawn — there is no board to perceive and no claim to
            // freeze, so the single-call review is the honest shape here.
            None
        };

        let (mut review, claim) = match staged {
            Some((claim, board_review)) => {
                let review = if has_code {
                    // Board-first merge: the code pass answers "does this match
                    // the claim?", and cannot talk an on-track board down.
                    let code_prompt = build_claim_code_review_prompt(
                        &meta,
                        description.as_deref(),
                        &board_for_prompt,
                        &claim,
                    );
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
                let prompt = build_review_prompt(&meta, description.as_deref(), &board_for_prompt);
                let reply = provider.chat_ex(
                    &ChatRequest::new(vec![
                        ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                        ChatMessage::user(prompt).with_images(board_for_prompt.images()),
                    ])
                    .json(),
                )?;
                (parse_review(&reply.content, &meta.cases)?, None)
            }
        };

        // Only reached when a counterexample survived the gated verdict stage:
        // the on-track path emits none, so a correct board never pays for this
        // call.
        retrace_counterexample(&*provider, &meta, &board_for_prompt, &mut review);

        Ok(ReviewOutcome {
            envelope: ReviewEnvelope {
                task_id: meta.task_id,
                provider: provider.label(),
                review,
            },
            claim,
        })
    })
    .await?;
    let ReviewOutcome { envelope, claim } = outcome;

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
            session.remember_claim(board_session::drawn_board_fingerprint(&board), claim);
        }
    }

    Ok(Json(envelope))
}

/// A review, plus the claim it froze (when the staged path ran).
struct ReviewOutcome {
    envelope: ReviewEnvelope,
    claim: Option<Claim>,
}

/// Stages 1–3: describe the board, name its claim, and judge only when the
/// claim does not already decide the answer.
///
/// The gate is [`Claim::decides_the_answer`], evaluated here rather than in a
/// prompt. That is the whole point of the split — the model that said "this is
/// enough" is never handed a `gaps` array to fill afterwards, so a correct
/// insight-only board cannot be argued into having missed something.
fn staged_board_review(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, ReviewResponse)> {
    let (claim, _) = perceive_and_claim(provider, meta, description, board)?;

    if claim.decides_the_answer() {
        // Stage 3b — synthesized by the daemon, no second call.
        return Ok((claim.clone(), on_track_review_from_claim(&claim)));
    }

    // Stage 3a — and only now is anything asked to look for what is missing.
    let prompt = build_verdict_prompt(meta, description, board, &claim);
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![
            ChatMessage::system(VERDICT_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(board.images()),
        ])
        .json(),
    )?;
    let mut review = parse_review(&reply.content, &meta.cases)?;
    // The claim is frozen: the verdict stage may say where it breaks, but it does
    // not get to rename their idea into something they never wrote.
    review.understood_approach = claim.understood_approach.clone();
    Ok((claim, review))
}

/// Stages 1 and 2, which the Lazy path needs on its own.
///
/// Stage 1 runs only when there is an image to look at. On a text-only build the
/// canvas layout and the recognized ink *are already text* — a describe pass
/// would spend a whole call paraphrasing what stage 2 can read directly — so the
/// two stages collapse into one call and the board goes straight to the claim.
fn perceive_and_claim(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, Option<Perception>)> {
    let perception = if board.png.is_some() {
        let prompt = build_perceive_prompt(meta, board);
        // Best-effort: describing a board is not worth failing a review over,
        // and stage 2 can still read the layout if this comes back malformed.
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

    let prompt = build_claim_prompt(meta, description, board, perception.as_ref());
    let mut message = ChatMessage::user(prompt);
    if perception.is_none() {
        // Either there was no image, or stage 1 failed — attach the board so
        // this call is the one that looks at it.
        message = message.with_images(board.images());
    }
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![ChatMessage::system(CLAIM_SYSTEM_PROMPT), message]).json(),
    )?;
    let claim = parse_claim(&reply.content)?;
    Ok((claim, perception))
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
    let frozen_claim = {
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&board_key);
        board = board_session::resolve_board_snapshot(session, board);
        if let Some(pseudo) = board_session::resolve_pseudocode(session, &board) {
            board.pseudocode = Some(pseudo);
        }
        session.claim_for(board_session::drawn_board_fingerprint(&board))
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
        let claim = frozen_claim.or_else(|| {
            perceive_and_claim(&*provider, &meta, description.as_deref(), &board)
                .ok()
                .map(|(claim, _)| claim)
        });
        let prompt = build_lazy_fill_prompt(&meta, description.as_deref(), &board, claim.as_ref());
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
    use std::cell::RefCell;

    use super::*;
    use crate::llm::coach::{Rating, Verdict};
    use crate::llm::{ChatReply, ChatRequest};
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

        let prompt = build_lazy_fill_prompt(&meta(), None, &lazy_send, Some(&found));
        assert!(prompt.contains("full working Python for the claim above"));
    }

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
