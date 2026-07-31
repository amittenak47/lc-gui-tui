use std::fmt::Write as _;

use anyhow::Result;
use serde::Deserialize;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;
use crate::llm::{ChatMessage, ChatRequest, LlmProvider};
use crate::problem::IoCase;

use super::board::BoardSnapshot;
use super::review::ReviewResponse;
use crate::llm::helpers::{parse_reply, MAX_CASE};
use super::prompts::TRACE_SYSTEM_PROMPT;

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

// ---------------------------------------------------------------------------
// Mode A, second pass — pin the trace to the cited case
// ---------------------------------------------------------------------------


/// A one-case trace prompt.
///
/// Why this exists: an 8B local model given a dozen numbered cases will happily
/// cite a real index and then illustrate its point with an input it made up.
/// The student runs the cited case and sees something different. Narrowing the
/// prompt to the single cited case removes the wandering room — the model
/// cannot reference the other cases because it is not shown them.
pub fn build_trace_prompt(
    meta: &WorkspaceMeta,
    board: &BoardSnapshot,
    case: &IoCase,
    case_number: u32,
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Problem: {}", meta.task_id);
    let _ = writeln!(
        out,
        "\n## The one case you are tracing (case {case_number})\n\n\
         - input:    `{}`\n- expected: `{}`",
        clip(&case.input, MAX_CASE),
        clip(&case.output, MAX_CASE)
    );
    // Both halves of what they wrote: the recognized ink *and* anything they
    // typed. Reading only the ink meant a pseudocode-only board looked empty
    // and the trace opened with "the student's approach is missing".
    let _ = writeln!(out, "\n## The student's approach");
    let approach = board.approach_text();
    let _ = writeln!(
        out,
        "\n```\n{}\n```",
        if approach.is_empty() {
            "(nothing legible — say so rather than guessing an approach)"
        } else {
            &approach
        }
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"trace\": \"run their approach on the input above, using only its values, and say \
         where it diverges from the expected output\"}}\n\
         ```"
    );
    out
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
