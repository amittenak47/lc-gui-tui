//! Blocking SSE reader. Progress is delivered while reading, not after `.text()`.
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::{ChatReply, EventSink};

const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct Completion {
    content: String,
    reasoning: String,
    tools: BTreeMap<u64, (String, String)>,
    finished: bool,
}

impl Completion {
    fn chunk(&mut self, value: Value) -> Result<()> {
        if let Some(error) = value.get("error") {
            bail!("model stream error: {error}");
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .context("stream chunk missing choices")?;
        // Usage-only chunks have no choices. Only one completion is requested.
        let Some(choice) = choices
            .iter()
            .find(|c| c.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
        else {
            return Ok(());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !matches!(reason, "stop" | "tool_calls" | "function_call") {
                bail!("model stream ended without a complete answer ({reason})");
            }
            self.finished = true;
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(text);
        }
        if let Some(text) = delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .or_else(|| delta.get("reasoning").and_then(Value::as_str))
        {
            self.reasoning.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .context("tool delta missing index")?;
                let entry = self.tools.entry(index).or_default();
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    entry.0.push_str(name);
                }
                if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str) {
                    entry.1.push_str(args);
                }
            }
        }
        Ok(())
    }

    fn split(&self) -> crate::llm::reasoning::SplitThink {
        // Tags may straddle SSE chunks. Complete an open thinking block only in
        // this temporary view, holding a partial closing delimiter out of the UI.
        let mut content = self.content.clone();
        for (open, close) in [
            ("<think>", "</think>"),
            ("<thinking>", "</thinking>"),
            ("<|think|>", "<|/think|>"),
        ] {
            if let Some(start) = content.rfind(open) {
                if !content[start + open.len()..].contains(close) {
                    let tail = &content[start + open.len()..];
                    let partial = (1..close.len())
                        .rev()
                        .find(|&n| tail.ends_with(&close[..n]))
                        .unwrap_or(0);
                    content.truncate(content.len() - partial);
                    content.push_str(close);
                }
            }
        }
        crate::llm::reasoning::split_think(&content, &self.reasoning)
    }

    fn reply(&self) -> Result<ChatReply> {
        let split = self.split();
        let mut tool_calls = Vec::new();
        for (name, args) in self.tools.values() {
            if name.is_empty() {
                bail!("streamed tool call has no name");
            }
            tool_calls.push(super::ToolCall {
                name: name.clone(),
                arguments: serde_json::from_str(args)
                    .context("incomplete streamed tool arguments")?,
            });
        }
        Ok(ChatReply {
            content: split.content,
            reasoning: split.reasoning,
            tool_calls,
        })
    }
}

struct Progress {
    id: u64,
    last: Option<Instant>,
    steps: Vec<String>,
}

impl Progress {
    fn publish(&mut self, completion: &Completion, events: &EventSink, force: bool) {
        if !force
            && self
                .last
                .is_some_and(|t| t.elapsed() < Duration::from_millis(50))
        {
            return;
        }
        let steps = crate::llm::reasoning::split_steps(&completion.split().reasoning);
        for (index, step) in steps.iter().enumerate() {
            if self.steps.get(index) != Some(step) {
                events.reasoning_step(format!("reason-{}-{index}", self.id), step.clone());
            }
        }
        for index in steps.len()..self.steps.len() {
            events.reasoning_step(format!("reason-{}-{index}", self.id), String::new());
        }
        self.steps = steps;
        self.last = Some(Instant::now());
    }
}

pub(super) fn read(reader: impl Read, events: &EventSink) -> Result<ChatReply> {
    let mut reader = BufReader::new(reader);
    let mut completion = Completion::default();
    let mut progress = Progress {
        id: NEXT_STREAM.fetch_add(1, Ordering::Relaxed),
        last: None,
        steps: Vec::new(),
    };
    let mut event = String::new();
    let mut total = 0usize;
    loop {
        if let Some(err) = events.cancelled_error() {
            return Err(err);
        }
        let mut line = String::new();
        // Bound a malicious/malformed line before allocating an entire response.
        let bytes = (&mut reader)
            .take((MAX_EVENT_BYTES + 1) as u64)
            .read_line(&mut line)?;
        if let Some(err) = events.cancelled_error() {
            return Err(err);
        }
        total += bytes;
        if bytes > MAX_EVENT_BYTES || total > MAX_RESPONSE_BYTES {
            bail!("model stream exceeds size limit");
        }
        let eof = bytes == 0;
        let line = line.trim_end_matches(['\r', '\n']);
        if eof || line.is_empty() {
            if !event.is_empty() {
                if event.trim() == "[DONE]" {
                    if !completion.finished {
                        bail!("model stream ended before finish_reason");
                    }
                    break;
                }
                completion.chunk(
                    serde_json::from_str(event.trim()).context("invalid model stream JSON")?,
                )?;
                event.clear();
                progress.publish(&completion, events, false);
            }
            if eof {
                if !completion.finished {
                    bail!("model stream disconnected before completion");
                }
                break;
            }
        } else if let Some(data) = line.strip_prefix("data:") {
            if !event.is_empty() {
                event.push('\n');
            }
            event.push_str(data.strip_prefix(' ').unwrap_or(data));
            if event.len() > MAX_EVENT_BYTES {
                bail!("model stream event exceeds size limit");
            }
        }
    }
    if let Some(err) = events.cancelled_error() {
        return Err(err);
    }
    let reply = completion.reply()?;
    progress.publish(&completion, events, true);
    // Only one full-text reasoning event per provider call, for the final fold.
    events.reasoning(&reply.reasoning);
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::coach::CoachEvent;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn chunk(delta: Value, finish: Value) -> String {
        format!(
            "data: {}\r\n\r\n",
            json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
        )
    }

    #[test]
    fn streams_reasoning_before_reader_finishes_and_keeps_unicode() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = EventSink::new({
            let seen = seen.clone();
            move |e| seen.lock().unwrap().push(e)
        });
        struct Phased {
            first: std::io::Cursor<Vec<u8>>,
            rest: std::io::Cursor<Vec<u8>>,
            seen: Arc<Mutex<Vec<CoachEvent>>>,
        }
        impl Read for Phased {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                let n = self.first.read(bytes)?;
                if n > 0 {
                    return Ok(n);
                }
                assert!(self.seen.lock().unwrap().iter().any(|e| matches!(
                    e,
                    CoachEvent::Stage {
                        update_id: Some(_),
                        ..
                    }
                )));
                self.rest.read(bytes)
            }
        }
        let reader = Phased {
            first: std::io::Cursor::new(
                chunk(json!({"reasoning_content":"First café"}), Value::Null).into_bytes(),
            ),
            rest: std::io::Cursor::new(
                format!(
                    "{}{}data: [DONE]\n\n",
                    chunk(json!({"reasoning_content":" step."}), Value::Null),
                    chunk(json!({"content":"Answer"}), json!("stop"))
                )
                .into_bytes(),
            ),
            seen: seen.clone(),
        };
        let reply = read(reader, &sink).unwrap();
        assert_eq!(reply.reasoning, "First café step.");
        assert_eq!(reply.content, "Answer");
        let events = seen.lock().unwrap();
        let ids: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                CoachEvent::Stage { update_id, .. } => update_id.as_ref(),
                _ => None,
            })
            .collect();
        assert!(ids.len() >= 2);
        assert!(ids.iter().all(|id| *id == ids[0]));
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, CoachEvent::Reasoning { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn parses_fragmented_tags_and_tool_arguments() {
        let mut c = Completion::default();
        for text in ["<thi", "nk>Plan π", "</thi", "nk>Answer"] {
            c.chunk(json!({"choices":[{"delta":{"content":text}}]}))
                .unwrap();
        }
        for delta in [
            json!({"tool_calls":[{"index":0,"function":{"name":"draw","arguments":"{\"x\":"}}]}),
            json!({"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}),
        ] {
            c.chunk(json!({"choices":[{"delta":delta}]})).unwrap();
        }
        let reply = c.reply().unwrap();
        assert_eq!(reply.reasoning, "Plan π");
        assert_eq!(reply.content, "Answer");
        assert_eq!(reply.tool_calls[0].arguments, json!({"x":1}));
    }

    #[test]
    fn rejects_truncated_error_and_cancelled_streams() {
        let partial = chunk(json!({"reasoning":"Partial"}), Value::Null);
        assert!(read(partial.as_bytes(), &EventSink::none()).is_err());
        assert!(read(
            b"data: {\"error\":\"failed\"}\n\n".as_slice(),
            &EventSink::none()
        )
        .is_err());
        let sink = EventSink::new(|_| {});
        sink.cancel_handle().unwrap().store(true, Ordering::Relaxed);
        assert!(read(partial.as_bytes(), &sink).is_err());
    }

    #[test]
    fn stops_between_events_when_cancelled_during_delivery() {
        let handle = Arc::new(Mutex::new(None::<Arc<std::sync::atomic::AtomicBool>>));
        let sink = EventSink::new({
            let handle = handle.clone();
            move |_| {
                handle
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Relaxed)
            }
        });
        *handle.lock().unwrap() = sink.cancel_handle();
        let data = format!(
            "{}{}data: [DONE]\n\n",
            chunk(json!({"reasoning":"Start"}), Value::Null),
            chunk(json!({"content":"Must not finish"}), json!("stop"))
        );
        assert!(read(data.as_bytes(), &sink)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
    }

    #[test]
    fn accepts_one_byte_reads_comments_and_usage_chunks() {
        struct ByteReader(std::io::Cursor<Vec<u8>>);
        impl Read for ByteReader {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                let count = bytes.len().min(1);
                self.0.read(&mut bytes[..count])
            }
        }
        let data = format!(
            ": ping\r\n\r\n{}{}data: {{\"choices\":[]}}\n\ndata: [DONE]\n\n",
            chunk(json!({"reasoning":"café π"}), Value::Null),
            chunk(json!({"content":"Yes"}), json!("stop"))
        );
        let reply = read(
            ByteReader(std::io::Cursor::new(data.into_bytes())),
            &EventSink::none(),
        )
        .unwrap();
        assert_eq!(reply.reasoning, "café π");
        assert_eq!(reply.content, "Yes");
    }
}
