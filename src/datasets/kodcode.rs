//! `KodCode/KodCode-V1` — 447k synthetic question / solution / test triplets.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `question` | `problem_description` (Complete: docstring extracted) |
//! | `test_info` | `entry_point` and a `starter_code` stub |
//! | `test` / `test_code` | `test`, and the sample cases read off its asserts |
//! | `gpt_difficulty` | `difficulty` |
//! | `subset`, `style` | `tags` |
//! | `question_id` / `conversation_id` / `id` | `question_id`, and part of `task_id` |
//!
//! `solution` is deliberately **not** read — see [`super::SOLUTION_FIELDS`].
//!
//! ## What its columns mean, since they are not LeetCode's
//!
//! KodCode is *synthetic*: every problem was generated from a seed, then kept
//! only if a model could solve it against its own tests. So it has no question
//! numbers, no titles and no topic tags, and the two columns it does have in
//! their place are worth spelling out, because they end up in the tag filter:
//!
//! - **`subset`** — which seed the problem was grown from: `Algorithm`,
//!   `Data_Structure`, `Leetcode`, `Codeforces`, `Apps`, `Taco`, `Docs`
//!   (library documentation), `Package`, `Filter`, `Prefill`, `Evol`. It is
//!   the closest thing the corpus has to a topic.
//! - **`style`** — how the question is phrased:
//!   - `Complete` — a function signature + docstring to finish (**indexed**).
//!   - `Instruct` — the same seed as prose (skipped — duplicate work).
//!   - `online_judge` — stdin/stdout I/O problems whose tests are not pytest
//!     asserts (skipped — they do not fit `run_tests.py`).
//!
//! `subset` is exposed as a tag (`Algorithm`, `Docs`, …), and `gpt_difficulty`
//! — the corpus's own easy / medium / hard rating — fills the difficulty column
//! that used to be blank.
//!
//! ## Naming
//!
//! `question_id` is a compound like `Algorithm_1_C`, which slugged to
//! `algorithm-1-c` and displayed as "Algorithm 1 C" — a name that says nothing
//! about the problem. The slug is built from the function under test instead
//! (`running_max` → `running-max-45219-c`), keeping the id's number and style
//! letter so seeds stay unique. The number is also reported on its own as the
//! question number, so the q# column sorts.

use serde_json::Value;

use super::{
    as_markdown, cases_from_asserts, container_value, difficulty, docstring_inside_def,
    entry_point_from_code, skeleton_from_declaration, slug_from_statement, slugify,
    strip_markdown_fences, text,
};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let question = text(raw, &["question", "problem", "prompt"])?;

    let style = text(raw, &["style"]);
    let style_l = style.as_deref().map(str::trim).map(|s| s.to_ascii_lowercase());
    // Instruct duplicates Complete as prose. online_judge ships stdin/stdout
    // tests the runner cannot execute — drop both.
    if matches!(
        style_l.as_deref(),
        Some("instruct") | Some("online_judge") | Some("online-judge")
    ) {
        return None;
    }
    // Also catch ids like `Apps_10003_OJ` when style is missing/odd.
    let raw_id_early = text(
        raw,
        &["question_id", "conversation_id", "id", "problem_id", "uuid"],
    );
    if style_letter(style.as_deref(), raw_id_early.as_deref()) == Some('i') {
        return None;
    }
    if raw_id_early
        .as_deref()
        .is_some_and(|id| id.rsplit('_').next() == Some("OJ"))
    {
        return None;
    }

    let info = test_info(raw);
    let entry_point = info
        .as_ref()
        .and_then(|info| text(info, &["function_name", "fn_name", "entry_point"]))
        .or_else(|| {
            info.as_ref()
                .and_then(|info| text(info, &["function_declaration", "declaration"]))
                .as_deref()
                .and_then(entry_point_from_code)
        })
        .or_else(|| text(raw, &["test_entry_point", "entry_point"]));

    let starter_raw = info
        .as_ref()
        .and_then(|info| text(info, &["function_declaration", "declaration", "signature"]))
        .as_deref()
        .and_then(skeleton_from_declaration)
        .or_else(|| {
            entry_point
                .as_deref()
                .map(|name| format!("def {name}():\n    pass\n"))
        });
    // Keep a module-level `def` — KodCode's pytest suites do
    // `from solution import foo`, not `Solution().foo`.
    let prompt = starter_raw
        .as_deref()
        .and_then(super::typing_imports_for)
        .or_else(|| super::typing_imports_for(&question));
    let starter_code = starter_raw;

    let raw_id = raw_id_early;
    let number = raw_id.as_deref().and_then(id_number);
    let task_id = task_id(
        &question,
        entry_point.as_deref(),
        raw_id.as_deref(),
        number,
        style.as_deref(),
    );
    if task_id.is_empty() {
        return None;
    }

    let mut tags = Vec::new();
    for key in ["subset", "style", "source"] {
        if let Some(value) = text(raw, &[key]) {
            tags.push(value);
        }
    }

    let suite = text(raw, &["test_code", "test"]);
    // Skip stdin/stdout suites if any slip through (online_judge shape).
    let suite = suite.filter(|s| {
        let t = s.trim_start();
        !(t.starts_with('{') && t.contains("stdin"))
    });
    let input_output = suite
        .as_deref()
        .map(|source| cases_from_asserts(source, entry_point.as_deref()))
        .unwrap_or_default();
    // Pytest suites do `from solution import TreeNode, foo`. test_info only
    // names one `def`; the rest become ImportError (audit missing-module).
    let starter_code = match (starter_code, suite.as_deref()) {
        (Some(s), Some(test)) => Some(ensure_imported_stubs(&s, test)),
        (s, _) => s,
    };

    // Complete rows put the statement in the function docstring; Instruct (skipped)
    // is prose; anything else may already be markdown with fences.
    let description = if let Some(doc) = docstring_inside_def(&question) {
        as_markdown(&strip_doctest_arrows(&doc))
    } else {
        as_markdown(&strip_markdown_fences(&question))
    };

    Some(Problem {
        task_id,
        question_id: number.map(|n| n.to_string()).or(raw_id),
        difficulty: difficulty(raw, &["gpt_difficulty", "difficulty", "4o_difficulty"])
            .or_else(|| {
                container_value(raw, "metadata")
                    .and_then(|meta| difficulty(&meta, &["difficulty", "gpt_difficulty"]))
            }),
        tags,
        problem_description: Some(description),
        prompt,
        starter_code,
        entry_point,
        test: suite,
        input_output,
        estimated_date: None,
    })
}

/// Turn doctest `>>> expr` lines into markdown code fences for readability.
fn strip_doctest_arrows(doc: &str) -> String {
    let mut out = String::new();
    let mut in_examples = false;
    for line in doc.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix(">>> ") {
            if !in_examples {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str("```python\n");
                in_examples = true;
            }
            out.push_str(rest);
            out.push('\n');
            continue;
        }
        if in_examples {
            out.push_str("```\n\n");
            in_examples = false;
        }
        out.push_str(line);
        out.push('\n');
    }
    if in_examples {
        out.push_str("```\n");
    }
    out.trim().to_string()
}

/// A readable, unique slug: what the problem is, then the seed number, then
/// the style letter that tells the two phrasings of one seed apart.
///
/// `running-max-45219-i` rather than `docs-combine-45219-i`. The number and the
/// letter are both load-bearing: the corpus ships most seeds twice (`…_C` and
/// `…_I`) and dropping either would make two problems share a primary key.
fn task_id(
    question: &str,
    entry_point: Option<&str>,
    raw_id: Option<&str>,
    number: Option<u64>,
    style: Option<&str>,
) -> String {
    let name = entry_point
        .map(slugify)
        .filter(|slug| !slug.is_empty())
        .unwrap_or_else(|| slug_from_statement(question, 8));
    if name.is_empty() {
        return raw_id.map(slugify).unwrap_or_default();
    }
    let mut slug = match number {
        Some(number) => format!("{name}-{number}"),
        // No number to disambiguate with: the importer's de-duplicator adds a
        // `-2` suffix if two rows land on the same name.
        None => name,
    };
    if let Some(letter) = style_letter(style, raw_id) {
        slug.push('-');
        slug.push(letter);
    }
    slug
}

/// `c` for Complete, `i` for Instruct — from the `style` column, or from the
/// trailing token of ids like `Docs_Combine_45219_I`.
fn style_letter(style: Option<&str>, raw_id: Option<&str>) -> Option<char> {
    if let Some(style) = style.map(str::trim).filter(|s| !s.is_empty()) {
        return style.chars().next().map(|c| c.to_ascii_lowercase());
    }
    let tail = raw_id?.rsplit('_').next()?;
    if tail.len() == 1 && tail.chars().all(|c| c.is_ascii_alphabetic()) {
        return tail.chars().next().map(|c| c.to_ascii_lowercase());
    }
    None
}

/// The number inside `Algorithm_1_C` / `Docs_Combine_45219_I`.
fn id_number(raw: &str) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut digits = String::new();
    for ch in raw.chars().chain(std::iter::once('_')) {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if !digits.is_empty() {
            if let Ok(value) = digits.parse::<u64>() {
                best = Some(value);
            }
            digits.clear();
        }
    }
    best
}

const LIST_NODE_STUB: &str = "\
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next
";

const TREE_NODE_STUB: &str = "\
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
";

const NODE_STUB: &str = "\
class Node:
    def __init__(self, val=0, left=None, right=None, next=None, neighbors=None, *args, **kwargs):
        self.val = val
        self.left = left
        self.right = right
        self.next = next
        self.neighbors = neighbors
";

/// Names `from solution import …` asks for, then stub any that the starter
/// does not already define so the suite can import.
fn ensure_imported_stubs(starter: &str, suite: &str) -> String {
    let mut extra = String::new();
    for name in solution_imported_names(suite) {
        if name_defined(starter, &name) || name_defined(&extra, &name) {
            continue;
        }
        extra.push_str(&stub_for_imported_name(&name));
        if !extra.ends_with('\n') {
            extra.push('\n');
        }
        extra.push('\n');
    }
    if extra.is_empty() {
        starter.to_string()
    } else {
        format!("{extra}{starter}")
    }
}

fn solution_imported_names(suite: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = String::new();
    let mut in_paren = false;
    for line in suite.lines() {
        let trimmed = line.trim();
        let trimmed = trimmed.split('#').next().unwrap_or(trimmed).trim();
        if in_paren {
            pending.push(' ');
            pending.push_str(trimmed);
            if trimmed.contains(')') {
                in_paren = false;
                parse_import_list(&pending, &mut names);
                pending.clear();
            }
            continue;
        }
        let Some(at) = trimmed
            .to_ascii_lowercase()
            .find("from solution import")
        else {
            continue;
        };
        let after = trimmed[at + "from solution import".len()..].trim();
        if after.starts_with('(') || after.ends_with(',') || after.ends_with('\\') {
            pending = after.trim_start_matches('(').trim_end_matches('\\').to_string();
            in_paren = !after.contains(')');
            if !in_paren {
                parse_import_list(&pending, &mut names);
                pending.clear();
            }
        } else {
            parse_import_list(after, &mut names);
        }
    }
    names.sort();
    names.dedup();
    names
}

fn parse_import_list(chunk: &str, names: &mut Vec<String>) {
    let cleaned = chunk.replace('\\', " ").replace('(', " ").replace(')', " ");
    for part in cleaned.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "*" {
            continue;
        }
        let imported = part
            .split_once(" as ")
            .map(|(orig, _)| orig.trim())
            .unwrap_or(part);
        if is_python_ident(imported) {
            names.push(imported.to_string());
        }
    }
}

fn is_python_ident(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn name_defined(src: &str, name: &str) -> bool {
    let def = format!("def {name}(");
    let class_space = format!("class {name} ");
    let class_colon = format!("class {name}:");
    let class_paren = format!("class {name}(");
    src.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with(&def)
            || t.starts_with(&class_colon)
            || t.starts_with(&class_paren)
            || t.starts_with(&class_space)
    })
}

fn stub_for_imported_name(name: &str) -> String {
    match name {
        "ListNode" => LIST_NODE_STUB.to_string(),
        "TreeNode" => TREE_NODE_STUB.to_string(),
        "Node" => NODE_STUB.to_string(),
        n if n.starts_with(|c: char| c.is_ascii_uppercase()) => {
            format!("class {n}:\n    def __init__(self, *args, **kwargs):\n        pass\n")
        }
        n => format!("def {n}(*args, **kwargs):\n    pass\n"),
    }
}

/// `test_info` is documented as an object, but the released parquet stores it
/// as a one-element list of objects — and a JSON string in some conversions.
fn test_info(raw: &Value) -> Option<Value> {
    match container_value(raw, "test_info")? {
        Value::Array(items) => items.first().cloned(),
        object @ Value::Object(_) => Some(object),
        _ => None,
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "question_id": "Docs_Combine_45219_C",
            "subset": "Docs",
            "style": "Complete",
            "gpt_difficulty": "medium",
            "question": "Write a function that returns the running maximum of a list.\n\nThe input is a list of integers.",
            "test_code": "from solution import running_max\n\ndef test_running_max():\n    assert running_max([1, 3, 2]) == [1, 3, 3]\n\ndef test_empty():\n    assert running_max([]) == []\n",
            "test_info": [{
                "function_name": "running_max",
                "parameter_list": "(values)",
                "function_declaration": "def running_max(values):",
                "docstring": "Return the running maximum."
            }],
            "gpt_pass_percentage": 1.0
        })
    }

    #[test]
    fn maps_the_documented_columns() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(problem.entry_point.as_deref(), Some("running_max"));
        assert_eq!(problem.tags, vec!["Docs", "Complete"]);
        assert!(problem
            .problem_description
            .as_deref()
            .unwrap()
            .starts_with("Write a function"));
        assert!(problem.test.as_deref().unwrap().contains("def test_running_max"));
        assert_eq!(
            problem.starter_code.as_deref(),
            Some("def running_max(values):\n    pass\n")
        );
    }

    /// The browser's columns: a name that says what the problem is, a question
    /// number that sorts, and the corpus's own difficulty rating.
    #[test]
    fn the_browser_columns_are_filled_in() {
        let problem = normalize(&sample()).expect("imports");
        assert_eq!(problem.task_id, "running-max-45219-c");
        assert_eq!(problem.question_id.as_deref(), Some("45219"));
        assert_eq!(problem.difficulty.as_deref(), Some("Medium"));
    }

    /// Instruct is the same seed as prose — skip it so the index stays half the size.
    #[test]
    fn instruct_rows_are_skipped() {
        let mut instruct = sample();
        instruct["question_id"] = serde_json::json!("Docs_Combine_45219_I");
        instruct["style"] = serde_json::json!("Instruct");
        assert!(normalize(&instruct).is_none());
        assert!(normalize(&sample()).is_some());
    }

    /// online_judge rows use stdin/stdout fixtures the runner cannot execute.
    #[test]
    fn online_judge_rows_are_skipped() {
        let mut oj = sample();
        oj["style"] = serde_json::json!("online_judge");
        oj["question_id"] = serde_json::json!("Apps_10003_OJ");
        oj["test"] = serde_json::json!({"stdin": ["1"], "stdout": ["True"]});
        assert!(normalize(&oj).is_none());
    }

    #[test]
    fn complete_docstring_becomes_the_markdown_description() {
        let mut complete = sample();
        complete["question"] = serde_json::json!(
            "def running_max(values: List[int]) -> List[int]:\n    \"\"\"Return the running maximum of a list.\n\n    >>> running_max([1, 3, 2]) == [1, 3, 3]\n    \"\"\"\n"
        );
        let problem = normalize(&complete).expect("imports");
        let desc = problem.problem_description.as_deref().unwrap();
        assert!(desc.contains("running maximum"), "{desc}");
        assert!(!desc.trim_start().starts_with("def "), "{desc}");
        assert!(desc.contains("```python"), "{desc}");
        assert_eq!(
            problem.starter_code.as_deref(),
            Some("def running_max(values):\n    pass\n")
        );
    }

    /// The suite *is* the case list; it was just written as source.
    #[test]
    fn sample_cases_are_read_off_the_asserts() {
        let problem = normalize(&sample()).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[0].input, "[1, 3, 2]");
        assert_eq!(problem.input_output[0].output, "[1, 3, 3]");
        assert_eq!(problem.input_output[1].input, "[]");
    }

    #[test]
    fn imported_helpers_are_stubbed_on_the_starter() {
        let mut record = sample();
        record["test_code"] = serde_json::json!(
            "from solution import running_max, TreeNode, helper_sum\n\ndef test_x():\n    assert running_max([1]) == [1]\n"
        );
        let problem = normalize(&record).expect("imports");
        let starter = problem.starter_code.as_deref().unwrap();
        assert!(starter.contains("def running_max(values):"), "{starter}");
        assert!(starter.contains("class TreeNode:"), "{starter}");
        assert!(starter.contains("def helper_sum("), "{starter}");
    }

    #[test]
    fn imported_names_ignore_trailing_comments() {
        let mut record = sample();
        record["test_code"] = serde_json::json!(
            "from solution import count_islands  # helper\n\ndef test_x():\n    assert True\n"
        );
        let problem = normalize(&record).expect("imports");
        let starter = problem.starter_code.as_deref().unwrap();
        assert!(starter.contains("def count_islands("), "{starter}");
    }

    /// An assert built from a fixture would not survive `ast.literal_eval`, so
    /// it is left to the full suite rather than shown as a broken sample.
    #[test]
    fn only_literal_asserts_become_cases() {
        let mut record = sample();
        record["test_code"] = serde_json::json!(
            "def test_x():\n    data = build()\n    assert running_max(data) == expected\n    assert running_max([2]) == [2]\n"
        );
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.input_output.len(), 1);
        assert_eq!(problem.input_output[0].input, "[2]");
    }

    #[test]
    fn test_info_may_arrive_as_an_object_or_a_json_string() {
        let mut record = sample();
        let info = record["test_info"][0].clone();
        record["test_info"] = info.clone();
        assert_eq!(
            normalize(&record).unwrap().entry_point.as_deref(),
            Some("running_max")
        );

        let mut stringified = sample();
        stringified["test_info"] = serde_json::json!(serde_json::to_string(&info).unwrap());
        assert_eq!(
            normalize(&stringified).unwrap().entry_point.as_deref(),
            Some("running_max")
        );
    }

    #[test]
    fn a_row_with_no_statement_is_dropped_rather_than_indexed_blank() {
        assert!(normalize(&serde_json::json!({"question_id": "x"})).is_none());
    }

    /// Rows identified only by an opaque uuid still need a readable slug.
    #[test]
    fn an_unidentified_row_is_slugged_from_its_first_line() {
        let record = serde_json::json!({
            "question": "Reverse a linked list in place.\n\nDetails follow."
        });
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.task_id, "reverse-a-linked-list-in-place");
    }
}
