pub mod ask;
pub mod coach;
pub mod docs;
pub mod helpers;
pub mod lifecycle;
pub mod providers;
pub mod reasoning;
pub mod viz;

/// Deprecated alias — prefer [`viz`]. Kept so `crate::llm::tools` imports keep working.
pub mod tools {
    pub use super::viz::*;
}

pub use providers::{
    is_tool_calling_unsupported, make_provider, make_provider_for_mode, ChatMessage, ChatReply,
    ChatRequest, LlmProvider, Role, ToolCall,
};
pub use viz::{parse_tool_calls, viz_tools, viz_tools_as_prompt, VizFrame, VizProgram, VIZ_KINDS};
