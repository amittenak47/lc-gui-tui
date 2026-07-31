use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;

use super::super::board::BoardSnapshot;
use super::super::stages::claim::board_without_code;

/// Stage 1 prompt. Deliberately narrow: no statement, no sample cases, no code
/// dock. Nothing to reason from means nothing to have an opinion about, and it
/// leaves the context budget for the board itself.
pub fn build_perceive_prompt(meta: &WorkspaceMeta, board: &BoardSnapshot) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Board for problem: {}", meta.task_id);
    board_without_code(board).write_into(&mut out);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"observations\": [\"one short clause per thing you can see on the board\"], \
         \"transcribed_notes\": [\"pieces of text you can read\"], \
         \"illegible\": [\"regions you cannot read — leave empty if none\"]}}\n\
         ```"
    );
    out
}
