//! Virtual scratchpad workspace — not backed by a corpus or `lc load`.
//!
//! The whiteboard client's notebook tab sends `dataset=scratchpad` and
//! `task_id=__scratchpad__`. Document annotation (markdown / PDF / EPUB) sends
//! `dataset=md-ink` and `task_id=__md_ink__`. Coach Ask is the action that
//! applies on both.

use crate::generator::WorkspaceMeta;

pub const DATASET_ID: &str = "scratchpad";
/// Client dataset slug after the notebook was renamed Whiteboard in the UI.
pub const DATASET_ID_PUBLIC: &str = "whiteboard";
pub const TASK_ID: &str = "__scratchpad__";

/// Markdown / PDF / EPUB annotation pad — same client constants as `mdInk.ts`.
pub const MD_INK_DATASET: &str = "md-ink";
pub const MD_INK_TASK_ID: &str = "__md_ink__";

/// Board-session key — same shape as [`crate::dataset::Dataset::key`].
pub fn board_key() -> String {
    format!("{DATASET_ID}/{TASK_ID}")
}

/// Whether a coach request targets the scratchpad notebook.
pub fn is_request(dataset: Option<&str>, task_id: &str) -> bool {
    task_id.trim() == TASK_ID
        || dataset
            .map(|slug| {
                let slug = slug.trim();
                slug == DATASET_ID || slug == DATASET_ID_PUBLIC
            })
            .unwrap_or(false)
}

/// Whether a coach request targets a document annotation session.
pub fn is_md_ink(dataset: Option<&str>, task_id: &str) -> bool {
    task_id.trim() == MD_INK_TASK_ID
        || dataset
            .map(|slug| slug.trim() == MD_INK_DATASET)
            .unwrap_or(false)
}

/// Whiteboard or document pad — no corpus problem, no `lc load`.
pub fn is_local_pad(dataset: Option<&str>, task_id: &str) -> bool {
    is_request(dataset, task_id) || is_md_ink(dataset, task_id)
}

/// Board-session key for markdown / PDF / EPUB annotation.
pub fn md_ink_board_key() -> String {
    format!("{MD_INK_DATASET}/{MD_INK_TASK_ID}")
}

/// Whether [`WorkspaceMeta`] came from [`workspace_meta`].
pub fn is_meta(meta: &WorkspaceMeta) -> bool {
    meta.dataset == DATASET_ID && meta.task_id == TASK_ID
}

/// Whether [`WorkspaceMeta`] came from [`md_ink_workspace_meta`].
pub fn is_md_ink_meta(meta: &WorkspaceMeta) -> bool {
    meta.dataset == MD_INK_DATASET && meta.task_id == MD_INK_TASK_ID
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

/// Synthetic meta for Ask from a document pad.
pub fn md_ink_workspace_meta() -> WorkspaceMeta {
    WorkspaceMeta {
        dataset: MD_INK_DATASET.to_string(),
        task_id: MD_INK_TASK_ID.to_string(),
        question_id: None,
        difficulty: None,
        tags: vec!["md-ink".into()],
        entry_point: None,
        json_path: String::new(),
        cases: vec![],
        test: None,
    }
}

/// Problem statement shown when the student asks from a quoted document mark.
pub const MD_INK_COACH_DESCRIPTION: &str = "\
Document annotation workspace. The student is reading a markdown file, PDF, or \
EPUB and asking about quoted passages, their notes, saved links, and prior \
chat threads attached to those marks. There is no specific coding problem, \
test cases, or reference solution.";

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
        assert!(is_request(Some("whiteboard"), "anything"));
        assert!(is_request(None, TASK_ID));
        assert!(!is_request(Some("leetcode"), "two-sum"));
        assert!(!is_md_ink(Some("leetcode"), "two-sum"));
        assert!(is_md_ink(Some("md-ink"), "anything"));
        assert!(is_md_ink(None, MD_INK_TASK_ID));
        assert!(is_local_pad(Some("md-ink"), MD_INK_TASK_ID));
        assert!(!is_local_pad(Some("leetcode"), "two-sum"));
        assert_eq!(md_ink_board_key(), "md-ink/__md_ink__");
    }
}
