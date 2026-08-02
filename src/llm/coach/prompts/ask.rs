use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{clip, write_problem_header};

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
    let _ = writeln!(
        out,
        "\n## Student question\n\n{}",
        clip(question.trim(), 4000)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\nAnswer the question as a tutor. Plain text only — no JSON."
    );
    out
}
