use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{
    clip, write_problem_header, ASK_QUESTION_MAX, PAD_ASK_QUESTION_MAX,
};

use super::super::approach::CoachContext;
use super::super::planner::write_catalog;
use super::super::stages::claim::write_committed_approach;

/// Single-turn Q&A. No board is required, which is the point — "how do I even
/// start?" is asked before there is anything to review.
pub fn build_ask_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    question: &str,
    ctx: &CoachContext,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_catalog(&mut out, &ctx.catalog);
    // A session already coaching an approach answers questions inside it. Ask
    // is where a student is most likely to be quietly talked into a different
    // one, because there is no board holding the answer down.
    if let Some(committed) = ctx.committed() {
        write_committed_approach(&mut out, committed);
    }
    let question_max =
        if crate::pad::is_pad_meta(meta) {
            PAD_ASK_QUESTION_MAX
        } else {
            ASK_QUESTION_MAX
        };
    let _ = writeln!(
        out,
        "\n## Student question\n\n{}",
        clip(question.trim(), question_max)
    );
    if crate::pad::is_pad_meta(meta) {
        let _ = writeln!(
            out,
            "\n## Your reply\n\nAnswer the question as a tutor. Call `draw_structure` or \
             `animate_trace` only when the ask is operational (a trace or a layout), and only \
             with values from this prompt. Do not invent a LeetCode example."
        );
    } else {
        let _ = writeln!(
            out,
            "\n## Your reply\n\nAnswer the question as a tutor. Plain text only — no JSON."
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::coach::approach::CoachContext;

    #[test]
    fn corpus_ask_clips_a_long_question() {
        let meta = crate::generator::WorkspaceMeta {
            dataset: "leetcode".into(),
            task_id: "two-sum".into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            entry_point: None,
            json_path: String::new(),
            cases: vec![],
            test: None,
        };
        let long = "q".repeat(ASK_QUESTION_MAX + 50);
        let prompt = build_ask_prompt(&meta, None, &long, &CoachContext::default());
        assert!(prompt.contains("truncated"));
        assert!(!prompt.contains(&long));
    }

    #[test]
    fn document_ask_keeps_a_question_past_the_old_4000_cap() {
        let meta = crate::pad::annotate_meta();
        let question = "q".repeat(5000);
        let prompt = build_ask_prompt(&meta, None, &question, &CoachContext::default());
        assert!(prompt.contains(&question));
        assert!(!prompt.contains("truncated"));
    }

    #[test]
    fn pad_ask_may_draw_and_corpus_ask_stays_prose() {
        let pad = build_ask_prompt(
            &crate::pad::whiteboard_meta(),
            None,
            "trace this array",
            &CoachContext::default(),
        );
        assert!(pad.contains("draw_structure"));
        let corpus = build_ask_prompt(
            &crate::generator::WorkspaceMeta {
                dataset: "leetcode".into(),
                task_id: "two-sum".into(),
                question_id: None,
                difficulty: None,
                tags: vec![],
                entry_point: None,
                json_path: String::new(),
                cases: vec![],
                test: None,
            },
            None,
            "how do I start?",
            &CoachContext::default(),
        );
        assert!(corpus.contains("Plain text only"));
        assert!(!corpus.contains("draw_structure"));
    }
}
