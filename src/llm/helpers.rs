//! Shared text helpers for LLM prompt assembly and reply parsing.
//!
//! Kept as a neutral leaf so `viz` / tools can scrape JSON without depending on
//! `coach`, and coach modules can truncate without depending on `ask`.

use std::fmt::Write as _;

use anyhow::{Context, Result};

use crate::generator::WorkspaceMeta;
use crate::problem::IoCase;

pub const MAX_DESCRIPTION: usize = 6000;
pub const MAX_BOARD: usize = 8000;
pub const MAX_STRUCTURE: usize = 4000;
pub const MAX_REFERENCE: usize = 8000;
pub const MAX_CASE: usize = 400;
/// Sample cases shown to the coach. Enough to pick a real counterexample from,
/// small enough to leave room for the board on a 8k-context local model.
pub const MAX_CASES_SHOWN: usize = 12;

/// Hard cap on the Ask `question` field for corpus problems.
///
/// Leaves room for the statement and code on an ~8k local model. Keep in sync
/// with `PROBLEM_ASK_CLIP_CHARS` in `app/src/modes/coachMarkContext.ts`.
pub const ASK_QUESTION_MAX: usize = 4000;

/// Document / whiteboard Ask has no code dump competing for context.
/// Keep in sync with `PAD_ASK_CLIP_CHARS` in `coachMarkContext.ts`.
pub const PAD_ASK_QUESTION_MAX: usize = 12_000;

/// Shared by coach (and ask), which follow the same section-heading style.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}\n…(truncated)")
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

pub fn write_problem_header(out: &mut String, meta: &WorkspaceMeta, description: Option<&str>) {
    if crate::pad::is_whiteboard_meta(meta) {
        let _ = writeln!(out, "# Whiteboard");
        if !meta.tags.is_empty() {
            let _ = writeln!(out, "Tags: {}", meta.tags.join(", "));
        }
        let desc = description.unwrap_or(crate::pad::WHITEBOARD_DESCRIPTION);
        let _ = writeln!(out, "\n## Context\n\n{}", clip(desc, MAX_DESCRIPTION));
        return;
    }
    if crate::pad::is_annotate_meta(meta) {
        let _ = writeln!(out, "# Annotated source");
        if !meta.tags.is_empty() {
            let _ = writeln!(out, "Tags: {}", meta.tags.join(", "));
        }
        let desc = description.unwrap_or(crate::pad::ANNOTATE_DESCRIPTION);
        let _ = writeln!(out, "\n## Context\n\n{}", clip(desc, MAX_DESCRIPTION));
        return;
    }
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
}

/// The numbered sample cases a counterexample must be cited from. These are
/// sample I/O out of `.lc/meta.json`, not reference solutions, so showing them
/// preserves the redaction invariant.
pub fn write_cases(out: &mut String, cases: &[IoCase]) {
    if cases.is_empty() {
        let _ = writeln!(
            out,
            "\n## Sample cases\n\n(none in the corpus for this problem — you cannot cite a \
             counterexample; set it to null)"
        );
        return;
    }
    let _ = writeln!(
        out,
        "\n## Sample cases (cite counterexamples by these 0-based indices)"
    );
    for (i, case) in cases.iter().take(MAX_CASES_SHOWN).enumerate() {
        let _ = writeln!(
            out,
            "- [{i}] input: `{}` → expected: `{}`",
            clip(&case.input, MAX_CASE),
            clip(&case.output, MAX_CASE)
        );
    }
    if cases.len() > MAX_CASES_SHOWN {
        let _ = writeln!(
            out,
            "\n(only the first {MAX_CASES_SHOWN} of {} cases are shown; cite one of these)",
            cases.len()
        );
    }
}

/// Extract and deserialize a coach reply.
///
/// Deliberately lenient about the ways a small local model malforms JSON, and
/// strict about nothing except "is the payload usable". In particular it goes
/// via [`serde_json::Value`], which makes a **duplicate field last-wins**
/// instead of a hard error — an 8B model that emits
/// `why_your_approach_fails` twice should not cost the student their whole
/// review.
pub fn parse_reply<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T> {
    let json = extract_json(raw)
        .with_context(|| format!("the coach did not return JSON: {}", clip(raw, 400)))?;
    let value: serde_json::Value = serde_json::from_str(json)
        .with_context(|| format!("bad {what} JSON: {}", clip(json, 400)))?;
    serde_json::from_value(value)
        .with_context(|| format!("unexpected {what} shape: {}", clip(json, 400)))
}

/// Pull the JSON object out of a reply, tolerating markdown fences and the
/// leading chatter small local models like to add.
pub fn extract_json(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }
    // Balanced scan, so a `}` inside a string value doesn't cut it short.
    let bytes = trimmed.as_bytes();
    let start = trimmed.find('{')?;
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_string {
            match c {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&trimmed[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}
