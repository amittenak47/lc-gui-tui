use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::helpers::parse_reply;

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

pub fn parse_lazy_fill(raw: &str) -> Result<LazyFillResponse> {
    let mut parsed: LazyFillResponse = parse_reply(raw, "lazy fill")?;
    parsed.filled_code = parsed.filled_code.trim().to_string();
    if parsed.filled_code.is_empty() {
        anyhow::bail!("lazy fill returned empty filled_code");
    }
    Ok(parsed)
}
