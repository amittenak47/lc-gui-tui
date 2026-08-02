//! Looking at the diagram after it is drawn.
//!
//! The tool schemas already stop a diagram that cannot be *rendered*: an
//! unknown structure kind, a program with no frames, an empty `cells` list.
//! What they cannot catch is a program that renders perfectly and is wrong —
//! pointers `i` and `j` at the same index for the whole animation, a "sorted"
//! array that is not sorted, six frames that show the same state.
//!
//! Those are visible in the picture, so this asks about the picture. One
//! critique, and at most one corrective redraw, both capped: an autonomous
//! redraw loop on a small model is how a diagram gets worse three times in a
//! row while the student watches.
//!
//! Structured JSON, never freehand shapes. The fix comes back as a tool call
//! for the same program id, which is what makes it a replacement rather than a
//! second diagram beside the first.

use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{clip, parse_reply, write_problem_header};
use crate::llm::viz::VizProgram;

pub const DRAW_REVIEW_SYSTEM_PROMPT: &str = "\
You are checking a diagram that has already been drawn for a student, against the \
program that produced it. You can see both.

Judge only what a student would get wrong from looking at it:
- does the picture show what the program says it shows?
- do the pointers, highlights, and labels move the way the walkthrough needs?
- would a student reading this reach a WRONG conclusion about the algorithm?

Do not ask for prettier layout, more colour, extra labels, or a different \
structure because you would have picked one. Those are not errors. A plain \
diagram that is correct is a pass.

Return only JSON.";

/// One structured critique of a rendered diagram.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DrawReview {
    /// Whether the diagram is good enough to leave alone.
    pub ok: bool,
    /// What is wrong, in the student's terms.
    pub issues: Vec<String>,
    /// One sentence for the redraw. Empty when `ok`.
    pub fix_hint: String,
}

/// How many issues are worth carrying into a redraw prompt. More than this and
/// the fix stops being a fix.
const MAX_ISSUES: usize = 4;
const MAX_ISSUE: usize = 240;

pub fn parse_draw_review(raw: &str) -> Result<DrawReview> {
    let mut review: DrawReview = parse_reply(raw, "draw review")?;
    review.issues.retain(|issue| !issue.trim().is_empty());
    for issue in review.issues.iter_mut() {
        *issue = clip(issue.trim(), MAX_ISSUE);
    }
    review.issues.truncate(MAX_ISSUES);
    review.fix_hint = clip(review.fix_hint.trim(), MAX_ISSUE);

    // A critique that says "not ok" and then names nothing is not actionable,
    // and redrawing on it would be a coin flip. Treat it as a pass — the
    // diagram already passed the schema, which is the check that has teeth.
    if !review.ok && review.issues.is_empty() && review.fix_hint.is_empty() {
        review.ok = true;
    }
    Ok(review)
}

pub fn build_draw_review_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    ask: &str,
    program: &VizProgram,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    if !ask.trim().is_empty() {
        let _ = writeln!(out, "\n## What the student asked for\n\n{}", clip(ask.trim(), 1000));
    }
    let _ = writeln!(
        out,
        "\n## The program that was drawn\n\n```json\n{}\n```",
        serde_json::to_string_pretty(program).unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "\nThe image attached is what that program actually rendered on the board.\n\n\
         ## Your reply\n\n\
         ```json\n\
         {{\n  \
           \"ok\": true or false,\n  \
           \"issues\": [\"what a student would get wrong from this picture\"],\n  \
           \"fix_hint\": \"one sentence naming the change — empty when ok\"\n\
         }}\n\
         ```"
    );
    out
}

/// The redraw request, for the viz provider's tool call.
///
/// The program id is repeated and pinned: a fix that comes back under a new id
/// is a second diagram next to the broken one, which is worse than the problem
/// it was fixing.
pub fn build_draw_fix_prompt(program: &VizProgram, review: &DrawReview) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "The diagram you drew has these problems:\n\n- {}",
        review.issues.join("\n- ")
    );
    if !review.fix_hint.is_empty() {
        let _ = writeln!(out, "\n{}", review.fix_hint);
    }
    let _ = writeln!(
        out,
        "\nHere is the program that produced it:\n\n```json\n{}\n```",
        serde_json::to_string_pretty(program).unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "\nCall the same tool again to replace it. Keep `id` exactly {:?} — a \
         different id draws a second diagram beside the broken one instead of \
         replacing it. Fix only what is listed above.",
        program.id
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::IoCase;

    fn meta() -> WorkspaceMeta {
        WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: "two-sum".into(),
            question_id: Some("1".into()),
            difficulty: Some("Easy".into()),
            tags: vec![],
            entry_point: Some("twoSum".into()),
            json_path: "corpus.jsonl".into(),
            cases: vec![IoCase {
                input: "nums = [2,7]".into(),
                output: "[0,1]".into(),
            }],
            test: None,
        }
    }

    fn program() -> VizProgram {
        serde_json::from_value(serde_json::json!({
            "viz": "array",
            "id": "viz-1",
            "title": "two pointers",
            "frames": [{"label": "start", "cells": [2, 7, 11], "pointers": {"i": 0, "j": 2}}]
        }))
        .unwrap()
    }

    /// The failure this guards: a model that dislikes the diagram, says so with
    /// no reason, and gets a redraw that is a coin flip. The schema already
    /// passed; a critique with nothing in it is not evidence against it.
    #[test]
    fn a_rejection_that_names_nothing_is_treated_as_a_pass() {
        let empty = parse_draw_review(r#"{"ok": false, "issues": [], "fix_hint": "  "}"#).unwrap();
        assert!(empty.ok);

        let named = parse_draw_review(
            r#"{"ok": false, "issues": ["both pointers sit on index 0 in every frame"],
                "fix_hint": "move j inward as the trace advances"}"#,
        )
        .unwrap();
        assert!(!named.ok);
        assert_eq!(named.issues.len(), 1);
    }

    #[test]
    fn issues_are_capped_and_trimmed() {
        let many: Vec<String> = (0..9).map(|i| format!("\"issue {i}\"")).collect();
        let review = parse_draw_review(&format!(
            r#"{{"ok": false, "issues": [{}, "  ", ""], "fix_hint": "redraw it"}}"#,
            many.join(", ")
        ))
        .unwrap();
        assert_eq!(review.issues.len(), MAX_ISSUES);
        assert!(review.issues.iter().all(|issue| !issue.trim().is_empty()));
    }

    /// The instruction that makes this a *replacement*. Without the pinned id
    /// the fix lands on the board next to what it was fixing.
    #[test]
    fn the_fix_prompt_pins_the_program_id_and_the_named_problems() {
        let review = DrawReview {
            ok: false,
            issues: vec!["both pointers sit on index 0".into()],
            fix_hint: "move j inward".into(),
        };
        let prompt = build_draw_fix_prompt(&program(), &review);
        assert!(prompt.contains("both pointers sit on index 0"));
        assert!(prompt.contains("move j inward"));
        assert!(prompt.contains("Keep `id` exactly \"viz-1\""));
        assert!(prompt.contains("Fix only what is listed above"));
    }

    /// Taste is not an error. A small model asked to critique a picture will
    /// otherwise ask for a nicer one every single time.
    #[test]
    fn the_critique_prompt_asks_about_correctness_not_looks() {
        assert!(DRAW_REVIEW_SYSTEM_PROMPT.contains("WRONG conclusion"));
        assert!(DRAW_REVIEW_SYSTEM_PROMPT.contains("prettier layout"));
        assert!(DRAW_REVIEW_SYSTEM_PROMPT.contains("correct is a pass"));

        let prompt = build_draw_review_prompt(&meta(), None, "show the scan", &program());
        assert!(prompt.contains("show the scan"));
        assert!(prompt.contains("\"id\": \"viz-1\""), "the critique sees the program too");
        assert!(prompt.contains("what that program actually rendered"));
    }
}
