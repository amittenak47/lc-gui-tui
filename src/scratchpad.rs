//! Virtual scratchpad workspace — not backed by a corpus or `lc load`.
//!
//! The whiteboard client's notebook tab sends `dataset=scratchpad` and
//! `task_id=__scratchpad__`. Coach Ask is the only action that applies there.

use crate::generator::WorkspaceMeta;

pub const DATASET_ID: &str = "scratchpad";
pub const TASK_ID: &str = "__scratchpad__";

/// Board-session key — same shape as [`crate::dataset::Dataset::key`].
pub fn board_key() -> String {
    format!("{DATASET_ID}/{TASK_ID}")
}

/// Whether a coach request targets the scratchpad notebook.
pub fn is_request(dataset: Option<&str>, task_id: &str) -> bool {
    task_id.trim() == TASK_ID
        || dataset
            .map(|slug| slug.trim() == DATASET_ID)
            .unwrap_or(false)
}

/// Whether [`WorkspaceMeta`] came from [`workspace_meta`].
pub fn is_meta(meta: &WorkspaceMeta) -> bool {
    meta.dataset == DATASET_ID && meta.task_id == TASK_ID
}

/// Synthetic meta for Ask — no problem file, no `solution.py`.
pub fn workspace_meta() -> WorkspaceMeta {
    WorkspaceMeta {
        dataset: DATASET_ID.to_string(),
        task_id: TASK_ID.to_string(),
        question_id: None,
        difficulty: None,
        tags: vec!["scratchpad".into()],
        entry_point: None,
        json_path: String::new(),
        cases: vec![],
        test: None,
    }
}

/// Problem statement shown to the tutor when the student asks from scratchpad.
pub const COACH_DESCRIPTION: &str = "\
Free-form notebook workspace. The student may be practicing writing, sketching \
ideas, working through any topic, or thinking aloud. There is no specific coding \
problem, test cases, or reference solution.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_key_matches_dataset_key_shape() {
        assert_eq!(board_key(), "scratchpad/__scratchpad__");
    }

    #[test]
    fn request_detected_by_slug_or_task_id() {
        assert!(is_request(Some("scratchpad"), "anything"));
        assert!(is_request(None, TASK_ID));
        assert!(!is_request(Some("leetcode"), "two-sum"));
    }
}
