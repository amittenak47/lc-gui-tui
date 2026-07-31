//! Tool definitions for the `viz` coach mode.
//!
//! **The model never emits Excalidraw coordinates.** It emits a *viz program* —
//! semantic state per frame — and the client renders it deterministically
//! (`app/src/viz/render/<kind>.ts`). These schemas are the contract between the
//! two; `app/src/viz/schema.ts` mirrors them and must be kept in step.

mod kinds;
mod registry;
pub mod tools;

pub use kinds::{VizFrame, VizProgram, VIZ_KINDS};
pub use registry::{parse_tool_calls, registry, viz_tools, viz_tools_as_prompt, VizTool};

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
            [
                "draw_structure",
                "animate_trace",
                "annotate_region",
                "cite_test_case",
                "highlight_student_work"
            ]
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
        assert!(
            why.contains("pointers"),
            "the message names the mistake: {why}"
        );
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
            assert!(
                prompt.contains(name),
                "{name} missing from the fallback prompt"
            );
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
        assert!(
            parse_tool_calls(r#"{"calls": [{"tool": "teleport", "arguments": {}}]}"#).is_empty()
        );
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
