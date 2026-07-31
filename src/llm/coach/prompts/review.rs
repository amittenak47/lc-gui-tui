use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{write_cases, write_problem_header};

use super::super::board::BoardSnapshot;

pub fn build_review_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence naming their intended idea\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"...\"],\n  \
           \"gaps\": [\"concrete missing pieces only — do not repeat understood_approach\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index into the numbered cases above>, \
              \"why_your_approach_fails\": \"step through THAT case's own input, using its actual \
values, and show where their approach diverges from its expected output\"}},\n  \
           \"socratic_question\": \"a specific, actionable next step or probe — more detailed than \
understood_approach\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```\n\n\
         `counterexample` must be null if no listed case breaks their approach. Do not restate the \
         input or expected output as fields — they are looked up from the corpus for you — but DO \
         work through that same input inside `why_your_approach_fails`."
    );
    out
}
