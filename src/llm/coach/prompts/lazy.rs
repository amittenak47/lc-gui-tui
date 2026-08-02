use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

use super::super::board::BoardSnapshot;
use super::super::approach::CoachContext;
use super::super::stages::claim::{board_without_code, write_claim, write_committed_approach, Claim};
use crate::llm::helpers::{write_cases, write_problem_header, MAX_REFERENCE};

/// Lazy fill without a reference (composer Lazy flag).
///
/// `claim` is the claim the staged review already froze for this board. Passing
/// it is what makes Lazy fill *implement the drawing* rather than re-interpret
/// it: the same understanding the student just saw on their review card is the
/// thing that gets written into `solution.py`. `None` means no review has been
/// run for this board yet, and the model reads the board directly.
pub fn build_lazy_fill_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: Option<&Claim>,
    ctx: &CoachContext,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    // Board only — ignore whatever is in the code dock.
    board_without_code(board).write_into(&mut out);
    if let Some(claim) = claim {
        write_claim(&mut out, claim);
    }
    // Lazy writes code for the approach the session committed to — never for a
    // better one it thought of while reading the board.
    if let Some(committed) = ctx.committed() {
        write_committed_approach(&mut out, committed);
    }
    let _ = writeln!(
        out,
        "\n## Task\n\n{}\n\n\
         ## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"one or two sentences: what you filled from the board vs left as TODO\"}}\n\
         ```",
        if claim.is_some() {
            "Write `filled_code`: full working Python for the claim above. Every step the claim \
             justifies must be implemented, not left as a TODO — only what the claim says it has \
             not decided may stay `pass` / `# TODO:`."
        } else {
            "Interpret the drawing. Write `filled_code` that correctly implements what the board \
             already justifies (full working code for those parts). Leave only unearned ideas as \
             TODO/pass."
        }
    );
    out
}

/// Lazy fill after Hint confirm — reference is allowed for the earned parts only.
pub fn build_lazy_hint_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);
    let _ = writeln!(
        out,
        "\n## Reference solution (use only to flesh out what they already earned)\n\n\
         ```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"what you filled vs left for them\"}}\n\
         ```"
    );
    out
}
