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
        if crate::scratchpad::is_meta(meta) || crate::scratchpad::is_md_ink_meta(meta) {
            PAD_ASK_QUESTION_MAX
        } else {
            ASK_QUESTION_MAX
        };
    let _ = writeln!(
        out,
        "\n## Student question\n\n{}",
        clip(question.trim(), question_max)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\nAnswer the question as a tutor. Plain text only — no JSON."
    );
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
        let meta = crate::scratchpad::md_ink_workspace_meta();
        let question = "q".repeat(5000);
        let prompt = build_ask_prompt(&meta, None, &question, &CoachContext::default());
        assert!(prompt.contains(&question));
        assert!(!prompt.contains("truncated"));
    }
}
