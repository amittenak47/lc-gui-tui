use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;
use crate::problem::IoCase;

use super::super::board::BoardSnapshot;
use crate::llm::helpers::MAX_CASE;

/// A one-case trace prompt.
///
/// Why this exists: an 8B local model given a dozen numbered cases will happily
/// cite a real index and then illustrate its point with an input it made up.
/// The student runs the cited case and sees something different. Narrowing the
/// prompt to the single cited case removes the wandering room — the model
/// cannot reference the other cases because it is not shown them.
pub fn build_trace_prompt(
    meta: &WorkspaceMeta,
    board: &BoardSnapshot,
    case: &IoCase,
    case_number: u32,
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Problem: {}", meta.task_id);
    let _ = writeln!(
        out,
        "\n## The one case you are tracing (case {case_number})\n\n\
         - input:    `{}`\n- expected: `{}`",
        clip(&case.input, MAX_CASE),
        clip(&case.output, MAX_CASE)
    );
    // Both halves of what they wrote: the recognized ink *and* anything they
    // typed. Reading only the ink meant a pseudocode-only board looked empty
    // and the trace opened with "the student's approach is missing".
    let _ = writeln!(out, "\n## The student's approach");
    let approach = board.approach_text();
    let _ = writeln!(
        out,
        "\n```\n{}\n```",
        if approach.is_empty() {
            "(nothing legible — say so rather than guessing an approach)"
        } else {
            &approach
        }
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"trace\": \"run their approach on the input above, using only its values, and say \
         where it diverges from the expected output\"}}\n\
         ```"
    );
    out
}
