//! Adapters that reshape a downloaded corpus into [`Problem`].
//!
//! Each Hugging Face dataset names its columns differently — `question` here,
//! `problem_description` there, a `meta` object somewhere else. Rather than
//! teach [`Problem`] every spelling, one adapter per dataset maps the raw
//! record onto the canonical field names and everything downstream (index,
//! workspace, runner, prompts) stays as it was.
//!
//! ## The redaction invariant, restated for adapters
//!
//! [`Problem`] deliberately has no field for a reference solution, and serde
//! drops `completion`/`response`/`query` at parse time. An adapter *builds* a
//! `Problem` by hand, so that protection does not apply automatically: it is
//! the adapter's job never to read a solution-bearing column
//! (`solution`, `python_solution`, `q_solution`, `canonical_solution`, …).
//!
//! Two things hold the line. [`SOLUTION_FIELDS`] lists the columns that must
//! never be read, and `no_adapter_can_leak_a_reference_solution` feeds every
//! adapter a record whose solution fields are filled with a marker and asserts
//! it cannot be found anywhere in the result.

pub mod deepseek_leetcode;
pub mod inspect;
pub mod kodcode;
pub mod leetcode_with_tests;
pub mod ms_python_q;
pub mod statement_markdown;

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::dataset::{Dataset, Shape};
use crate::problem::{IoCase, Problem};

/// Corpus columns that carry a worked solution. No adapter may read these.
pub const SOLUTION_FIELDS: [&str; 9] = [
    "solution",
    "completion",
    "response",
    "query",
    "python_solution",
    "q_solution",
    "canonical_solution",
    "reference_solution",
    "code",
];

/// Turn one raw corpus record into a [`Problem`], or drop it.
///
/// Returning `None` is normal: these corpora contain rows with no usable
/// statement or no id, and one bad row must not fail a 400k-record import.
pub fn normalize(dataset: &Dataset, raw: &Value) -> Option<Problem> {
    let mut problem = match dataset.shape {
        Shape::Canonical => {
            let mut problem: Problem = serde_json::from_value(raw.clone()).ok()?;
            sanitize_entry_point(&mut problem);
            problem
        }
        Shape::KodCode => kodcode::normalize(raw)?,
        Shape::MorganStanleyPythonQ => ms_python_q::normalize(raw)?,
        Shape::DeepSeekLeetCode => deepseek_leetcode::normalize(raw)?,
        Shape::LeetCodeWithTests => leetcode_with_tests::normalize(raw)?,
    };
    finalize_problem_description(&mut problem);
    sanitize_io_cases(&mut problem);
    Some(problem)
}

/// Strip `Solution().foo()` down to the bare method the runner looks up.
pub(crate) fn sanitize_entry_point(problem: &mut Problem) {
    if let Some(raw) = problem.entry_point.take() {
        let cleaned = clean_entry_point(&raw);
        problem.entry_point = if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        };
    }
}

/// Everything a raw statement needs before anything displays it.
///
/// [`as_markdown`] drops the corpus boilerplate and settles the newlines;
/// [`statement_markdown::normalize_statement_markdown`] lays out the sections
/// and restores flattened exponents. Both are idempotent, so an adapter that
/// already called `as_markdown` loses nothing by going through here.
pub(crate) fn finalize_description(text: &str) -> String {
    statement_markdown::normalize_statement_markdown(&as_markdown(text))
}

/// Tidy a [`Problem`] that serde just built from a canonical corpus record.
///
/// The canonical shape bypasses [`normalize`] — `load_task` / `load_all` hand
/// the record straight to serde — so the fix-ups the adapters get for free have
/// to be applied at each of those sites. Pairing them in one call is what keeps
/// a new load path from picking up only half of them.
pub(crate) fn finish_canonical(problem: &mut Problem) {
    sanitize_entry_point(problem);
    finalize_problem_description(problem);
    sanitize_io_cases(problem);
}

/// Clean a problem's statement in place, on the way out of a load.
///
/// Called wherever a [`Problem`] is built from corpus text — [`normalize`] for
/// the adapters, [`finish_canonical`] for the canonical serde paths — so the
/// API, the coach, the TUI, an offline pack and the board all read the same
/// cleaned description. Nothing is written back: the index stores only metadata
/// and a `json_path`, so this needs no re-index and rewrites no corpus file.
pub(crate) fn finalize_problem_description(problem: &mut Problem) {
    if let Some(raw) = problem.problem_description.take() {
        let cleaned = finalize_description(&raw);
        problem.problem_description = if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        };
    }
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

/// First present, non-empty string among `keys`. Numbers are stringified,
/// because ids arrive both ways.
pub(crate) fn text(raw: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        match raw.get(key) {
            Some(Value::String(s)) if !s.trim().is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            Some(Value::Bool(b)) => return Some(b.to_string()),
            _ => {}
        }
    }
    None
}

/// Like [`text`], but reads `meta.<key>` style nested objects too.
pub(crate) fn nested_text(raw: &Value, container: &str, keys: &[&str]) -> Option<String> {
    let inner = container_value(raw, container)?;
    text(&inner, keys)
}

/// A nested column, whether it arrived as a structure or as a string holding
/// one.
///
/// Parquet is where this bites. A dataset whose `meta` is a struct converts to
/// a JSON object, but one whose schema could not be pinned down stores the same
/// content as a *string* — and then `meta.difficulty` reads as absent and the
/// column silently disappears from the index. Reading both spellings is the
/// difference between a populated q# / tags column and an empty one.
pub(crate) fn container_value(raw: &Value, container: &str) -> Option<Value> {
    match raw.get(container)? {
        Value::String(s) => serde_json::from_str(s).ok(),
        other => Some(other.clone()),
    }
}

/// A column that should be an array or object, whichever way it was stored.
fn structured(raw: &Value, key: &str) -> Option<Value> {
    match raw.get(key)? {
        Value::String(s) if s.trim_start().starts_with(['[', '{']) => {
            serde_json::from_str(s).ok()
        }
        other @ (Value::Array(_) | Value::Object(_)) => Some(other.clone()),
        _ => None,
    }
}

/// Tags from an array of strings, an array of `{name}` objects, or one string.
///
/// An array stored as a JSON string (`"[\"Array\", \"Hash Table\"]"`) counts as
/// an array — see [`container_value`] for why corpora do that.
pub(crate) fn tags(raw: &Value, keys: &[&str]) -> Vec<String> {
    for key in keys {
        let stored = structured(raw, key);
        match stored.as_ref().or_else(|| raw.get(key)) {
            Some(Value::Array(items)) => {
                let out: Vec<String> = items
                    .iter()
                    .filter_map(|item| match item {
                        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                        Value::Object(_) => text(item, &["name", "slug", "title", "tag"]),
                        _ => None,
                    })
                    .collect();
                if !out.is_empty() {
                    return out;
                }
            }
            Some(Value::String(s)) if !s.trim().is_empty() => {
                return vec![s.trim().to_string()];
            }
            _ => {}
        }
    }
    Vec::new()
}

/// `Easy` / `Medium` / `Hard`, from a word or from LeetCode's 1/2/3 encoding.
pub(crate) fn difficulty(raw: &Value, keys: &[&str]) -> Option<String> {
    let value = text(raw, keys)?;
    Some(match value.trim().to_ascii_lowercase().as_str() {
        "easy" | "1" => "Easy".to_string(),
        "medium" | "2" => "Medium".to_string(),
        "hard" | "3" => "Hard".to_string(),
        _ => value.trim().to_string(),
    })
}

/// A URL-shaped id: lowercase, non-alphanumerics collapsed to single hyphens.
pub(crate) fn slugify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

/// A short slug built from the first line of a statement, for corpora whose
/// rows are identified only by an opaque uuid.
pub(crate) fn slug_from_statement(statement: &str, max_words: usize) -> String {
    let first = statement
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let words: Vec<&str> = first.split_whitespace().take(max_words).collect();
    slugify(&words.join(" "))
}

// ---------------------------------------------------------------------------
// Python rendering
// ---------------------------------------------------------------------------

/// Render JSON as a Python literal, so a structured test case can be fed to
/// `run_tests.py`, which parses its `input` with `ast.literal_eval`.
pub(crate) fn py_literal(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("{}", PyStr(s)),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(py_literal).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", PyStr(k), py_literal(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// A Python string literal. `repr`-ish: double quotes, backslash-escaped.
struct PyStr<'a>(&'a str);

impl std::fmt::Display for PyStr<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("\"")?;
        for ch in self.0.chars() {
            match ch {
                '"' => f.write_str("\\\"")?,
                '\\' => f.write_str("\\\\")?,
                '\n' => f.write_str("\\n")?,
                '\r' => f.write_str("\\r")?,
                '\t' => f.write_str("\\t")?,
                _ => f.write_fmt(format_args!("{ch}"))?,
            }
        }
        f.write_str("\"")
    }
}

/// The call arguments for one case, in the `n = 7, queries = [[0, 5]]` shape
/// `run_tests.py` expects.
///
/// A string passes through untouched — those corpora already store the call
/// arguments as source. An object becomes keyword arguments, an array becomes
/// positional ones.
pub(crate) fn render_case_input(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(map) if !map.is_empty() => Some(
            map.iter()
                .map(|(k, v)| format!("{k} = {}", py_literal(v)))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Value::Array(items) if !items.is_empty() => Some(
            items
                .iter()
                .map(py_literal)
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Value::Null => None,
        other => Some(py_literal(other)),
    }
}

/// The expected value for one case. Strings pass through; everything else is
/// rendered as a Python literal so `ast.literal_eval` can read it back.
pub(crate) fn render_case_output(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_string(),
        other => py_literal(other),
    }
}

/// Read `input_output` / `test_cases` style arrays with tolerant key names.
///
/// Three shapes are accepted, because all three turn up in these downloads:
/// an array of `{input, output}` objects; the same array stored as a JSON
/// *string* (see [`container_value`]); and an array of bare `assert f(…) == …`
/// source lines, which is really a suite pretending to be a case list.
pub(crate) fn io_cases(raw: &Value, keys: &[&str]) -> Vec<IoCase> {
    const INPUT_KEYS: [&str; 5] = ["input", "inputs", "args", "arguments", "parameters"];
    const OUTPUT_KEYS: [&str; 6] = [
        "output",
        "expected",
        "expected_output",
        "outputs",
        "result",
        "answer",
    ];

    for key in keys {
        let stored = structured(raw, key);
        let items = match stored.as_ref().or_else(|| raw.get(key)) {
            Some(Value::Array(items)) => items.clone(),
            _ => continue,
        };
        let mut out = Vec::new();
        let mut assert_lines = Vec::new();
        for item in &items {
            match item {
                Value::Object(_) => {
                    let input = INPUT_KEYS
                        .iter()
                        .find_map(|k| item.get(k))
                        .and_then(render_case_input);
                    let output = OUTPUT_KEYS.iter().find_map(|k| item.get(k));
                    if let (Some(input), Some(output)) = (input, output) {
                        out.push(IoCase {
                            input,
                            output: render_case_output(output),
                        });
                    }
                }
                Value::String(line) => assert_lines.push(line.as_str()),
                _ => {}
            }
        }
        if out.is_empty() && !assert_lines.is_empty() {
            out = cases_from_asserts(&assert_lines.join("\n"), None);
        }
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
}

/// Drop corpus junk that cannot be fed to `run_tests.py`.
///
/// The LeetCode dump mixes real keyword cases with leaked parser fragments
/// (`s`, `]`, truncated quotes) whose stored output is `Error: …`. One of
/// those would otherwise fail `ast.literal_eval` and look like the whole
/// problem is unrunnable.
pub(crate) fn sanitize_io_cases(problem: &mut Problem) {
    problem
        .input_output
        .retain(|case| io_case_is_runnable(&case.input, &case.output));
}

fn io_case_is_runnable(input: &str, output: &str) -> bool {
    let output = output.trim();
    if output.starts_with("Error:") || output.starts_with("error:") {
        return false;
    }
    let input = input.trim();
    if input.is_empty() {
        return false;
    }
    if looks_like_junk_token(input) {
        return false;
    }
    if assigns_to_literal(input) || has_leading_zero_int(input) || has_duplicate_keyword(input) {
        return false;
    }
    quotes_and_brackets_ok(input)
}

/// `True = …` / `1 = …` — Python `SyntaxError: invalid assignment target`.
fn assigns_to_literal(input: &str) -> bool {
    for part in input.split(',') {
        let Some((left, _)) = part.split_once('=') else {
            continue;
        };
        let left = left.trim();
        if matches!(left, "True" | "False" | "None") {
            return true;
        }
        if !left.is_empty() && left.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '.') {
            return true;
        }
    }
    false
}

/// Python 3 rejects `07`; `ast.parse("__lc__(07)")` is SyntaxError.
fn has_leading_zero_int(input: &str) -> bool {
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;
    let mut quote: Option<char> = None;
    let mut escape = false;
    while i < chars.len() {
        let c = chars[i];
        if escape {
            escape = false;
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                escape = true;
            } else if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '0' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
            let prev = i.checked_sub(1).map(|j| chars[j]);
            let glued = prev.is_some_and(|p| p.is_ascii_alphanumeric() || p == '_' || p == '.');
            if !glued {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// `foo=1, foo=2` — `ast.parse("__lc__(…)")` raises duplicate keyword argument.
fn has_duplicate_keyword(input: &str) -> bool {
    let mut seen = HashSet::new();
    let mut quote: Option<char> = None;
    let mut escape = false;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if escape {
            escape = false;
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                escape = true;
            } else if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && chars[j] == '=' && (j + 1 >= chars.len() || chars[j + 1] != '=') {
                let name: String = chars[start..i].iter().collect();
                if !seen.insert(name) {
                    return true;
                }
                i = j + 1;
                continue;
            }
            continue;
        }
        i += 1;
    }
    false
}

/// Bare names (`s`) and stray punctuation (`]`, `,`, `=`) that `literal_eval` rejects.
fn looks_like_junk_token(input: &str) -> bool {
    let s = input.trim();
    if matches!(s, "True" | "False" | "None") {
        return false;
    }
    if s.chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
        return true;
    }
    s.len() == 1 && !s.chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn quotes_and_brackets_ok(s: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut escape = false;
    let mut paren = 0i32;
    let mut brack = 0i32;
    let mut brace = 0i32;
    for c in s.chars() {
        if escape {
            escape = false;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                escape = true;
                continue;
            }
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '(' => paren += 1,
            ')' => paren -= 1,
            '[' => brack += 1,
            ']' => brack -= 1,
            '{' => brace += 1,
            '}' => brace -= 1,
            _ => {}
        }
        if paren < 0 || brack < 0 || brace < 0 {
            return false;
        }
    }
    quote.is_none() && paren == 0 && brack == 0 && brace == 0
}

/// How many sample cases one corpus row is allowed to contribute.
///
/// A suite can hold hundreds of asserts; the sample cases exist to be *read*,
/// on a board, next to the statement. `--full` still runs the whole suite.
const MAX_EXTRACTED_CASES: usize = 12;

/// Sample cases read off a pytest-style suite: `assert f(args) == expected`.
///
/// Corpora that ship a suite but no per-case I/O (KodCode is the big one) show
/// `0` in the browser's cases column and give the runner nothing to report per
/// case. The asserts already are the cases; they just need to be in the
/// `input` / `output` shape `run_tests.py` parses — and its `parse_input`
/// reads bare positional literals, which is exactly what an assert's arguments
/// are.
///
/// Deliberately conservative: only single-line asserts whose call arguments and
/// expected value are *literals* are taken. A case built out of a variable, a
/// helper call or a `pytest.approx` would fail at `ast.literal_eval` and read
/// as a broken problem rather than a missing sample.
pub(crate) fn cases_from_asserts(suite: &str, entry_point: Option<&str>) -> Vec<IoCase> {
    let mut out = Vec::new();
    for line in suite.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("assert ") else {
            continue;
        };
        let Some((call, expected)) = rest.split_once("==") else {
            continue;
        };
        let expected = expected.trim();
        if expected.is_empty() || !is_literal_source(expected) {
            continue;
        }

        let call = call.trim();
        let Some(open) = call.find('(') else { continue };
        let name = call[..open].trim();
        // `Solution().two_sum(…)` and `sol.two_sum(…)` both count.
        let called = name.rsplit('.').next().unwrap_or(name).trim();
        if called.is_empty() || !called.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        // `candidate` is the name the runner binds the entry point to, and the
        // one a `check(candidate)` suite calls it by.
        if let Some(entry) = entry_point {
            if called != entry && called != "candidate" {
                continue;
            }
        }
        let Some(args) = balanced_call_args(&call[open..]) else {
            continue;
        };
        if args.trim().is_empty() || !is_literal_source(args) {
            continue;
        }

        out.push(IoCase {
            input: args.trim().to_string(),
            output: expected.to_string(),
        });
        if out.len() >= MAX_EXTRACTED_CASES {
            break;
        }
    }
    out
}

/// The text inside `(...)`, given a slice that starts at the opening paren, or
/// `None` when the call is not closed on this line.
fn balanced_call_args(from_open: &str) -> Option<&str> {
    let bytes = from_open.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    for (i, &byte) in bytes.iter().enumerate() {
        if let Some(active) = quote {
            if byte == b'\\' {
                continue;
            }
            if byte == active {
                quote = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' => quote = Some(byte),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&from_open[1..i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// True when every bare word outside a string literal is a number or one of
/// Python's literal keywords — i.e. `ast.literal_eval` will read this.
fn is_literal_source(text: &str) -> bool {
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in text.chars().chain(std::iter::once(' ')) {
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_alphanumeric() || ch == '_' || ch == '.' {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            let numeric = word
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_digit() || first == '-');
            if !numeric && !matches!(word.as_str(), "True" | "False" | "None") {
                return false;
            }
            word.clear();
        }
    }
    quote.is_none()
}

// ---------------------------------------------------------------------------
// Python source helpers
// ---------------------------------------------------------------------------

/// The entry point a `class Solution:` skeleton (or a bare `def`) declares.
pub(crate) fn entry_point_from_code(code: &str) -> Option<String> {
    let mut fallback = None;
    for line in code.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("def ") else {
            continue;
        };
        let (name, args) = rest.split_once('(')?;
        let name = name.trim();
        if name.is_empty() || name.starts_with('_') {
            continue;
        }
        // A method on the skeleton class is the entry point; a module-level
        // `def` is only a fallback, because helpers live there too.
        if args.trim_start().starts_with("self") {
            return Some(name.to_string());
        }
        if fallback.is_none() && line.starts_with("def ") {
            fallback = Some(name.to_string());
        }
    }
    fallback
}

/// A minimal editable skeleton, for corpora that ship a signature but no stub.
pub(crate) fn skeleton_from_declaration(declaration: &str) -> Option<String> {
    let trimmed = declaration.trim();
    if !trimmed.starts_with("def ") {
        return None;
    }
    let head = trimmed.trim_end_matches(':').trim_end();
    Some(format!("{head}:\n    pass\n"))
}

/// Strip a leading `"""…"""` docstring, returning `(docstring, code)`.
///
/// DeepSeek's LeetCode records put the whole statement in a module docstring
/// above the `class Solution:` stub, so the two halves have to be separated
/// before either is usable.
pub(crate) fn split_leading_docstring(source: &str) -> (Option<String>, String) {
    let trimmed = source.trim_start();
    for quote in ["\"\"\"", "'''"] {
        let Some(rest) = trimmed.strip_prefix(quote) else {
            continue;
        };
        let Some(end) = rest.find(quote) else { continue };
        let doc = rest[..end].trim().to_string();
        let code = rest[end + quote.len()..].trim_start_matches('\n').to_string();
        return (
            if doc.is_empty() { None } else { Some(doc) },
            code,
        );
    }
    (None, source.to_string())
}

/// First markdown code fence in `text`, plus the prose around it.
///
/// Corpora like DeepSeek and MS Python/Q paste a ```python stub at the end of
/// the statement even when the same stub already lives in `starter_code`.
/// LC+Tests stores the solution fence first and an explanation after.
pub(crate) fn split_markdown_fence(text: &str) -> Option<(String, String, String)> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] != b"```" {
            i += 1;
            continue;
        }
        let after_ticks = i + 3;
        let line_end = text[after_ticks..]
            .find('\n')
            .map(|n| after_ticks + n + 1)
            .unwrap_or(text.len());
        let lang = text[after_ticks..line_end].trim();
        // Prefer python fences; accept bare ``` when that is all the corpus has.
        if !(lang.is_empty()
            || lang.eq_ignore_ascii_case("python")
            || lang.eq_ignore_ascii_case("py")
            || lang.eq_ignore_ascii_case("python3"))
        {
            i = after_ticks;
            continue;
        }
        let body_start = line_end;
        let Some(rel_close) = text[body_start..].find("```") else {
            return None;
        };
        let body_end = body_start + rel_close;
        let before = text[..i].trim().to_string();
        let code = text[body_start..body_end].trim().to_string();
        let after = text[body_end + 3..].trim().to_string();
        return Some((before, code, after));
    }
    None
}

/// Drop every ``` / ```python fence from a statement, keeping surrounding prose.
pub(crate) fn strip_markdown_fences(text: &str) -> String {
    let mut remaining = text.to_string();
    let mut parts = Vec::new();
    while let Some((before, _code, after)) = split_markdown_fence(&remaining) {
        if !before.is_empty() {
            parts.push(before);
        }
        remaining = after;
    }
    if !remaining.trim().is_empty() {
        parts.push(remaining.trim().to_string());
    }
    parts.join("\n\n").trim().to_string()
}

/// Light-touch markdown cleanup so statements render as MD on the board.
///
/// Most corpora already ship markdown (bold, fences, headings). This normalises
/// newlines and drops trailing "please complete the code" boilerplate that
/// only exists to wrap a duplicate starter fence.
pub(crate) fn as_markdown(text: &str) -> String {
    let mut s = text.replace("\r\n", "\n").replace('\r', "\n");
    for marker in [
        "\nPlease complete the code below to solve above prblem:",
        "\nPlease complete the code below to solve above problem:",
        "\nYou will use the following starter code to write the solution to the problem and enclose your code within delimiters.",
    ] {
        if let Some(idx) = s.find(marker) {
            s.truncate(idx);
        }
    }
    // MS Python/Q appends a Q-language note after the Python stub — drop it.
    if let Some(idx) = s.find("\nNOTE: This problem is described for Python") {
        s.truncate(idx);
    }
    s.trim().to_string()
}

/// `from typing import …` lines implied by annotations in `code`.
pub(crate) fn typing_imports_for(code: &str) -> Option<String> {
    const NAMES: &[&str] = &[
        "List", "Dict", "Set", "Tuple", "Optional", "Any", "Callable", "Iterable",
        "Iterator", "Sequence", "Mapping", "Union", "DefaultDict", "Deque", "FrozenSet",
    ];
    let mut found = Vec::new();
    for name in NAMES {
        let needle = format!("{name}[");
        if code.contains(&needle)
            && !(code.contains(&format!("import {name}")) || code.contains("import *"))
        {
            found.push(*name);
        }
    }
    if found.is_empty() {
        return None;
    }
    Some(format!("from typing import {}", found.join(", ")))
}

/// Build Imports (`prompt`) + Solution (`starter_code`) halves like LeetCode.
///
/// Bare `def foo(...):` stubs become `class Solution` methods so the editor's
/// Imports / Solution tabs split. Existing `class Solution` / other classes are
/// left alone; typing imports go above.
pub(crate) fn with_imports_and_solution(starter: &str) -> (Option<String>, String) {
    let trimmed = starter.trim();
    if trimmed.is_empty() {
        return (None, String::new());
    }
    let exploded = explode_jammed_defs(trimmed);
    let exploded = collapse_chained_type_assigns(&exploded);
    let (preamble, code) = split_import_preamble(&exploded);
    let code = close_open_def_signatures(code);
    let body = if code.trim_start().starts_with("def ") && !code.contains("\nclass ") {
        wrap_all_module_defs(&code).unwrap_or_else(|| ensure_pass_bodies(&code))
    } else {
        ensure_pass_bodies(&code)
    };
    let typing = typing_imports_for(&body).filter(|imp| {
        !body.contains(imp.as_str()) && !preamble.contains(imp.as_str())
    });
    let prompt = match (preamble.is_empty(), typing) {
        (true, typing) => typing,
        (false, None) => Some(preamble.to_string()),
        (false, Some(typing)) => Some(format!("{preamble}\n{typing}")),
    };
    (prompt, body)
}

/// Corpus writes `self.left = TreeNode | None = None` — assignment to a type.
fn collapse_chained_type_assigns(src: &str) -> String {
    let mut out = String::new();
    for line in src.lines() {
        if let Some(fixed) = collapse_one_typed_none_assign(line) {
            out.push_str(&fixed);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !src.ends_with('\n') {
        out.pop();
    }
    out
}

fn collapse_one_typed_none_assign(line: &str) -> Option<String> {
    let Some((left, rest)) = line.split_once('=') else {
        return None;
    };
    let rhs = rest.trim();
    if !rhs.contains('=') {
        return None;
    }
    let looks_like_type = rhs.contains('|') || (rhs.contains('[') && rhs.contains(']'));
    let ends_none = rhs.ends_with("= None") || rhs.ends_with("=None");
    if looks_like_type && ends_none {
        return Some(format!("{left}= None"));
    }
    None
}

/// Whether the stub exposes `def {name}(`.
pub(crate) fn stub_defines(code: &str, name: &str) -> bool {
    let needle = format!("def {name}(");
    let needle_sp = format!("def {name} (");
    code.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with(&needle) || t.starts_with(&needle_sp)
    })
}

/// Split `from collections import Counter\\ndef foo` so the `def` can wrap as Solution.
fn split_import_preamble(src: &str) -> (&str, &str) {
    if src.starts_with("def ") || src.starts_with("class ") {
        return ("", src);
    }
    let def_at = src.find("\ndef ");
    let class_at = src.find("\nclass ");
    let at = match (def_at, class_at) {
        (None, None) => return ("", src),
        (Some(d), None) => d + 1,
        (None, Some(c)) => c + 1,
        (Some(d), Some(c)) => d.min(c) + 1,
    };
    (src[..at].trim_end(), src[at..].trim())
}

/// LC+Tests dumps two signatures as `def a(...) -> T, def b(...)` or `; def`.
fn explode_jammed_defs(src: &str) -> String {
    src.replace("; def ", "\ndef ").replace(", def ", "\ndef ")
}

/// Corpus class stubs often omit the trailing `:` on `def foo(...) -> int`.
fn close_open_def_signatures(src: &str) -> String {
    let mut out = String::new();
    for line in src.lines() {
        let trimmed_end = line.trim_end();
        let trimmed = trimmed_end.trim_start();
        if trimmed.starts_with("def ") && !trimmed_end.ends_with(':') && def_parens_closed(trimmed) {
            out.push_str(trimmed_end);
            out.push(':');
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !src.ends_with('\n') {
        out.pop();
    }
    out
}

fn def_parens_closed(def_line: &str) -> bool {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    for ch in def_line.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
    }
    depth == 0 && def_line.contains('(') && def_line.contains(')')
}

fn wrap_all_module_defs(code: &str) -> Option<String> {
    let chunks = split_top_level_defs(code);
    if chunks.is_empty() {
        return None;
    }
    let mut methods = String::from("class Solution:\n");
    for chunk in chunks {
        let wrapped = wrap_def_as_solution_method(chunk.trim())?;
        for line in wrapped.lines().skip(1) {
            methods.push_str(line);
            methods.push('\n');
        }
    }
    Some(methods)
}

fn split_top_level_defs(code: &str) -> Vec<&str> {
    let mut starts = Vec::new();
    let mut search = 0usize;
    if code.starts_with("def ") {
        starts.push(0);
        search = 1;
    }
    while let Some(rel) = code[search..].find("\ndef ") {
        let at = search + rel + 1;
        starts.push(at);
        search = at + 1;
    }
    if starts.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    for i in 0..starts.len() {
        let end = starts.get(i + 1).copied().unwrap_or(code.len());
        chunks.push(code[starts[i]..end].trim_end());
    }
    chunks
}

/// Most common `assert name(` callee — helpers listed first in `function` are
/// not the entry the tests actually call.
pub(crate) fn entry_point_from_asserts(suite: &str) -> Option<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for line in suite.lines() {
        let Some(rest) = line.trim().strip_prefix("assert ") else {
            continue;
        };
        let call = rest.split_once("==").map(|(c, _)| c).unwrap_or(rest);
        let Some(open) = call.find('(') else {
            continue;
        };
        let name = call[..open].trim();
        let called = name.rsplit('.').next().unwrap_or(name).trim();
        if called.is_empty() || called == "candidate" || is_assert_noise(called) {
            continue;
        }
        if !called.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        *counts.entry(called.to_string()).or_default() += 1;
    }
    counts.into_iter().max_by_key(|(_, n)| *n).map(|(k, _)| k)
}

fn is_assert_noise(name: &str) -> bool {
    matches!(
        name,
        "isinstance"
            | "issubclass"
            | "len"
            | "sorted"
            | "set"
            | "list"
            | "dict"
            | "tuple"
            | "all"
            | "any"
            | "min"
            | "max"
            | "sum"
            | "type"
            | "int"
            | "str"
            | "bool"
            | "range"
            | "enumerate"
            | "zip"
            | "map"
            | "filter"
            | "print"
            | "abs"
            | "reversed"
            | "iter"
            | "hasattr"
            | "getattr"
            | "setattr"
            | "callable"
            | "id"
            | "vars"
            | "dir"
            | "open"
            | "format"
            | "round"
            | "repr"
            | "hash"
            | "super"
            | "object"
            | "bytes"
            | "frozenset"
    )
}

fn wrap_def_as_solution_method(declaration: &str) -> Option<String> {
    let sig = def_signature_only(declaration)?;
    let sig = sig.trim().trim_end_matches(':').trim_end();
    let rest = sig.strip_prefix("def ")?;
    let (name, args_and_ret) = rest.split_once('(')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let close = args_and_ret.rfind(')')?;
    let args = args_and_ret[..close].trim();
    let ret = args_and_ret[close + 1..].trim(); // e.g. `-> List[int]`
    let ret = if ret.is_empty() {
        String::new()
    } else if ret.starts_with("->") {
        format!(" {ret}")
    } else {
        format!(" {ret}")
    };
    let params = if args.is_empty() {
        "self".to_string()
    } else if args.starts_with("self") {
        args.to_string()
    } else {
        format!("self, {args}")
    };
    Some(format!(
        "class Solution:\n    def {name}({params}){ret}:\n        pass\n"
    ))
}

/// The `def …` signature only — drop an existing body (`pass`, docstring, …).
fn def_signature_only(source: &str) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.trim_start().starts_with("def "))?;
    let mut depth = 0i32;
    let mut out = Vec::new();
    for &line in &lines[start..] {
        out.push(line);
        let mut quote: Option<char> = None;
        for ch in line.chars() {
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
                continue;
            }
            if ch == '"' || ch == '\'' {
                quote = Some(ch);
                continue;
            }
            match ch {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth -= 1,
                _ => {}
            }
        }
        if depth <= 0 && (line.contains("->") || line.trim_end().ends_with(':')) {
            break;
        }
    }
    Some(out.join("\n"))
}

/// Ensure every `def` line in a multi-def class stub has a `pass` body.
pub(crate) fn ensure_pass_bodies(source: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return source.to_string();
    }
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        out.push_str(line);
        out.push('\n');
        let trimmed = line.trim_start();
        if !trimmed.starts_with("def ") {
            continue;
        }
        // Signature may wrap; only treat as closed when this line ends with `:`.
        if !trimmed.trim_end().ends_with(':') && !line.trim_end().ends_with(':') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let next = lines.get(i + 1).map(|l| l.trim()).unwrap_or("");
        let next_indent = lines
            .get(i + 1)
            .map(|l| l.len() - l.trim_start().len())
            .unwrap_or(0);
        if next.is_empty() || next_indent <= indent || next.starts_with("def ") || next.starts_with("class ")
        {
            out.push_str(&" ".repeat(indent + 4));
            out.push_str("pass\n");
        }
    }
    out
}

/// Replace `foo(` with `candidate(` unless it is `obj.foo(` / `otherfoo(`.
fn replace_bare_call(src: &str, entry: &str) -> String {
    let needle = format!("{entry}(");
    let mut out = String::new();
    let mut rest = src;
    while let Some(at) = rest.find(&needle) {
        let before = &rest[..at];
        let glued = before.chars().last().is_some_and(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '.'
        });
        out.push_str(before);
        if glued {
            out.push_str(&needle);
        } else {
            out.push_str("candidate(");
        }
        rest = &rest[at + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// Rewrite `assert foo(...)` lines into a `check(candidate)` suite.
pub(crate) fn asserts_as_check_suite(suite: &str, entry_point: &str) -> String {
    let mut body = String::from("def check(candidate):\n");
    let mut wrote = false;
    for line in suite.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut rewritten = trimmed.to_string();
        let assert_bare = format!("assert {entry_point}(");
        let assert_sol = format!("assert Solution().{entry_point}(");
        let assert_sol_var = format!("assert sol.{entry_point}(");
        if let Some(rest) = rewritten.strip_prefix(&assert_bare) {
            rewritten = format!("assert candidate({rest}");
        } else if let Some(rest) = rewritten.strip_prefix(&assert_sol) {
            rewritten = format!("assert candidate({rest}");
        } else if let Some(rest) = rewritten.strip_prefix(&assert_sol_var) {
            rewritten = format!("assert candidate({rest}");
        } else {
            rewritten = rewritten.replace(&format!("Solution().{entry_point}("), "candidate(");
            rewritten = rewritten.replace(&format!("sol.{entry_point}("), "candidate(");
            rewritten = replace_bare_call(&rewritten, entry_point);
        }
        if !rewritten.starts_with("assert ") {
            continue;
        }
        body.push_str("    ");
        body.push_str(&rewritten);
        body.push('\n');
        wrote = true;
    }
    if !wrote {
        body.push_str("    pass\n");
    }
    body
}

/// Docstring sitting under a `def` / method in a Complete-style KodCode prompt.
pub(crate) fn docstring_inside_def(source: &str) -> Option<String> {
    let trimmed = source.trim_start();
    if !(trimmed.starts_with("def ") || trimmed.starts_with("class ")) {
        return None;
    }
    for quote in ["\"\"\"", "'''"] {
        let Some(start) = trimmed.find(quote) else {
            continue;
        };
        let rest = &trimmed[start + quote.len()..];
        let Some(end) = rest.find(quote) else {
            continue;
        };
        let doc = rest[..end].trim();
        if !doc.is_empty() {
            return Some(doc.to_string());
        }
    }
    None
}

/// Clean an entry point that arrived as `Solution().isValid` / `sol.foo()` /
/// `isValid()`.
///
/// The default LeetCode corpus stores receivers and call parens; the runner
/// looks up a bare method name on `class Solution`.
pub(crate) fn clean_entry_point(raw: &str) -> String {
    let s = raw.trim();
    let s = if let Some(rest) = s.strip_prefix("Solution().") {
        rest.trim()
    } else if let Some(rest) = s.strip_prefix("Solution.") {
        rest.trim()
    } else if let Some((_, method)) = s.rsplit_once('.') {
        let method = method.trim();
        // Allow trailing `()` here — stripped below.
        let name = method.split_once('(').map(|(n, _)| n).unwrap_or(method).trim();
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            name
        } else {
            s
        }
    } else {
        s
    };

    if let Some((name, _)) = s.split_once('(') {
        let name = name.trim();
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return name.to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::DATASETS;
    use crate::problem::{IoCase, Problem};

    #[test]
    fn slugs_are_url_shaped_and_collapse_punctuation() {
        assert_eq!(slugify("Minimum Number of Pushes!"), "minimum-number-of-pushes");
        assert_eq!(slugify("  Two   Sum  "), "two-sum");
        assert_eq!(slugify("3Sum Closest"), "3sum-closest");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn difficulty_reads_words_and_leetcodes_numeric_encoding() {
        let numeric = serde_json::json!({"difficulty": 2});
        assert_eq!(difficulty(&numeric, &["difficulty"]).as_deref(), Some("Medium"));
        let word = serde_json::json!({"difficulty": "hard"});
        assert_eq!(difficulty(&word, &["difficulty"]).as_deref(), Some("Hard"));
        assert!(difficulty(&serde_json::json!({}), &["difficulty"]).is_none());
    }

    #[test]
    fn structured_cases_render_as_python_the_runner_can_parse() {
        let raw = serde_json::json!({
            "test_cases": [
                {"input": {"nums": [2, 7, 11], "target": 9}, "expected_output": [0, 1]},
                {"input": "s = \"abc\"", "output": "3"},
                {"input": {"flag": true, "note": null}, "expected": "ok"}
            ]
        });
        let cases = io_cases(&raw, &["test_cases"]);
        assert_eq!(cases.len(), 3);
        assert_eq!(cases[0].input, "nums = [2, 7, 11], target = 9");
        assert_eq!(cases[0].output, "[0, 1]");
        // A corpus that already stores source keeps it verbatim.
        assert_eq!(cases[1].input, "s = \"abc\"");
        // Python spellings, not JSON ones — `true`/`null` would not eval.
        assert_eq!(cases[2].input, "flag = True, note = None");
    }

    #[test]
    fn tags_read_arrays_objects_and_bare_strings() {
        assert_eq!(
            tags(&serde_json::json!({"tags": ["Array", "Hash Table"]}), &["tags"]),
            vec!["Array", "Hash Table"]
        );
        assert_eq!(
            tags(
                &serde_json::json!({"topic_tags": [{"name": "Graph"}, {"name": "DFS"}]}),
                &["tags", "topic_tags"]
            ),
            vec!["Graph", "DFS"]
        );
        assert_eq!(
            tags(&serde_json::json!({"tags": "Greedy"}), &["tags"]),
            vec!["Greedy"]
        );
    }

    #[test]
    fn entry_point_prefers_the_solution_method_over_a_helper() {
        let code = "def helper(x):\n    return x\n\nclass Solution:\n    def twoSum(self, nums, target):\n        pass\n";
        assert_eq!(entry_point_from_code(code).as_deref(), Some("twoSum"));
        // A module-level function alone is still usable.
        assert_eq!(
            entry_point_from_code("def max_subarray(nums):\n    pass\n").as_deref(),
            Some("max_subarray")
        );
    }

    #[test]
    fn a_leading_docstring_is_split_off_the_code() {
        let source = "\"\"\"\nGiven a string word…\n\nExample 1:\n\"\"\"\nclass Solution:\n    def minimumPushes(self, word: str) -> int:\n";
        let (doc, code) = split_leading_docstring(source);
        assert!(doc.unwrap().contains("Given a string word"));
        assert!(code.starts_with("class Solution:"));

        // Source with no docstring comes back untouched.
        let (doc, code) = split_leading_docstring("class Solution:\n    pass\n");
        assert!(doc.is_none());
        assert_eq!(code, "class Solution:\n    pass\n");
    }

    #[test]
    fn markdown_fences_split_and_strip() {
        let text = "Intro.\n\n```python\ndef foo():\n    pass\n```\n\nOutro.";
        let (before, code, after) = split_markdown_fence(text).unwrap();
        assert_eq!(before, "Intro.");
        assert!(code.contains("def foo"));
        assert_eq!(after, "Outro.");
        assert_eq!(strip_markdown_fences(text), "Intro.\n\nOutro.");
    }

    #[test]
    fn bare_defs_become_solution_methods_with_typing_imports() {
        let (prompt, body) =
            with_imports_and_solution("def max_beauty(items: List[int], queries: List[int]) -> List[int]");
        assert!(prompt.unwrap().contains("List"));
        assert!(body.contains("class Solution:"));
        assert!(body.contains("def max_beauty(self, items: List[int], queries: List[int]) -> List[int]:"));
        assert!(body.contains("pass"));
        assert!(!body.contains("pass:"));
    }

    #[test]
    fn design_class_method_calls_are_not_rewritten_to_candidate() {
        let suite = asserts_as_check_suite(
            "assert RLEIterator([3, 8]).next(2) == 8\nassert next(3) == 8\n",
            "next",
        );
        assert!(
            suite.contains("RLEIterator([3, 8]).next(2)"),
            "{suite}"
        );
        assert!(!suite.contains(".candidate("), "{suite}");
        assert!(suite.contains("assert candidate(3) == 8"), "{suite}");
    }

    #[test]
    fn chained_type_none_assigns_collapse_to_plain_none() {
        let (_, body) = with_imports_and_solution(
            "class TreeNode:\n    def __init__(self, x: int) -> None:\n        self.left = TreeNode | None = None\n        self.right = TreeNode | None = None\n",
        );
        assert!(body.contains("self.left = None"), "{body}");
        assert!(body.contains("self.right = None"), "{body}");
        assert!(!body.contains("| None = None"), "{body}");
    }

    #[test]
    fn wrapping_a_def_that_already_has_pass_does_not_corrupt_the_signature() {
        let (_, body) = with_imports_and_solution(
            "def max_beauty(items: List[Tuple[int, int]], queries: List[int]) -> List[int]:\n    pass\n",
        );
        assert!(body.contains("def max_beauty(self, items: List[Tuple[int, int]], queries: List[int]) -> List[int]:"));
        assert!(!body.contains("pass:"));
        assert_eq!(body.matches("pass").count(), 1);
    }

    #[test]
    fn jammed_and_uncoloned_stubs_become_parseable_python() {
        let (_, parse) = with_imports_and_solution(
            "def parse(formula: str, i: list[int]) -> Counter, def countOfAtoms(formula: str) -> str",
        );
        assert!(parse.contains("class Solution:"), "{parse}");
        assert!(parse.contains("def parse(self,"), "{parse}");
        assert!(parse.contains("def countOfAtoms(self,"), "{parse}");
        assert!(parse.contains("-> Counter:"), "{parse}");
        assert!(parse.contains("-> str:"), "{parse}");

        let (_, klass) = with_imports_and_solution(
            "class Solution:\n    def findKthLargest(self, nums: List[int], k: int) -> int",
        );
        assert!(
            klass.contains("def findKthLargest(self, nums: List[int], k: int) -> int:"),
            "{klass}"
        );
        assert!(klass.contains("pass"), "{klass}");

        let (_, semi) = with_imports_and_solution(
            "def sign_func(x: int | float) -> int; def array_sign(nums: list[int | float]) -> int",
        );
        assert!(semi.contains("def array_sign(self,"), "{semi}");
        assert_eq!(entry_point_from_asserts("assert array_sign([1, 2, 3]) == 1"), Some("array_sign".into()));
    }

    #[test]
    fn leading_zero_and_true_assignment_cases_are_dropped() {
        let mut problem = Problem {
            task_id: "demo".into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            problem_description: None,
            prompt: None,
            starter_code: None,
            entry_point: None,
            test: None,
            input_output: vec![
                IoCase {
                    input: "nums = [1, 2]".into(),
                    output: "[1, 2]".into(),
                },
                IoCase {
                    input: "07".into(),
                    output: "7".into(),
                },
                IoCase {
                    input: "True = False".into(),
                    output: "True".into(),
                },
                IoCase {
                    input: "s1 = \"ab\", s2 = \"ba\", s2 = \"xx\"".into(),
                    output: "True".into(),
                },
            ],
            estimated_date: None,
        };
        sanitize_io_cases(&mut problem);
        assert_eq!(problem.input_output.len(), 1);
        assert_eq!(problem.input_output[0].input, "nums = [1, 2]");
    }

    #[test]
    fn entry_points_like_solution_dot_method_clean_up() {
        assert_eq!(clean_entry_point("Solution().isValid"), "isValid");
        assert_eq!(clean_entry_point("Solution().isSameAfterReversals()"), "isSameAfterReversals");
        assert_eq!(clean_entry_point("sol.isValid()"), "isValid");
        assert_eq!(clean_entry_point("isValid()"), "isValid");
        assert_eq!(clean_entry_point("twoSum"), "twoSum");
    }

    #[test]
    fn junk_io_cases_are_dropped() {
        let mut problem = Problem {
            task_id: "demo".into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            problem_description: None,
            prompt: None,
            starter_code: None,
            entry_point: None,
            test: None,
            input_output: vec![
                IoCase {
                    input: "nums = [1, 2]".into(),
                    output: "[1, 2, 1, 2]".into(),
                },
                IoCase {
                    input: "s".into(),
                    output: "Error: Solution.foo() missing 1 required positional argument: 'nums'"
                        .into(),
                },
                IoCase {
                    input: "]".into(),
                    output: "[]".into(),
                },
                IoCase {
                    input: "accounts = [[\"Sam\"".into(),
                    output: "[]".into(),
                },
            ],
            estimated_date: None,
        };
        sanitize_io_cases(&mut problem);
        assert_eq!(problem.input_output.len(), 1);
        assert_eq!(problem.input_output[0].input, "nums = [1, 2]");
    }

    #[test]
    fn imports_before_a_def_still_wrap_as_solution() {
        let (prompt, body) = with_imports_and_solution(
            "from collections import OrderedDict\n\ndef sortString(s: str) -> str:",
        );
        assert!(prompt.unwrap().contains("OrderedDict"), "preamble kept");
        assert!(body.contains("class Solution:"), "{body}");
        assert!(body.contains("def sortString"), "{body}");
    }

    /// The invariant an adapter could break by hand, since it constructs
    /// `Problem` field by field rather than going through serde.
    #[test]
    fn no_adapter_can_leak_a_reference_solution() {
        for dataset in DATASETS {
            let mut record = sample_record(dataset.shape);
            let object = record.as_object_mut().expect("sample is an object");
            for field in SOLUTION_FIELDS {
                object.insert(
                    field.to_string(),
                    Value::String("SECRET_REFERENCE_SOLUTION".into()),
                );
            }

            let Some(problem) = normalize(&dataset, &record) else {
                panic!("{} adapter rejected its own sample record", dataset.id);
            };
            let rendered = format!("{problem:?}");
            assert!(
                !rendered.contains("SECRET"),
                "the {} adapter leaked a reference solution",
                dataset.id
            );
        }
    }

    /// One representative record per corpus, shaped like the real download.
    /// Also the fixture the per-adapter tests build on.
    pub(super) fn sample_record(shape: Shape) -> Value {
        match shape {
            Shape::Canonical => serde_json::json!({
                "task_id": "two-sum",
                "question_id": 1,
                "difficulty": "Easy",
                "tags": ["Array"],
                "problem_description": "Find two numbers.",
                "starter_code": "class Solution:\n    def twoSum(self, nums, target):\n",
                "entry_point": "twoSum",
                "input_output": [{"input": "nums = [2,7], target = 9", "output": "[0, 1]"}]
            }),
            Shape::KodCode => kodcode::tests::sample(),
            Shape::MorganStanleyPythonQ => ms_python_q::tests::sample(),
            Shape::DeepSeekLeetCode => deepseek_leetcode::tests::sample(),
            Shape::LeetCodeWithTests => leetcode_with_tests::tests::sample(),
        }
    }
}
