//! `morganstanley/sft-python-q-problems` — LeetCode-style problems with both a
//! Python and a Q solution, plus structured test cases.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `problem_id` / `problem_name` | `task_id` |
//! | `leetcode_id` | `question_id` |
//! | `difficulty`, `tags` | `difficulty`, `tags` |
//! | `problem_description` | statement (```python stub + Q note stripped) |
//! | `test_cases` / `metadata.input_output` | `input_output` |
//! | `metadata.entry_point` / `metadata.starter_code` | `entry_point`, starter |
//! | `metadata.test` | `test` |
//!
//! `python_solution` and `q_solution` are deliberately **not** read — they are
//! complete answers.

use serde_json::Value;

use super::{
    as_markdown, cases_from_asserts, clean_entry_point, difficulty, entry_point_from_code,
    io_cases, nested_text, slugify, strip_markdown_fences, tags, text, with_imports_and_solution,
};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let name = text(raw, &["problem_name", "name", "title"])
        .filter(|s| !s.trim().is_empty())
        .or_else(|| text(raw, &["problem_id", "id"]))?;
    let task_id = slugify(&name);
    if task_id.is_empty() {
        return None;
    }

    let meta = super::container_value(raw, "metadata");

    let starter_raw = nested_text(raw, "metadata", &["starter_code", "template", "stub"])
        .or_else(|| text(raw, &["starter_code", "python_template"]))
        .or_else(|| {
            // Description often ends with the same stub inside a fence.
            text(
                raw,
                &["problem_description", "description", "problem", "question"],
            )
            .and_then(|d| super::split_markdown_fence(&d).map(|(_, code, _)| code))
        });

    let entry_point = nested_text(raw, "metadata", &["entry_point", "function_name", "fn_name"])
        .or_else(|| text(raw, &["entry_point", "function_name"]))
        .map(|e| clean_entry_point(&e))
        .or_else(|| starter_raw.as_deref().and_then(entry_point_from_code));

    let (prompt, starter_code) = match starter_raw {
        Some(s) => {
            let (p, body) = with_imports_and_solution(&s);
            (p, Some(body))
        }
        None => (None, None),
    };

    let test = text(raw, &["test", "test_code", "python_test", "unit_test"]).or_else(|| {
        meta.as_ref()
            .and_then(|m| text(m, &["test", "test_code"]))
    });

    let mut input_output = io_cases(
        raw,
        &[
            "test_cases",
            "input_output",
            "tests",
            "examples",
            "python_test_cases",
            "sample_cases",
        ],
    );
    if input_output.is_empty() {
        if let Some(meta) = meta.as_ref() {
            input_output = io_cases(meta, &["input_output", "test_cases", "tests"]);
        }
    }
    if input_output.is_empty() {
        input_output = test
            .as_deref()
            .map(|suite| cases_from_asserts(suite, entry_point.as_deref()))
            .unwrap_or_default();
    }

    let description = text(
        raw,
        &["problem_description", "description", "problem", "question"],
    )
    .map(|d| as_markdown(&strip_markdown_fences(&d)));

    Some(Problem {
        task_id,
        question_id: text(raw, &["leetcode_id", "question_id", "problem_id"]),
        difficulty: difficulty(raw, &["difficulty"]),
        tags: tags(raw, &["tags", "topics", "categories"]),
        problem_description: description,
        prompt,
        starter_code,
        entry_point,
        test,
        input_output,
        estimated_date: nested_text(raw, "metadata", &["estimated_date", "date"]),
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "problem_id": "check-if-word-is-valid-after-substitutions",
            "problem_name": "",
            "leetcode_id": 1003,
            "difficulty": "Medium",
            "tags": ["Stack", "String"],
            "problem_description": "### Question:\nGiven a string s, determine if it is valid.\n\nYou will use the following starter code to write the solution to the problem and enclose your code within delimiters.\n```python\ndef solve(s: str) -> bool:\n        \n```\n\nNOTE: This problem is described for Python, but your task is to implement it in Q programming language.",
            "test_cases": [
                {"input": {"s": "aaabbbccc"}, "expected_output": false},
                {"input": {"s": "abc"}, "expected_output": true}
            ],
            "metadata": {
                "entry_point": "Solution().isValid",
                "starter_code": "class Solution:\n    def isValid(self, s: str) -> bool:\n        ",
                "test": "def check(candidate):\n    assert candidate(\"abc\") is True\n"
            }
        })
    }

    #[test]
    fn maps_the_documented_columns() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(
            problem.task_id,
            "check-if-word-is-valid-after-substitutions"
        );
        assert_eq!(problem.question_id.as_deref(), Some("1003"));
        assert_eq!(problem.difficulty.as_deref(), Some("Medium"));
        assert_eq!(problem.tags, vec!["Stack", "String"]);
        assert_eq!(problem.entry_point.as_deref(), Some("isValid"));
        assert_eq!(problem.input_output.len(), 2);
    }

    #[test]
    fn strips_the_python_fence_and_q_note_from_the_description() {
        let problem = normalize(&sample()).expect("imports");
        let desc = problem.problem_description.as_deref().unwrap();
        assert!(desc.contains("determine if it is valid"));
        assert!(!desc.contains("```"));
        assert!(!desc.contains("Q programming"));
        assert!(!desc.contains("starter code"));
    }

    #[test]
    fn starter_keeps_class_solution_with_pass() {
        let problem = normalize(&sample()).expect("imports");
        let starter = problem.starter_code.as_deref().unwrap();
        assert!(starter.contains("class Solution:"), "{starter}");
        assert!(starter.contains("def isValid"), "{starter}");
        assert!(starter.contains("pass"), "{starter}");
    }

    #[test]
    fn the_entry_point_falls_back_to_the_starter_signature() {
        let mut record = sample();
        record["metadata"] = serde_json::json!({
            "starter_code": "class Solution:\n    def twoSum(self, nums, target):\n        pass\n"
        });
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.entry_point.as_deref(), Some("twoSum"));
    }

    #[test]
    fn test_cases_stored_as_a_json_string_still_import() {
        let mut record = sample();
        let cases = record["test_cases"].clone();
        record["test_cases"] = serde_json::json!(serde_json::to_string(&cases).unwrap());
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
    }

    #[test]
    fn a_suite_without_cases_contributes_its_literal_asserts() {
        let mut record = sample();
        record.as_object_mut().unwrap().remove("test_cases");
        record["metadata"] = serde_json::json!({
            "entry_point": "two_sum",
            "starter_code": "def two_sum(nums, target):\n    pass\n"
        });
        record["test"] = serde_json::json!(
            "def test_two_sum():\n    assert two_sum([2, 7], 9) == [0, 1]\n    assert two_sum([3, 3], 6) == [0, 1]\n"
        );
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[0].input, "[2, 7], 9");
        assert_eq!(problem.input_output[0].output, "[0, 1]");
    }

    #[test]
    fn a_row_with_no_name_is_dropped() {
        assert!(normalize(&serde_json::json!({"difficulty": "Easy"})).is_none());
    }
}
