use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::helpers::parse_reply;

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

pub fn parse_bridge(raw: &str) -> Result<BridgeResponse> {
    parse_reply(raw, "bridge")
}
