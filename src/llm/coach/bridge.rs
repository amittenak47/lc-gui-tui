use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;
use crate::runner::CaseResult;

use super::board::BoardSnapshot;
use crate::llm::helpers::{
    parse_reply, write_cases, write_problem_header, MAX_CASE, MAX_REFERENCE,
};
use super::pipeline::{board_without_code, write_claim, Claim};

// ---------------------------------------------------------------------------
// Mode C — the bridge, after an explicit reveal
// ---------------------------------------------------------------------------


#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeStep {
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeResponse {
    /// What their approach already gets right.
    pub already_yours: String,
    /// The one idea they are missing.
    pub missing_piece: String,
    pub steps: Vec<BridgeStep>,
    /// The smallest single edit that makes progress today.
    pub smallest_edit: String,
}

/// Build the bridge prompt.
///
/// `reference` is reference-solution text and must only ever come from
/// [`crate::reveal::SolutionReveal`], which is constructed from an explicit
/// user reveal. Nothing in the review or ambient path calls this.
pub fn build_bridge_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
    failing: &[CaseResult],
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);

    if !failing.is_empty() {
        let _ = writeln!(out, "\n## Cases their current code fails");
        for result in failing.iter().take(3) {
            let _ = writeln!(out, "\n### Case {}", result.case);
            let _ = writeln!(out, "- input:    `{}`", clip(&result.input, MAX_CASE));
            let _ = writeln!(out, "- expected: `{}`", clip(&result.expected, MAX_CASE));
            if let Some(actual) = &result.actual {
                let _ = writeln!(out, "- actual:   `{}`", clip(actual, MAX_CASE));
            }
        }
    }

    let _ = writeln!(
        out,
        "\n## Reference solution (the student asked for this — use it to plan the path, \
         do not paste it back)\n\n```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"already_yours\": \"...\", \"missing_piece\": \"...\", \
         \"steps\": [{{\"title\": \"...\", \"detail\": \"...\"}}], \
         \"smallest_edit\": \"the one change to make right now\"}}\n\
         ```"
    );
    out
}

pub fn parse_bridge(raw: &str) -> Result<BridgeResponse> {
    parse_reply(raw, "bridge")
}

// ---------------------------------------------------------------------------
// Lazy fill — write the parts of solution.py the student already earned
// ---------------------------------------------------------------------------



#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LazyFillResponse {
    /// Full `solution.py` text to write into the workspace.
    pub filled_code: String,
    /// Short note of what was filled vs left for the student.
    pub note: String,
}

/// Lazy fill without a reference (composer Lazy flag).
///
/// `claim` is the claim the staged review already froze for this board. Passing
/// it is what makes Lazy fill *implement the drawing* rather than re-interpret
/// it: the same understanding the student just saw on their review card is the
/// thing that gets written into `solution.py`. `None` means no review has been
/// run for this board yet, and the model reads the board directly.
pub fn build_lazy_fill_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: Option<&Claim>,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    // Board only — ignore whatever is in the code dock.
    board_without_code(board).write_into(&mut out);
    if let Some(claim) = claim {
        write_claim(&mut out, claim);
    }
    let _ = writeln!(
        out,
        "\n## Task\n\n{}\n\n\
         ## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"one or two sentences: what you filled from the board vs left as TODO\"}}\n\
         ```",
        if claim.is_some() {
            "Write `filled_code`: full working Python for the claim above. Every step the claim \
             justifies must be implemented, not left as a TODO — only what the claim says it has \
             not decided may stay `pass` / `# TODO:`."
        } else {
            "Interpret the drawing. Write `filled_code` that correctly implements what the board \
             already justifies (full working code for those parts). Leave only unearned ideas as \
             TODO/pass."
        }
    );
    out
}

/// Lazy fill after Hint confirm — reference is allowed for the earned parts only.
pub fn build_lazy_hint_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);
    let _ = writeln!(
        out,
        "\n## Reference solution (use only to flesh out what they already earned)\n\n\
         ```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"what you filled vs left for them\"}}\n\
         ```"
    );
    out
}

pub fn parse_lazy_fill(raw: &str) -> Result<LazyFillResponse> {
    let mut parsed: LazyFillResponse = parse_reply(raw, "lazy fill")?;
    parsed.filled_code = parsed.filled_code.trim().to_string();
    if parsed.filled_code.is_empty() {
        anyhow::bail!("lazy fill returned empty filled_code");
    }
    Ok(parsed)
}
