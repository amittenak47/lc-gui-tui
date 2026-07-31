use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::helpers::parse_reply;

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

pub fn parse_ambient(raw: &str) -> Result<AmbientNudge> {
    let mut nudge: AmbientNudge = parse_reply(raw, "ambient")?;
    nudge.confidence = nudge.confidence.clamp(0.0, 1.0);
    Ok(nudge)
}
