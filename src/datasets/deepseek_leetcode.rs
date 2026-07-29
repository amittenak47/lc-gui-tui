//! `davidheineman/deepseek-leetcode` — the LeetCode contest benchmark from
//! DeepSeek-Coder's evaluation suite.
//!
//! Columns used here:
//!
//! | Column | Becomes |
//! | --- | --- |
//! | `title` / `task_id` | `task_id` |
//! | `meta.questionFrontendId`, `meta.difficulty`, `meta.categoryTitle` | `question_id`, `difficulty`, `tags` |
//! | `prompt_sft`, or the docstring in `prompt` | `problem_description` |
//! | the code below that docstring | `starter_code`, `entry_point` |
//! | `test` | `input_output`, and a rewritten `test` |
//! | `start_time` | `estimated_date` |
//!
//! Two things need real work rather than a rename.
//!
//! **The statement and the stub share one column.** `prompt` is a module
//! docstring holding the whole problem, followed by `class Solution:`. They are
//! split apart so the board shows a statement and the editor shows a stub.
//!
//! **The suite is written against its own object.** The `test` column is a run
//! of `test_input = {…}` / `assert my_solution.foo(**test_input) == 5` pairs,
//! which `run_tests.py` cannot execute — it calls a `check(candidate)`. So the
//! asserts are read twice: once to extract per-case sample I/O, and once to
//! rewrite the body into the `check(candidate)` the runner expects.

use serde_json::Value;

use super::{
    difficulty, entry_point_from_code, nested_text, py_literal, slugify,
    split_leading_docstring, tags, text,
};
use crate::problem::{IoCase, Problem};

pub fn normalize(raw: &Value) -> Option<Problem> {
    let name = text(raw, &["title", "task_id", "titleSlug"])
        .or_else(|| nested_text(raw, "meta", &["titleSlug", "title"]))?;
    let task_id = slugify(&name);
    if task_id.is_empty() {
        return None;
    }

    let prompt = text(raw, &["prompt"]).unwrap_or_default();
    let (docstring, code) = split_leading_docstring(&prompt);
    let starter_code = (!code.trim().is_empty()).then(|| code.trim_end().to_string());
    let entry_point = starter_code.as_deref().and_then(entry_point_from_code);

    let suite = text(raw, &["test", "test_code"]);
    let input_output = suite
        .as_deref()
        .map(extract_cases)
        .unwrap_or_default();
    let test = suite
        .as_deref()
        .and_then(|src| entry_point.as_deref().map(|entry| as_check_suite(src, entry)));

    // `meta` carries the question number, the difficulty and the category, and
    // it is the column most likely to have arrived as a JSON *string* rather
    // than a structure — `nested_text` reads both, which is what put the q#
    // and tags columns back.
    let meta = super::container_value(raw, "meta");
    let mut topics = Vec::new();
    for key in ["categoryTitle", "category", "topic"] {
        if let Some(value) = nested_text(raw, "meta", &[key]) {
            topics.push(value);
            break;
        }
    }
    if topics.is_empty() {
        topics = tags(raw, &["tags", "topic_tags", "topics"]);
    }
    if topics.is_empty() {
        if let Some(meta) = meta.as_ref() {
            topics = tags(meta, &["topicTags", "topic_tags", "tags"]);
        }
    }

    Some(Problem {
        task_id,
        question_id: nested_text(
            raw,
            "meta",
            &["questionFrontendId", "questionId", "question_id", "id"],
        )
        .or_else(|| text(raw, &["question_id", "questionFrontendId", "frontend_id"])),
        difficulty: difficulty(raw, &["difficulty"])
            .or_else(|| meta.as_ref().and_then(|m| difficulty(m, &["difficulty"]))),
        tags: topics,
        problem_description: text(raw, &["prompt_sft", "problem_description", "content"])
            .or(docstring),
        prompt: None,
        starter_code,
        entry_point,
        test,
        input_output,
        estimated_date: text(raw, &["start_time", "estimated_date"]),
    })
}

/// Pull `test_input = {…}` / `assert … == expected` pairs out of the suite.
///
/// Best-effort by design: a pair whose dict is not JSON-readable is skipped
/// rather than guessed at, and the rewritten `check(candidate)` suite still
/// runs every assert including the skipped ones.
fn extract_cases(suite: &str) -> Vec<IoCase> {
    let mut cases = Vec::new();
    let mut pending: Option<String> = None;
    let mut collecting: Option<String> = None;
    let mut depth = 0usize;

    for line in suite.lines() {
        // Continue a dict literal that spans lines.
        if let Some(buffer) = collecting.as_mut() {
            buffer.push('\n');
            buffer.push_str(line);
            depth = (depth + count(line, '{')).saturating_sub(count(line, '}'));
            if depth == 0 {
                pending = collecting.take();
            }
            continue;
        }

        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("test_input") {
            let Some(eq) = rest.find('=') else { continue };
            let value = rest[eq + 1..].trim();
            let opens = count(value, '{');
            let closes = count(value, '}');
            if opens > 0 && opens == closes {
                pending = Some(value.to_string());
            } else if opens > 0 {
                depth = opens - closes;
                collecting = Some(value.to_string());
            }
            continue;
        }

        if trimmed.starts_with("assert ") {
            let Some(input) = pending.take() else { continue };
            let Some(expected) = trimmed.rsplit_once("==").map(|(_, rhs)| rhs.trim()) else {
                continue;
            };
            if expected.is_empty() {
                continue;
            }
            if let Some(rendered) = kwargs_from_json(&input) {
                cases.push(IoCase {
                    input: rendered,
                    output: expected.to_string(),
                });
            }
        }
    }
    cases
}

fn count(text: &str, needle: char) -> usize {
    text.chars().filter(|c| *c == needle).count()
}

/// `{ "word": "abcde" }` → `word = "abcde"`, the shape `run_tests.py` parses.
fn kwargs_from_json(literal: &str) -> Option<String> {
    let value: Value = serde_json::from_str(literal).ok()?;
    let map = value.as_object()?;
    if map.is_empty() {
        return None;
    }
    Some(
        map.iter()
            .map(|(key, value)| format!("{key} = {}", py_literal(value)))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// Rewrite the suite into the `check(candidate)` function `run_tests.py` calls.
///
/// `my_solution = Solution()` is dropped (the runner supplies the bound method)
/// and `my_solution.<entry>(` becomes `candidate(`.
fn as_check_suite(suite: &str, entry_point: &str) -> String {
    let receiver = format!("my_solution.{entry_point}(");
    let mut body = String::from("def check(candidate):\n");
    let mut wrote_any = false;

    for line in suite.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("my_solution") && trimmed.contains('=') && !trimmed.contains("==") {
            continue;
        }
        let rewritten = line.replace(&receiver, "candidate(");
        if rewritten.trim().is_empty() {
            body.push('\n');
            continue;
        }
        body.push_str("    ");
        body.push_str(&rewritten);
        body.push('\n');
        wrote_any = true;
    }

    if !wrote_any {
        body.push_str("    pass\n");
    }
    body
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn sample() -> Value {
        serde_json::json!({
            "task_id": "weekly-contest-381-minimum-number-of-pushes-to-type-word-i",
            "url": "https://leetcode.com/problems/minimum-number-of-pushes-to-type-word-i",
            "title": "minimum-number-of-pushes-to-type-word-i",
            "meta": {
                "questionId": "3275",
                "questionFrontendId": "3014",
                "title": "Minimum Number of Pushes to Type Word I",
                "titleSlug": "minimum-number-of-pushes-to-type-word-i",
                "difficulty": "Easy",
                "categoryTitle": "Algorithms"
            },
            "prompt": "\"\"\"\nYou are given a string word containing distinct lowercase English letters.\nReturn the minimum number of pushes.\n\"\"\"\nclass Solution:\n    def minimumPushes(self, word: str) -> int:\n        ",
            "prompt_sft": "You are given a string word containing distinct lowercase English letters.",
            "test": "\nmy_solution = Solution()\n\ntest_input = { \"word\": \"abcde\" }\nassert my_solution.minimumPushes(**test_input) == 5\n\ntest_input = { \"word\": \"xycdefghij\" }\nassert my_solution.minimumPushes(**test_input) == 12\n",
            "start_time": 1705804200
        })
    }

    #[test]
    fn splits_the_statement_from_the_stub() {
        let problem = normalize(&sample()).expect("sample imports");
        assert_eq!(problem.task_id, "minimum-number-of-pushes-to-type-word-i");
        assert_eq!(problem.question_id.as_deref(), Some("3014"));
        assert_eq!(problem.difficulty.as_deref(), Some("Easy"));
        assert_eq!(problem.tags, vec!["Algorithms"]);
        assert_eq!(problem.entry_point.as_deref(), Some("minimumPushes"));

        let starter = problem.starter_code.as_deref().unwrap();
        assert!(starter.starts_with("class Solution:"), "{starter}");
        assert!(
            !starter.contains("You are given a string"),
            "the statement must not end up in the editor stub"
        );
        assert!(problem
            .problem_description
            .as_deref()
            .unwrap()
            .contains("distinct lowercase English letters"));
    }

    #[test]
    fn asserts_become_numbered_sample_cases() {
        let problem = normalize(&sample()).expect("imports");
        assert_eq!(problem.input_output.len(), 2);
        // Exactly the `k = v` shape `run_tests.py`'s `parse_input` reads.
        assert_eq!(problem.input_output[0].input, "word = \"abcde\"");
        assert_eq!(problem.input_output[0].output, "5");
        assert_eq!(problem.input_output[1].input, "word = \"xycdefghij\"");
        assert_eq!(problem.input_output[1].output, "12");
    }

    /// The suite is written against `my_solution`, which does not exist inside
    /// the runner. Without this rewrite `lc test --full` fails on every problem
    /// in the corpus.
    #[test]
    fn the_suite_is_rewritten_to_the_runners_check_signature() {
        let problem = normalize(&sample()).expect("imports");
        let suite = problem.test.as_deref().unwrap();
        assert!(suite.starts_with("def check(candidate):"), "{suite}");
        assert!(suite.contains("assert candidate(**test_input) == 5"), "{suite}");
        assert!(
            !suite.contains("my_solution"),
            "the suite still references an object the runner never creates: {suite}"
        );
    }

    /// The failure this guards: a parquet conversion that stores `meta` as a
    /// string leaves the q# and tags columns empty, because `meta.difficulty`
    /// and friends read as absent.
    #[test]
    fn a_meta_column_stored_as_a_json_string_still_reads() {
        let mut record = sample();
        let meta = record["meta"].clone();
        record["meta"] = serde_json::json!(serde_json::to_string(&meta).unwrap());
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.question_id.as_deref(), Some("3014"));
        assert_eq!(problem.difficulty.as_deref(), Some("Easy"));
        assert_eq!(problem.tags, vec!["Algorithms"]);
    }

    /// Some dumps carry the topics as a normal column instead of a category.
    #[test]
    fn topic_tags_are_read_when_there_is_no_category() {
        let mut record = sample();
        record["meta"] = serde_json::json!({"questionFrontendId": "3014", "difficulty": "Easy"});
        record["topic_tags"] = serde_json::json!(["Hash Table", "Greedy"]);
        let problem = normalize(&record).expect("imports");
        assert_eq!(problem.tags, vec!["Hash Table", "Greedy"]);
    }

    #[test]
    fn a_multiline_dict_is_read_as_one_case() {
        let suite = "\nmy_solution = Solution()\n\ntest_input = {\n  \"nums\": [1, 2],\n  \"target\": 3\n}\nassert my_solution.f(**test_input) == [0, 1]\n";
        let cases = extract_cases(suite);
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].input, "nums = [1, 2], target = 3");
        assert_eq!(cases[0].output, "[0, 1]");
    }

    /// A dict holding Python-only spellings cannot be read back as JSON. The
    /// case is dropped, but the rewritten suite still runs that assert.
    #[test]
    fn an_unreadable_case_is_skipped_not_guessed() {
        let suite = "test_input = { \"flag\": True }\nassert my_solution.f(**test_input) == 1\n";
        assert!(extract_cases(suite).is_empty());
        assert!(as_check_suite(suite, "f").contains("assert candidate(**test_input) == 1"));
    }
}
