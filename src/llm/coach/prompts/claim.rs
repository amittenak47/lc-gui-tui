use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{write_cases, write_problem_header};

use super::super::board::BoardSnapshot;
use super::super::approach::CoachContext;
use super::super::stages::claim::board_without_code;
use super::super::stages::perceive::{write_perception, Perception};

/// Stage 2 prompt. Takes the stage-1 description when there was one; on a
/// text-only build the caller passes `None` and this same call reads the layout
/// and the recognized ink directly.
pub fn build_claim_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    perception: Option<&Perception>,
    ctx: &CoachContext,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board_without_code(board).write_into(&mut out);
    write_perception(&mut out, perception);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence naming their idea\",\n  \
           \"key_steps\": [\"the steps the board justifies, in order\"],\n  \
           \"claim_sufficient\": true or false,\n  \
           \"why_sufficient_or_not\": \"one or two sentences — if false, name exactly what the \
claim leaves undecided\",\n  \
           \"unresolved\": [\"parts of the problem the board has not decided — empty when \
claim_sufficient is true\"],\n  \
           \"confirming_question\": \"one question that would confirm or stress-test this claim\",\n  \
           \"compatible_alternatives\": [\"other approaches this same board could be arguing for \
— list them only when the board genuinely has not settled it, never to \
second-guess a clear board\"]\n\
         }}\n\
         ```"
    );
    let _ = ctx;
    out
}
