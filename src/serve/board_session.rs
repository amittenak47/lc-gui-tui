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
        let mut added: Vec<String> = state
            .elements
            .keys()
            .filter(|id| !state.review_ids.contains(*id))
            .cloned()
            .collect();
        // Sorted because this goes into the prompt: iteration order of the
        // element map is arbitrary, and the coach should not see the same board
        // described differently on two runs.
        added.sort();
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
    if incoming.code_mode.as_deref() == Some("delta") {
        let anchored = incoming
            .skeleton_hash
            .as_deref()
            .is_some_and(|h| state.skeleton_hash.as_deref() == Some(h));
        return match incoming.pseudocode_delta.as_deref().filter(|_| anchored) {
            Some(delta) => {
                let merged = merge_solution_delta(state.pseudocode.as_deref(), delta);
                state.pseudocode = Some(merged.clone());
                Some(merged)
            }
            // The delta is anchored to a skeleton this session never acked, so
            // it cannot be reconstructed. Returning the last text we held would
            // have the coach critique code the student has since rewritten —
            // confidently, and about lines that no longer exist. A review with
            // no code attached is the honest degradation.
            None => None,
        };
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
/// `pseudocode_delta` carries the *entire current solution*, so this is a
/// passthrough. Before replacing it with a real line patch, note that it would
/// save nothing: `submitForReview` calls `syncSolution()` first, which PUTs the
/// whole file to `/workspace/:id/solution` in the request immediately before
/// `/coach/review`. The code bytes are already on the wire.
///
/// The saving worth having is the opposite direction — the daemon has that file
/// on disk by the time the review arrives, so the review payload could carry no
/// code at all and the server could read it. That removes the code from the
/// wire entirely instead of compressing a duplicate.
fn merge_solution_delta(_baseline: Option<&str>, delta: &str) -> String {
    delta.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::WorkspaceMeta;
    use crate::llm::coach::{build_review_prompt, BoardSnapshot};
    use crate::problem::IoCase;

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

    /// Seed a session the way a first review does, then send `ops` as a second.
    fn seed_then(seed: Vec<CapturedElement>, ops: Vec<BoardOp>) -> BoardSnapshot {
        let mut state = BoardSessionState::default();
        let _ = resolve_board_snapshot(
            &mut state,
            BoardSnapshot {
                scene_structure: Some(serde_json::to_value(&seed).unwrap()),
                ..Default::default()
            },
        );
        resolve_board_snapshot(
            &mut state,
            BoardSnapshot {
                board_ops: Some(ops.iter().map(|o| serde_json::to_value(o).unwrap()).collect()),
                ..Default::default()
            },
        )
    }

    /// What the same board looks like when a legacy client dumps it in full.
    fn full_send(elements: Vec<CapturedElement>) -> BoardSnapshot {
        let mut state = BoardSessionState::default();
        resolve_board_snapshot(
            &mut state,
            BoardSnapshot {
                scene_structure: Some(serde_json::to_value(&elements).unwrap()),
                ..Default::default()
            },
        )
    }

    #[test]
    fn a_delta_reconstructs_exactly_what_a_full_dump_would_have_sent() {
        // The wire saving is only worth having if the prompt cannot tell the
        // difference — deltas are transport, never something the model merges.
        let seeded = vec![el("keep", 1), el("move", 2), el("drop", 3)];
        let mut moved = el("move", 40);
        moved.text = Some("binary search on the answer".into());

        let via_delta = seed_then(
            seeded,
            vec![
                BoardOp::Update {
                    id: "move".into(),
                    version: 2,
                    element: moved.clone(),
                },
                BoardOp::Delete { id: "drop".into() },
                BoardOp::Add {
                    element: el("added", 9),
                },
            ],
        );
        let via_full = full_send(vec![el("added", 9), el("keep", 1), moved]);

        assert_eq!(via_delta.scene_structure, via_full.scene_structure);
    }

    #[test]
    fn a_deleted_element_disappears_from_the_review_prompt() {
        let resolved = seed_then(
            vec![
                CapturedElement {
                    text: Some("two pointers from both ends".into()),
                    ..el("keep", 1)
                },
                CapturedElement {
                    text: Some("sort the array first".into()),
                    ..el("drop", 2)
                },
            ],
            vec![BoardOp::Delete { id: "drop".into() }],
        );

        let meta = WorkspaceMeta {
            task_id: "two-sum".into(),
            question_id: Some("1".into()),
            difficulty: Some("Easy".into()),
            tags: vec!["Array".into()],
            entry_point: Some("twoSum".into()),
            json_path: "corpus.jsonl".into(),
            cases: vec![IoCase {
                input: "nums = [2,7]".into(),
                output: "[0,1]".into(),
            }],
            test: None,
        };
        let prompt = build_review_prompt(&meta, None, &resolved);

        assert!(prompt.contains("two pointers from both ends"));
        // The erased idea must not linger in the prompt, or the coach keeps
        // arguing with work the student already took off the board.
        assert!(!prompt.contains("sort the array first"));
        assert!(!prompt.contains("\"drop\""));
    }

    #[test]
    fn new_since_last_is_ordered_so_the_prompt_is_stable() {
        let mut state = BoardSessionState::default();
        state.acknowledge_review(["a".into()]);
        for id in ["z", "a", "m"] {
            state.elements.insert(id.into(), el(id, 1));
        }
        let resolved = resolve_board_snapshot(
            &mut state,
            BoardSnapshot {
                board_ops: Some(vec![]),
                ..Default::default()
            },
        );
        assert_eq!(resolved.new_since_last, vec!["m", "z"]);
    }

    #[test]
    fn an_unanchored_delta_yields_no_code_rather_than_stale_code() {
        // Reachable the moment `skeleton_hash` starts tracking edits to the
        // skeleton, which is what makes a delta mode worth having at all.
        let mut state = BoardSessionState::default();
        state.pseudocode = Some("def solve(): return 1  # the old attempt".into());
        state.skeleton_hash = Some("sha256:starter".into());

        let incoming = BoardSnapshot {
            code_mode: Some("delta".into()),
            skeleton_hash: Some("sha256:they-edited-the-imports".into()),
            pseudocode_delta: Some("def solve(): return 2".into()),
            ..Default::default()
        };
        assert_eq!(resolve_pseudocode(&mut state, &incoming), None);
        // And the baseline must not drift to something never reviewed.
        assert_eq!(
            state.pseudocode.as_deref(),
            Some("def solve(): return 1  # the old attempt")
        );
    }

    #[test]
    fn an_anchored_delta_replaces_the_session_pseudocode() {
        let mut state = BoardSessionState::default();
        state.pseudocode = Some("def solve(): return 1".into());
        state.skeleton_hash = Some("sha256:starter".into());

        let incoming = BoardSnapshot {
            code_mode: Some("delta".into()),
            skeleton_hash: Some("sha256:starter".into()),
            pseudocode_delta: Some("def solve(): return 2".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_pseudocode(&mut state, &incoming).as_deref(),
            Some("def solve(): return 2")
        );
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
