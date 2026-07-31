use super::super::registry::{tool_schema, VizTool};

pub struct CiteTestCase;

impl VizTool for CiteTestCase {
    fn name(&self) -> &'static str {
        "cite_test_case"
    }

    fn schema(&self) -> serde_json::Value {
        tool_schema(
            self.name(),
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
        )
    }
}
