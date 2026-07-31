use super::super::registry::{tool_schema, VizTool};

pub struct AnnotateRegion;

impl VizTool for AnnotateRegion {
    fn name(&self) -> &'static str {
        "annotate_region"
    }

    fn schema(&self) -> serde_json::Value {
        tool_schema(
            self.name(),
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
        )
    }
}
