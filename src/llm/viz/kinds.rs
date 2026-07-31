//! Structures the client has a deterministic layout function for.
//!
//! **The model never emits Excalidraw coordinates.** It emits a *viz program* —
//! semantic state per frame — and the client renders it deterministically
//! (`app/src/viz/render/<kind>.ts`). These schemas are the contract between the
//! two; `app/src/viz/schema.ts` mirrors them and must be kept in step.

use serde::{Deserialize, Serialize};

pub const VIZ_KINDS: [&str; 9] = [
    "array",
    "grid",
    "hashmap",
    "tree",
    "linkedlist",
    "heap",
    "stack",
    "queue",
    "graph",
];

/// One step of an animation: the full semantic state at that moment, not a
/// diff. The scrubber can therefore jump to any frame.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VizFrame {
    pub label: String,
    /// Cell contents, for the linear structures.
    pub cells: Vec<serde_json::Value>,
    /// Named pointers into `cells`, e.g. `{"i": 0, "j": 3}`.
    pub pointers: serde_json::Map<String, serde_json::Value>,
    /// Indices to highlight this frame.
    pub highlight: Vec<usize>,
    /// Key/value pairs, edges, or child links, depending on `viz`.
    pub entries: Vec<serde_json::Value>,
    pub note: String,
}

/// A complete viz program, as emitted by `draw_structure` / `animate_trace`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VizProgram {
    #[serde(rename = "viz")]
    pub kind: String,
    pub id: String,
    pub title: String,
    pub frames: Vec<VizFrame>,
}

impl VizProgram {
    pub fn is_known_kind(&self) -> bool {
        VIZ_KINDS.contains(&self.kind.as_str())
    }

    /// Whether there is anything to draw.
    ///
    /// A model can return a schema-valid program with nothing in it.
    /// granite-4.1-8b does exactly this for `hashmap`: first with
    /// `cells: []`/`entries: []` (contents misfiled into `pointers`), and then,
    /// after the schema spelled out where contents go, with `cells: [{}]` — a
    /// list containing one empty object. Both render as an empty box, so the
    /// check has to look at the *values*, not just the array lengths.
    pub fn has_content(&self) -> bool {
        self.frames
            .iter()
            .any(|frame| {
                frame.cells.iter().any(is_meaningful) || frame.entries.iter().any(is_meaningful)
            })
    }

    /// Why this program cannot be drawn, or `None` if it can.
    pub fn rejection(&self) -> Option<String> {
        if !self.is_known_kind() {
            return Some(format!(
                "no renderer for a {:?} — expected one of {}",
                self.kind,
                VIZ_KINDS.join(", ")
            ));
        }
        if self.frames.is_empty() {
            return Some("the diagram had no frames".to_string());
        }
        if !self.has_content() {
            return Some(format!(
                "every frame of the {:?} was empty — `cells`/`entries` carry the contents, \
                 `pointers` only holds indices",
                self.kind
            ));
        }
        None
    }
}

/// Whether one cell or entry would actually draw as something.
///
/// Scalars do. `null` renders as a placeholder dot, which is meaningful inside a
/// tree's level-order array but is not content on its own. An empty object or
/// array is never content.
fn is_meaningful(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Object(map) => !map.is_empty(),
        serde_json::Value::Array(items) => items.iter().any(is_meaningful),
        _ => true,
    }
}

pub(super) fn frame_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "label": {"type": "string", "description": "Short state label, e.g. \"i=0, j=3\""},
            "cells": {
                "type": "array",
                "description":
                    "THE CONTENTS at this step, in full, not a diff. Required for array, grid, \
                     stack, queue, linkedlist, tree, heap, and graph — a frame with an empty \
                     `cells` draws an empty box. array: [2,7,11,15]. grid: [[1,0],[0,1]]. \
                     tree/heap: level-order with nulls, [5,3,8,null,1]. graph: node labels.",
                "items": {}
            },
            "pointers": {
                "type": "object",
                "description":
                    "Named INDICES into cells — positions, never values, never map contents. \
                     e.g. {\"i\": 0, \"j\": 3}. If you want to show what a variable holds, put it \
                     in `cells`, `entries`, or `note`.",
                "additionalProperties": {"type": "integer"}
            },
            "highlight": {
                "type": "array",
                "description": "Indices to emphasise this step.",
                "items": {"type": "integer"}
            },
            "entries": {
                "type": "array",
                "description":
                    "REQUIRED for hashmap: the map's contents as [key, value] pairs, e.g. \
                     [[2,0],[7,1]]. For tree/graph/linkedlist it holds edges as [from, to]. A \
                     hashmap frame with an empty `entries` draws an empty map.",
                "items": {}
            },
            "note": {"type": "string", "description": "One line on why this step happens."}
        },
        "required": ["label"]
    })
}
