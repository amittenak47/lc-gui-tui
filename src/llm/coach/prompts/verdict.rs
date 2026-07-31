use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{write_cases, write_problem_header};

use super::super::board::BoardSnapshot;
use super::super::stages::claim::{board_without_code, write_claim, Claim};

/// Stage 3a prompt — reached only when the claim did not decide the answer.
pub fn build_verdict_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: &Claim,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board_without_code(board).write_into(&mut out);
    write_claim(&mut out, claim);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"the claim above, carried through unchanged\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"what the claim already gets right\"],\n  \
           \"gaps\": [\"only what the claim leaves open — do not restate the claim itself\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index into the numbered cases above>, \
              \"why_your_approach_fails\": \"step through THAT case's own input, using its actual \
values, and show where the claim diverges from its expected output\"}},\n  \
           \"socratic_question\": \"the most specific next move you can name\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```\n\n\
         `counterexample` must be null if no listed case breaks the claim. Do not restate the input \
         or expected output as fields — they are looked up from the corpus for you."
    );
    out
}
