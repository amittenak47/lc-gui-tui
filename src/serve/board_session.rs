//! Server-side whiteboard baseline and delta application.
//!
//! The client may send a full `scene_structure` (legacy / first submit) or a list
//! of `board_ops` since the last acknowledged baseline. This module reconstructs
//! the canonical layout the coach prompt reads — the model never has to merge
//! deltas mentally.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm::coach::BoardSnapshot;

/// One element as captured off the canvas (`{id, type, x, y, w, h, text?}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapturedElement {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Incremental change to the element map since the last server ack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum BoardOp {
    Add {
        element: CapturedElement,
    },
    Update {
        id: String,
        #[serde(default)]
        version: u32,
        element: CapturedElement,
    },
    Delete {
        id: String,
    },
}

/// Per-problem board state held in memory for the lifetime of the daemon.
#[derive(Debug, Clone, Default)]
pub struct BoardSessionState {
    elements: HashMap<String, CapturedElement>,
    /// Truncated ids present at the last successful review ack.
    review_ids: HashSet<String>,
    /// Length of the raster ink op log the client last reported.
    ink_ops_len: usize,
    /// Last pseudocode the coach saw for this problem.
    pseudocode: Option<String>,
    /// SHA-256 hex of the starter skeleton the client claims to be editing.
    skeleton_hash: Option<String>,
}

#[derive(Debug, Default)]
pub struct BoardSessionStore {
    by_task: HashMap<String, BoardSessionState>,
}

impl BoardSessionStore {
    pub fn entry(&mut self, task_id: &str) -> &mut BoardSessionState {
        self.by_task
            .entry(task_id.to_string())
            .or_insert_with(BoardSessionState::default)
    }

    pub fn clear_task(&mut self, task_id: &str) {
        self.by_task.remove(task_id);
    }
}

impl BoardSessionState {
    pub fn acknowledge_review(&mut self, element_ids: impl IntoIterator<Item = String>) {
        self.review_ids = element_ids.into_iter().collect();
    }

    pub fn acknowledge_pseudocode(&mut self, text: impl Into<String>) {
        self.pseudocode = Some(text.into());
    }
}

/// Apply one op to the element map.
pub fn apply_board_op(elements: &mut HashMap<String, CapturedElement>, op: &BoardOp) {
    match op {
        BoardOp::Add { element } => {
            elements.insert(element.id.clone(), element.clone());
        }
        BoardOp::Update { id, element, .. } => {
            elements.insert(id.clone(), element.clone());
        }
        BoardOp::Delete { id } => {
            elements.remove(id);
        }
    }
}

fn structure_to_elements(structure: &Value) -> HashMap<String, CapturedElement> {
    let Some(arr) = structure.as_array() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for value in arr {
        if let Ok(el) = serde_json::from_value::<CapturedElement>(value.clone()) {
            out.insert(el.id.clone(), el);
        }
    }
    out
}

fn elements_to_structure(elements: &HashMap<String, CapturedElement>) -> Value {
    let mut items: Vec<&CapturedElement> = elements.values().collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    serde_json::to_value(items).unwrap_or(Value::Array(vec![]))
}

/// Reconstruct a coach-facing snapshot from an incoming payload and session state.
///
/// Returns the resolved snapshot and whether the client sent a delta (for metrics).
pub fn resolve_board_snapshot(
    state: &mut BoardSessionState,
    incoming: BoardSnapshot,
) -> BoardSnapshot {
    if let Some(raw_ops) = incoming.board_ops.as_ref() {
        let ops: Vec<BoardOp> = raw_ops
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        for op in &ops {
            apply_board_op(&mut state.elements, op);
        }
    } else if let Some(structure) = incoming.scene_structure.as_ref() {
        state.elements = structure_to_elements(structure);
    }

    if let Some(len) = incoming.ink_ops_len {
        state.ink_ops_len = len;
    }

    let mut resolved = incoming;
    resolved.scene_structure = Some(elements_to_structure(&state.elements));
    resolved.board_ops = None;

    if !state.review_ids.is_empty() {
        let added: Vec<String> = state
            .elements
            .keys()
            .filter(|id| !state.review_ids.contains(*id))
            .cloned()
            .collect();
        if !added.is_empty() {
            resolved.new_since_last = added;
        }
    }

    resolved
}

/// Resolve pseudocode from optional delta fields. Falls back to the incoming
/// full text and updates the session baseline.
pub fn resolve_pseudocode(
    state: &mut BoardSessionState,
    incoming: &BoardSnapshot,
) -> Option<String> {
    if let Some(mode) = incoming.code_mode.as_deref() {
        if mode == "delta" {
            if let Some(delta) = incoming.pseudocode_delta.as_deref() {
                if incoming
                    .skeleton_hash
                    .as_deref()
                    .is_some_and(|h| state.skeleton_hash.as_deref() == Some(h))
                {
                    let merged = merge_solution_delta(state.pseudocode.as_deref(), delta);
                    state.pseudocode = Some(merged.clone());
                    return Some(merged);
                }
            }
        }
    }

    if let Some(hash) = incoming.skeleton_hash.as_deref() {
        state.skeleton_hash = Some(hash.to_string());
    }

    if let Some(text) = incoming
        .pseudocode
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        state.pseudocode = Some(text.to_string());
        return Some(text.to_string());
    }

    state.pseudocode.clone()
}

/// Merge a method-body delta into a stored full file.
///
/// Phase 3 sends the *entire current solution* in `pseudocode_delta` when the
/// skeleton hash still matches — the wire savings come from omitting it when
/// unchanged (see `code_unchanged`). A true line-range patch can slot in here
/// later without changing the wire shape.
fn merge_solution_delta(_baseline: Option<&str>, delta: &str) -> String {
    delta.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::coach::BoardSnapshot;

    fn el(id: &str, x: i32) -> CapturedElement {
        CapturedElement {
            id: id.into(),
            kind: "rectangle".into(),
            x,
            y: 0,
            w: 10,
            h: 10,
            text: None,
            region: None,
        }
    }

    #[test]
    fn ops_apply_add_update_delete() {
        let mut map = HashMap::new();
        apply_board_op(&mut map, &BoardOp::Add { element: el("a", 1) });
        assert_eq!(map.get("a").unwrap().x, 1);
        apply_board_op(
            &mut map,
            &BoardOp::Update {
                id: "a".into(),
                version: 2,
                element: el("a", 9),
            },
        );
        assert_eq!(map.get("a").unwrap().x, 9);
        apply_board_op(&mut map, &BoardOp::Delete { id: "a".into() });
        assert!(!map.contains_key("a"));
    }

    #[test]
    fn full_structure_seeds_baseline_then_ops_merge() {
        let mut state = BoardSessionState::default();
        let seed = BoardSnapshot {
            scene_structure: Some(serde_json::json!([el("a", 1)])),
            ..Default::default()
        };
        let _ = resolve_board_snapshot(&mut state, seed);

        let delta = BoardSnapshot {
            board_ops: Some(vec![
                serde_json::to_value(BoardOp::Add {
                    element: el("b", 2),
                })
                .unwrap(),
                serde_json::to_value(BoardOp::Delete { id: "a".into() }).unwrap(),
            ]),
            ..Default::default()
        };
        let resolved = resolve_board_snapshot(&mut state, delta);
        let arr = resolved.scene_structure.unwrap();
        let ids: Vec<String> = arr
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.get("id").and_then(|id| id.as_str()).map(str::to_string))
            .collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn new_since_last_comes_from_review_ack_ids() {
        let mut state = BoardSessionState::default();
        state.acknowledge_review(["a".into()]);
        state.elements.insert("a".into(), el("a", 1));
        state.elements.insert("b".into(), el("b", 2));

        let resolved = resolve_board_snapshot(
            &mut state,
            BoardSnapshot {
                board_ops: Some(vec![]),
                ..Default::default()
            },
        );
        assert_eq!(resolved.new_since_last, vec!["b"]);
    }

    #[test]
    fn code_unchanged_reuses_session_pseudocode() {
        let mut state = BoardSessionState::default();
        state.pseudocode = Some("def solve(): pass".into());
        state.skeleton_hash = Some("abc".into());

        let incoming = BoardSnapshot {
            code_mode: Some("unchanged".into()),
            skeleton_hash: Some("abc".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_pseudocode(&mut state, &incoming).as_deref(),
            Some("def solve(): pass")
        );
    }
}
