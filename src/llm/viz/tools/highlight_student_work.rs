use super::super::registry::{tool_schema, VizTool};

pub struct HighlightStudentWork;

impl VizTool for HighlightStudentWork {
    fn name(&self) -> &'static str {
        "highlight_student_work"
    }

    fn schema(&self) -> serde_json::Value {
        tool_schema(
            self.name(),
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
        )
    }
}
