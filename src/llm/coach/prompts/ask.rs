use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{clip, write_problem_header};

pub fn build_ask_prompt(meta: &WorkspaceMeta, description: Option<&str>, question: &str) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    let _ = writeln!(
        out,
        "\n## Student question\n\n{}",
        clip(question.trim(), 4000)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\nAnswer the question as a tutor. Plain text only — no JSON."
    );
    out
}
