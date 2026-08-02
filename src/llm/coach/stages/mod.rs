//! Stage types and parsers for perceive → claim → verdict.

use crate::llm::helpers::clip;

pub mod claim;
pub mod perceive;
pub mod verdict;

pub use claim::{parse_claim, write_committed_approach, Claim};
pub use perceive::{parse_perception, Perception};
pub use verdict::on_track_review_from_claim;

/// How many items any staged list keeps, and how long each may be. Local models
/// will happily return thirty observations; the next prompt has to fit beside a
/// board and a problem statement in 8k.
pub(super) const MAX_STAGE_ITEMS: usize = 8;
pub(super) const MAX_STAGE_ITEM: usize = 240;
pub(super) const MAX_CLAIM_FIELD: usize = 600;

pub(super) fn tidy_list(list: &mut Vec<String>) {
    list.retain(|item| !item.trim().is_empty());
    for item in list.iter_mut() {
        *item = clip(item.trim(), MAX_STAGE_ITEM);
    }
    list.truncate(MAX_STAGE_ITEMS);
}
