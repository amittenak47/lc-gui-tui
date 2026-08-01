//! System consts and user prompt builders for the whiteboard coach.

mod ambient;
mod ask;
mod bridge;
mod claim;
mod code;
mod draw;
mod lazy;
mod perceive;
mod review;
mod scaffold;
mod system;
mod trace;
mod verdict;

pub use ambient::build_ambient_prompt;
pub use ask::build_ask_prompt;
pub use bridge::build_bridge_prompt;
pub use claim::build_claim_prompt;
pub use code::build_claim_code_review_prompt;
pub use draw::build_viz_prompt;
pub use lazy::{build_lazy_fill_prompt, build_lazy_hint_prompt};
pub use perceive::build_perceive_prompt;
pub use review::build_review_prompt;
pub use scaffold::build_scaffold_prompt;
pub use system::{
    AMBIENT_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, BRIDGE_SYSTEM_PROMPT, CLAIM_CODE_SYSTEM_PROMPT,
    CLAIM_SYSTEM_PROMPT, LAZY_FILL_SYSTEM_PROMPT, LAZY_HINT_SYSTEM_PROMPT, PERCEIVE_SYSTEM_PROMPT,
    REVIEW_SYSTEM_PROMPT, SCAFFOLD_SYSTEM_PROMPT, TRACE_SYSTEM_PROMPT, VERDICT_SYSTEM_PROMPT,
    VIZ_SYSTEM_PROMPT,
};
pub use trace::build_trace_prompt;
pub use verdict::build_verdict_prompt;
