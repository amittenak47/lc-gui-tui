use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

use super::super::approach::CoachContext;
use super::super::board::BoardSnapshot;
use super::super::stages::claim::write_committed_approach;
use crate::llm::helpers::{write_cases, write_problem_header};

/// Prompt for the `viz` mode. `ask` is what the student (or the review) wants
/// drawn; an empty `ask` means "pick whatever would help most".
pub fn build_viz_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    ask: &str,
    ctx: &CoachContext,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);
    // A diagram of a different approach than the one being coached is worse
    // than no diagram: it reads as the coach quietly changing its advice.
    if let Some(committed) = ctx.committed() {
        write_committed_approach(&mut out, committed);
    }
    if let Some(plan) = ctx.viz_plan.as_ref() {
        super::super::planner::write_viz_plan(&mut out, plan);
    }

    let _ = writeln!(out, "\n## What to draw");
    if ask.trim().is_empty() {
        let _ = writeln!(
            out,
            "\nPick the one diagram that would most help them right now, and draw it."
        );
    } else {
        let _ = writeln!(out, "\n{}", clip(ask.trim(), 1000));
    }
    out
}
