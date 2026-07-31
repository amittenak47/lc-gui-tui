use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;
use crate::runner::CaseResult;

use super::super::board::BoardSnapshot;
use crate::llm::helpers::{write_problem_header, MAX_CASE, MAX_REFERENCE};

/// Build the bridge prompt.
///
/// `reference` is reference-solution text and must only ever come from
/// [`crate::reveal::SolutionReveal`], which is constructed from an explicit
/// user reveal. Nothing in the review or ambient path calls this.
pub fn build_bridge_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
    failing: &[CaseResult],
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);

    if !failing.is_empty() {
        let _ = writeln!(out, "\n## Cases their current code fails");
        for result in failing.iter().take(3) {
            let _ = writeln!(out, "\n### Case {}", result.case);
            let _ = writeln!(out, "- input:    `{}`", clip(&result.input, MAX_CASE));
            let _ = writeln!(out, "- expected: `{}`", clip(&result.expected, MAX_CASE));
            if let Some(actual) = &result.actual {
                let _ = writeln!(out, "- actual:   `{}`", clip(actual, MAX_CASE));
            }
        }
    }

    let _ = writeln!(
        out,
        "\n## Reference solution (the student asked for this — use it to plan the path, \
         do not paste it back)\n\n```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"already_yours\": \"...\", \"missing_piece\": \"...\", \
         \"steps\": [{{\"title\": \"...\", \"detail\": \"...\"}}], \
         \"smallest_edit\": \"the one change to make right now\"}}\n\
         ```"
    );
    out
}
