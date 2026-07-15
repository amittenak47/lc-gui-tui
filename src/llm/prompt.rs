//! Builds the redacted tutor prompt for `lc ask`.
//!
//! Everything here is assembled from `WorkspaceMeta`, the user's own
//! solution.py, and test results — none of which can contain the corpus's
//! `completion`/`response` fields (see `problem::Problem`).

use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::runner::CaseResult;

pub const SYSTEM_PROMPT: &str = "You are a patient competitive-programming tutor. The student is \
practicing LeetCode-style problems and has one or more failing test cases. Help them debug their \
own code:\n\
- Explain what the failing input exercises and why their output diverges from the expected one.\n\
- Point at the specific line(s) or logic in their code that are responsible, and name the \
underlying concept (off-by-one, wrong invariant, missed edge case, integer overflow, wrong data \
structure, ...).\n\
- Suggest what to trace or which extra input to try next.\n\
- You may show tiny illustrative fragments (a condition, a loop bound), but NEVER write the full \
corrected function or a complete working solution. If asked for the full solution, decline and \
keep coaching.";

const MAX_DESCRIPTION: usize = 6000;
const MAX_CODE: usize = 12000;
const MAX_ERROR: usize = 2000;
const MAX_STDOUT: usize = 1500;

pub fn build_user_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    solution_src: &str,
    results: &[&CaseResult],
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Problem: {}", meta.task_id);
    if let Some(q) = &meta.question_id {
        let _ = writeln!(out, "LeetCode question id: {q}");
    }
    if let Some(d) = &meta.difficulty {
        let _ = writeln!(out, "Difficulty: {d}");
    }
    if !meta.tags.is_empty() {
        let _ = writeln!(out, "Tags: {}", meta.tags.join(", "));
    }
    if let Some(desc) = description {
        let _ = writeln!(out, "\n## Statement\n\n{}", clip(desc, MAX_DESCRIPTION));
    }
    let _ = writeln!(
        out,
        "\n## My current solution.py\n\n```python\n{}\n```",
        clip(solution_src, MAX_CODE)
    );

    let _ = writeln!(out, "\n## Failing case(s) from the last test run");
    for result in results {
        let _ = writeln!(out, "\n### Case {}", result.case);
        let _ = writeln!(out, "- input:    `{}`", result.input);
        let _ = writeln!(out, "- expected: `{}`", result.expected);
        match (&result.actual, &result.error) {
            (Some(actual), _) => {
                let _ = writeln!(out, "- actual:   `{actual}`");
            }
            (None, Some(_)) => {
                let _ = writeln!(out, "- actual:   (raised an exception)");
            }
            _ => {}
        }
        if let Some(err) = &result.error {
            let _ = writeln!(out, "- traceback:\n```\n{}\n```", clip(err.trim_end(), MAX_ERROR));
        }
        if let Some(stdout) = &result.stdout {
            if !stdout.trim().is_empty() {
                let _ = writeln!(
                    out,
                    "- my debug prints:\n```\n{}\n```",
                    clip(stdout, MAX_STDOUT)
                );
            }
        }
    }

    out.push_str(
        "\nHelp me understand why this fails. Coach me — do not write the full corrected solution.\n",
    );
    out
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}\n…(truncated)")
}
