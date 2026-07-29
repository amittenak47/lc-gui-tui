//! `kr4t0n/leetcode-with-tests` — LeetCode-shaped rows with a pytest-style
//! assert list.
//!
//! The download this adapter targets spells columns as:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `function` | name / entry point / Solution stub |
//! | `content` | ```python solution``` + prose after → starter is *not* the
//! |           | solution; description is the prose (or a short fallback) |
//! | `valid_tests` | `test` suite + sample `input_output` |
//! | `level` | difficulty |
//!
//! `question_content` looks like a problem statement but is **misaligned** with
//! `function` / `content` / `valid_tests` in this dump (different problems on
//! the same row), so it is never used for the description.
//!
//! `code` is the full reference solution and is never read.

use serde_json::Value;

use super::{
    as_markdown, asserts_as_check_suite, cases_from_asserts, difficulty, entry_point_from_code,
    slugify, split_markdown_fence, tags, text, with_imports_and_solution,
};
use crate::problem::Problem;

pub fn normalize(raw: &Value) -> Option<Problem> {
    let function = text(raw, &["function", "signature", "declaration"]);
    let content = text(raw, &["content", "problem", "question"]);

    let (fence_code, after_fence) = content
        .as_deref()
        .and_then(|c| split_markdown_fence(c))
        .map(|(_before, code, after)| (Some(code), after))
        .unwrap_or((None, String::new()));

    // Prefer the typed signature column; fall back to whatever the fence held
    // only for naming — the fence body is a worked solution and must not become
    // the editor stub.
    let declaration = function
        .clone()
        .or_else(|| {
            fence_code
                .as_deref()
                .and_then(|code| first_signature_line(code).map(|s| s.to_string()))
        })
        .or_else(|| {
            text(
                raw,
                &[
                    "starter_code",
                    "python3",
                    "python",
                    "code_template",
                    "template",
                ],
            )
        })?;

    let entry_point = text(raw, &["entry_point", "func_name", "function_name"])
        .or_else(|| entry_point_from_code(&declaration))
        .or_else(|| fence_code.as_deref().and_then(entry_point_from_code))?;

    let name = text(raw, &["task_id", "title_slug", "titleSlug", "slug"])
        .or_else(|| text(raw, &["title", "name", "question_title", "problem_name"]))
        .unwrap_or_else(|| entry_point.clone());
    let task_id = slugify(&name);
    if task_id.is_empty() {
        return None;
    }

    let skeleton = if declaration.trim_start().starts_with("class ") {
        let mut s = declaration.trim().to_string();
        if !s.contains("pass") {
            // Multi-def class stubs from `function` often omit bodies.
            s = super::ensure_pass_bodies(&s);
        }
        s
    } else {
        declaration.trim().to_string()
    };
    let (prompt, starter_code) = with_imports_and_solution(&skeleton);

    let description = {
        let prose = as_markdown(&after_fence);
        if prose.is_empty() {
            format!(
                "Implement `{entry_point}`.\n\n*(This corpus row has no separate problem statement — only a signature and tests.)*"
            )
        } else {
            // The prose after the fence is usually a solution walkthrough, not
            // a LeetCode statement. Still better than naming every row "Python".
            prose
        }
    };

    let assert_src = match raw.get("valid_tests") {
        Some(Value::Array(items)) => {
            let lines: Vec<&str> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if lines.is_empty() {
                None
            } else {
                Some(lines.join("\n"))
            }
        }
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => text(raw, &["test", "test_code"]).or_else(|| match raw.get("tests") {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
            _ => None,
        }),
    };

    let mut input_output = super::io_cases(raw, &["input_output", "test_cases", "tests", "examples"]);
    if input_output.is_empty() {
        input_output = assert_src
            .as_deref()
            .map(|suite| cases_from_asserts(suite, Some(&entry_point)))
            .unwrap_or_default();
    }

    let test = assert_src
        .as_deref()
        .map(|suite| asserts_as_check_suite(suite, &entry_point));

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
        difficulty: difficulty(raw, &["level", "difficulty"]),
        tags: tags(raw, &["tags", "topic_tags", "topics", "categories"]),
        problem_description: Some(description),
        prompt,
        starter_code: Some(starter_code),
        entry_point: Some(entry_point),
        test,
        input_output,
        estimated_date: text(raw, &["estimated_date", "date"]),
    })
}

fn first_signature_line(code: &str) -> Option<&str> {
    for line in code.lines() {
        let t = line.trim_start();
        if t.starts_with("def ") || t.starts_with("class ") {
            return Some(line.trim_end());
        }
    }
    None
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "content": "```python\ndef max_beauty(items, queries):\n    return []\n```\n\nBuild a prefix of max beauty per price, then answer each query.",
            "question_content": "UNRELATED STATEMENT ABOUT A DIFFERENT PROBLEM",
            "level": "Hard",
            "function": "def max_beauty(items: List[Tuple[int, int]], queries: List[int]) -> List[int]",
            "valid_tests": [
                "assert max_beauty([(1, 2), (2, 3), (3, 4)], [1, 2, 3]) == [2, 3, 4]",
                "assert max_beauty([(1, 5), (2, 3), (3, 1)], [1, 2, 3]) == [5, 5, 5]"
            ],
            "code": "SECRET_SHOULD_NOT_APPEAR"
        })
    }

    #[test]
    fn names_the_problem_after_its_function_not_python() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(problem.task_id, "max-beauty");
        assert_eq!(problem.entry_point.as_deref(), Some("max_beauty"));
        assert_eq!(problem.difficulty.as_deref(), Some("Hard"));
    }

    #[test]
    fn description_comes_from_prose_after_the_fence_not_question_content() {
        let problem = normalize(&sample()).expect("imports");
        let desc = problem.problem_description.as_deref().unwrap();
        assert!(desc.contains("prefix of max beauty"));
        assert!(!desc.contains("UNRELATED"));
        assert!(!desc.contains("```"));
    }

    #[test]
    fn starter_is_a_solution_stub_not_the_reference_code() {
        let problem = normalize(&sample()).expect("imports");
        let starter = problem.starter_code.as_deref().unwrap();
        assert!(starter.contains("class Solution:"), "{starter}");
        assert!(starter.contains("def max_beauty"), "{starter}");
        assert!(starter.contains("pass"), "{starter}");
        assert!(!starter.contains("return []"), "{starter}");
        assert!(
            problem.prompt.as_deref().unwrap().contains("from typing import"),
            "{:?}",
            problem.prompt
        );
    }

    #[test]
    fn valid_tests_become_a_check_suite_and_sample_cases() {
        let problem = normalize(&sample()).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        assert_eq!(
            problem.input_output[0].input,
            "[(1, 2), (2, 3), (3, 4)], [1, 2, 3]"
        );
        let suite = problem.test.as_deref().unwrap();
        assert!(suite.starts_with("def check(candidate):"), "{suite}");
        assert!(suite.contains("assert candidate("), "{suite}");
        assert!(!suite.contains("max_beauty("), "{suite}");
    }

    #[test]
    fn reference_code_column_is_ignored() {
        let problem = normalize(&sample()).expect("imports");
        let blob = format!("{problem:?}");
        assert!(!blob.contains("SECRET"));
    }

    #[test]
    fn a_row_with_no_signature_is_dropped() {
        assert!(normalize(&serde_json::json!({
            "content": "no fence here",
            "valid_tests": []
        }))
        .is_none());
    }
}
