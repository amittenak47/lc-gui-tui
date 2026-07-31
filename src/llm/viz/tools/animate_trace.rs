use super::super::kinds::{frame_schema, VIZ_KINDS};
use super::super::registry::{tool_schema, VizTool};

pub struct AnimateTrace;

impl VizTool for AnimateTrace {
    fn name(&self) -> &'static str {
        "animate_trace"
    }

    fn schema(&self) -> serde_json::Value {
        tool_schema(
            self.name(),
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
        )
    }
}
