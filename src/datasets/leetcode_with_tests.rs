//! `kr4t0n/leetcode-with-tests` — LeetCode problems paired with test code.
//!
//! This adapter is deliberately the tolerant one. The corpus is a community
//! re-packaging of LeetCode data, and re-packagings of the same source disagree
//! on spelling far more than they disagree on content: the statement is
//! `content` or `question_content` or `problem_description`, the stub is
//! `python3` or `starter_code` or `code_template`, the id is `title_slug` or
//! `titleSlug` or `slug`. So every field is read through a candidate list, and
//! a row is only dropped when it has neither a name nor a statement.
//!
//! | Field | Candidate columns, in order |
//! | --- | --- |
//! | `task_id` | `task_id`, `title_slug`, `titleSlug`, `slug`, slug of `title`/`name` |
//! | `question_id` | `question_id`, `questionFrontendId`, `frontend_id`, `problem_id`, `id` |
//! | `difficulty` | `difficulty` (word or LeetCode's 1/2/3) |
//! | `tags` | `tags`, `topic_tags`, `topics`, `categories` |
//! | `problem_description` | `problem_description`, `content`, `question_content`, `description`, `problem`, `question` |
//! | `starter_code` | `starter_code`, `python3`, `python`, `code_template`, `prompt`, `template` |
//! | `entry_point` | `entry_point`, `func_name`, `function_name`, else read off the stub |
//! | `test` | `test`, `test_code`, `tests` (when a string) |
//! | `input_output` | `input_output`, `test_cases`, `tests` (when an array), `examples` |

use serde_json::Value;

use super::{difficulty, entry_point_from_code, io_cases, slugify, tags, text};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let statement = text(
        raw,
        &[
            "problem_description",
            "content",
            "question_content",
            "description",
            "problem",
            "question",
        ],
    );

    let name = text(raw, &["task_id", "title_slug", "titleSlug", "slug"])
        .or_else(|| text(raw, &["title", "name", "question_title"]))
        .or_else(|| statement.as_deref().map(|s| super::slug_from_statement(s, 8)))?;
    let task_id = slugify(&name);
    if task_id.is_empty() {
        return None;
    }
    if statement.is_none() {
        return None;
    }

    let starter_code = text(
        raw,
        &[
            "starter_code",
            "python3",
            "python",
            "code_template",
            "prompt",
            "template",
        ],
    );
    let entry_point = text(raw, &["entry_point", "func_name", "function_name"])
        .or_else(|| starter_code.as_deref().and_then(entry_point_from_code));

    // `tests` is a string in some dumps and an array of cases in others.
    let test = text(raw, &["test", "test_code"]).or_else(|| match raw.get("tests") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    });

    Some(Problem {
        task_id,
        question_id: text(
            raw,
            &[
                "question_id",
                "questionFrontendId",
                "frontend_id",
                "problem_id",
                "id",
            ],
        ),
        difficulty: difficulty(raw, &["difficulty", "level"]),
        tags: tags(raw, &["tags", "topic_tags", "topics", "categories"]),
        problem_description: statement,
        prompt: None,
        starter_code,
        entry_point,
        test,
        input_output: io_cases(raw, &["input_output", "test_cases", "tests", "examples"]),
        estimated_date: text(raw, &["estimated_date", "date"]),
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "id": 1,
            "title": "Two Sum",
            "title_slug": "two-sum",
            "difficulty": "Easy",
            "topic_tags": [{"name": "Array"}, {"name": "Hash Table"}],
            "content": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
            "python3": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ",
            "tests": [
                {"input": "nums = [2,7,11,15], target = 9", "output": "[0,1]"},
                {"input": "nums = [3,2,4], target = 6", "output": "[1,2]"}
            ]
        })
    }

    #[test]
    fn maps_a_repackaged_leetcode_row() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(problem.task_id, "two-sum");
        assert_eq!(problem.question_id.as_deref(), Some("1"));
        assert_eq!(problem.difficulty.as_deref(), Some("Easy"));
        assert_eq!(problem.tags, vec!["Array", "Hash Table"]);
        assert_eq!(problem.entry_point.as_deref(), Some("twoSum"));
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(problem.input_output[1].output, "[1,2]");
    }

    /// The point of the candidate lists: a dump that spells everything
    /// differently must still import, because these re-packagings do.
    #[test]
    fn alternate_column_spellings_import_the_same_problem() {
        let renamed = serde_json::json!({
            "questionFrontendId": "1",
            "titleSlug": "two-sum",
            "difficulty": 1,
            "topics": ["Array"],
            "question_content": "Given an array of integers nums…",
            "code_template": "class Solution:\n    def twoSum(self, nums, target):\n        pass\n",
            "test_cases": [{"input": {"nums": [2, 7], "target": 9}, "expected": [0, 1]}]
        });
        let problem = normalize(&renamed).expect("imports");
        assert_eq!(problem.task_id, "two-sum");
        assert_eq!(problem.question_id.as_deref(), Some("1"));
        assert_eq!(problem.difficulty.as_deref(), Some("Easy"));
        assert_eq!(problem.entry_point.as_deref(), Some("twoSum"));
        assert_eq!(problem.input_output[0].input, "nums = [2, 7], target = 9");
    }

    /// `tests` carries a suite in some dumps and cases in others.
    #[test]
    fn a_string_tests_column_is_a_suite_not_a_case_list() {
        let mut record = sample();
        record["tests"] = serde_json::json!("def check(candidate):\n    assert candidate([2,7], 9) == [0,1]\n");
        let problem = normalize(&record).expect("imports");
        assert!(problem.test.as_deref().unwrap().contains("def check(candidate)"));
        assert!(problem.input_output.is_empty());
    }

    #[test]
    fn a_row_with_no_statement_is_dropped() {
        assert!(normalize(&serde_json::json!({"title_slug": "two-sum"})).is_none());
    }
}
