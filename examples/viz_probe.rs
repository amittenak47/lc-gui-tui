//! Reproduce the `POST /coach/viz` model call and print what came back.
//!
//! ```bash
//! cargo run --example viz_probe -- two-sum leetcode "show the hash map filling up"
//! ```

use anyhow::Result;
use whiteboard::config::Config;
use whiteboard::llm::coach::{build_viz_prompt, BoardSnapshot, CoachContext, VIZ_SYSTEM_PROMPT};
use whiteboard::llm::tools::{parse_tool_calls, viz_tools, viz_tools_as_prompt};
use whiteboard::llm::{make_provider_for_mode, ChatMessage, ChatRequest};
use whiteboard::runner;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let task = args.next().unwrap_or_else(|| "two-sum".into());
    let slug = args.next().unwrap_or_else(|| "leetcode".into());
    let ask = args.next().unwrap_or_default();

    let cfg = Config::load()?;
    let dataset = whiteboard::dataset::resolve(Some(&slug))?;
    let dir = runner::locate_workspace_in(&cfg, dataset, Some(&task))?;
    let meta = runner::read_meta(&dir)?;
    let description = whiteboard::problem::load_task_for(
        meta.dataset(),
        std::path::Path::new(&meta.json_path),
        &meta.task_id,
    )
    .ok()
    .and_then(|p| p.problem_description);

    let board = BoardSnapshot {
        recognized_text: "seen = {} value -> index; for i,x: need = target - x; if need in seen return".into(),
        ..Default::default()
    };
    let prompt = build_viz_prompt(&meta, description.as_deref(), &board, &ask, &CoachContext::default());
    let provider = make_provider_for_mode(&cfg, "viz")?;
    println!("=== provider: {}", provider.label());
    println!("=== tools: {}", serde_json::to_string(&viz_tools())?.len());

    println!("\n--- attempt 1: with tools ---");
    let first = provider.chat_ex(
        &ChatRequest::new(vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(prompt.clone()),
        ])
        .with_tools(viz_tools()),
    );
    match &first {
        Ok(reply) => {
            println!("tool_calls: {}", reply.tool_calls.len());
            for call in &reply.tool_calls {
                println!("  {} <- {}", call.name, serde_json::to_string(&call.arguments)?);
            }
            println!("content ({}b): {}", reply.content.len(), &reply.content.chars().take(1500).collect::<String>());
            println!("reasoning ({}b)", reply.reasoning.len());
        }
        Err(err) => println!("ERR: {err:#}"),
    }

    println!("\n--- attempt 2: json fallback ---");
    let second = provider.chat_ex(
        &ChatRequest::new(vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(format!("{prompt}\n\n{}", viz_tools_as_prompt())),
        ])
        .json(),
    );
    match &second {
        Ok(reply) => {
            println!("content ({}b): {}", reply.content.len(), &reply.content.chars().take(2500).collect::<String>());
            let calls = parse_tool_calls(&reply.content);
            println!("parsed calls: {}", calls.len());
            for call in &calls {
                println!("  {} <- {}", call.name, serde_json::to_string(&call.arguments)?);
            }
        }
        Err(err) => println!("ERR: {err:#}"),
    }
    Ok(())
}
