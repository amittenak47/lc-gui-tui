//! `lc mcp` — stdio MCP server for the footnote inbox.
//!
//! JSON-RPC messages are the only bytes on stdout. The hub is the only writer
//! of the inbox; this process just calls it over HTTP.

use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::config::Config;
use crate::pads::footnotes::{self, FootnoteLink};

pub const INSTRUCTIONS: &str = "Explain the selected words in the context of the surrounding text, for a reader who is in the middle of this document. 1-3 short markdown notes; lead with the direct explanation; add links only to sources you are confident exist. If the request has a prompt, follow it.";

const SUPPORTED_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const FALLBACK_PROTOCOL: &str = "2025-06-18";

pub trait FootnoteHub {
    fn list_pending(&self) -> Result<Value, String>;
    fn get(&self, id: &str) -> Result<Value, String>;
    fn submit(&self, id: &str, notes: Vec<String>, links: Vec<FootnoteLink>) -> Result<Value, String>;
}

pub struct HttpFootnoteHub {
    base: String,
    token: Option<String>,
    client: reqwest::blocking::Client,
}

impl HttpFootnoteHub {
    pub fn new(base: String, token: Option<String>) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("cannot build the hub client")?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            client,
        })
    }

    fn send(&self, builder: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
        let builder = match &self.token {
            Some(token) => builder.header("x-lc-token", token),
            None => builder,
        };
        let response = builder.send().map_err(|err| format!("hub request failed: {err}"))?;
        let status = response.status();
        let text = response.text().map_err(|err| format!("hub response: {err}"))?;
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(json!({ "ok": true }));
            }
            return serde_json::from_str(&text).map_err(|err| format!("hub response was not JSON: {err}"));
        }
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| {
                if text.trim().is_empty() {
                    format!("hub status {}", status.as_u16())
                } else {
                    text
                }
            });
        Err(message)
    }
}

impl FootnoteHub for HttpFootnoteHub {
    fn list_pending(&self) -> Result<Value, String> {
        self.send(self.client.get(format!("{}/footnote-requests?status=pending", self.base)))
    }

    fn get(&self, id: &str) -> Result<Value, String> {
        self.send(self.client.get(format!("{}/footnote-requests/{id}", self.base)))
    }

    fn submit(&self, id: &str, notes: Vec<String>, links: Vec<FootnoteLink>) -> Result<Value, String> {
        let body = json!({ "notes": notes, "links": links });
        self.send(
            self.client
                .post(format!("{}/footnote-requests/{id}/result", self.base))
                .json(&body),
        )
    }
}

pub fn serve_from_config(hub: Option<String>) -> Result<()> {
    let cfg = Config::load()?;
    let base = hub.unwrap_or_else(|| format!("http://127.0.0.1:{}", cfg.serve.port));
    let client = HttpFootnoteHub::new(base, cfg.serve.token)?;
    serve(&client)
}

/// Newline-delimited JSON-RPC on stdin/stdout. Notifications get no reply.
pub fn serve(hub: &dyn FootnoteHub) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input.read_line(&mut line).context("reading mcp stdin")?;
        if read == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => dispatch(hub, &message),
            Err(_) => Some(error_reply(&Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            writeln!(stdout, "{}", serde_json::to_string(&reply)?)?;
            stdout.flush()?;
        }
    }
}

/// `None` when the message is a notification and must not be answered.
pub fn dispatch(hub: &dyn FootnoteHub, message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null());
    let method = message.get("method").and_then(Value::as_str);
    let Some(method) = method else {
        return id.map(|id| error_reply(id, -32600, "Invalid Request"));
    };
    let Some(id) = id else {
        return None;
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(match method {
        "initialize" => result_reply(id, initialize_result(&params)),
        "ping" => result_reply(id, json!({})),
        "tools/list" => result_reply(id, json!({ "tools": tool_list() })),
        "tools/call" => result_reply(id, call_tool(hub, &params)),
        _ => error_reply(id, -32601, "Method not found"),
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let protocol = if SUPPORTED_PROTOCOLS.contains(&requested) {
        requested
    } else {
        FALLBACK_PROTOCOL
    };
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "lc-footnotes", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "list_footnote_requests",
            "description": "List pending footnote requests, oldest first. Each item has id, doc_name, page, excerpt, context, prompt, and created_at.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        }),
        json!({
            "name": "get_footnote_request",
            "description": "Fetch one footnote request, including wide_context and page_footnotes (other footnotes already on that page).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": "submit_footnote",
            "description": format!("Store the footnote for a pending request. {INSTRUCTIONS}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "notes": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 8 },
                    "links": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "url": { "type": "string" },
                            },
                            "required": ["url"],
                        },
                    },
                },
                "required": ["id", "notes"],
                "additionalProperties": false,
            },
        }),
    ]
}

fn call_tool(hub: &dyn FootnoteHub, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let outcome = match name {
        "list_footnote_requests" => hub.list_pending(),
        "get_footnote_request" => match arguments.get("id").and_then(Value::as_str) {
            Some(id) if footnotes::valid_id(id) => hub.get(id),
            _ => Err("id must be a request id from list_footnote_requests".into()),
        },
        "submit_footnote" => submit_tool(hub, &arguments),
        _ => Err(format!("unknown tool {name}")),
    };
    match outcome {
        Ok(value) => tool_text(&serde_json::to_string(&value).unwrap_or_else(|_| "null".into()), false),
        Err(message) => tool_text(&message, true),
    }
}

fn submit_tool(hub: &dyn FootnoteHub, arguments: &Value) -> Result<Value, String> {
    let id = arguments.get("id").and_then(Value::as_str).unwrap_or("");
    if !footnotes::valid_id(id) {
        return Err("id must be a request id from list_footnote_requests".into());
    }
    let Some(raw_notes) = arguments.get("notes").and_then(Value::as_array) else {
        return Err("notes must be an array of strings".into());
    };
    let mut notes = Vec::with_capacity(raw_notes.len());
    for note in raw_notes {
        let Some(text) = note.as_str() else {
            return Err("notes must be an array of strings".into());
        };
        notes.push(text.to_string());
    }
    let mut links = Vec::new();
    if let Some(raw_links) = arguments.get("links").and_then(Value::as_array) {
        for link in raw_links {
            let url = link.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let title = link.get("title").and_then(Value::as_str).map(str::to_string);
            links.push(FootnoteLink { title, url });
        }
    } else if arguments.get("links").is_some() && !arguments.get("links").is_some_and(Value::is_null) {
        return Err("links must be an array".into());
    }
    let cleaned = footnotes::validate_result(&notes, &links)?;
    hub.submit(id, cleaned.notes, cleaned.links)
}

fn tool_text(text: &str, is_error: bool) -> Value {
    let mut result = json!({
        "content": [{ "type": "text", "text": text }],
    });
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    result
}

fn result_reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_reply(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeHub {
        pending: Value,
        full: Mutex<Value>,
        submits: Mutex<Vec<(String, Vec<String>)>>,
        fail_submit: Mutex<Option<String>>,
    }

    impl FootnoteHub for FakeHub {
        fn list_pending(&self) -> Result<Value, String> {
            Ok(self.pending.clone())
        }
        fn get(&self, id: &str) -> Result<Value, String> {
            let full = self.full.lock().unwrap();
            if full.get("id").and_then(Value::as_str) == Some(id) {
                Ok(full.clone())
            } else {
                Err("unknown footnote request".into())
            }
        }
        fn submit(&self, id: &str, notes: Vec<String>, links: Vec<FootnoteLink>) -> Result<Value, String> {
            if let Some(message) = self.fail_submit.lock().unwrap().clone() {
                return Err(message);
            }
            assert!(links.is_empty() || links.iter().all(|link| link.url.starts_with("https://")));
            self.submits.lock().unwrap().push((id.to_string(), notes));
            Ok(json!({ "ok": true }))
        }
    }

    fn fake() -> FakeHub {
        FakeHub {
            pending: json!([{
                "id": "fr-1",
                "doc_name": "Notes.md",
                "page": 2,
                "excerpt": "lemma",
                "context": "a lemma",
                "prompt": null,
                "created_at": 1
            }]),
            full: Mutex::new(json!({
                "id": "fr-1",
                "doc_name": "Notes.md",
                "page": 2,
                "excerpt": "lemma",
                "context": "a lemma",
                "wide_context": "a longer lemma",
                "page_footnotes": [],
                "prompt": null,
                "created_at": 1
            })),
            submits: Mutex::new(Vec::new()),
            fail_submit: Mutex::new(None),
        }
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[test]
    fn initialize_echoes_a_supported_protocol_and_carries_the_style() {
        let hub = fake();
        let reply = dispatch(&hub, &request(1, "initialize", json!({
            "protocolVersion": "2025-03-26",
        }))).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(reply["result"]["serverInfo"]["name"], "lc-footnotes");
        assert_eq!(reply["result"]["instructions"], INSTRUCTIONS);
    }

    #[test]
    fn initialize_falls_back_when_the_protocol_is_unknown() {
        let hub = fake();
        let reply = dispatch(&hub, &request(1, "initialize", json!({
            "protocolVersion": "1999-01-01",
        }))).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], FALLBACK_PROTOCOL);
    }

    #[test]
    fn notifications_and_initialized_get_no_reply() {
        let hub = fake();
        assert!(dispatch(&hub, &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })).is_none());
        assert!(dispatch(&hub, &json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
        })).is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let hub = fake();
        let reply = dispatch(&hub, &request(7, "tools/nope", json!({}))).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
        assert!(reply.get("result").is_none());
    }

    #[test]
    fn ping_and_tools_list_name_the_three_tools() {
        let hub = fake();
        let ping = dispatch(&hub, &request(1, "ping", json!({}))).unwrap();
        assert_eq!(ping["result"], json!({}));
        let listed = dispatch(&hub, &request(2, "tools/list", json!({}))).unwrap();
        let names: Vec<_> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["list_footnote_requests", "get_footnote_request", "submit_footnote"]);
        let description = listed["result"]["tools"][2]["description"].as_str().unwrap();
        assert!(description.contains(INSTRUCTIONS));
    }

    #[test]
    fn tools_call_returns_json_text_and_tool_failures_are_not_rpc_errors() {
        let hub = fake();
        let listed = dispatch(&hub, &request(1, "tools/call", json!({
            "name": "list_footnote_requests",
        }))).unwrap();
        assert!(listed.get("error").is_none());
        let text = listed["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed[0]["excerpt"], "lemma");

        let missing = dispatch(&hub, &request(2, "tools/call", json!({
            "name": "get_footnote_request",
            "arguments": { "id": "missing" },
        }))).unwrap();
        assert!(missing.get("error").is_none());
        assert_eq!(missing["result"]["isError"], true);
        assert_eq!(missing["result"]["content"][0]["text"], "unknown footnote request");

        let bad = dispatch(&hub, &request(3, "tools/call", json!({
            "name": "submit_footnote",
            "arguments": { "id": "fr-1", "notes": ["  "] },
        }))).unwrap();
        assert_eq!(bad["result"]["isError"], true);
        assert!(hub.submits.lock().unwrap().is_empty());

        let ok = dispatch(&hub, &request(4, "tools/call", json!({
            "name": "submit_footnote",
            "arguments": {
                "id": "fr-1",
                "notes": ["  A lemma is a stepping stone.  "],
                "links": [{ "title": "Source", "url": "https://example.com/a" }],
            },
        }))).unwrap();
        assert!(ok["result"].get("isError").is_none());
        let stored = hub.submits.lock().unwrap();
        assert_eq!(stored[0].0, "fr-1");
        assert_eq!(stored[0].1, ["A lemma is a stepping stone."]);
    }
}
