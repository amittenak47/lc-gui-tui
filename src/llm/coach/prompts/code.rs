use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{clip, write_cases, write_problem_header, MAX_BOARD};

use super::super::board::BoardSnapshot;
use super::super::approach::CoachContext;
use super::super::stages::claim::{write_claim, write_committed_approach, Claim};

/// The code pass, conditioned on the frozen claim. Asks "does this code match
/// the claim?" — never "what approach does this stub suggest?", which is how a
/// half-typed file used to talk the coach out of a correct board.
pub fn build_claim_code_review_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: &Claim,
    ctx: &CoachContext,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    write_claim(&mut out, claim);
    if let Some(committed) = ctx.committed() {
        write_committed_approach(&mut out, committed);
    }
    if !board.app_messages.is_empty() {
        let _ = writeln!(
            out,
            "\n## From the app (not the student)\n\n\
             Real results from running their code — treat them as fact."
        );
        for message in &board.app_messages {
            let _ = writeln!(out, "\n```\n{}\n```", clip(message.trim(), MAX_BOARD));
        }
    }
    let code = board.pseudocode.as_deref().unwrap_or("").trim();
    let _ = writeln!(
        out,
        "\n## The code dock (solution.py)\n\n```python\n{}\n```",
        clip(if code.is_empty() { "(empty)" } else { code }, MAX_BOARD)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Does this code implement the claim above? Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence: what the code does\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"where the code follows the claim\"],\n  \
           \"gaps\": [\"only where the code contradicts the claim — empty if it just stops \
early\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index, or null>, \
              \"why_your_approach_fails\": \"...\"}},\n  \
           \"socratic_question\": \"a code-focused next step\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```"
    );
    out
}
