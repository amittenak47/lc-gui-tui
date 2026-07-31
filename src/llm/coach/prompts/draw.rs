use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

use super::super::board::BoardSnapshot;
use crate::llm::helpers::{write_cases, write_problem_header};

/// Prompt for the `viz` mode. `ask` is what the student (or the review) wants
/// drawn; an empty `ask` means "pick whatever would help most".
pub fn build_viz_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    ask: &str,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

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
