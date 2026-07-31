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
//! Mirrors the section-heading style of coach prompts and reuses
//! [`crate::llm::helpers::clip`]. Every prompt here is assembled from
//! [`WorkspaceMeta`], the problem statement, and what the user wrote on the
//! board — the same redacted sources `lc ask` uses. The one exception is
//! [`build_bridge_prompt`], which takes reference text the caller obtained
//! through [`crate::reveal`] after an explicit user action; it is never called
//! from the review or ambient paths.
//!
//! Layout:
//! - [`prompts`] — all `*_SYSTEM_PROMPT` consts and `build_*_prompt` builders
//! - [`board`] — canvas snapshot
//! - [`modes::review`] — Mode A oneshot types / parse / merge / format card
//! - [`stages`] — Mode A perceive → claim → verdict types and parsers
//! - [`assess`] — staged review orchestration entry points
//! - [`modes::ambient`] — Mode B
//! - [`trace`] — counterexample retrace
//! - [`actions::draw`] — Mode D diagram validation
//! - [`actions::bridge`] / [`actions::lazy`] — Mode C reveal bridge + Lazy fill

mod actions;
mod assess;
mod board;
mod modes;
mod prompts;
mod stages;
mod trace;

#[cfg(test)]
mod tests;

pub use actions::{
    parse_bridge, parse_lazy_fill, validate_citation, validate_highlight, Annotation, BridgeResponse,
    BridgeStep, Citation, Highlight, LazyFillResponse,
};
pub use assess::{
    perceive_and_claim, review_submission, review_submission_text_only, staged_board_review,
    ReviewOutcome,
};
pub use board::BoardSnapshot;
pub use crate::llm::helpers::extract_json;
pub use modes::ambient::{escalation_instruction, parse_ambient, AmbientNudge};
pub use modes::review::{
    format_review_card, merge_layout_and_code_reviews, parse_review, validate_counterexample,
    Counterexample, Rating, ReviewResponse, Verdict,
};
pub use prompts::{
    build_ambient_prompt, build_bridge_prompt, build_claim_code_review_prompt, build_claim_prompt,
    build_lazy_fill_prompt, build_lazy_hint_prompt, build_perceive_prompt, build_review_prompt,
    build_trace_prompt, build_verdict_prompt, build_viz_prompt, AMBIENT_SYSTEM_PROMPT,
    BRIDGE_SYSTEM_PROMPT, CLAIM_CODE_SYSTEM_PROMPT, CLAIM_SYSTEM_PROMPT, LAZY_FILL_SYSTEM_PROMPT,
    LAZY_HINT_SYSTEM_PROMPT, PERCEIVE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, TRACE_SYSTEM_PROMPT,
    VERDICT_SYSTEM_PROMPT, VIZ_SYSTEM_PROMPT,
};
pub use stages::{on_track_review_from_claim, parse_claim, parse_perception, Claim, Perception};
pub use trace::{parse_trace, retrace_counterexample};
