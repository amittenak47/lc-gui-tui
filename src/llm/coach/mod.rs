//! Prompt builders and response types for the whiteboard coach.
//!
//! Review (Mode A) is staged rather than one-shot: [`build_perceive_prompt`]
//! describes the board, [`build_claim_prompt`] names what it claims and whether
//! that claim decides the answer, and [`build_verdict_prompt`] runs only when it
//! does not. The gate is [`Claim::decides_the_answer`] inside [`staged_board_review`]
//! — a [`Claim`] is data Rust inspects, not a step a model talks itself past.
//! Callers (HTTP `/coach/review`, TUI coach chat) build a [`BoardSnapshot`] and
//! run [`review_submission`]; GUI-only fields (PNG, scene layout, lazy flags)
//! are simply left unset on text-only paths.
//!
//! Mirrors the section-heading style of [`crate::llm::prompt`] and reuses its
//! [`clip`] helper. Every prompt here is assembled from [`WorkspaceMeta`], the
//! problem statement, and what the user wrote on the board — the same redacted
//! sources `lc ask` uses. The one exception is [`build_bridge_prompt`], which
//! takes reference text the caller obtained through [`crate::reveal`] after an
//! explicit user action; it is never called from the review or ambient paths.
//!
//! Layout (by Mode banner from the former single file):
//! - [`board`] — canvas snapshot
//! - [`review`] — Mode A oneshot types / parse / merge / format card
//! - [`staged`] — Mode A perceive → claim → verdict / submission entry points
//! - [`ambient`] — Mode B
//! - [`trace`] — counterexample retrace
//! - [`viz`] — Mode D diagram prompts
//! - [`bridge`] — Mode C reveal bridge + Lazy fill
//! - [`shared`] — prompt section helpers / JSON extract

mod ambient;
mod board;
mod bridge;
mod review;
mod shared;
mod staged;
mod trace;
mod viz;

#[cfg(test)]
mod tests;

pub use ambient::{
    build_ambient_prompt, escalation_instruction, parse_ambient, AmbientNudge,
    AMBIENT_SYSTEM_PROMPT,
};
pub use board::BoardSnapshot;
pub use bridge::{
    build_bridge_prompt, build_lazy_fill_prompt, build_lazy_hint_prompt, parse_bridge,
    parse_lazy_fill, BridgeResponse, BridgeStep, LazyFillResponse, BRIDGE_SYSTEM_PROMPT,
    LAZY_FILL_SYSTEM_PROMPT, LAZY_HINT_SYSTEM_PROMPT,
};
pub use review::{
    build_review_prompt, format_review_card, merge_layout_and_code_reviews, parse_review,
    validate_counterexample, Counterexample, Rating, ReviewResponse, Verdict,
    REVIEW_SYSTEM_PROMPT,
};
pub use shared::extract_json;
pub use staged::{
    build_claim_code_review_prompt, build_claim_prompt, build_perceive_prompt,
    build_verdict_prompt, on_track_review_from_claim, parse_claim, parse_perception,
    perceive_and_claim, review_submission, review_submission_text_only, staged_board_review,
    Claim, Perception, ReviewOutcome, CLAIM_CODE_SYSTEM_PROMPT, CLAIM_SYSTEM_PROMPT,
    PERCEIVE_SYSTEM_PROMPT, VERDICT_SYSTEM_PROMPT,
};
pub use trace::{
    build_trace_prompt, parse_trace, retrace_counterexample, TRACE_SYSTEM_PROMPT,
};
pub use viz::{
    build_viz_prompt, validate_citation, validate_highlight, Annotation, Citation, Highlight,
    VIZ_SYSTEM_PROMPT,
};
