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

const TARGET_CHARS: usize = 480;
const MAX_SENTENCES: usize = 3;

/// Split reasoning into process steps. Markdown headings, blank paragraphs,
/// and a finished sentence followed by a new thought are boundaries.
/// Numbered lists stay inside the thought that introduced them.
pub fn split_steps(reasoning: &str) -> Vec<String> {
    let text = reasoning.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts = split_headings(text);
    if parts.len() < 2 {
        parts = split_paragraphs(text);
    }
    let parts: Vec<String> = parts.into_iter().flat_map(split_one_thought).collect();
    let parts = merge_tiny(parts);
    cap_steps(parts)
}

fn split_one_thought(block: String) -> Vec<String> {
    let text = block.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if text.chars().count() <= TARGET_CHARS || is_list_heavy(text) {
        return vec![text.to_string()];
    }
    let by_line = split_thought_lines(text);
    if by_line.len() > 1 {
        return by_line
            .into_iter()
            .flat_map(|part| {
                if part.chars().count() > TARGET_CHARS && !is_list_heavy(&part) {
                    pack_sentences(&part)
                } else {
                    vec![part]
                }
            })
            .collect();
    }
    pack_sentences(text)
}

fn split_headings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let heading = trimmed.starts_with("# ") || trimmed.starts_with("## ");
        if heading && !current.trim().is_empty() {
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

fn split_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
}

fn is_list_item(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("• ") {
        return true;
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    matches!(t[digits..].chars().next(), Some('.' | ')'))
        && t.get(digits + 1..)
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_whitespace()))
}

fn is_list_heavy(text: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return false;
    }
    let listed = lines.iter().filter(|line| is_list_item(line)).count();
    listed >= 2 && listed >= lines.len().saturating_sub(2)
}

fn is_quote_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('"') || t.starts_with('\'') || t.starts_with('“') || t.starts_with('«')
}

fn thought_ended(block: &str) -> bool {
    let last = block
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if last.is_empty() || last.ends_with(':') {
        return false;
    }
    last.ends_with('.')
        || last.ends_with('?')
        || last.ends_with('!')
        || last.ends_with('"')
        || last.ends_with('”')
        || last.ends_with('\'')
}

fn looks_like_new_thought(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || is_list_item(t) || is_quote_line(t) {
        return false;
    }
    t.chars().next().is_some_and(|c| c.is_uppercase())
}

fn split_thought_lines(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 2 {
        let trimmed = text.trim();
        return if trimmed.is_empty() {
            Vec::new()
        } else {
            vec![trimmed.to_string()]
        };
    }
    let mut out = Vec::new();
    let mut current = String::new();
    for line in lines {
        let trimmed = line.trim();
        if !current.is_empty() && thought_ended(&current) && looks_like_new_thought(trimmed) {
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
    if out.is_empty() {
        vec![text.trim().to_string()]
    } else {
        out
    }
}

fn is_list_marker_period(text: &str, period_index: usize) -> bool {
    let line_start = text[..period_index].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let prefix = text[line_start..period_index].trim();
    !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit())
}

fn is_abbrev_period(text: &str, period_index: usize) -> bool {
    let prefix = &text[..period_index];
    let word: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if (1..=2).contains(&word.len()) {
        return true;
    }
    let chars: Vec<char> = prefix.chars().collect();
    chars.len() >= 2
        && chars[chars.len() - 2] == '.'
        && chars[chars.len() - 1].is_ascii_alphabetic()
}

fn split_sentences(text: &str) -> Vec<String> {
    if is_list_heavy(text) {
        return vec![text.trim().to_string()];
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if !matches!(ch, '.' | '!' | '?') {
            i += 1;
            continue;
        }
        let byte_index: usize = chars[..i].iter().map(|c| c.len_utf8()).sum();
        if ch == '.' && (is_list_marker_period(text, byte_index) || is_abbrev_period(text, byte_index))
        {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && matches!(chars[j], '"' | '”' | '\'') {
            j += 1;
        }
        let mut ws = 0;
        while j + ws < chars.len() && chars[j + ws].is_whitespace() {
            ws += 1;
        }
        if ws == 0 && j < chars.len() {
            i += 1;
            continue;
        }
        let next = chars.get(j + ws).copied();
        if next.is_some_and(|n| !n.is_uppercase() && n != '"' && n != '“') {
            i += 1;
            continue;
        }
        let sentence: String = chars[start..j].iter().collect();
        let sentence = sentence.trim();
        if !sentence.is_empty() {
            out.push(sentence.to_string());
        }
        start = j + ws;
        i = start;
    }
    let tail: String = chars[start..].iter().collect();
    let tail = tail.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    if out.is_empty() {
        vec![text.trim().to_string()]
    } else {
        out
    }
}

fn pack_sentences(text: &str) -> Vec<String> {
    let sentences = split_sentences(text);
    if sentences.len() <= 1 {
        return vec![text.trim().to_string()];
    }
    let mut out = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for sentence in sentences {
        let next_len = chars + sentence.len();
        if !current.is_empty() && (current.len() >= MAX_SENTENCES || next_len > TARGET_CHARS) {
            out.push(current.join(" "));
            current.clear();
            chars = 0;
        }
        chars += sentence.len() + 1;
        current.push(sentence);
    }
    if !current.is_empty() {
        out.push(current.join(" "));
    }
    out
}

fn merge_tiny(parts: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        let merge = out.last().is_some()
            && part.len() < 32
            && !part.trim().ends_with(['.', '!', '?'])
            && !is_list_item(&part);
        if merge {
            if let Some(prev) = out.last_mut() {
                prev.push('\n');
                prev.push_str(&part);
            }
        } else {
            out.push(part);
        }
    }
    out
}

fn cap_steps(parts: Vec<String>) -> Vec<String> {
    if parts.len() <= REASON_STEP_CAP {
        return parts;
    }
    let mut kept: Vec<String> = parts.iter().take(REASON_STEP_CAP - 1).cloned().collect();
    kept.push(parts[REASON_STEP_CAP - 1..].join("\n\n"));
    kept
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
    fn numbered_lists_stay_inside_the_thought_that_contains_them() {
        let blob = "\
The document describes:
1. The concept of alignment (writing strings one above the other with gaps)
2. The cost of an alignment (number of columns where letters differ)
3. Edit distance = cost of the best possible alignment
4. The observation that brute-forcing all alignments is infeasible
The document does not actually show a suboptimal algorithm.";
        let steps = split_steps(blob);
        assert!(
            steps.iter().any(|step| step.contains("1. The concept of alignment")),
            "{steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.contains("4. The observation")),
            "{steps:?}"
        );
        assert!(
            !steps.iter().any(|step| step.trim_start().starts_with("1. ")),
            "{steps:?}"
        );
    }

    #[test]
    fn long_cot_without_headings_becomes_several_steps() {
        let blob = "\
The student is asking whether the algorithm I described (the DP table with dp[i][j] = min) is the algorithm for the suboptimal edit distance alignment cost shown in the document.
Let me re-read the document context. The document says:
\"In general, there are so many possible alignments between two strings that it would be terribly inefficient to search through all of them for the best one.\"
So the document describes:
1. The concept of alignment (writing strings one above the other with gaps)
2. The cost of an alignment (number of columns where letters differ)
3. Edit distance = cost of the best possible alignment
4. The observation that brute-forcing all alignments is infeasible
The document does not actually show a suboptimal algorithm per se.
Wait, let me re-read. The student says they are NOT referring to the correct implementation.
So the student seems to be asking: is the DP table algorithm the one that computes the suboptimal cost shown in the document?
Actually, I think the student is confused. The document doesn't show a suboptimal algorithm.
So the answer is: No, the DP table is the efficient algorithm. The suboptimal approach the document alludes to is simply trying every possible alignment.";
        let steps = split_steps(blob);
        assert!(steps.len() > 2, "{steps:?}");
        assert!(steps.len() <= REASON_STEP_CAP, "{steps:?}");
        assert!(steps[0].contains("The student is asking"), "{steps:?}");
        assert!(
            steps.iter().any(|step| step.contains("1. The concept of alignment")),
            "{steps:?}"
        );
    }

    #[test]
    fn markdown_headings_still_split_thoughts() {
        let steps = split_steps("# Check the board\nLook at the ink.\n\n# Name the claim\nSGD is the method.");
        assert_eq!(steps.len(), 2, "{steps:?}");
        assert!(steps[0].contains("Check the board"));
        assert!(steps[1].contains("Name the claim"));
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
