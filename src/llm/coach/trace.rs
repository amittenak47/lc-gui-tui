use anyhow::Result;
use serde::Deserialize;

use crate::generator::WorkspaceMeta;
use crate::llm::{ChatMessage, ChatRequest, LlmProvider};

use super::board::BoardSnapshot;
use super::modes::review::ReviewResponse;
use super::prompts::{build_trace_prompt, TRACE_SYSTEM_PROMPT};
use crate::llm::helpers::parse_reply;

pub fn retrace_counterexample(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    board: &BoardSnapshot,
    review: &mut ReviewResponse,
) {
    let Some(cited) = review.counterexample.as_ref() else {
        return;
    };
    let Some(case) = meta.cases.get(cited.case_index) else {
        return;
    };

    let prompt = build_trace_prompt(meta, board, case, cited.case_number);
    let request = ChatRequest::new(vec![
        ChatMessage::system(TRACE_SYSTEM_PROMPT),
        ChatMessage::user(prompt),
    ])
    .json()
    .with_temperature(0.0)
    .with_max_tokens(400);

    if let Ok(trace) = provider
        .chat_ex(&request)
        .and_then(|reply| parse_trace(&reply.content))
    {
        if let Some(cited) = review.counterexample.as_mut() {
            cited.why_your_approach_fails = trace;
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct TraceReply {
    trace: String,
}

pub fn parse_trace(raw: &str) -> Result<String> {
    let reply: TraceReply = parse_reply(raw, "trace")?;
    if reply.trace.trim().is_empty() {
        anyhow::bail!("the coach returned an empty trace");
    }
    Ok(reply.trace.trim().to_string())
}
