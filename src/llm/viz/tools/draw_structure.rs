use super::super::kinds::{frame_schema, VIZ_KINDS};
use super::super::registry::{tool_schema, VizTool};

pub struct DrawStructure;

impl VizTool for DrawStructure {
    fn name(&self) -> &'static str {
        "draw_structure"
    }

    fn schema(&self) -> serde_json::Value {
        tool_schema(
            self.name(),
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
        )
    }
}
