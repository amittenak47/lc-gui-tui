//! Pull Qwen / llama.cpp thinking text out of a chat reply and split it into
//! tap-sized process steps.
//!
//! The 27B thinks a lot. That text must not land in the answer bubble. It
//! becomes `reason` stages on the existing Thought list.

/// Hard cap so a novel of chain-of-thought does not become 200 chips.
pub const REASON_STEP_CAP: usize = 12;

pub struct SplitThink {
    pub content: String,
    pub reasoning: String,
}

/// Prefer an explicit API field; otherwise peel `<think>…</think>` (and
/// Qwen-style variants) out of `content`.
pub fn split_think(content: &str, reasoning_field: &str) -> SplitThink {
    let field = reasoning_field.trim();
    if !field.is_empty() {
        return SplitThink {
            content: strip_think_tags(content).trim().to_string(),
            reasoning: field.to_string(),
        };
    }
    peel_think_tags(content)
}

fn strip_think_tags(text: &str) -> String {
    peel_think_tags(text).content
}

fn peel_think_tags(text: &str) -> SplitThink {
    let mut reasoning = String::new();
    let mut content = text.to_string();
    for (open, close) in [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
        ("<|think|>", "<|/think|>"),
    ] {
        while let Some(start) = content.find(open) {
            let Some(rel_end) = content[start + open.len()..].find(close) else {
                break;
            };
            let body_start = start + open.len();
            let body_end = body_start + rel_end;
            let chunk = content[body_start..body_end].trim();
            if !chunk.is_empty() {
                if !reasoning.is_empty() {
                    reasoning.push_str("\n\n");
                }
                reasoning.push_str(chunk);
            }
            let after = body_end + close.len();
            content = format!("{}{}", &content[..start], &content[after..]);
        }
    }
    SplitThink {
        content: content.trim().to_string(),
        reasoning,
    }
}

/// Split reasoning into process steps. Numbered / heading blocks win;
/// otherwise blank-line paragraphs. Remainder past the cap merges into the last.
pub fn split_steps(reasoning: &str) -> Vec<String> {
    let text = reasoning.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts = split_numbered(text);
    if parts.len() < 2 {
        parts = split_paragraphs(text);
    }
    if parts.is_empty() {
        return vec![text.to_string()];
    }
    if parts.len() <= REASON_STEP_CAP {
        return parts;
    }
    let mut kept: Vec<String> = parts.iter().take(REASON_STEP_CAP - 1).cloned().collect();
    kept.push(parts[REASON_STEP_CAP - 1..].join("\n\n"));
    kept
}

fn split_numbered(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let numbered = heading_or_number(trimmed);
        if numbered && !current.trim().is_empty() {
            out.push(current.trim().to_string());
            current.clear();
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

fn heading_or_number(line: &str) -> bool {
    if line.starts_with("## ") || line.starts_with("# ") {
        return true;
    }
    let bytes = line.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_digit() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    matches!(bytes.get(i), Some(b'.' | b')'))
}

fn split_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
}

/// Whether extra think-mode JSON keys would 400 this host.
pub fn thinking_params_unsafe(base_url: &str) -> bool {
    let host = base_url.to_ascii_lowercase();
    host.contains("api.openai.com")
        || host.contains("openai.azure.com")
        || host.contains("api.groq.com")
}

/// Local OpenAI-compat servers (Ollama, vLLM, llama.cpp) honour these.
/// Cloud OpenAI / Groq reject unknown fields — skip them there.
/// Local OpenAI-compat servers (Ollama, vLLM, llama.cpp) honour these.
/// Cloud OpenAI / Groq reject unknown fields — skip them there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
}

impl ReasoningEffort {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    /// llama.cpp `reasoning_budget` / Qwen `thinking_budget`. High is unlimited.
    pub fn budget_tokens(self) -> i64 {
        match self {
            Self::Low => 1024,
            Self::Medium => 4096,
            Self::High => -1,
        }
    }
}

pub fn apply_thinking_request(
    map: &mut serde_json::Map<String, serde_json::Value>,
    base_url: &str,
    enabled: bool,
    effort: Option<ReasoningEffort>,
) {
    if thinking_params_unsafe(base_url) {
        return;
    }
    map.insert("enable_thinking".into(), serde_json::json!(enabled));
    map.insert("think".into(), serde_json::json!(enabled));
    let mut kwargs = serde_json::json!({ "enable_thinking": enabled });
    if enabled {
        if let Some(effort) = effort {
            map.insert(
                "reasoning_effort".into(),
                serde_json::json!(effort.as_str()),
            );
            map.insert(
                "reasoning_budget".into(),
                serde_json::json!(effort.budget_tokens()),
            );
            kwargs["thinking_budget"] = serde_json::json!(effort.budget_tokens());
        }
    }
    map.insert("chat_template_kwargs".into(), kwargs);
}

/// First clause, short enough for a process chip.
pub fn step_title(step: &str) -> String {
    let line = step.lines().next().unwrap_or(step).trim();
    let stripped = line
        .trim_start_matches('#')
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == ' ')
        .trim();
    let clause = stripped
        .split_once(['.', '!', '?', ':'])
        .map(|(a, _)| a.trim())
        .filter(|a| a.len() >= 8)
        .unwrap_or(stripped);
    let mut out: String = clause.chars().take(72).collect();
    if clause.chars().count() > 72 {
        out.push('…');
    }
    if out.is_empty() {
        "Thought".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_content_field_wins_and_think_tags_leave_the_answer() {
        let split = split_think(
            "visible <think>secret</think> answer",
            "chain of thought",
        );
        assert_eq!(split.reasoning, "chain of thought");
        assert_eq!(split.content, "visible  answer");
    }

    #[test]
    fn think_tags_are_peeled_when_no_field() {
        let split = split_think("<think>step one\n\nstep two</think>\nSGD is a minibatch.", "");
        assert_eq!(split.reasoning, "step one\n\nstep two");
        assert_eq!(split.content, "SGD is a minibatch.");
    }

    #[test]
    fn three_paragraphs_become_three_steps() {
        let steps = split_steps("alpha is first.\n\nbeta is second.\n\ngamma is third.");
        assert_eq!(steps.len(), 3);
        assert!(steps[0].contains("alpha"));
        assert!(steps[2].contains("gamma"));
    }

    #[test]
    fn cap_merges_the_tail() {
        let blob = (0..20)
            .map(|i| format!("Paragraph {i} is long enough."))
            .collect::<Vec<_>>()
            .join("\n\n");
        let steps = split_steps(&blob);
        assert_eq!(steps.len(), REASON_STEP_CAP);
        assert!(steps.last().unwrap().contains("Paragraph 19"));
    }

    #[test]
    fn thinking_params_skip_openai_and_groq() {
        assert!(thinking_params_unsafe("https://api.openai.com/v1"));
        assert!(thinking_params_unsafe("https://api.groq.com/openai/v1"));
        assert!(!thinking_params_unsafe("http://127.0.0.1:11434/v1"));
        let mut map = serde_json::Map::new();
        apply_thinking_request(&mut map, "http://localhost:8000/v1", true, None);
        assert_eq!(map.get("think").and_then(|v| v.as_bool()), Some(true));
        map.clear();
        apply_thinking_request(&mut map, "https://api.openai.com/v1", true, None);
        assert!(map.is_empty());
        map.clear();
        apply_thinking_request(
            &mut map,
            "http://localhost:8000/v1",
            true,
            Some(ReasoningEffort::Low),
        );
        assert_eq!(
            map.get("reasoning_budget").and_then(|v| v.as_i64()),
            Some(1024)
        );
        assert_eq!(
            map.get("reasoning_effort").and_then(|v| v.as_str()),
            Some("low")
        );
    }
}
