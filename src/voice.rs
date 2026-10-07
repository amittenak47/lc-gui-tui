//! Android's built-in recognizer is free and stays on the device, but it is weak
//! on technical words and punctuation. These engines take one recorded clip and,
//! for the cloud providers, the user's own API key, and return a transcript.
//! Nothing is sent unless the user picked one of them.

use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::time::Duration;

use crate::config::{resolve_api_key, Config};
use crate::llm::reasoning::split_think;
use crate::llm::{make_provider, ChatMessage, ChatRequest};

/// One recorded clip, as the recorder left it.
pub struct Clip {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime: String,
}

/// Send `clip` to the engine chosen in `cfg.voice` and return the trimmed text
/// (may be empty when nothing was said).
pub fn transcribe(cfg: &Config, clip: Clip) -> Result<String> {
    match cfg.voice.engine.as_str() {
        "android" => bail!("Dictation is set to Android's built-in recognizer"),
        "openai" => transcribe_openai(
            &cfg.llm.openai.base_url,
            resolve_api_key("OPENAI_API_KEY", cfg.llm.openai.api_key.as_deref()),
            &cfg.voice.openai_model,
            &cfg.voice.vocabulary,
            clip,
            "OpenAI",
            "Add an OpenAI API key in Settings → LLM → Voice dictation",
        ),
        "groq" => transcribe_openai(
            &cfg.llm.groq.base_url,
            resolve_api_key("GROQ_API_KEY", cfg.llm.groq.api_key.as_deref()),
            &cfg.voice.groq_model,
            &cfg.voice.vocabulary,
            clip,
            "Groq",
            "Add a Groq API key in Settings → LLM → Voice dictation",
        ),
        "local" => transcribe_local(cfg, clip),
        "deepgram" => transcribe_deepgram(cfg, clip),
        other => bail!(
            "voice engine must be one of {}, got {other:?}",
            crate::config::VOICE_ENGINES.join(", ")
        ),
    }
}

fn transcribe_openai(
    base_url: &str,
    api_key: Option<String>,
    model: &str,
    vocabulary: &str,
    clip: Clip,
    provider: &str,
    missing_key: &str,
) -> Result<String> {
    let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) else {
        bail!("{missing_key}");
    };
    post_transcription(
        base_url,
        Some(api_key),
        model,
        vocabulary,
        clip,
        provider,
        false,
    )
}

fn transcribe_local(cfg: &Config, clip: Clip) -> Result<String> {
    post_transcription(
        &cfg.voice.local_base_url,
        None,
        &cfg.voice.local_model,
        &cfg.voice.vocabulary,
        clip,
        "Local",
        true,
    )
}

fn post_transcription(
    base_url: &str,
    api_key: Option<String>,
    model: &str,
    vocabulary: &str,
    clip: Clip,
    provider: &str,
    local: bool,
) -> Result<String> {
    let base = base_url.trim().trim_end_matches('/');
    if local && base.is_empty() {
        bail!("Set the local speech server URL in Settings → LLM → Voice dictation");
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()?;
    let url = format!("{base}/audio/transcriptions");
    let mime = clip.mime.clone();
    let part = reqwest::blocking::multipart::Part::bytes(clip.bytes)
        .file_name(clip.filename)
        .mime_str(&mime)
        .with_context(|| format!("clip mime {mime:?} is not a media type"))?;
    let terms = vocabulary_terms(vocabulary);
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json")
        .text("temperature", "0");
    if !terms.is_empty() {
        form = form.text("prompt", terms.join(", "));
    }
    let mut request = client.post(&url).multipart(form);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = match request.send() {
        Ok(response) => response,
        Err(err) if local && err.is_connect() => bail!(
            "The speech server at {base} could not be reached ({err}). On the tablet, localhost is the tablet itself."
        ),
        Err(err) => return Err(err.into()),
    };
    response_text(response, provider, parse_openai_text)
}

fn transcribe_deepgram(cfg: &Config, clip: Clip) -> Result<String> {
    let Some(key) = resolve_api_key("DEEPGRAM_API_KEY", cfg.voice.deepgram_api_key.as_deref())
    else {
        bail!("Add a Deepgram API key in Settings → LLM → Voice dictation");
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()?;
    let terms = vocabulary_terms(&cfg.voice.vocabulary);
    let response = client
        .post("https://api.deepgram.com/v1/listen")
        .query(&deepgram_query(&cfg.voice.deepgram_model, &terms))
        .header("Authorization", format!("Token {key}"))
        .header("Content-Type", clip.mime)
        .body(clip.bytes)
        .send()?;
    response_text(response, "Deepgram", parse_deepgram_text)
}

fn response_text(
    response: reqwest::blocking::Response,
    provider: &str,
    parse: fn(&str) -> Result<String>,
) -> Result<String> {
    let status = response.status();
    let body = response
        .text()
        .with_context(|| format!("{provider} transcription response was unreadable"))?;
    if !status.is_success() {
        bail!(
            "{provider} transcription failed ({status}): {}",
            provider_error_detail(&body)
        );
    }
    parse(&body)
}

fn vocabulary_terms(raw: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for piece in raw.split(|c| c == ',' || c == '\n') {
        let term = piece.trim();
        if term.is_empty() {
            continue;
        }
        if seen.insert(term.to_lowercase()) {
            terms.push(term.to_string());
        }
        if terms.len() == 100 {
            break;
        }
    }
    terms
}

const CLEANUP_PROMPT: &str = "\
You clean up dictated text for a chat box in a coding and study app.
Fix punctuation, capitalization and spacing. Remove filler words (um, uh, you know) and false starts.
Fix words the speech recognizer obviously misheard, especially programming terms, identifiers and math (for example \"heap q\" -> \"heapq\", \"oh of n log n\" -> \"O(n log n)\", \"dee eff ess\" -> \"DFS\").
Do not answer, explain, summarize, translate, or add anything. Keep the speaker's wording and meaning.
Reply with the cleaned text only, no quotes, no preamble.";

fn cleanup_system_prompt(vocabulary: &str) -> String {
    let terms = vocabulary_terms(vocabulary);
    if terms.is_empty() {
        CLEANUP_PROMPT.to_string()
    } else {
        format!(
            "{CLEANUP_PROMPT}\nWords the speaker uses: {}.",
            terms.join(", ")
        )
    }
}

/// Tidy dictated `text` with the LLM named by `cfg.voice.cleanup`.
///
/// `"off"`, or text that is only whitespace, returns `text` without calling a
/// provider. A reply that is empty, much longer, or much shorter than the
/// input is discarded and the original text is returned.
pub fn cleanup(cfg: &Config, text: &str) -> Result<String> {
    if cfg.voice.cleanup == "off" || text.trim().is_empty() {
        return Ok(text.to_string());
    }
    let provider = make_provider(cfg, Some(&cfg.voice.cleanup))?;
    let request = ChatRequest::new(vec![
        ChatMessage::system(cleanup_system_prompt(&cfg.voice.vocabulary)),
        ChatMessage::user(text.to_string()),
    ])
    .with_temperature(0.0)
    .with_reasoning(false);
    let reply = provider.chat_ex(&request)?;
    Ok(tidy_reply(&reply.content, text))
}

fn tidy_reply(raw: &str, original: &str) -> String {
    let peeled = split_think(raw, "").content;
    let cleaned = strip_wrapping_quotes(peeled.trim());
    let cleaned_chars = cleaned.chars().count();
    let input_chars = original.chars().count();
    if cleaned.is_empty()
        || cleaned_chars > input_chars * 2 + 40
        || cleaned_chars < input_chars / 3
        || cleanup_tokens(&cleaned) != cleanup_tokens(original)
        || cleanup_numbers(&cleaned) != cleanup_numbers(original)
    {
        original.to_string()
    } else {
        cleaned
    }
}

// Only casing, punctuation and hesitation removal may be applied automatically.
// Never replace a dictated question with a model's answer or paraphrase.
fn cleanup_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\u{201C}' | '\u{201D}'
                )
        })
        .filter(|word| !word.is_empty() && !matches!(*word, "um" | "uh" | "umm" | "uhh"))
        .map(str::to_string)
        .collect()
}

// A decimal point, thousands separator or time separator carries meaning.
// Do not treat a formatting change that splits a number as punctuation cleanup.
fn cleanup_numbers(text: &str) -> Vec<String> {
    text.split(|ch: char| !(ch.is_numeric() || matches!(ch, '.' | ',' | ':')))
        .filter(|part| part.chars().any(char::is_numeric))
        .map(|part| part.trim_matches(['.', ',', ':']).to_string())
        .collect()
}

fn strip_wrapping_quotes(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let Some(last) = chars.next_back() else {
        return text.to_string();
    };
    let wrapped = (first == '"' && last == '"') || (first == '\u{201C}' && last == '\u{201D}');
    if wrapped {
        chars.collect()
    } else {
        text.to_string()
    }
}

fn deepgram_query(model: &str, terms: &[String]) -> Vec<(String, String)> {
    let mut query = vec![
        ("model".to_string(), model.to_string()),
        ("smart_format".to_string(), "true".to_string()),
        ("punctuate".to_string(), "true".to_string()),
    ];
    let param = if model.starts_with("nova-3") {
        "keyterm"
    } else {
        "keywords"
    };
    for term in terms {
        query.push((param.to_string(), term.clone()));
    }
    query
}

fn parse_openai_text(body: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(body).context("transcription response was not JSON")?;
    let text = value
        .get("text")
        .and_then(|v| v.as_str())
        .context("transcription response missing text")?;
    Ok(text.trim().to_string())
}

fn parse_deepgram_text(body: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(body).context("Deepgram response was not JSON")?;
    let text = value
        .pointer("/results/channels/0/alternatives/0/transcript")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(text.trim().to_string())
}

fn provider_error_detail(body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| first_error_message(&value))
        .unwrap_or_else(|| body.to_string());
    truncate_chars(&detail, 300)
}

fn first_error_message(value: &serde_json::Value) -> Option<String> {
    let fields = [
        value.pointer("/error/message").and_then(|v| v.as_str()),
        value.get("err_msg").and_then(|v| v.as_str()),
        value.get("message").and_then(|v| v.as_str()),
    ];
    fields
        .into_iter()
        .flatten()
        .find(|text| !text.is_empty())
        .map(str::to_string)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip() -> Clip {
        Clip {
            bytes: b"clip".to_vec(),
            filename: "clip.webm".into(),
            mime: "audio/webm".into(),
        }
    }

    fn env_is_set(name: &str) -> bool {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    }

    #[test]
    fn vocabulary_terms_split_trim_dedupe_and_cap() {
        assert!(vocabulary_terms("  , \n ").is_empty());
        assert_eq!(
            vocabulary_terms("BFS, bfs, \nDFS\r\n, , sliding window"),
            vec!["BFS", "DFS", "sliding window"]
        );
        assert_eq!(
            vocabulary_terms("TwoSum, twosum"),
            vec!["TwoSum".to_string()]
        );
        let raw = (0..120)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let terms = vocabulary_terms(&raw);
        assert_eq!(terms.len(), 100);
        assert_eq!(terms[0], "0");
        assert_eq!(terms[99], "99");
    }

    #[test]
    fn deepgram_query_uses_keyterm_only_for_nova_3() {
        let terms = vec!["BFS".to_string(), "union find".to_string()];
        assert_eq!(
            deepgram_query("nova-3", &terms),
            vec![
                ("model".into(), "nova-3".into()),
                ("smart_format".into(), "true".into()),
                ("punctuate".into(), "true".into()),
                ("keyterm".into(), "BFS".into()),
                ("keyterm".into(), "union find".into()),
            ]
        );
        assert_eq!(
            deepgram_query("nova-3-medical", &[]),
            vec![
                ("model".into(), "nova-3-medical".into()),
                ("smart_format".into(), "true".into()),
                ("punctuate".into(), "true".into()),
            ]
        );
        let older = deepgram_query("nova-2", &terms);
        assert!(older.iter().any(|(k, v)| k == "keywords" && v == "BFS"));
        assert!(older.iter().all(|(k, _)| k != "keyterm"));
    }

    #[test]
    fn parse_openai_and_deepgram_text() {
        assert_eq!(
            parse_openai_text(r#"{"text":"  hello world  "}"#).unwrap(),
            "hello world"
        );
        assert_eq!(parse_openai_text(r#"{"text":""}"#).unwrap(), "");
        assert!(parse_openai_text("nope").is_err());
        assert!(parse_openai_text(r#"{"text":1}"#).is_err());

        assert_eq!(
            parse_deepgram_text(
                r#"{"results":{"channels":[{"alternatives":[{"transcript":" hi "}]}]}}"#
            )
            .unwrap(),
            "hi"
        );
        assert_eq!(parse_deepgram_text(r#"{"results":{}}"#).unwrap(), "");
        assert!(parse_deepgram_text("nope").is_err());
    }

    #[test]
    fn provider_error_detail_prefers_message_fields_and_truncates() {
        assert_eq!(
            provider_error_detail(
                r#"{"error":{"message":"bad key"},"err_msg":"nope","message":"also"}"#
            ),
            "bad key"
        );
        assert_eq!(provider_error_detail(r#"{"err_msg":"dg down"}"#), "dg down");
        assert_eq!(provider_error_detail(r#"{"message":"nope"}"#), "nope");
        assert_eq!(provider_error_detail("plain failure"), "plain failure");
        assert_eq!(provider_error_detail(&"x".repeat(350)).chars().count(), 300);
        let long_message = "y".repeat(320);
        let body = format!(r#"{{"error":{{"message":"{long_message}"}}}}"#);
        assert_eq!(provider_error_detail(&body).chars().count(), 300);
        assert!(provider_error_detail(&body).chars().all(|c| c == 'y'));
    }

    #[test]
    fn android_engine_does_not_send_audio() {
        let cfg = Config::default();
        let err = transcribe(&cfg, clip()).unwrap_err().to_string();
        assert_eq!(err, "Dictation is set to Android's built-in recognizer");
    }

    #[test]
    fn missing_openai_key_names_settings() {
        if env_is_set("OPENAI_API_KEY") {
            return;
        }
        let mut cfg = Config::default();
        cfg.voice.engine = "openai".into();
        cfg.llm.openai.api_key = None;
        let err = transcribe(&cfg, clip()).unwrap_err().to_string();
        assert_eq!(
            err,
            "Add an OpenAI API key in Settings → LLM → Voice dictation"
        );
    }

    #[test]
    fn missing_groq_key_names_settings() {
        if env_is_set("GROQ_API_KEY") {
            return;
        }
        let mut cfg = Config::default();
        cfg.voice.engine = "groq".into();
        cfg.llm.groq.api_key = None;
        let err = transcribe(&cfg, clip()).unwrap_err().to_string();
        assert_eq!(
            err,
            "Add a Groq API key in Settings → LLM → Voice dictation"
        );
    }

    #[test]
    fn missing_deepgram_key_names_settings() {
        if env_is_set("DEEPGRAM_API_KEY") {
            return;
        }
        let mut cfg = Config::default();
        cfg.voice.engine = "deepgram".into();
        cfg.voice.deepgram_api_key = None;
        let err = transcribe(&cfg, clip()).unwrap_err().to_string();
        assert_eq!(
            err,
            "Add a Deepgram API key in Settings → LLM → Voice dictation"
        );
    }

    #[test]
    fn cleanup_system_prompt_lists_vocabulary_terms() {
        assert_eq!(cleanup_system_prompt(""), CLEANUP_PROMPT);
        assert_eq!(cleanup_system_prompt("  , \n "), CLEANUP_PROMPT);
        assert_eq!(
            cleanup_system_prompt("BFS, bfs, \nDFS"),
            format!("{CLEANUP_PROMPT}\nWords the speaker uses: BFS, DFS.")
        );
    }

    #[test]
    fn tidy_reply_strips_think_tags_and_wrapping_quotes() {
        assert_eq!(
            tidy_reply("<think>plan</think>\n\"Hello.\"", "hello"),
            "Hello."
        );
        assert_eq!(tidy_reply("\u{201C}Hello.\u{201D}", "hello"), "Hello.");
        assert_eq!(tidy_reply("  Hello.  ", "hello"), "Hello.");
    }

    #[test]
    fn tidy_reply_keeps_the_original_when_the_model_did_not_clean() {
        assert_eq!(tidy_reply("   ", "hello"), "hello");
        assert_eq!(tidy_reply("<think>only thought</think>", "hello"), "hello");
        assert_eq!(tidy_reply("\"\"", "hello"), "hello");
        let original = "abcdefghi";
        assert_eq!(tidy_reply("ab", original), original);
        assert_eq!(tidy_reply("abc", original), original);
        let short = "hi";
        assert_eq!(tidy_reply(&"x".repeat(44), short), short);
        assert_eq!(tidy_reply(&"x".repeat(45), short), short);
    }

    #[test]
    fn cleanup_preserves_questions_negations_numbers_and_operators() {
        for (original, answer) in [
            ("what is bfs", "BFS explores graphs level by level."),
            ("do not delete this", "Delete this."),
            ("a - b equals 12", "a + b equals 13"),
            ("what's bfs", "what is bfs"),
            ("the value is 1.25", "The value is 1 25."),
            ("at 12:30", "At 12 30."),
        ] {
            assert_eq!(tidy_reply(answer, original), original);
        }
        assert_eq!(tidy_reply("What is BFS?", "um what is bfs"), "What is BFS?");
    }

    #[test]
    fn cleanup_off_or_blank_returns_the_input_unchanged() {
        let cfg = Config::default();
        assert_eq!(cfg.voice.cleanup, "off");
        assert_eq!(cleanup(&cfg, "um hello").unwrap(), "um hello");
        let mut cfg = Config::default();
        cfg.voice.cleanup = "local".into();
        assert_eq!(cleanup(&cfg, "   ").unwrap(), "   ");
        assert_eq!(cleanup(&cfg, "").unwrap(), "");
    }

    #[test]
    fn local_engine_without_a_url_names_settings() {
        let mut cfg = Config::default();
        cfg.voice.engine = "local".into();
        cfg.voice.local_base_url.clear();
        let err = transcribe(&cfg, clip()).unwrap_err().to_string();
        assert_eq!(
            err,
            "Set the local speech server URL in Settings → LLM → Voice dictation"
        );
    }
}
