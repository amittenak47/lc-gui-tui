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
///
/// Prefer [`for_each_for`] on a large corpus: this collects every `Problem` —
/// statements and test suites included — into memory at once.
pub fn load_all_for(dataset: &Dataset, path: &Path) -> Result<Vec<Problem>> {
    let mut out = Vec::new();
    for_each_for(dataset, path, |problem| {
        out.push(problem);
        Ok(())
    })?;
    Ok(out)
}

/// Stream every problem in `path`, in file order, without holding the corpus.
///
/// KodCode arrives as one 487k-row `.jsonl`. Reading it into a `Vec<Value>`
/// and then into a `Vec<Problem>` costs gigabytes, twice, for an import that
/// only ever looks at one record at a time.
pub fn for_each_for<F>(dataset: &Dataset, path: &Path, mut visit: F) -> Result<()>
where
    F: FnMut(Problem) -> Result<()>,
{
    if dataset.shape == Shape::Canonical {
        for problem in load_all(path)? {
            visit(problem)?;
        }
        return Ok(());
    }

    let mut ids = IdDeduper::default();
    for_each_value(path, &mut |raw| {
        let Some(mut problem) = datasets::normalize(dataset, &raw) else {
            return Ok(());
        };
        problem.task_id = ids.unique(problem.task_id);
        visit(problem)
    })
}

/// One problem from `path`, reading it the way `dataset` is shaped.
///
/// Streams and stops at the match, so opening one KodCode problem no longer
/// parses the other 487,431 rows first.
pub fn load_task_for(dataset: &Dataset, path: &Path, task_id: &str) -> Result<Problem> {
    if dataset.shape == Shape::Canonical {
        return load_task(path, task_id);
    }

    let mut ids = IdDeduper::default();
    let mut found: Option<Problem> = None;
    for_each_value(path, &mut |raw| {
        if found.is_some() {
            return Ok(());
        }
        let Some(mut problem) = datasets::normalize(dataset, &raw) else {
            return Ok(());
        };
        // The same numbering as the import, so a disambiguated id resolves to
        // the row it was minted for.
        problem.task_id = ids.unique(problem.task_id);
        if problem.task_id == task_id {
            found = Some(problem);
        }
        Ok(())
    })?;
    found.with_context(|| format!("task_id {task_id:?} not found in {}", path.display()))
}

/// Keeps every `task_id` in one corpus file unique.
///
/// Ids are the primary key of the index, so two rows that slug to the same name
/// are not two problems — the second silently replaces the first. That is how a
/// multi-thousand-row corpus can index as a single problem: if its rows carry
/// no id column and every statement opens with the same words, every row slugs
/// to the same name. Duplicates now get `-2`, `-3`, … in file order, which is
/// stable across re-imports.
#[derive(Default)]
struct IdDeduper {
    seen: std::collections::HashSet<String>,
}

impl IdDeduper {
    fn unique(&mut self, id: String) -> String {
        if self.seen.insert(id.clone()) {
            return id;
        }
        // A corpus that already contains `foo-2` must not collide with the
        // disambiguated form of a second `foo`.
        for n in 2.. {
            let candidate = format!("{id}-{n}");
            if self.seen.insert(candidate.clone()) {
                return candidate;
            }
        }
        unreachable!("the suffix search always terminates")
    }
}

/// Raw records from a `.json` object, a JSON array, or a `.jsonl` file, one at
/// a time.
///
/// Unparseable lines are skipped rather than fatal: these corpora are hundreds
/// of thousands of rows, and one malformed record must not cost the import.
fn for_each_value(
    path: &Path,
    visit: &mut dyn FnMut(serde_json::Value) -> Result<()>,
) -> Result<()> {
    if is_jsonl(path) {
        let file = File::open(path)
            .with_context(|| format!("cannot read problem file {}", path.display()))?;
        for line in BufReader::new(file).lines() {
            let line = line.with_context(|| format!("cannot read {}", path.display()))?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str(line) {
                visit(value)?;
            }
        }
        return Ok(());
    }

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read problem file {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("cannot parse problem JSON {}", path.display()))?;
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                visit(item)?;
            }
        }
        other => visit(other)?,
    }
    Ok(())
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

    /// The bug this prevents: rows that slug to the same name are not two
    /// problems in a table keyed on `task_id` — the second replaces the first,
    /// and a whole corpus can index as a single entry.
    #[test]
    fn rows_that_share_a_name_stay_separate_problems() {
        let dir = std::env::temp_dir().join(format!("lc-dupes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("corpus.jsonl");
        // No id and no title: every row is named after its statement, and the
        // statements all open the same way.
        let row = |body: &str| {
            format!(
                "{{\"content\": \"Solve the following problem carefully and completely now. {body}\", \"python3\": \"x\"}}\n"
            )
        };
        std::fs::write(&path, format!("{}{}{}", row("One."), row("Two."), row("Three."))).unwrap();

        let dataset = crate::dataset::get("leetcode-with-tests").unwrap();
        let problems = load_all_for(dataset, &path).expect("imports");
        let ids: Vec<&str> = problems.iter().map(|p| p.task_id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[1], format!("{}-2", ids[0]));
        assert_eq!(ids[2], format!("{}-3", ids[0]));

        // And a disambiguated id resolves back to the row it was minted for.
        let second = load_task_for(dataset, &path, ids[1]).expect("resolves");
        assert!(second.problem_description.as_deref().unwrap().ends_with("Two."));

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
