//! `lc datasets --inspect`: what a downloaded corpus actually contains, and
//! what the adapter made of it.
//!
//! Every column mapping in `src/datasets/` is a bet on how one Hugging Face
//! repo spells things, and the bet can be wrong in ways that are invisible from
//! the browser: a blank difficulty column looks the same whether the corpus has
//! no difficulty or the adapter is reading the wrong key, and a nested column
//! that arrived as a JSON string reads as absent rather than as an error. Both
//! happened here.
//!
//! So this reports, per corpus file: the columns the rows really have, which
//! canonical fields came out filled over a sample, and which columns no
//! adapter looked at. That turns "the tags are empty" into "the tags are in a
//! column called `topic_tags` that nothing reads", which is a one-line fix.
//!
//! It reads a bounded prefix of each file, so it is fast even on the 487k-row
//! corpus, and it never prints field *values* — only names, counts, and one
//! example id — because a corpus row may hold a reference solution.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::Result;
use serde_json::Value;

use crate::config::Config;
use crate::dataset::{self, Dataset};
use crate::datasets;

/// How many rows of each file are read. Enough to tell a missing column from an
/// occasionally-empty one, cheap enough to run on a 6 GB corpus.
const SAMPLE_ROWS: usize = 200;

#[derive(Debug, Default)]
pub struct FileReport {
    pub path: String,
    pub rows_sampled: usize,
    /// Column names seen in the sample, with how many rows had them non-empty.
    pub columns: BTreeMap<String, usize>,
    /// Rows the adapter accepted.
    pub imported: usize,
    /// Canonical field → how many imported problems had it filled.
    pub filled: BTreeMap<&'static str, usize>,
    /// First imported `task_id`, as a sanity check on naming.
    pub example_task_id: Option<String>,
    /// Columns no adapter reads. Candidates for a mapping that is missing.
    pub unread_columns: BTreeSet<String>,
}

/// Canonical fields, in the order the browser shows them.
const FIELDS: [&str; 7] = [
    "question_id",
    "task_id",
    "difficulty",
    "tags",
    "problem_description",
    "starter_code",
    "cases",
];

/// Report on every corpus file of `dataset`, in walk order.
pub fn inspect(cfg: &Config, dataset: &'static Dataset) -> Result<Vec<FileReport>> {
    let dir = dataset.corpus_dir(cfg)?;
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir()
                || !dataset::belongs_to_other_dataset(&dir, entry.path(), dataset)
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if dataset::belongs_to_other_dataset(&dir, path, dataset) {
            continue;
        }
        if !dataset::is_corpus_file(path) {
            continue;
        }
        out.push(inspect_file(dataset, path)?);
    }
    Ok(out)
}

fn inspect_file(dataset: &'static Dataset, path: &Path) -> Result<FileReport> {
    let mut report = FileReport {
        path: path.display().to_string(),
        ..FileReport::default()
    };

    for raw in sample_rows(path)? {
        report.rows_sampled += 1;
        if let Value::Object(map) = &raw {
            for (key, value) in map {
                let filled = !is_blank(value);
                let counter = report.columns.entry(key.clone()).or_insert(0);
                if filled {
                    *counter += 1;
                }
            }
        }

        let Some(problem) = datasets::normalize(dataset, &raw) else {
            continue;
        };
        report.imported += 1;
        if report.example_task_id.is_none() {
            report.example_task_id = Some(problem.task_id.clone());
        }
        let mut mark = |field: &'static str, present: bool| {
            if present {
                *report.filled.entry(field).or_insert(0) += 1;
            }
        };
        mark("task_id", !problem.task_id.is_empty());
        mark("question_id", problem.question_id.is_some());
        mark("difficulty", problem.difficulty.is_some());
        mark("tags", !problem.tags.is_empty());
        mark(
            "problem_description",
            problem
                .problem_description
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty()),
        );
        mark("starter_code", problem.starter_code.is_some());
        mark("cases", !problem.input_output.is_empty());
    }

    // A column nothing reads is the usual explanation for an empty field.
    for column in report.columns.keys() {
        if !READ_COLUMNS.contains(&column.as_str()) && !datasets::SOLUTION_FIELDS.contains(&column.as_str()) {
            report.unread_columns.insert(column.clone());
        }
    }
    Ok(report)
}

/// Every column name any adapter looks at.
///
/// Kept as one flat list rather than derived from the adapters: it exists to
/// answer "is this column being read at all", and a name that moved between
/// adapters is still being read.
const READ_COLUMNS: [&str; 65] = [
    // ids and names
    "task_id", "title", "titleSlug", "title_slug", "slug", "name", "question_title",
    "problem_name", "problem_id", "id", "question_id", "questionFrontendId", "questionId",
    "frontend_id", "conversation_id", "uuid", "leetcode_id",
    // statements
    "question", "problem", "prompt", "prompt_sft", "problem_description", "content",
    "question_content", "description",
    // code
    "starter_code", "python3", "python", "code_template", "template", "python_template",
    "entry_point", "func_name", "function_name", "fn_name", "test_entry_point",
    "test_info", "function_declaration", "declaration", "signature", "metadata",
    // tests
    "test", "test_code", "tests", "test_cases", "input_output", "examples",
    "python_test", "unit_test", "python_test_cases", "sample_cases",
    // classification
    "difficulty", "gpt_difficulty", "4o_difficulty", "level", "tags", "topic_tags", "topics",
    "topicTags", "categories", "categoryTitle", "category", "topic", "subset", "style",
];

fn sample_rows(path: &Path) -> Result<Vec<Value>> {
    let jsonl = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"));
    if jsonl {
        let file = File::open(path)?;
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str(line) {
                out.push(value);
            }
            if out.len() >= SAMPLE_ROWS {
                break;
            }
        }
        return Ok(out);
    }

    let raw = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&raw)?;
    Ok(match value {
        Value::Array(items) => items.into_iter().take(SAMPLE_ROWS).collect(),
        other => vec![other],
    })
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

impl FileReport {
    /// Human-readable lines, for `lc datasets --inspect`.
    pub fn lines(&self) -> Vec<String> {
        let mut out = vec![format!(
            "  {} — {} rows sampled, {} imported",
            self.path, self.rows_sampled, self.imported
        )];
        if self.rows_sampled == 0 {
            out.push("    (no readable rows — is this the right file?)".into());
            return out;
        }
        if let Some(example) = &self.example_task_id {
            out.push(format!("    example task_id: {example}"));
        }
        let mapped = FIELDS
            .iter()
            .map(|field| {
                let count = self.filled.get(field).copied().unwrap_or(0);
                let mark = if count == 0 {
                    "MISSING"
                } else if count < self.imported {
                    "partial"
                } else {
                    "ok"
                };
                format!("{field}={mark}({count})")
            })
            .collect::<Vec<_>>()
            .join("  ");
        out.push(format!("    mapped: {mapped}"));
        out.push(format!(
            "    columns: {}",
            self.columns
                .iter()
                .map(|(name, filled)| format!("{name}({filled})"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        if !self.unread_columns.is_empty() {
            out.push(format!(
                "    not read by any adapter: {}",
                self.unread_columns.iter().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_mapping_is_reported_as_missing_with_the_column_that_holds_it() {
        let dir = std::env::temp_dir().join(format!("lc-inspect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rows.jsonl");
        // A difficulty nothing reads, under a name nothing reads.
        std::fs::write(
            &path,
            "{\"question\": \"Do a thing.\", \"question_id\": \"Algorithm_7_C\", \"style\": \"Complete\", \"hardness\": \"medium\", \"test_info\": [{\"function_name\": \"do_thing\", \"function_declaration\": \"def do_thing():\"}]}\n",
        )
        .unwrap();

        let dataset = dataset::get("kodcode").unwrap();
        let report = inspect_file(dataset, &path).expect("inspects");
        assert_eq!(report.rows_sampled, 1);
        assert_eq!(report.imported, 1);
        assert_eq!(report.example_task_id.as_deref(), Some("do-thing-7-c"));
        assert_eq!(report.filled.get("difficulty").copied().unwrap_or(0), 0);
        assert!(report.unread_columns.contains("hardness"));
        // …and a column that *is* read is not reported as unread.
        assert!(!report.unread_columns.contains("question"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
