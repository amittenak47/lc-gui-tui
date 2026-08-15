use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

use super::ascii_morph::AsciiAnimProgram;
use crate::llm::coach::BoardSnapshot;

pub(super) fn coach_message(role: &str, content: String) -> serde_json::Value {
    coach_message_with_anim(role, content, None)
}

pub(super) fn coach_message_with_anim(
    role: &str,
    content: String,
    anim: Option<&AsciiAnimProgram>,
) -> serde_json::Value {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut msg = serde_json::json!({
        "id": format!("tui-{at}-{}", rand::random::<u32>()),
        "role": role,
        "content": content,
        "at": at,
    });
    if let Some(anim) = anim {
        if let Ok(value) = serde_json::to_value(anim) {
            msg["ascii_anim"] = value;
        }
    }
    msg
}
pub(super) fn viz_json_fallback(
    provider: &dyn crate::llm::LlmProvider,
    prompt: &str,
    board: &BoardSnapshot,
    first: Result<crate::llm::ChatReply>,
) -> Result<crate::llm::ChatReply> {
    use crate::llm::coach::VIZ_SYSTEM_PROMPT;
    use crate::llm::tools::{parse_tool_calls, viz_tools_as_prompt};
    use crate::llm::{ChatMessage, ChatReply, ChatRequest};

    let messages = vec![
        ChatMessage::system(VIZ_SYSTEM_PROMPT),
        ChatMessage::user(format!("{prompt}\n\n{}", viz_tools_as_prompt()))
            .with_images(board.images()),
    ];
    let retried = provider.chat_ex(&ChatRequest::new(messages).json());

    match retried {
        Ok(reply) => {
            let calls = parse_tool_calls(&reply.content);
            if !calls.is_empty() {
                Ok(ChatReply {
                    content: String::new(),
                    tool_calls: calls,
                    reasoning: String::new(),
                })
            } else {
                first.map(|original| {
                    if original.content.trim().is_empty() {
                        reply
                    } else {
                        original
                    }
                })
            }
        }
        Err(fallback_error) => first.map_err(|original| {
            if crate::llm::is_tool_calling_unsupported(&original) {
                fallback_error
            } else {
                original
            }
        }),
    }
}

pub(super) fn viz_programs_from_reply(reply: &crate::llm::ChatReply) -> Vec<crate::llm::tools::VizProgram> {
    use crate::llm::tools::VizProgram;

    let mut programs = Vec::new();
    for call in &reply.tool_calls {
        if matches!(call.name.as_str(), "draw_structure" | "animate_trace") {
            if let Ok(program) = serde_json::from_value::<VizProgram>(call.arguments.clone()) {
                if program.rejection().is_none() {
                    programs.push(program);
                }
            }
        }
    }
    programs
}
