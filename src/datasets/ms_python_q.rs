//! `morganstanley/sft-python-q-problems` — LeetCode-style problems with both a
//! Python and a Q solution, plus structured test cases.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `problem_name` / `problem_id` | `task_id` |
//! | `leetcode_id` | `question_id` |
//! | `difficulty`, `tags` | `difficulty`, `tags` |
//! | `problem_description` | `problem_description` |
//! | `test_cases` | `input_output` |
//! | `metadata.entry_point` / `metadata.starter_code` | `entry_point`, `starter_code` |
//!
//! `python_solution` and `q_solution` are deliberately **not** read — they are
//! complete answers, and this corpus is the one where forgetting that would be
//! easiest.
//!
//! ## Why the cases column was empty
//!
//! `test_cases` is a nested column, and a parquet conversion stores those
//! either as a structure or as a *string* holding the same JSON. Only the first
//! spelling used to be read, so the corpus imported with zero sample cases even
//! though it ships them. `io_cases` now reads both, and also accepts a list of
//! bare `assert f(…) == …` lines, which is the third shape these dumps use.

use serde_json::Value;

use super::{
    cases_from_asserts, difficulty, entry_point_from_code, io_cases, nested_text, slugify,
    tags, text,
};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let name = text(raw, &["problem_name", "name", "title", "problem_id", "id"])?;
    let task_id = slugify(&name);
    if task_id.is_empty() {
        return None;
    }

    let starter_code = nested_text(raw, "metadata", &["starter_code", "template", "stub"])
        .or_else(|| text(raw, &["starter_code", "python_template"]));
    let entry_point = nested_text(raw, "metadata", &["entry_point", "function_name", "fn_name"])
        .or_else(|| text(raw, &["entry_point", "function_name"]))
        .or_else(|| starter_code.as_deref().and_then(entry_point_from_code));

    let test = text(raw, &["test", "test_code", "python_test", "unit_test"]);
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
        // A suite instead of a case list: its asserts are the cases, written as
        // source. Same treatment as KodCode.
        input_output = test
            .as_deref()
            .map(|suite| cases_from_asserts(suite, entry_point.as_deref()))
            .unwrap_or_default();
    }

    Some(Problem {
        task_id,
        question_id: text(raw, &["leetcode_id", "question_id", "problem_id"]),
        difficulty: difficulty(raw, &["difficulty"]),
        tags: tags(raw, &["tags", "topics", "categories"]),
        problem_description: text(
            raw,
            &["problem_description", "description", "problem", "question"],
        ),
        prompt: None,
        starter_code,
        entry_point,
        test,
        input_output,
        estimated_date: None,
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "problem_id": "0001",
            "problem_name": "Two Sum",
            "leetcode_id": 1,
            "difficulty": "Easy",
            "tags": ["Array", "Hash Table"],
            "problem_description": "Return indices of the two numbers adding to target.",
            "test_cases": [
                {"input": {"nums": [2, 7, 11, 15], "target": 9}, "expected_output": [0, 1]},
                {"input": {"nums": [3, 3], "target": 6}, "expected_output": [0, 1]}
            ],
            "metadata": {
                "entry_point": "two_sum",
                "starter_code": "def two_sum(nums, target):\n    pass\n"
            }
        })
    }

    #[test]
    fn maps_the_documented_columns() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(problem.task_id, "two-sum");
        assert_eq!(problem.question_id.as_deref(), Some("1"));
        assert_eq!(problem.difficulty.as_deref(), Some("Easy"));
        assert_eq!(problem.tags, vec!["Array", "Hash Table"]);
        assert_eq!(problem.entry_point.as_deref(), Some("two_sum"));
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[0].input, "nums = [2, 7, 11, 15], target = 9");
        assert_eq!(problem.input_output[0].output, "[0, 1]");
    }

    /// Without `metadata.entry_point` the runner has to work the name out of
    /// the stub, or `run_tests.py` cannot find anything to call.
    #[test]
    fn the_entry_point_falls_back_to_the_starter_signature() {
        let mut record = sample();
        record["metadata"] = serde_json::json!({
            "starter_code": "class Solution:\n    def twoSum(self, nums, target):\n        pass\n"
        });
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.entry_point.as_deref(), Some("twoSum"));
    }

    /// The reason this corpus imported with an empty cases column: its nested
    /// column came through as a string, and only the structured spelling was
    /// being read.
    #[test]
    fn test_cases_stored_as_a_json_string_still_import() {
        let mut record = sample();
        let cases = record["test_cases"].clone();
        record["test_cases"] = serde_json::json!(serde_json::to_string(&cases).unwrap());
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[0].input, "nums = [2, 7, 11, 15], target = 9");
    }

    /// A dump that ships a suite rather than a case list still gets samples.
    #[test]
    fn a_suite_without_cases_contributes_its_literal_asserts() {
        let mut record = sample();
        record.as_object_mut().unwrap().remove("test_cases");
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
