//! Walk the existing SQLite corpus index and list problems whose tests
//! RustPython cannot execute. Does not re-index. Does not mutate `problems.db`
//! or `~/lc-workspace`. KodCode is skipped unless `--all` / `--dataset kodcode`.
//!
//! Writes one JSON object per issue (dataset, task_id, json_path, kind, detail)
//! to `--out` (default `audit-tests.jsonl`). Stderr is the count summary only.
//!
//! ```text
//! cargo run --release --bin audit-tests -- --dataset leetcode --limit 50
//! cargo run --release --bin audit-tests -- --dataset kodcode --out audit-kodcode.jsonl
//! cargo run --release --bin audit-tests -- --dataset kodcode --sample 500
//! cargo run --release --bin audit-tests -- --dataset kodcode --full
//! ```

use anyhow::{Context, Result};
use clap::Parser;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use whiteboard::dataset::{self, Dataset, DATASETS};
use whiteboard::generator::{self, WorkspaceMeta, RUN_TESTS_PY};
use whiteboard::index::{self, ProblemRow, ROW_COLUMNS};
use whiteboard::problem::{self, Problem};
use whiteboard::runner::{self, CaseResult};

const RUN_TIMEOUT: Duration = Duration::from_secs(8);
const STUB: &str = "class Solution:\n    pass\n";

#[derive(Parser)]
#[command(
    name = "audit-tests",
    about = "Flag indexed problems whose tests RustPython cannot execute"
)]
struct Args {
    /// Dataset slug (repeatable). Default: every indexed corpus except kodcode.
    #[arg(long)]
    dataset: Vec<String>,
    /// Include KodCode (ignored if --dataset is set without kodcode).
    #[arg(long)]
    all: bool,
    #[arg(long)]
    limit: Option<usize>,
    #[arg(long, default_value_t = 0)]
    offset: usize,
    /// Random subset after offset (KodCode smoke: `--dataset kodcode --sample 500`).
    #[arg(long)]
    sample: Option<usize>,
    /// Also run `--full` when the problem has a `test` suite.
    #[arg(long)]
    full: bool,
    /// JSONL of issues (default: `audit-tests.jsonl` in cwd). `-` writes stdout.
    #[arg(long, default_value = "audit-tests.jsonl")]
    out: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IssueKind {
    NoTests,
    LoadError,
    Syntax,
    MissingModule,
    MissingEntry,
    Crash,
    Harness,
}

#[derive(Serialize)]
struct Issue {
    dataset: String,
    task_id: String,
    json_path: String,
    kind: IssueKind,
    detail: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    // Pin `--out` before any workspace scratch work. Relative paths would
    // otherwise follow a later cwd change into the temp scan dirs.
    let out = if args.out == "-" {
        None
    } else {
        let path = PathBuf::from(&args.out);
        Some(if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        })
    };
    let conn = index::open_db().with_context(|| {
        format!(
            "cannot open {} — run `lc index` first",
            index::db_path().map(|p| p.display().to_string()).unwrap_or_else(|_| "problems.db".into())
        )
    })?;
    eprintln!("index {}", index::db_path()?.display());

    let targets = target_datasets(&args)?;
    let mut all_issues: Vec<Issue> = Vec::new();
    let scratch = std::env::temp_dir().join("lc-audit-tests");
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch)?;

    for dataset in targets {
        let mut rows = load_rows(&conn, dataset, args.sample)?;
        if rows.is_empty() {
            eprintln!(
                "{}: not indexed — `lc index --dataset {}`",
                dataset.id, dataset.id
            );
            continue;
        }
        if args.sample.is_none() {
            if args.offset > 0 {
                if args.offset >= rows.len() {
                    eprintln!("{}: offset {} past {} rows", dataset.id, args.offset, rows.len());
                    continue;
                }
                rows = rows.split_off(args.offset);
            }
            if let Some(limit) = args.limit {
                rows.truncate(limit);
            }
        }
        eprintln!("{}: {} indexed rows to scan", dataset.id, rows.len());
        let issues = scan_dataset(dataset, &rows, args.full, &scratch)?;
        eprintln!(
            "{}: {} issues / {} scanned",
            dataset.id,
            issues.len(),
            rows.len()
        );
        all_issues.extend(issues);
    }

    let _ = fs::remove_dir_all(&scratch);

    if let Some(path) = &out {
        let mut body = String::new();
        for issue in &all_issues {
            body.push_str(&serde_json::to_string(issue)?);
            body.push('\n');
        }
        fs::write(path, body).with_context(|| format!("cannot write {}", path.display()))?;
        eprintln!("wrote {} issues → {}", all_issues.len(), path.display());
    } else {
        for issue in &all_issues {
            println!("{}", serde_json::to_string(issue)?);
        }
    }

    print_summary(&all_issues);
    Ok(())
}

fn target_datasets(args: &Args) -> Result<Vec<&'static Dataset>> {
    if !args.dataset.is_empty() {
        let mut out = Vec::new();
        for slug in &args.dataset {
            out.push(dataset::get(slug)?);
        }
        return Ok(out);
    }
    Ok(DATASETS
        .iter()
        .filter(|d| args.all || d.id != "kodcode")
        .collect())
}

fn load_rows(
    conn: &rusqlite::Connection,
    dataset: &'static Dataset,
    sample: Option<usize>,
) -> Result<Vec<ProblemRow>> {
    let sql = if let Some(n) = sample {
        format!(
            "SELECT {ROW_COLUMNS} FROM {} ORDER BY RANDOM() LIMIT {n}",
            dataset.table
        )
    } else {
        format!("SELECT {ROW_COLUMNS} FROM {} ORDER BY task_id", dataset.table)
    };
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map([], index::row_reader(dataset))?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row?);
    }
    Ok(out)
}

fn scan_dataset(
    dataset: &'static Dataset,
    rows: &[ProblemRow],
    run_full: bool,
    scratch: &Path,
) -> Result<Vec<Issue>> {
    let mut wanted: HashMap<String, HashSet<String>> = HashMap::new();
    for row in rows {
        wanted
            .entry(row.json_path.clone())
            .or_default()
            .insert(row.task_id.clone());
    }

    let mut loaded: HashMap<String, Problem> = HashMap::new();
    let mut load_errors: Vec<Issue> = Vec::new();

    for (json_path, ids) in &wanted {
        let path = Path::new(json_path);
        if ids.len() == 1 {
            let task_id = ids.iter().next().unwrap();
            match problem::load_task_for(dataset, path, task_id) {
                Ok(p) => {
                    loaded.insert(task_id.clone(), p);
                }
                Err(err) => load_errors.push(Issue {
                    dataset: dataset.id.to_string(),
                    task_id: task_id.clone(),
                    json_path: json_path.clone(),
                    kind: IssueKind::LoadError,
                    detail: format!("{err:#}"),
                }),
            }
            continue;
        }
        let mut remaining = ids.clone();
        if let Err(err) = problem::for_each_for(dataset, path, |p| {
            if remaining.remove(&p.task_id) {
                loaded.insert(p.task_id.clone(), p);
            }
            Ok(())
        }) {
            for task_id in remaining {
                load_errors.push(Issue {
                    dataset: dataset.id.to_string(),
                    task_id,
                    json_path: json_path.clone(),
                    kind: IssueKind::LoadError,
                    detail: format!("{err:#}"),
                });
            }
        } else {
            for task_id in remaining {
                load_errors.push(Issue {
                    dataset: dataset.id.to_string(),
                    task_id,
                    json_path: json_path.clone(),
                    kind: IssueKind::LoadError,
                    detail: "task_id not found in corpus file".into(),
                });
            }
        }
    }

    let mut issues = load_errors;
    let started = Instant::now();
    let total = rows.len();
    for (i, row) in rows.iter().enumerate() {
        if let Some(problem) = loaded.get(&row.task_id) {
            if let Some(issue) = audit_problem(dataset, row, problem, run_full, scratch) {
                issues.push(issue);
            }
        }
        if (i + 1) % 25 == 0 || i + 1 == total {
            let secs = started.elapsed().as_secs_f32().max(0.001);
            eprintln!(
                "  {} {}/{}  {:.1}/s  {} issues",
                dataset.id,
                i + 1,
                total,
                (i + 1) as f32 / secs,
                issues.len()
            );
        }
    }
    Ok(issues)
}

fn audit_problem(
    dataset: &'static Dataset,
    row: &ProblemRow,
    problem: &Problem,
    run_full: bool,
    scratch: &Path,
) -> Option<Issue> {
    let no_cases = problem.input_output.is_empty();
    let no_suite = problem
        .test
        .as_deref()
        .map(|t| t.trim().is_empty())
        .unwrap_or(true);
    if no_cases && no_suite {
        return Some(issue(dataset, row, IssueKind::NoTests, "no sample cases and no test suite"));
    }

    let dir = scratch.join(dataset.id).join(sanitize_id(&row.task_id));
    if let Err(err) = write_stub_workspace(&dir, dataset, row, problem) {
        return Some(issue(dataset, row, IssueKind::Harness, format!("cannot write temp workspace: {err:#}")));
    }

    let (results, err, timed_out) = run_with_timeout(&dir, &[]);
    let kind = classify(
        &results,
        err.as_deref(),
        timed_out,
        problem.entry_point.as_deref(),
    );
    if let Some(kind) = kind {
        let _ = fs::remove_dir_all(&dir);
        return Some(issue(
            dataset,
            row,
            kind,
            err.unwrap_or_else(|| summarize(&results)),
        ));
    }

    if run_full && !no_suite {
        let (results, err, timed_out) = run_with_timeout(&dir, &["--full"]);
        let kind = classify(
            &results,
            err.as_deref(),
            timed_out,
            problem.entry_point.as_deref(),
        );
        let _ = fs::remove_dir_all(&dir);
        return kind.map(|kind| {
            issue(
                dataset,
                row,
                kind,
                err.unwrap_or_else(|| summarize(&results)),
            )
        });
    }

    let _ = fs::remove_dir_all(&dir);
    None
}

fn write_stub_workspace(
    dir: &Path,
    dataset: &Dataset,
    row: &ProblemRow,
    problem: &Problem,
) -> Result<()> {
    fs::create_dir_all(dir.join(".lc"))?;
    let mut body = generator::solution_stub(problem);
    if body.trim().is_empty() {
        body = STUB.to_string();
    }
    body = fill_empty_blocks(&body);
    fs::write(dir.join("solution.py"), body)?;
    fs::write(dir.join("run_tests.py"), RUN_TESTS_PY)?;
    let meta = WorkspaceMeta {
        dataset: dataset.id.to_string(),
        task_id: problem.task_id.clone(),
        question_id: problem.question_id.clone(),
        difficulty: problem.difficulty.clone(),
        tags: problem.tags.clone(),
        entry_point: problem.entry_point.clone(),
        json_path: row.json_path.clone(),
        cases: problem.input_output.clone(),
        test: problem.test.clone(),
    };
    fs::write(
        dir.join(".lc").join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;
    Ok(())
}

fn run_with_timeout(dir: &Path, extra: &[&str]) -> (Vec<CaseResult>, Option<String>, bool) {
    let dir = dir.to_path_buf();
    let extra: Vec<String> = extra.iter().map(|s| (*s).to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let refs: Vec<&str> = extra.iter().map(|s| s.as_str()).collect();
        let sent = match runner::execute_run_tests(&dir, &refs) {
            Ok((results, _stdout, stderr)) => {
                if results.is_empty() {
                    Err(format!(
                        "no JSONL from runner{}",
                        if stderr.trim().is_empty() {
                            String::new()
                        } else {
                            format!("\n{stderr}")
                        }
                    ))
                } else {
                    Ok(results)
                }
            }
            Err(err) => Err(format!("{err:#}")),
        };
        let _ = tx.send(sent);
    });
    match rx.recv_timeout(RUN_TIMEOUT) {
        Ok(Ok(results)) => (results, None, false),
        Ok(Err(err)) => (Vec::new(), Some(err), false),
        Err(_) => (Vec::new(), Some("runner timed out (8s)".into()), true),
    }
}

fn classify(
    results: &[CaseResult],
    exec_err: Option<&str>,
    timed_out: bool,
    entry_point: Option<&str>,
) -> Option<IssueKind> {
    if timed_out {
        return Some(IssueKind::Crash);
    }
    let blob = {
        let mut parts: Vec<&str> = Vec::new();
        if let Some(err) = exec_err {
            parts.push(err);
        }
        for result in results {
            if let Some(error) = result.error.as_deref() {
                parts.push(error);
            }
        }
        parts.join("\n")
    };
    if let Some(kind) = kind_from_text(&blob, entry_point) {
        return Some(kind);
    }
    if results.is_empty() {
        return Some(IssueKind::Crash);
    }
    // Stub fail as JSONL is healthy — including TypeError/None from `pass`.
    None
}

fn kind_from_text(blob: &str, _entry_point: Option<&str>) -> Option<IssueKind> {
    if blob.is_empty() {
        return None;
    }
    if blob.contains("timed out") {
        return Some(IssueKind::Crash);
    }
    if blob.contains("SyntaxError") || blob.contains("IndentationError") || blob.contains("TabError")
    {
        return Some(IssueKind::Syntax);
    }
    if blob.contains("ModuleNotFoundError") || blob.contains("ImportError") {
        return Some(IssueKind::MissingModule);
    }
    if (blob.contains("is not defined") && blob.contains("Solution"))
        || blob.contains("cannot find entry point")
        || blob.contains("could not find")
    {
        return Some(IssueKind::MissingEntry);
    }
    // Stub internals (`obj.history`, `self.x`) are red cases, not missing entry.
    if blob.contains("panicked") || blob.contains("stack overflow") || blob.contains("no JSONL") {
        return Some(IssueKind::Crash);
    }
    if blob.contains("this problem has no") && blob.contains("test") {
        return Some(IssueKind::NoTests);
    }
    // Harness: runner itself blew up, not a normal stub miss.
    if blob.contains("RustPython failed") || blob.contains("cannot spawn") {
        return Some(IssueKind::Crash);
    }
    None
}

fn summarize(results: &[CaseResult]) -> String {
    results
        .iter()
        .find_map(|r| r.error.clone())
        .or_else(|| results.first().and_then(|r| r.actual.clone()))
        .unwrap_or_else(|| format!("{} JSONL lines", results.len()))
}

fn issue(dataset: &Dataset, row: &ProblemRow, kind: IssueKind, detail: impl Into<String>) -> Issue {
    let detail = detail.into();
    let clipped = {
        let line = last_error_line(&detail);
        if line.len() > 240 {
            format!("{}…", &line[..240])
        } else {
            line
        }
    };
    Issue {
        dataset: dataset.id.to_string(),
        task_id: row.task_id.clone(),
        json_path: row.json_path.clone(),
        kind,
        detail: clipped,
    }
}

fn opens_python_suite(line: &str) -> bool {
    let s = line.trim_start();
    if s.is_empty() || s.starts_with('#') {
        return false;
    }
    s.starts_with("def ")
        || s.starts_with("async def ")
        || s.starts_with("class ")
        || s.starts_with("if ")
        || s.starts_with("elif ")
        || s.starts_with("else:")
        || s.starts_with("for ")
        || s.starts_with("async for ")
        || s.starts_with("while ")
        || s.starts_with("try:")
        || s.starts_with("except")
        || s.starts_with("finally:")
        || s.starts_with("with ")
        || s.starts_with("async with ")
        || s.starts_with("match ")
        || s.starts_with("case ")
}

fn fill_empty_blocks(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        out.push((*line).to_string());
        let trimmed = line.trim_end();
        if !trimmed.ends_with(':') || !opens_python_suite(trimmed) {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let next = lines.get(i + 1).map(|s| s.as_ref()).unwrap_or("");
        let next_trim = next.trim();
        let next_indent = next.len() - next.trim_start().len();
        let needs_pass = next_trim.is_empty()
            || next_trim.starts_with('#')
            || (!next_trim.is_empty() && next_indent <= indent);
        if needs_pass {
            out.push(format!("{}    pass", " ".repeat(indent)));
        }
    }
    if !src.ends_with('\n') {
        out.join("\n")
    } else {
        format!("{}\n", out.join("\n"))
    }
}

fn last_error_line(detail: &str) -> String {
    detail
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(detail)
        .trim()
        .to_string()
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn print_summary(issues: &[Issue]) {
    let mut counts: BTreeMap<String, BTreeMap<IssueKind, usize>> = BTreeMap::new();
    for issue in issues {
        *counts
            .entry(issue.dataset.clone())
            .or_default()
            .entry(issue.kind)
            .or_insert(0) += 1;
    }
    eprintln!("\nsummary");
    if counts.is_empty() {
        eprintln!("  no issues");
        return;
    }
    for (dataset, kinds) in counts {
        eprint!("  {dataset}:");
        for (kind, n) in kinds {
            eprint!(" {kind:?}={n}");
        }
        eprintln!();
    }
    eprintln!("  total issues {}", issues.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commented_api_stubs_do_not_get_a_pass_body() {
        let src = "\
# def isBadVersion(version: int) -> bool:

class Solution:
    def firstBadVersion(self, n: int) -> int:
";
        let filled = fill_empty_blocks(src);
        assert!(!filled.contains("    pass\n\nclass"), "{filled}");
        assert!(filled.contains("def firstBadVersion"), "{filled}");
        assert!(filled.contains("        pass"), "{filled}");
    }

    #[test]
    fn missing_internal_attr_is_not_missing_entry() {
        let blob = "AttributeError: 'BrowserHistory' object has no attribute 'history'";
        assert_eq!(kind_from_text(blob, Some("visit")), None);
        let missing = "AttributeError: cannot find entry point 'visit' as a Solution method or module-level function";
        assert_eq!(kind_from_text(missing, Some("visit")), Some(IssueKind::MissingEntry));
        let internal = "AttributeError: 'H2O' object has no attribute 'hydrogenSemaphore'";
        assert_eq!(kind_from_text(internal, Some("hydrogen")), None);
    }
}

