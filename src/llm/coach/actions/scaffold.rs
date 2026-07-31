//! Board scaffolding — problem-specific region prompts for a fresh template.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::helpers::parse_reply;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BoardScaffold {
    /// Short approach outline (bullets or numbered steps). No solution code.
    pub approach: String,
    /// Suggested time/space complexity framing — not the final answer.
    pub complexity: String,
    /// How to walk one example by hand — variables to track, not the answer.
    pub walkthrough: String,
}

pub fn parse_board_scaffold(raw: &str) -> Result<BoardScaffold> {
    let mut parsed: BoardScaffold = parse_reply(raw, "board scaffold")?;
    parsed.approach = parsed.approach.trim().to_string();
    parsed.complexity = parsed.complexity.trim().to_string();
    parsed.walkthrough = parsed.walkthrough.trim().to_string();
    if parsed.approach.is_empty() && parsed.complexity.is_empty() && parsed.walkthrough.is_empty()
    {
        anyhow::bail!("board scaffold returned empty prompts");
    }
    Ok(parsed)
}
