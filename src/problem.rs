use anyhow::{bail, Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::dataset::{Dataset, Shape};
use crate::datasets;

/// A problem as loaded from the JSON corpus.
///
/// Solution-bearing fields (`completion`, `response`, `query`) are deliberately
/// absent from this struct: serde never deserializes them, so they cannot reach
/// the workspace files, the SQLite index, or an LLM prompt through any code path
/// that goes through `Problem`.
#[derive(Debug, Clone, Deserialize)]
pub struct Problem {
    pub task_id: String,
    #[serde(default, deserialize_with = "string_or_number")]
    pub question_id: Option<String>,
    #[serde(default)]
    pub difficulty: Option<String>,
    #[serde(default, deserialize_with = "flexible_tags")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub problem_description: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub starter_code: Option<String>,
    #[serde(default)]
    pub entry_point: Option<String>,
    #[serde(default)]
    pub test: Option<String>,
    #[serde(default, deserialize_with = "io_cases")]
    pub input_output: Vec<IoCase>,
    #[serde(default, deserialize_with = "string_or_number")]
    pub estimated_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoCase {
    pub input: String,
    pub output: String,
}

/// Load one problem from a per-problem `.json` file, or from a bulk `.json` / `.jsonl`
/// corpus by `task_id`.
pub fn load_task(path: &Path, task_id: &str) -> Result<Problem> {
    if is_jsonl(path) {
        return load_task_jsonl(path, task_id);
    }

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    let trimmed = raw.trim_start();
    if trimmed.starts_with('[') {
        for problem in parse_json_corpus(&raw, path)? {
            if problem.task_id == task_id {
                return Ok(problem);
            }
        }
        bail!(
            "task_id {task_id:?} not found in {}",
            path.display()
        );
    } else {
        let problem: Problem = serde_json::from_str(&raw)
            .with_context(|| format!("cannot parse problem JSON {}", path.display()))?;
        if problem.task_id != task_id {
            bail!(
                "problem file {} contains {:?}, not {:?}",
                path.display(),
                problem.task_id,
                task_id
            );
        }
        Ok(problem)
    }
}

/// Load every problem from a single-object `.json`, a JSON array, or `.jsonl`.
pub fn load_all(path: &Path) -> Result<Vec<Problem>> {
    if is_jsonl(path) {
        return load_all_jsonl(path);
    }

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    parse_json_corpus(&raw, path)
}

/// Load every problem from `path`, reading it the way `dataset` is shaped.
///
/// The original corpus already uses `lc`'s field names, so it keeps the strict
/// serde path — including the redaction guarantee that `Problem` cannot even
/// deserialize `completion`/`response`/`query`. Every other corpus goes through
/// its adapter in [`crate::datasets`], which maps a raw record onto those same
/// fields and never reads a solution column.
pub fn load_all_for(dataset: &Dataset, path: &Path) -> Result<Vec<Problem>> {
    if dataset.shape == Shape::Canonical {
        return load_all(path);
    }
    Ok(load_values(path)?
        .iter()
        .filter_map(|raw| datasets::normalize(dataset, raw))
        .collect())
}

/// One problem from `path`, reading it the way `dataset` is shaped.
pub fn load_task_for(dataset: &Dataset, path: &Path, task_id: &str) -> Result<Problem> {
    if dataset.shape == Shape::Canonical {
        return load_task(path, task_id);
    }
    load_values(path)?
        .iter()
        .filter_map(|raw| datasets::normalize(dataset, raw))
        .find(|problem| problem.task_id == task_id)
        .with_context(|| format!("task_id {task_id:?} not found in {}", path.display()))
}

/// Raw records from a `.json` object, a JSON array, or a `.jsonl` file.
///
/// Unparseable lines are skipped rather than fatal: these corpora are hundreds
/// of thousands of rows, and one malformed record must not cost the import.
fn load_values(path: &Path) -> Result<Vec<serde_json::Value>> {
    if is_jsonl(path) {
        let file = File::open(path)
            .with_context(|| format!("cannot read problem file {}", path.display()))?;
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line.with_context(|| format!("cannot read {}", path.display()))?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str(line) {
                out.push(value);
            }
        }
        return Ok(out);
    }

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("cannot parse problem JSON {}", path.display()))?;
    Ok(match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonCorpus {
    One(Problem),
    Many(Vec<Problem>),
}

fn parse_json_corpus(raw: &str, path: &Path) -> Result<Vec<Problem>> {
    let corpus: JsonCorpus = serde_json::from_str(raw)
        .with_context(|| format!("cannot parse problem JSON {}", path.display()))?;
    Ok(match corpus {
        JsonCorpus::One(problem) => vec![problem],
        JsonCorpus::Many(problems) => problems,
    })
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("jsonl"))
}

fn load_all_jsonl(path: &Path) -> Result<Vec<Problem>> {
    let file = File::open(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    let mut out = Vec::new();
    for (line_no, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("cannot read {}", path.display()))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let problem: Problem = serde_json::from_str(line).with_context(|| {
            format!(
                "cannot parse problem JSON {} (line {})",
                path.display(),
                line_no + 1
            )
        })?;
        out.push(problem);
    }
    Ok(out)
}

fn load_task_jsonl(path: &Path, task_id: &str) -> Result<Problem> {
    let file = File::open(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    for (line_no, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("cannot read {}", path.display()))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let problem: Problem = serde_json::from_str(line).with_context(|| {
            format!(
                "cannot parse problem JSON {} (line {})",
                path.display(),
                line_no + 1
            )
        })?;
        if problem.task_id == task_id {
            return Ok(problem);
        }
    }
    bail!(
        "task_id {task_id:?} not found in {}",
        path.display()
    );
}

/// Accept a JSON string or number (question ids show up both ways).
fn string_or_number<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| match v {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Null => None,
        other => Some(other.to_string()),
    }))
}

/// Accept `["Array", "Hash Table"]` or a single string.
fn flexible_tags<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let mut out = Vec::new();
    match v {
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                match item {
                    serde_json::Value::String(s) => out.push(s),
                    other => out.push(other.to_string()),
                }
            }
        }
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => out.push(s),
        _ => {}
    }
    Ok(out)
}

/// Accept `[{"input": "...", "output": "..."}, ...]`; stringify non-string values.
fn io_cases<'de, D>(d: D) -> Result<Vec<IoCase>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let mut out = Vec::new();
    if let Some(serde_json::Value::Array(items)) = v {
        for item in items {
            if let serde_json::Value::Object(map) = item {
                let get = |key: &str| {
                    map.get(key)
                        .map(|x| match x {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .unwrap_or_default()
                };
                out.push(IoCase {
                    input: get("input"),
                    output: get("output"),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solution_fields_are_never_deserialized() {
        let json = r#"{
            "task_id": "two-sum",
            "question_id": 1,
            "difficulty": "Easy",
            "tags": ["Array", "Hash Table"],
            "starter_code": "class Solution:\n    def twoSum(self, nums, target):\n        pass",
            "entry_point": "twoSum",
            "completion": "SECRET_SOLUTION_BODY",
            "response": "SECRET_MODEL_RESPONSE",
            "query": "SECRET_QUERY_TEXT",
            "input_output": [{"input": "nums = [2,7], target = 9", "output": "[0, 1]"}]
        }"#;
        let p: Problem = serde_json::from_str(json).expect("parses");
        let debug = format!("{p:?}");
        assert!(!debug.contains("SECRET"), "solution text leaked into Problem");
        assert_eq!(p.task_id, "two-sum");
        assert_eq!(p.question_id.as_deref(), Some("1"));
        assert_eq!(p.tags, vec!["Array", "Hash Table"]);
        assert_eq!(p.input_output.len(), 1);
    }

    #[test]
    fn question_id_accepts_string() {
        let p: Problem =
            serde_json::from_str(r#"{"task_id": "x", "question_id": "217"}"#).unwrap();
        assert_eq!(p.question_id.as_deref(), Some("217"));
    }

    #[test]
    fn load_all_accepts_json_array() {
        let dir = std::env::temp_dir().join(format!("lc-bulk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bulk.json");
        std::fs::write(
            &path,
            r#"[
                {"task_id": "two-sum", "question_id": 1, "input_output": []},
                {"task_id": "add-two-numbers", "question_id": 2, "input_output": []}
            ]"#,
        )
        .unwrap();

        let problems = load_all(&path).expect("parses array");
        assert_eq!(problems.len(), 2);
        assert_eq!(problems[0].task_id, "two-sum");
        assert_eq!(
            load_task(&path, "add-two-numbers")
                .unwrap()
                .question_id
                .as_deref(),
            Some("2")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn load_all_accepts_jsonl() {
        let dir = std::env::temp_dir().join(format!("lc-jsonl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bulk.jsonl");
        std::fs::write(
            &path,
            "{\"task_id\": \"two-sum\", \"question_id\": 1, \"input_output\": []}\n\
             {\"task_id\": \"add-two-numbers\", \"question_id\": 2, \"input_output\": []}\n",
        )
        .unwrap();

        let problems = load_all(&path).expect("parses jsonl");
        assert_eq!(problems.len(), 2);
        assert_eq!(
            load_task(&path, "two-sum").unwrap().task_id,
            "two-sum"
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
