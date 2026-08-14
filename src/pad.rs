//! Freeform pads — not a SQLite corpus and not `lc load`.
//!
//! Coach Ask (and board sessions) key these by [`AgentSurface`], not by stuffing
//! a fake slug into `dataset`. `dataset` is a corpus id for [`AgentSurface::Problem`]
//! only.
//!
//! Old clients still send `dataset=scratchpad|whiteboard|md-ink`. [`parse_surface`]
//! maps those onto the same enum so a mixed tablet / desktop pair cannot 400.

use crate::generator::WorkspaceMeta;

/// Wire / JSON `surface` for a whiteboard notebook.
pub const SURFACE_WHITEBOARD: &str = "whiteboard";
/// Wire / JSON `surface` for any annotated source (markdown, PDF, EPUB, code; later web).
pub const SURFACE_ANNOTATE: &str = "annotate";
/// Wire / JSON `surface` for a corpus problem.
pub const SURFACE_PROBLEM: &str = "problem";

pub const WHITEBOARD_TASK_ID: &str = "__whiteboard__";
pub const ANNOTATE_TASK_ID: &str = "__annotate__";

/// Pre-rename notebook slugs. Still accepted on the wire.
pub const LEGACY_SCRATCHPAD_SLUG: &str = "scratchpad";
pub const LEGACY_SCRATCHPAD_TASK_ID: &str = "__scratchpad__";
/// Pre-rename annotate slug. Still accepted on the wire.
pub const LEGACY_MD_INK_SLUG: &str = "md-ink";
pub const LEGACY_MD_INK_TASK_ID: &str = "__md_ink__";

/// What is open — independent of composer flags (Ask / Handwriting / Draw).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSurface {
    Whiteboard,
    Annotate,
    Problem { dataset: String },
}

impl AgentSurface {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Whiteboard => SURFACE_WHITEBOARD,
            Self::Annotate => SURFACE_ANNOTATE,
            Self::Problem { .. } => SURFACE_PROBLEM,
        }
    }

    pub fn is_pad(&self) -> bool {
        matches!(self, Self::Whiteboard | Self::Annotate)
    }
}

/// Board-session key — same shape as [`crate::dataset::Dataset::key`].
pub fn session_key(surface: &AgentSurface, task_id: &str) -> String {
    match surface {
        AgentSurface::Whiteboard => format!("{SURFACE_WHITEBOARD}/{WHITEBOARD_TASK_ID}"),
        AgentSurface::Annotate => format!("{SURFACE_ANNOTATE}/{ANNOTATE_TASK_ID}"),
        AgentSurface::Problem { dataset } => format!("{dataset}/{task_id}"),
    }
}

/// Resolve Ask / Viz `surface` plus the legacy `dataset` / `task_id` map.
///
/// Prefer `surface` when it is present. Otherwise:
/// - `scratchpad` / `whiteboard` / `__scratchpad__` / `__whiteboard__` → whiteboard
/// - `md-ink` / `__md_ink__` / `__annotate__` → annotate
/// - anything else → problem with that dataset slug (default corpus if omitted)
pub fn parse_surface(
    surface: Option<&str>,
    dataset: Option<&str>,
    task_id: &str,
) -> AgentSurface {
    let surface = surface.map(str::trim).filter(|s| !s.is_empty());
    let dataset = dataset.map(str::trim).filter(|s| !s.is_empty());
    let task_id = task_id.trim();

    if let Some(kind) = surface {
        return match kind {
            SURFACE_WHITEBOARD => AgentSurface::Whiteboard,
            SURFACE_ANNOTATE => AgentSurface::Annotate,
            SURFACE_PROBLEM => AgentSurface::Problem {
                dataset: dataset.unwrap_or("leetcode").to_string(),
            },
            _ => parse_surface(None, dataset, task_id),
        };
    }

    if is_whiteboard_slug(dataset, task_id) {
        return AgentSurface::Whiteboard;
    }
    if is_annotate_slug(dataset, task_id) {
        return AgentSurface::Annotate;
    }
    AgentSurface::Problem {
        dataset: dataset.unwrap_or("leetcode").to_string(),
    }
}

fn is_whiteboard_slug(dataset: Option<&str>, task_id: &str) -> bool {
    task_id == WHITEBOARD_TASK_ID
        || task_id == LEGACY_SCRATCHPAD_TASK_ID
        || dataset
            .map(|slug| slug == SURFACE_WHITEBOARD || slug == LEGACY_SCRATCHPAD_SLUG)
            .unwrap_or(false)
}

fn is_annotate_slug(dataset: Option<&str>, task_id: &str) -> bool {
    task_id == ANNOTATE_TASK_ID
        || task_id == LEGACY_MD_INK_TASK_ID
        || dataset
            .map(|slug| slug == SURFACE_ANNOTATE || slug == LEGACY_MD_INK_SLUG)
            .unwrap_or(false)
}

pub fn is_whiteboard_meta(meta: &WorkspaceMeta) -> bool {
    (meta.dataset == SURFACE_WHITEBOARD && meta.task_id == WHITEBOARD_TASK_ID)
        || (meta.dataset == LEGACY_SCRATCHPAD_SLUG && meta.task_id == LEGACY_SCRATCHPAD_TASK_ID)
}

pub fn is_annotate_meta(meta: &WorkspaceMeta) -> bool {
    (meta.dataset == SURFACE_ANNOTATE && meta.task_id == ANNOTATE_TASK_ID)
        || (meta.dataset == LEGACY_MD_INK_SLUG && meta.task_id == LEGACY_MD_INK_TASK_ID)
}

pub fn is_pad_meta(meta: &WorkspaceMeta) -> bool {
    is_whiteboard_meta(meta) || is_annotate_meta(meta)
}

pub fn whiteboard_meta() -> WorkspaceMeta {
    WorkspaceMeta {
        dataset: SURFACE_WHITEBOARD.to_string(),
        task_id: WHITEBOARD_TASK_ID.to_string(),
        question_id: None,
        difficulty: None,
        tags: vec!["whiteboard".into()],
        entry_point: None,
        json_path: String::new(),
        cases: vec![],
        test: None,
    }
}

pub fn annotate_meta() -> WorkspaceMeta {
    WorkspaceMeta {
        dataset: SURFACE_ANNOTATE.to_string(),
        task_id: ANNOTATE_TASK_ID.to_string(),
        question_id: None,
        difficulty: None,
        tags: vec!["annotate".into()],
        entry_point: None,
        json_path: String::new(),
        cases: vec![],
        test: None,
    }
}

pub const WHITEBOARD_DESCRIPTION: &str = "\
Free-form notebook workspace. The student may be practicing writing, sketching \
ideas, working through any topic, or thinking aloud. There is no specific coding \
problem, test cases, or reference solution.";

pub const ANNOTATE_DESCRIPTION: &str = "\
Annotation workspace. The student is reading a file or page (markdown, PDF, EPUB, \
code, or similar) and asking about quoted passages, their notes, saved links, and \
prior chat threads attached to those marks. There is no specific coding problem, \
test cases, or reference solution.";

/// True when a session key's dataset half is a pad, not a corpus.
pub fn is_pad_dataset_slug(dataset: &str) -> bool {
    matches!(
        dataset,
        SURFACE_WHITEBOARD
            | SURFACE_ANNOTATE
            | LEGACY_SCRATCHPAD_SLUG
            | LEGACY_MD_INK_SLUG
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_keys() {
        assert_eq!(
            session_key(&AgentSurface::Whiteboard, "ignored"),
            "whiteboard/__whiteboard__"
        );
        assert_eq!(
            session_key(&AgentSurface::Annotate, "ignored"),
            "annotate/__annotate__"
        );
        assert_eq!(
            session_key(
                &AgentSurface::Problem {
                    dataset: "leetcode".into()
                },
                "two-sum"
            ),
            "leetcode/two-sum"
        );
    }

    #[test]
    fn surface_field_wins() {
        assert_eq!(
            parse_surface(Some("whiteboard"), Some("leetcode"), "two-sum"),
            AgentSurface::Whiteboard
        );
        assert_eq!(
            parse_surface(Some("annotate"), None, "two-sum"),
            AgentSurface::Annotate
        );
        assert_eq!(
            parse_surface(Some("problem"), Some("kodcode"), "two-sum"),
            AgentSurface::Problem {
                dataset: "kodcode".into()
            }
        );
    }

    #[test]
    fn legacy_dataset_slugs() {
        assert_eq!(
            parse_surface(None, Some("scratchpad"), "anything"),
            AgentSurface::Whiteboard
        );
        assert_eq!(
            parse_surface(None, Some("whiteboard"), "anything"),
            AgentSurface::Whiteboard
        );
        assert_eq!(
            parse_surface(None, Some("md-ink"), "anything"),
            AgentSurface::Annotate
        );
        assert_eq!(
            parse_surface(None, None, LEGACY_SCRATCHPAD_TASK_ID),
            AgentSurface::Whiteboard
        );
        assert_eq!(
            parse_surface(None, None, LEGACY_MD_INK_TASK_ID),
            AgentSurface::Annotate
        );
        assert_eq!(
            parse_surface(None, Some("leetcode"), "two-sum"),
            AgentSurface::Problem {
                dataset: "leetcode".into()
            }
        );
    }
}
