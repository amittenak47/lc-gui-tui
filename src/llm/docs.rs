//! Document Ask: tutor prompt, slash presets, optional OpenAI tools.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::docs_index;
use crate::llm::coach::{EventSink, ToolStatus};
use crate::llm::viz::parse_tool_calls;
use crate::llm::{is_tool_calling_unsupported, ChatMessage, ChatRequest, LlmProvider};
use crate::llm::reasoning::ReasoningEffort;

pub const DOCUMENT_ASK_SYSTEM: &str = "You are a technical tutor sitting with the reader of a \
document (paper, textbook, or source file). Explain the highlighted passage using the retrieved \
chunks and glossary of terms that appear in the prompt.\n\
\n\
Rules:\n\
- Prefer definitions that appear in the retrieved context. Do not invent a meaning that \
contradicts those chunks.\n\
- When it helps: (1) a short physical or mechanical analogy, (2) the mechanism as a few sequential \
steps, (3) a tiny pseudocode fragment — not a full solution dump.\n\
- Tools are optional. Call one only if the prompt is missing something you need.\n\
- Plain text. No JSON unless you are emitting a tool-call fallback object.";

pub const PRESET_DE_JARGON: &str = "Act as a strict parser. Extract every novel term, variable, or \
acronym in the highlighted text. Give a one-sentence mechanical definition for each, based only on \
the provided text and retrieved chunks. Do not summarise the whole passage.";

pub const PRESET_EXPLAIN_MATH: &str = "Translate any LaTeX or equations in the highlight into \
plain language and a short Python-shaped pseudocode fragment. Stay faithful to the symbols as \
used in this document.";

pub const PRESET_ANALYZE_METHODOLOGY: &str = "Extract and critique the methodology that the \
highlighted passage belongs to. Name assumptions, what is measured, and what would falsify it.";

pub const PRESET_REVERSE_ENGINEER: &str = "Work backward from the stated result or architecture \
in the highlight. Explain the mechanism that must have produced it, using the retrieved context.";

pub fn preset_system(name: Option<&str>) -> &'static str {
    match name.map(|s| s.trim()) {
        Some("de_jargon") => PRESET_DE_JARGON,
        Some("explain_math") => PRESET_EXPLAIN_MATH,
        Some("analyze_methodology") => PRESET_ANALYZE_METHODOLOGY,
        Some("reverse_engineer") => PRESET_REVERSE_ENGINEER,
        _ => DOCUMENT_ASK_SYSTEM,
    }
}

pub fn document_tools(cfg: &Config) -> Vec<serde_json::Value> {
    let mut tools = vec![
        tool(
            "query_document_vectors",
            "Search the rest of this document's index for more context.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "minimum": 1, "maximum": 8}
                },
                "required": ["query"]
            }),
        ),
        tool(
            "query_library_vectors",
            "Search every indexed document, not just this one. Use when the question is about anywhere rather than about this book.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "minimum": 1, "maximum": 8}
                },
                "required": ["query"]
            }),
        ),
        tool(
            "get_document_section",
            "Retrieve chunks whose heading or text matches a section name (e.g. conclusion).",
            serde_json::json!({
                "type": "object",
                "properties": { "section_name": {"type": "string"} },
                "required": ["section_name"]
            }),
        ),
        tool(
            "lookup_reference",
            "Return the local bibliography snippet for a numeric citation like [12].",
            serde_json::json!({
                "type": "object",
                "properties": { "n": {"type": "integer", "minimum": 1} },
                "required": ["n"]
            }),
        ),
        tool(
            "get_current_page",
            "Return the text of the page the reader is on, if it was sent with the Ask.",
            serde_json::json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_highlight",
            "Return the exact highlighted string again.",
            serde_json::json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "list_document_marks",
            "List the reader's marks that were packed into this Ask.",
            serde_json::json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "save_annotation",
            "Propose an AI book-tab on the page. The tablet applies it; you do not write the library.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "excerpt": {"type": "string"},
                    "note": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "page": {"type": "integer"},
                    "links": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["excerpt", "note"]
            }),
        ),
    ];
    if cfg.searxng_url().is_some() {
        tools.push(tool(
            "search_web",
            "Privacy-preserving web search. Returns snippet-only meta descriptions, never HTML.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "num_results": {"type": "integer", "minimum": 1, "maximum": 5}
                },
                "required": ["query"]
            }),
        ));
    }
    tools
}

fn tool(name: &str, description: &str, parameters: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    })
}

pub fn tools_as_prompt(tools: &[serde_json::Value]) -> String {
    let rendered: Vec<serde_json::Value> = tools
        .iter()
        .filter_map(|t| t.get("function").cloned())
        .collect();
    format!(
        "Your server does not support tool calls, so emit them as JSON instead.\n\n\
         The tools available to you:\n\n```json\n{}\n```\n\n\
         If you need a tool, reply with a single JSON object:\n\
         {{\"calls\": [{{\"tool\": \"<name>\", \"arguments\": {{…}}}}]}}\n\
         Otherwise answer in plain text.",
        serde_json::to_string_pretty(&rendered).unwrap_or_else(|_| "[]".into())
    )
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProposedAnnotation {
    pub excerpt: String,
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub page: Option<u32>,
    #[serde(default)]
    pub links: Vec<String>,
}

pub struct AskContext {
    pub document_hash: Option<String>,
    pub page: Option<u32>,
    pub highlight: String,
    pub page_text: String,
    pub marks_prose: String,
    pub retrieved: String,
}

const MAX_TOOL_ITERS: usize = 3;

pub fn run_document_ask(
    provider: &dyn LlmProvider,
    cfg: &Config,
    system: &str,
    user: String,
    images: Vec<String>,
    ctx: &AskContext,
    events: &EventSink,
    reasoning: bool,
    effort: Option<ReasoningEffort>,
) -> Result<(String, Vec<ProposedAnnotation>)> {
    let tools = document_tools(cfg);
    let mut messages = vec![
        ChatMessage::system(system),
        ChatMessage::user(user.clone()).with_images(images),
    ];
    let mut proposed = Vec::new();
    let mut reply = match provider.chat_ex(
        &ChatRequest::new(messages.clone())
            .with_tools(tools.clone())
            .with_reasoning(reasoning)
            .with_reasoning_effort(effort),
    ) {
        Ok(reply) => reply,
        Err(err) if is_tool_calling_unsupported(&err) => {
            let fallback = format!("{}\n\n{}", tools_as_prompt(&tools), user);
            let fb_messages = vec![
                ChatMessage::system(system),
                ChatMessage::user(fallback),
            ];
            let mut parsed =
                provider.chat_ex(
                    &ChatRequest::new(fb_messages.clone())
                        .with_reasoning(reasoning)
                        .with_reasoning_effort(effort),
                )?;
            if parsed.tool_calls.is_empty() {
                parsed.tool_calls = parse_tool_calls(&parsed.content);
            }
            events.emit_reasoning(&parsed.reasoning);
            if parsed.tool_calls.is_empty() {
                return Ok((parsed.content.trim().to_string(), proposed));
            }
            messages = fb_messages;
            parsed
        }
        Err(err) => return Err(err),
    };
    events.emit_reasoning(&reply.reasoning);

    for _ in 0..MAX_TOOL_ITERS {
        if reply.tool_calls.is_empty() {
            break;
        }
        let mut results = Vec::new();
        for call in &reply.tool_calls {
            events.tool(call.name.as_str(), ToolStatus::Proposed, tool_summary(&call.name), None);
            let (text, maybe_ann) = dispatch_tool(cfg, ctx, call.name.as_str(), &call.arguments)?;
            events.tool(
                call.name.as_str(),
                ToolStatus::Accepted,
                clip_tool_detail(&text),
                None,
            );
            if let Some(ann) = maybe_ann {
                proposed.push(ann);
            }
            results.push(format!("{}: {}", call.name, text));
        }
        messages.push(ChatMessage::assistant(if reply.content.trim().is_empty() {
            format!(
                "(called tools: {})",
                reply
                    .tool_calls
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            reply.content.clone()
        }));
        messages.push(ChatMessage::user(format!(
            "Tool results:\n{}\n\nContinue. Call another tool only if needed, otherwise answer.",
            results.join("\n")
        )));
        reply = provider.chat_ex(
            &ChatRequest::new(messages.clone())
                .with_tools(tools.clone())
                .with_reasoning(reasoning)
                .with_reasoning_effort(effort),
        )?;
        events.emit_reasoning(&reply.reasoning);
        if reply.tool_calls.is_empty() {
            reply.tool_calls = parse_tool_calls(&reply.content);
        }
    }
    if reply.content.trim().is_empty() {
        messages.push(ChatMessage::user(
            "Answer the question now in plain text. Do not call tools.",
        ));
        reply = provider.chat_ex(
            &ChatRequest::new(messages)
                .with_reasoning(reasoning)
                .with_reasoning_effort(effort),
        )?;
        events.emit_reasoning(&reply.reasoning);
    }
    Ok((reply.content.trim().to_string(), proposed))
}

fn tool_summary(name: &str) -> &'static str {
    match name {
        "query_document_vectors" => "searching the book",
        "query_library_vectors" => "searching your library",
        "get_document_section" => "opening a section",
        "lookup_reference" => "checking a citation",
        "get_current_page" => "reading this page",
        "get_highlight" => "re-reading the highlight",
        "list_document_marks" => "listing marks",
        "save_annotation" => "pinning a tab",
        "search_web" => "searching the web",
        _ => "calling a tool",
    }
}

fn clip_tool_detail(text: &str) -> String {
    let t = text.trim();
    let mut out: String = t.chars().take(280).collect();
    if t.chars().count() > 280 {
        out.push('…');
    }
    out
}

fn dispatch_tool(
    cfg: &Config,
    ctx: &AskContext,
    name: &str,
    args: &serde_json::Value,
) -> Result<(String, Option<ProposedAnnotation>)> {
    match name {
        "query_document_vectors" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            let hits = docs_index::retrieve(&conn, hash, query, k, cfg)?;
            Ok((docs_index::format_retrieval(&hits), None))
        }
        /*
         * The library, not the open book.
         *
         * Deliberately a separate tool rather than a flag on the first one. The
         * model picks by what the question is about, and the two have different
         * costs: this scans every eligible document, and its answer has to name
         * which book each passage came from or it is no use in a library.
         *
         * The scope line comes back with the passages, so an answer built from
         * a partial library says so instead of sounding complete.
         */
        "query_library_vectors" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            let (hits, scope) = docs_index::retrieve_library(&conn, query, k, cfg)?;
            if hits.is_empty() {
                return Ok((docs_index::library_scope_line(&scope), None));
            }
            Ok((docs_index::format_library_retrieval(&hits, &scope), None))
        }
        "get_document_section" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let name = args
                .get("section_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            match docs_index::section_text(&conn, hash, name) {
                Ok(text) => Ok((text, None)),
                Err(err) => Ok((err.to_string(), None)),
            }
        }
        "lookup_reference" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let n = args.get("n").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            match docs_index::lookup_reference(&conn, hash, n) {
                Ok(text) => Ok((text, None)),
                Err(err) => Ok((err.to_string(), None)),
            }
        }
        "get_current_page" => {
            let text = ctx.page_text.trim();
            if text.is_empty() {
                Ok(("no page text was sent with this Ask".into(), None))
            } else {
                let clipped: String = text.chars().take(4000).collect();
                Ok((clipped, None))
            }
        }
        "get_highlight" => {
            if ctx.highlight.trim().is_empty() {
                Ok(("no highlight was sent".into(), None))
            } else {
                Ok((ctx.highlight.clone(), None))
            }
        }
        "list_document_marks" => {
            if ctx.marks_prose.trim().is_empty() {
                Ok(("no marks packed into this Ask".into(), None))
            } else {
                Ok((ctx.marks_prose.clone(), None))
            }
        }
        "save_annotation" => {
            let ann = ProposedAnnotation {
                excerpt: args
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                note: args
                    .get("note")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                tags: args
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                page: args.get("page").and_then(|v| v.as_u64()).map(|n| n as u32),
                links: args
                    .get("links")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            Ok((
                "queued an AI book-tab; the tablet will place it".into(),
                Some(ann),
            ))
        }
        "search_web" => {
            let Some(base) = cfg.searxng_url() else {
                return Ok(("web search is not configured".into(), None));
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let n = args.get("num_results").and_then(|v| v.as_u64()).unwrap_or(3) as usize;
            Ok((search_web_snippets(base, query, n)?, None))
        }
        other => Ok((format!("unknown tool {other}"), None)),
    }
}

fn search_web_snippets(base: &str, query: &str, n: usize) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/search",
        base.trim_end_matches('/')
    );
    let value: serde_json::Value = client
        .get(&url)
        .query(&[("q", query), ("format", "json")])
        .send()?
        .json()?;
    let results = value
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut lines = Vec::new();
    for item in results.iter().take(n.max(1).min(5)) {
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let content = item
            .get("content")
            .or_else(|| item.get("snippet"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let href = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() && content.is_empty() {
            continue;
        }
        lines.push(format!("{title} — {href}\n{content}"));
    }
    if lines.is_empty() {
        Ok("no snippets".into())
    } else {
        Ok(lines.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    use anyhow::anyhow;

    use crate::llm::coach::{CoachEvent, EventSink};
    use crate::llm::{ChatReply, ToolCall};

    #[test]
    fn unknown_preset_is_the_document_tutor() {
        assert_eq!(preset_system(None), DOCUMENT_ASK_SYSTEM);
        assert_eq!(preset_system(Some("nope")), DOCUMENT_ASK_SYSTEM);
        assert_eq!(preset_system(Some("de_jargon")), PRESET_DE_JARGON);
    }

    #[test]
    fn search_web_is_absent_without_searxng() {
        let cfg = Config::default();
        let names: Vec<String> = document_tools(&cfg)
            .into_iter()
            .filter_map(|t| {
                t.pointer("/function/name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        assert!(names.contains(&"query_document_vectors".into()));
        assert!(names.contains(&"save_annotation".into()));
        assert!(!names.iter().any(|n| n == "search_web"));
    }

    struct Scripted {
        calls: Cell<usize>,
        fail_tools: bool,
        always_tool: bool,
        reasoning: &'static str,
    }

    impl LlmProvider for Scripted {
        fn label(&self) -> String {
            "scripted".into()
        }

        fn chat(&self, _system: &str, _user: &str) -> anyhow::Result<String> {
            unreachable!("document ask uses chat_ex")
        }

        fn chat_ex(&self, req: &ChatRequest) -> anyhow::Result<ChatReply> {
            self.calls.set(self.calls.get() + 1);
            if self.fail_tools && !req.tools.is_empty() {
                return Err(anyhow!("this server does not support tools"));
            }
            if self.always_tool && !req.tools.is_empty() {
                return Ok(ChatReply {
                    content: String::new(),
                    tool_calls: vec![ToolCall {
                        name: "get_highlight".into(),
                        arguments: serde_json::json!({}),
                    }],
                    reasoning: self.reasoning.to_string(),
                });
            }
            Ok(ChatReply {
                content: "SGD is a minibatch gradient estimate.".into(),
                tool_calls: vec![],
                reasoning: self.reasoning.to_string(),
            })
        }
    }

    fn ctx() -> AskContext {
        AskContext {
            document_hash: None,
            page: Some(1),
            highlight: "what is SGD".into(),
            page_text: String::new(),
            marks_prose: String::new(),
            retrieved: String::new(),
        }
    }

    #[test]
    fn ask_answers_when_tools_are_disabled() {
        let provider = Scripted {
            calls: Cell::new(0),
            fail_tools: true,
            always_tool: false,
            reasoning: "",
        };
        let (reply, proposed) = run_document_ask(
            &provider,
            &Config::default(),
            DOCUMENT_ASK_SYSTEM,
            "what is SGD".into(),
            vec![],
            &ctx(),
            &EventSink::none(),
            false,
            None,
        )
        .unwrap();
        assert!(reply.contains("SGD"));
        assert!(proposed.is_empty());
        assert_eq!(provider.calls.get(), 2);
    }

    #[test]
    fn tool_loop_stops_after_three_iterations() {
        let provider = Scripted {
            calls: Cell::new(0),
            fail_tools: false,
            always_tool: true,
            reasoning: "",
        };
        let (reply, _) = run_document_ask(
            &provider,
            &Config::default(),
            DOCUMENT_ASK_SYSTEM,
            "what is SGD".into(),
            vec![],
            &ctx(),
            &EventSink::none(),
            false,
            None,
        )
        .unwrap();
        assert!(reply.contains("SGD"));
        // initial + 3 tool rounds + 1 forced plain-text close
        assert_eq!(provider.calls.get(), 1 + MAX_TOOL_ITERS + 1);
    }

    #[test]
    fn save_annotation_returns_a_proposal_and_does_not_need_a_store() {
        let (text, proposed) = dispatch_tool(
            &Config::default(),
            &ctx(),
            "save_annotation",
            &serde_json::json!({
                "excerpt": "SGD",
                "note": "minibatch gradient",
                "page": 2,
                "tags": ["def"],
                "links": []
            }),
        )
        .unwrap();
        assert!(text.contains("book-tab"));
        let ann = proposed.expect("proposal");
        assert_eq!(ann.excerpt, "SGD");
        assert_eq!(ann.note, "minibatch gradient");
        assert_eq!(ann.page, Some(2));
    }

    #[test]
    fn problem_ask_prompt_does_not_name_document_tools() {
        let names: Vec<String> = document_tools(&Config::default())
            .into_iter()
            .filter_map(|t| {
                t.pointer("/function/name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        assert!(names.contains(&"query_document_vectors".into()));
        let ask = crate::llm::coach::ASK_SYSTEM_PROMPT;
        for name in &names {
            assert!(
                !ask.contains(name),
                "problem Ask system prompt must not mention {name}"
            );
        }
    }

    #[test]
    fn tool_loop_emits_tool_events_and_reasoning_steps() {
        use std::sync::{Arc, Mutex};

        let log = Arc::new(Mutex::new(Vec::new()));
        let events = EventSink::new({
            let log = log.clone();
            move |ev| match ev {
                CoachEvent::Tool { name, status, .. } => {
                    log.lock().unwrap().push(format!("tool:{name}:{}", status.as_str()));
                }
                CoachEvent::Stage { stage, detail } => {
                    log.lock().unwrap().push(format!("stage:{stage}:{detail}"));
                }
                CoachEvent::Reasoning { text } => {
                    log.lock().unwrap().push(format!("reasoning:{text}"));
                }
            }
        });
        let provider = Scripted {
            calls: Cell::new(0),
            fail_tools: false,
            always_tool: true,
            reasoning: "First I look at the highlight.\n\nThen I name SGD.",
        };
        let _ = run_document_ask(
            &provider,
            &Config::default(),
            DOCUMENT_ASK_SYSTEM,
            "what is SGD".into(),
            vec![],
            &ctx(),
            &events,
            true,
            None,
        )
        .unwrap();
        let lines = log.lock().unwrap().clone();
        assert!(
            lines.iter().any(|l| l.starts_with("tool:get_highlight:proposed")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.starts_with("tool:get_highlight:accepted")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.starts_with("stage:reason:")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.starts_with("reasoning:First I look")),
            "{lines:?}"
        );
    }
}
