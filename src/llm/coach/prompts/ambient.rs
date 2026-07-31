use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

use super::super::board::BoardSnapshot;
use super::super::modes::ambient::escalation_instruction;
use crate::llm::helpers::{write_cases, write_problem_header};

pub fn build_ambient_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    already_said: &[String],
    nudges_so_far: u32,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

    let _ = writeln!(out, "\n## Already said (do not repeat)");
    if already_said.is_empty() {
        let _ = writeln!(out, "\n(nothing yet — this is your first look)");
    } else {
        for line in already_said {
            let _ = writeln!(out, "- {}", clip(line, 300));
        }
    }

    let _ = writeln!(out, "\n## How hard to push\n\n{}", escalation_instruction(nudges_so_far));
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"confidence\": 0.0-1.0, \"guessed_approach\": \"one clause\", \
         \"closeness\": \"cold | warm | close | there\", \"nudge\": \"one or two sentences\"}}\n\
         ```"
    );
    out
}
