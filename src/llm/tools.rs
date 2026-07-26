//! Tool definitions for the `viz` coach mode.
//!
//! **The model never emits Excalidraw coordinates.** It emits a *viz program* —
//! semantic state per frame — and the client renders it deterministically
//! (`app/src/viz/render/<kind>.ts`). These schemas are the contract between the
//! two; `app/src/viz/schema.ts` mirrors them and must be kept in step.

use serde::{Deserialize, Serialize};

/// Structures the client has a deterministic layout function for.
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

fn frame_schema() -> serde_json::Value {
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

/// The tool set handed to the `viz` provider.
pub fn viz_tools() -> Vec<serde_json::Value> {
    vec![
        tool(
            "draw_structure",
            "Draw one data structure on the board's agent lane. Use for a single static \
             picture — one frame. Never give pixel coordinates; describe the structure and the \
             client lays it out.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "viz": {"type": "string", "enum": VIZ_KINDS},
                    "id": {"type": "string", "description": "Stable id; reusing it replaces the existing diagram instead of adding another."},
                    "title": {"type": "string"},
                    "frames": {"type": "array", "items": frame_schema(), "minItems": 1, "maxItems": 1}
                },
                "required": ["viz", "id", "frames"]
            }),
        ),
        tool(
            "animate_trace",
            "Draw one structure stepped through time. Emit the full state in every frame; the \
             student scrubs the timeline. Use this instead of drawing the same array several \
             times.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "viz": {"type": "string", "enum": VIZ_KINDS},
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "frames": {"type": "array", "items": frame_schema(), "minItems": 2, "maxItems": 40}
                },
                "required": ["viz", "id", "frames"]
            }),
        ),
        tool(
            "annotate_region",
            "Attach a short note to one of the board's regions. Use to point at something the \
             student already wrote.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "region": {
                        "type": "string",
                        "enum": ["approach", "complexity", "walkthrough", "constraints", "agent"]
                    },
                    "text": {"type": "string", "maxLength": 240},
                    "tone": {"type": "string", "enum": ["question", "warning", "confirm"]}
                },
                "required": ["region", "text"]
            }),
        ),
        tool(
            "cite_test_case",
            "Point at one of the numbered sample cases. Only 0-based indices into the cases you \
             were shown are accepted — the daemon rejects anything else.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "case_index": {"type": "integer", "minimum": 0},
                    "why": {"type": "string", "description": "What this case does to their approach."}
                },
                "required": ["case_index", "why"]
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, parameters: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {"name": name, "description": description, "parameters": parameters},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_well_formed() {
        for tool in viz_tools() {
            let function = tool.get("function").expect("function block");
            assert!(function.get("name").and_then(|n| n.as_str()).is_some());
            assert!(function.get("description").is_some());
            assert_eq!(
                function.pointer("/parameters/type").and_then(|t| t.as_str()),
                Some("object")
            );
        }
    }

    #[test]
    fn tool_names_match_the_client_contract() {
        let names: Vec<String> = viz_tools()
            .iter()
            .filter_map(|t| t.pointer("/function/name")?.as_str().map(str::to_string))
            .collect();
        assert_eq!(
            names,
            ["draw_structure", "animate_trace", "annotate_region", "cite_test_case"]
        );
    }

    #[test]
    fn viz_program_kind_is_checked_against_the_renderers() {
        let good: VizProgram = serde_json::from_str(r#"{"viz": "array", "id": "nums"}"#).unwrap();
        assert!(good.is_known_kind());
        let bad: VizProgram = serde_json::from_str(r#"{"viz": "hypercube", "id": "x"}"#).unwrap();
        assert!(!bad.is_known_kind());
        assert!(bad.rejection().unwrap().contains("no renderer"));
    }

    /// Verbatim from granite-4.1-8b: schema-valid, three frames, and nothing to
    /// draw — the map's contents went into `pointers` instead of `entries`.
    #[test]
    fn a_contentless_program_is_rejected_rather_than_drawn_empty() {
        let granite = r#"{
            "viz": "hashmap", "id": "two_sum_hashmap", "title": "Two-Sum one-pass hash map",
            "frames": [
                {"label": "i=0, num=2", "cells": [], "entries": [],
                 "pointers": {"map": 2, "need": 7, "num": 0}, "highlight": [0]},
                {"label": "i=1, num=7", "cells": [], "entries": [],
                 "pointers": {"map": 7, "need": 2, "num": 1}, "highlight": [1]},
                {"label": "found pair", "cells": [], "entries": [], "highlight": [0, 1]}
            ]
        }"#;
        let program: VizProgram = serde_json::from_str(granite).unwrap();
        assert!(program.is_known_kind(), "the kind itself was fine");
        assert!(!program.frames.is_empty(), "the frames were there too");
        assert!(!program.has_content(), "but there was nothing in them");

        let why = program.rejection().expect("must be rejected");
        assert!(why.contains("empty"), "{why}");
        assert!(why.contains("pointers"), "the message names the mistake: {why}");
    }

    /// granite's second attempt, after the schema was sharpened: it moved from
    /// an empty `cells` to `cells: [{}]`, which is still an empty box.
    #[test]
    fn cells_holding_only_empty_objects_are_still_empty() {
        let granite: VizProgram = serde_json::from_str(
            r#"{"viz": "hashmap", "id": "two_sum_hashmap", "frames": [
                {"label": "i=0, num=2", "cells": [{}], "entries": []},
                {"label": "i=1, num=7", "cells": [{}], "entries": []}
            ]}"#,
        )
        .unwrap();
        assert!(!granite.has_content(), "[{{}}] draws nothing");
        assert!(granite.rejection().unwrap().contains("empty"));
    }

    #[test]
    fn null_alone_is_not_content_but_null_beside_a_value_is() {
        let all_null: VizProgram = serde_json::from_str(
            r#"{"viz": "tree", "id": "t", "frames": [{"label": "x", "cells": [null, null]}]}"#,
        )
        .unwrap();
        assert!(!all_null.has_content());

        // A tree's level-order array uses null for gaps; that is legitimate.
        let sparse: VizProgram = serde_json::from_str(
            r#"{"viz": "tree", "id": "t", "frames": [{"label": "x", "cells": [5, null, 8]}]}"#,
        )
        .unwrap();
        assert!(sparse.has_content());
    }

    #[test]
    fn a_program_with_real_contents_passes() {
        let filled: VizProgram = serde_json::from_str(
            r#"{"viz": "hashmap", "id": "seen",
                "frames": [{"label": "i=1", "entries": [[2, 0]], "highlight": [0]}]}"#,
        )
        .unwrap();
        assert!(filled.has_content());
        assert!(filled.rejection().is_none());

        let cells_only: VizProgram = serde_json::from_str(
            r#"{"viz": "array", "id": "nums", "frames": [{"label": "start", "cells": [2, 7]}]}"#,
        )
        .unwrap();
        assert!(cells_only.rejection().is_none(), "cells alone are enough");
    }

    #[test]
    fn the_schema_tells_the_model_where_contents_go() {
        let tools = viz_tools();
        let frame = tools[0]
            .pointer("/function/parameters/properties/frames/items/properties")
            .expect("frame schema");
        let entries = frame["entries"]["description"].as_str().unwrap();
        let pointers = frame["pointers"]["description"].as_str().unwrap();
        assert!(entries.contains("REQUIRED for hashmap"));
        assert!(pointers.contains("never values"), "the observed failure mode");
    }
}
