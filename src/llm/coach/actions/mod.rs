pub mod bridge;
pub mod draw;
pub mod draw_review;
pub mod lazy;
pub mod scaffold;

pub use bridge::{parse_bridge, BridgeResponse, BridgeStep};
pub use draw::{
    validate_citation, validate_highlight, Annotation, Citation, Highlight,
};
pub use draw_review::{
    build_draw_fix_prompt, build_draw_review_prompt, parse_draw_review, DrawReview,
    DRAW_REVIEW_SYSTEM_PROMPT,
};
pub use lazy::{parse_lazy_fill, LazyFillResponse};
pub use scaffold::{parse_board_scaffold, BoardScaffold};
