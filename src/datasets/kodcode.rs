//! `KodCode/KodCode-V1` — 447k synthetic question / solution / test triplets.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `question` | `problem_description` |
//! | `test_info` | `entry_point` and a `starter_code` stub |
//! | `test_code` | `test` (a pytest module, run by `run_tests.py --full`) |
//! | `subset`, `style` | `tags` |
//! | `question_id` / `conversation_id` / `id` | `task_id`, `question_id` |
//!
//! `solution` is deliberately **not** read — see [`super::SOLUTION_FIELDS`].
//!
//! KodCode ships no per-case I/O, so a problem imports with zero sample cases
//! and its `test_code` is the whole suite. `run_tests.py` already falls back to
//! the suite when `cases` is empty, and its pytest path binds `solution` in
//! `sys.modules` first, which is exactly what `from solution import …` at the
//! top of a KodCode test needs.

use serde_json::Value;

use super::{entry_point_from_code, skeleton_from_declaration, slug_from_statement, slugify, text};
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
        });

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
    let task_id = match raw_id.as_deref() {
        Some(id) => slugify(id),
        None => slug_from_statement(&question, 8),
    };
    if task_id.is_empty() {
        return None;
    }

    let mut tags = Vec::new();
    for key in ["subset", "style", "source"] {
        if let Some(value) = text(raw, &[key]) {
            tags.push(value);
        }
    }

    Some(Problem {
        task_id,
        question_id: raw_id,
        // KodCode has no difficulty column; its `subset` carries the flavour
        // and is exposed as a tag instead of being guessed at.
        difficulty: None,
        tags,
        problem_description: Some(question),
        prompt: None,
        starter_code,
        entry_point,
        test: text(raw, &["test_code", "test"]),
        input_output: Vec::new(),
        estimated_date: None,
    })
}

/// `test_info` is documented as an object, but the released parquet stores it
/// as a one-element list of objects. Accept both.
fn test_info(raw: &Value) -> Option<Value> {
    match raw.get("test_info")? {
        Value::Array(items) => items.first().cloned(),
        object @ Value::Object(_) => Some(object.clone()),
        _ => None,
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "question_id": "Docs_Combine_45219_I",
            "subset": "Docs",
            "style": "Instruct",
            "question": "Write a function that returns the running maximum of a list.\n\nThe input is a list of integers.",
            "test_code": "from solution import running_max\n\ndef test_running_max():\n    assert running_max([1, 3, 2]) == [1, 3, 3]\n",
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
        assert_eq!(problem.task_id, "docs-combine-45219-i");
        assert_eq!(problem.question_id.as_deref(), Some("Docs_Combine_45219_I"));
        assert_eq!(problem.entry_point.as_deref(), Some("running_max"));
        assert_eq!(problem.tags, vec!["Docs", "Instruct"]);
        assert!(problem
            .problem_description
            .as_deref()
            .unwrap()
            .starts_with("Write a function"));
        // The pytest module is the whole suite for this corpus.
        assert!(problem.test.as_deref().unwrap().contains("def test_running_max"));
        assert!(problem.input_output.is_empty(), "KodCode ships no per-case I/O");
        // And the editor gets something to type into.
        assert_eq!(
            problem.starter_code.as_deref(),
            Some("def running_max(values):\n    pass\n")
        );
    }

    #[test]
    fn test_info_may_arrive_as_an_object_instead_of_a_list() {
        let mut record = sample();
        let info = record["test_info"][0].clone();
        record["test_info"] = info;
        let problem = normalize(&record).expect("object form imports");
        assert_eq!(problem.entry_point.as_deref(), Some("running_max"));
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
