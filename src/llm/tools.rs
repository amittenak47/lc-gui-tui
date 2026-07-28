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
        tool(
            "highlight_student_work",
            "Point at specific student board elements without editing them. Use the truncated \
             `id` values from the canvas layout JSON. Draws a dashed overlay the student can clear.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 6
                    },
                    "tone": {"type": "string", "enum": ["question", "warning", "confirm"]},
                    "note": {"type": "string", "maxLength": 240}
                },
                "required": ["ids", "note"]
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

// ---------------------------------------------------------------------------
// The no-tool-calling fallback
// ---------------------------------------------------------------------------

/// The tool set, written out as instructions for a server that refuses `tools`.
///
/// vLLM rejects a request carrying `tools` unless it was started with
/// `--enable-auto-tool-choice` and a `--tool-call-parser`, and a plain
/// llama.cpp or LM Studio build often has no tool support at all. Diagrams are
/// the one coach mode built entirely on tool calls, so without this **Draw**
/// simply does not work on those servers.
///
/// The schemas here are the same [`viz_tools`] values, so the two cannot drift.
pub fn viz_tools_as_prompt() -> String {
    let rendered: Vec<serde_json::Value> = viz_tools()
        .into_iter()
        .filter_map(|tool| tool.get("function").cloned())
        .collect();
    format!(
        "Your server does not support tool calls, so emit them as JSON instead.\n\n\
         The tools available to you:\n\n```json\n{}\n```\n\n\
         Reply with a single JSON object and nothing else — no prose, no markdown fence:\n\n\
         ```json\n\
         {{\"calls\": [{{\"tool\": \"<one of the names above>\", \"arguments\": {{…}}}}]}}\n\
         ```\n\n\
         `arguments` must match that tool's `parameters` schema exactly. Emit one entry per \
         thing you want drawn; an empty `calls` list means you have nothing to draw.",
        serde_json::to_string_pretty(&rendered).unwrap_or_else(|_| "[]".into())
    )
}

/// Read tool calls back out of a JSON reply produced by [`viz_tools_as_prompt`].
///
/// Deliberately lenient about shape — a model told to emit `{"calls": [...]}`
/// will sometimes emit the bare array, or name the field `name` instead of
/// `tool`. Names that are not real tools are dropped here rather than becoming
/// "ignored an unknown tool call" noise in the UI.
pub fn parse_tool_calls(raw: &str) -> Vec<super::ToolCall> {
    let Some(json) = crate::llm::coach::extract_json(raw) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let calls = match value.get("calls").or_else(|| value.get("tool_calls")) {
        Some(serde_json::Value::Array(items)) => items.clone(),
        _ => match value {
            serde_json::Value::Array(items) => items,
            // A single call, emitted without the envelope.
            other if other.get("tool").is_some() || other.get("name").is_some() => vec![other],
            _ => return Vec::new(),
        },
    };

    let known: Vec<String> = viz_tools()
        .iter()
        .filter_map(|t| t.pointer("/function/name")?.as_str().map(str::to_string))
        .collect();

    calls
        .into_iter()
        .filter_map(|call| {
            let name = ["tool", "name", "function"]
                .iter()
                .find_map(|key| call.get(*key)?.as_str())?
                .to_string();
            if !known.contains(&name) {
                return None;
            }
            let arguments = ["arguments", "args", "parameters", "input"]
                .iter()
                .find_map(|key| call.get(*key))
                .cloned()
                // Some models inline the arguments beside the name.
                .unwrap_or_else(|| call.clone());
            // Arguments may still arrive as a JSON *string*, as in the wire format.
            let arguments = match arguments {
                serde_json::Value::String(text) => {
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
                }
                other => other,
            };
            Some(super::ToolCall { name, arguments })
        })
        .collect()
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
            ["draw_structure", "animate_trace", "annotate_region", "cite_test_case", "highlight_student_work"]
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

    /// The failure this exists for, verbatim from vLLM: every Draw request
    /// died on a 400 because the server was not started with
    /// `--enable-auto-tool-choice`.
    #[test]
    fn a_server_that_refuses_tools_is_recognized_and_a_real_error_is_not() {
        use crate::llm::is_tool_calling_unsupported;
        let vllm = anyhow::anyhow!(
            "LLM request to http://localhost:8000/v1/chat/completions failed (400 Bad Request): \
             {{\"error\":{{\"message\":\"\\\"auto\\\" tool choice requires \
             --enable-auto-tool-choice and --tool-call-parser to be set\",\
             \"type\":\"BadRequestError\",\"param\":null,\"code\":400}}}}"
        );
        assert!(is_tool_calling_unsupported(&vllm));

        for real in [
            "cannot reach the LLM at http://localhost:8000/v1 — start your server first",
            "LLM request failed (500 Internal Server Error): out of memory",
        ] {
            assert!(
                !is_tool_calling_unsupported(&anyhow::anyhow!("{real}")),
                "{real} is not a tool-calling problem"
            );
        }
    }

    #[test]
    fn the_prompt_fallback_carries_the_same_schemas_as_the_tools() {
        let prompt = viz_tools_as_prompt();
        for name in [
            "draw_structure",
            "animate_trace",
            "annotate_region",
            "cite_test_case",
            "highlight_student_work",
        ] {
            assert!(prompt.contains(name), "{name} missing from the fallback prompt");
        }
        // The schema detail that keeps hashmaps from drawing empty must survive.
        assert!(prompt.contains("REQUIRED for hashmap"));
        assert!(prompt.contains("\"calls\""));
    }

    #[test]
    fn json_tool_calls_are_read_back_in_the_shapes_models_actually_emit() {
        let enveloped = parse_tool_calls(
            r#"Sure!
            ```json
            {"calls": [{"tool": "draw_structure",
                        "arguments": {"viz": "array", "id": "nums",
                                      "frames": [{"label": "start", "cells": [2, 7]}]}}]}
            ```"#,
        );
        assert_eq!(enveloped.len(), 1);
        assert_eq!(enveloped[0].name, "draw_structure");
        let program: VizProgram = serde_json::from_value(enveloped[0].arguments.clone()).unwrap();
        assert!(program.rejection().is_none(), "the parsed call is drawable");

        // A bare array, `name` instead of `tool`, and stringified arguments.
        let loose = parse_tool_calls(
            r#"[{"name": "cite_test_case", "args": "{\"case_index\": 1, \"why\": \"dupes\"}"}]"#,
        );
        assert_eq!(loose.len(), 1);
        assert_eq!(loose[0].arguments["case_index"], 1);

        // A hallucinated tool is dropped rather than reported as unknown.
        assert!(parse_tool_calls(r#"{"calls": [{"tool": "teleport", "arguments": {}}]}"#).is_empty());
        assert!(parse_tool_calls("no json at all").is_empty());
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
