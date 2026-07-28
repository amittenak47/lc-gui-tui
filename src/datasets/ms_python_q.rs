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

use serde_json::Value;

use super::{
    difficulty, entry_point_from_code, io_cases, nested_text, slugify, tags, text,
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
        test: text(raw, &["test", "test_code"]),
        input_output: io_cases(raw, &["test_cases", "input_output", "tests", "examples"]),
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

    #[test]
    fn a_row_with_no_name_is_dropped() {
        assert!(normalize(&serde_json::json!({"difficulty": "Easy"})).is_none());
    }
}
