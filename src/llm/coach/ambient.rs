use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

use super::board::BoardSnapshot;
use crate::llm::helpers::{parse_reply, write_cases, write_problem_header};

// ---------------------------------------------------------------------------
// Mode B — ambient nudges
// ---------------------------------------------------------------------------


#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AmbientNudge {
    /// 0.0–1.0, how sure the coach is that it read the approach correctly.
    pub confidence: f32,
    pub guessed_approach: String,
    /// "cold" | "warm" | "close" | "there"
    pub closeness: String,
    pub nudge: String,
}

/// How hard the coach is allowed to push, derived from how many nudges this
/// session has already produced for the problem.
pub fn escalation_instruction(nudges_so_far: u32) -> &'static str {
    match nudges_so_far {
        0 => "This is your first nudge: ask one light question about their direction.",
        1 => "Second nudge: name the concept or invariant that matters, without solving it.",
        2 => "Third nudge: point at the shape of input that breaks or slows their approach.",
        _ => "They are stuck. Cite one concrete sample case by its index and what it does to \
              their approach — still no code.",
    }
}

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

pub fn parse_ambient(raw: &str) -> Result<AmbientNudge> {
    let mut nudge: AmbientNudge = parse_reply(raw, "ambient")?;
    nudge.confidence = nudge.confidence.clamp(0.0, 1.0);
    Ok(nudge)
}
