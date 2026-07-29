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

use serde_json::Value;

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
    match dataset.shape {
        Shape::Canonical => serde_json::from_value(raw.clone()).ok(),
        Shape::KodCode => kodcode::normalize(raw),
        Shape::MorganStanleyPythonQ => ms_python_q::normalize(raw),
        Shape::DeepSeekLeetCode => deepseek_leetcode::normalize(raw),
        Shape::LeetCodeWithTests => leetcode_with_tests::normalize(raw),
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
    let imports = typing_imports_for(trimmed);
    let body = if trimmed.starts_with("def ") {
        wrap_def_as_solution_method(trimmed).unwrap_or_else(|| ensure_pass_bodies(trimmed))
    } else {
        ensure_pass_bodies(trimmed)
    };
    let prompt = imports.filter(|imp| !body.contains(imp.as_str()));
    (prompt, body)
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
        for prefix in [
            format!("{entry_point}("),
            format!("Solution().{entry_point}("),
            format!("sol.{entry_point}("),
        ] {
            if let Some(rest) = rewritten.strip_prefix(&format!("assert {prefix}")) {
                rewritten = format!("assert candidate({rest}");
                break;
            }
            if rewritten.contains(&prefix) {
                rewritten = rewritten.replace(&prefix, "candidate(");
            }
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

/// Clean an entry point that arrived as `Solution().isValid` / `sol.foo`.
pub(crate) fn clean_entry_point(raw: &str) -> String {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix("Solution().") {
        return rest.trim().to_string();
    }
    if let Some((_, method)) = s.rsplit_once('.') {
        let method = method.trim();
        if !method.is_empty()
            && method
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return method.to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::DATASETS;

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
    fn wrapping_a_def_that_already_has_pass_does_not_corrupt_the_signature() {
        let (_, body) = with_imports_and_solution(
            "def max_beauty(items: List[Tuple[int, int]], queries: List[int]) -> List[int]:\n    pass\n",
        );
        assert!(body.contains("def max_beauty(self, items: List[Tuple[int, int]], queries: List[int]) -> List[int]:"));
        assert!(!body.contains("pass:"));
        assert_eq!(body.matches("pass").count(), 1);
    }

    #[test]
    fn entry_points_like_solution_dot_method_clean_up() {
        assert_eq!(clean_entry_point("Solution().isValid"), "isValid");
        assert_eq!(clean_entry_point("twoSum"), "twoSum");
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
