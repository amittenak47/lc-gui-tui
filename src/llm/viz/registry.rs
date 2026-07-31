use crate::llm::ToolCall;

use super::tools::{
    AnimateTrace, AnnotateRegion, CiteTestCase, DrawStructure, HighlightStudentWork,
};

/// One OpenAI-shaped viz tool: stable name plus full schema JSON.
pub trait VizTool: Send + Sync {
    fn name(&self) -> &'static str;
    fn schema(&self) -> serde_json::Value;
}

pub(super) fn tool_schema(
    name: &str,
    description: &str,
    parameters: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {"name": name, "description": description, "parameters": parameters},
    })
}

/// Ordered registry — add a tool = new file under `tools/` + one line here.
pub fn registry() -> Vec<Box<dyn VizTool>> {
    vec![
        Box::new(DrawStructure),
        Box::new(AnimateTrace),
        Box::new(AnnotateRegion),
        Box::new(CiteTestCase),
        Box::new(HighlightStudentWork),
    ]
}

/// The tool set handed to the `viz` provider.
pub fn viz_tools() -> Vec<serde_json::Value> {
    registry().into_iter().map(|tool| tool.schema()).collect()
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
pub fn parse_tool_calls(raw: &str) -> Vec<ToolCall> {
    let Some(json) = crate::llm::helpers::extract_json(raw) else {
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

    let known: Vec<&'static str> = registry().into_iter().map(|t| t.name()).collect();

    calls
        .into_iter()
        .filter_map(|call| {
            let name = ["tool", "name", "function"]
                .iter()
                .find_map(|key| call.get(*key)?.as_str())?
                .to_string();
            if !known.contains(&name.as_str()) {
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
            Some(ToolCall { name, arguments })
        })
        .collect()
}
