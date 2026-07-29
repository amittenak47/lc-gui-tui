//! `KodCode/KodCode-V1` — 447k synthetic question / solution / test triplets.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `question` | `problem_description` |
//! | `test_info` | `entry_point` and a `starter_code` stub |
//! | `test_code` | `test`, and the sample cases read off its asserts |
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
//! - **`style`** — how the question is phrased. `Instruct` is a natural-language
//!   problem statement; `Complete` gives you a function to finish. The same
//!   seed usually appears in both styles (`…_I` / `…_C`). **Only `Complete`
//!   is indexed** — Instruct duplicates the same seed as prose and roughly
//!   doubles the set without adding new work.
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
//! (`running_max` → `running-max-45219-i`), keeping the id's number and style
//! letter so the two phrasings of one seed stay two problems. The number is
//! also reported on its own as the question number, so the q# column sorts.

use serde_json::Value;

use super::{
    cases_from_asserts, container_value, difficulty, entry_point_from_code,
    skeleton_from_declaration, slug_from_statement, slugify, text,
};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let question = text(raw, &["question", "problem", "prompt"])?;

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

    let starter_code = info
        .as_ref()
        .and_then(|info| text(info, &["function_declaration", "declaration", "signature"]))
        .as_deref()
        .and_then(skeleton_from_declaration)
        .or_else(|| {
            entry_point
                .as_deref()
                .map(|name| format!("def {name}():\n    pass\n"))
        });

    let raw_id = text(
        raw,
        &["question_id", "conversation_id", "id", "problem_id", "uuid"],
    );
    let number = raw_id.as_deref().and_then(id_number);
    let style = text(raw, &["style"]);
    // Instruct and Complete are the same seed twice — keep Complete only.
    if style_letter(style.as_deref(), raw_id.as_deref()) == Some('i') {
        return None;
    }
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
    // KodCode ships no per-case I/O, but its asserts are per-case I/O written
    // as source. Reading them gives the browser a real `cases` count and the
    // runner something to report case by case; `--full` still runs the module.
    let input_output = suite
        .as_deref()
        .map(|source| cases_from_asserts(source, entry_point.as_deref()))
        .unwrap_or_default();

    Some(Problem {
        task_id,
        // The number alone, so `sort: q#` (which casts to integer) orders the
        // corpus instead of collapsing every row to 0.
        question_id: number.map(|n| n.to_string()).or(raw_id),
        difficulty: difficulty(raw, &["gpt_difficulty", "difficulty", "4o_difficulty"])
            .or_else(|| {
                container_value(raw, "metadata")
                    .and_then(|meta| difficulty(&meta, &["difficulty", "gpt_difficulty"]))
            }),
        tags,
        problem_description: Some(question),
        prompt: None,
        starter_code,
        entry_point,
        test: suite,
        input_output,
        estimated_date: None,
    })
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

    /// The suite *is* the case list; it was just written as source.
    #[test]
    fn sample_cases_are_read_off_the_asserts() {
        let problem = normalize(&sample()).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[0].input, "[1, 3, 2]");
        assert_eq!(problem.input_output[0].output, "[1, 3, 3]");
        assert_eq!(problem.input_output[1].input, "[]");
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
