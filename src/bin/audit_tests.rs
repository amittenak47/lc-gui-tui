//! Walk the existing SQLite corpus index and list problems whose tests
//! RustPython cannot execute. Does not re-index. Does not mutate `problems.db`
//! or `~/lc-workspace`. KodCode is skipped unless `--all` / `--dataset kodcode`.
//!
//! Writes one JSON object per issue (dataset, task_id, json_path, kind, detail)
//! to `--out` (default `audit-tests.jsonl`). Stderr is the count summary only.
//!
//! Issues and a sibling `.progress.json` are flushed every `--flush-every`
//! scanned rows (default 25) so a crash does not lose the run. Resume with
//! `--resume` using the same `--out`. KodCode is scanned **one jsonl shard at
//! a time** so the process does not hold every problem in RAM.
//!
//! ```text
//! cargo run --release --bin audit_tests -- --dataset leetcode --limit 50
//! cargo run --release --bin audit_tests -- --dataset kodcode --out audit-kodcode.jsonl
//! cargo run --release --bin audit_tests -- --dataset kodcode --out audit-kodcode.jsonl --resume
//! cargo run --release --bin audit_tests -- --dataset kodcode --sample 500
//! cargo run --release --bin audit_tests -- --dataset kodcode --full
//! ```

use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
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
const DEFAULT_FLUSH_EVERY: usize = 25;

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
    /// Flush issues + progress every N scanned rows (default 25).
    #[arg(long, default_value_t = DEFAULT_FLUSH_EVERY)]
    flush_every: usize,
    /// Append to `--out` and skip rows already recorded in the sibling `.progress.json`.
    #[arg(long)]
    resume: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Issue {
    dataset: String,
    task_id: String,
    json_path: String,
    kind: IssueKind,
    detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ScanProgress {
    dataset: String,
    json_path: String,
    last_task_id: String,
    scanned: usize,
    issues: usize,
}

fn progress_path_for(out: &Path) -> PathBuf {
    let mut raw = out.as_os_str().to_os_string();
    raw.push(".progress.json");
    PathBuf::from(raw)
}

struct IssueSink {
    writer: Option<BufWriter<File>>,
    progress_path: Option<PathBuf>,
    pending: String,
    flush_every: usize,
    since_flush: usize,
    scanned: usize,
    issues: usize,
    dataset: String,
    json_path: String,
    last_task_id: String,
}

impl IssueSink {
    fn create(out: Option<&Path>, resume: bool, flush_every: usize) -> Result<(Self, Option<ScanProgress>)> {
        let flush_every = flush_every.max(1);
        let Some(out) = out else {
            if resume {
                bail!("--resume needs --out (not '-')");
            }
            return Ok((
                Self {
                    writer: None,
                    progress_path: None,
                    pending: String::new(),
                    flush_every,
                    since_flush: 0,
                    scanned: 0,
                    issues: 0,
                    dataset: String::new(),
                    json_path: String::new(),
                    last_task_id: String::new(),
                },
                None,
            ));
        };

        let progress_path = progress_path_for(out);
        let prior = if resume {
            let raw = fs::read_to_string(&progress_path).with_context(|| {
                format!("--resume needs {} (no progress from a crashed pre-flush run)", progress_path.display())
            })?;
            Some(serde_json::from_str::<ScanProgress>(&raw)?)
        } else {
            None
        };

        if let Some(parent) = out.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resume)
            .truncate(!resume)
            .open(out)
            .with_context(|| format!("cannot open {}", out.display()))?;

        let sink = Self {
            writer: Some(BufWriter::new(file)),
            progress_path: Some(progress_path),
            pending: String::new(),
            flush_every,
            since_flush: 0,
            scanned: prior.as_ref().map(|p| p.scanned).unwrap_or(0),
            issues: prior.as_ref().map(|p| p.issues).unwrap_or(0),
            dataset: prior.as_ref().map(|p| p.dataset.clone()).unwrap_or_default(),
            json_path: prior.as_ref().map(|p| p.json_path.clone()).unwrap_or_default(),
            last_task_id: prior.as_ref().map(|p| p.last_task_id.clone()).unwrap_or_default(),
        };
        Ok((sink, prior))
    }

    fn push_issue(&mut self, issue: Issue) -> Result<()> {
        self.issues += 1;
        self.pending.push_str(&serde_json::to_string(&issue)?);
        self.pending.push('\n');
        if self.writer.is_none() {
            println!("{}", serde_json::to_string(&issue)?);
            self.pending.clear();
        }
        Ok(())
    }

    fn note_row(&mut self, dataset: &str, json_path: &str, task_id: &str) -> Result<()> {
        self.scanned += 1;
        self.since_flush += 1;
        self.dataset = dataset.to_string();
        self.json_path = json_path.to_string();
        self.last_task_id = task_id.to_string();
        if self.since_flush >= self.flush_every {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        if let Some(writer) = self.writer.as_mut() {
            if !self.pending.is_empty() {
                writer.write_all(self.pending.as_bytes())?;
                self.pending.clear();
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        self.since_flush = 0;
        if let Some(path) = &self.progress_path {
            if !self.last_task_id.is_empty() {
                write_progress_atomic(
                    path,
                    &ScanProgress {
                        dataset: self.dataset.clone(),
                        json_path: self.json_path.clone(),
                        last_task_id: self.last_task_id.clone(),
                        scanned: self.scanned,
                        issues: self.issues,
                    },
                )?;
            }
        }
        Ok(())
    }
}

fn write_progress_atomic(path: &Path, progress: &ScanProgress) -> Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, serde_json::to_vec_pretty(progress)?)
        .with_context(|| format!("cannot write {}", tmp.display()))?;
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).with_context(|| format!("cannot replace {}", path.display()))?;
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.resume && args.sample.is_some() {
        bail!("--resume cannot be used with --sample (order is random)");
    }
    if args.resume && args.offset > 0 {
        bail!("--resume cannot be used with --offset (progress file is the offset)");
    }

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

    let (mut sink, prior) = IssueSink::create(out.as_deref(), args.resume, args.flush_every)?;
    if let Some(prior) = &prior {
        eprintln!(
            "resume {} after {} scanned ({} issues) at {}",
            prior.dataset, prior.scanned, prior.issues, prior.last_task_id
        );
    }

    let targets = target_datasets(&args)?;
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

        let mut groups = group_rows_by_path(&rows);
        if let Some(prior) = &prior {
            if prior.dataset != dataset.id {
                bail!(
                    "--resume progress is for {}, this scan is {}",
                    prior.dataset,
                    dataset.id
                );
            }
            groups = apply_resume(groups, prior)?;
        }

        let remaining: usize = groups.iter().map(|(_, rows)| rows.len()).sum();
        eprintln!(
            "{}: {} indexed rows to scan ({} this session)",
            dataset.id,
            rows.len(),
            remaining
        );
        scan_dataset(dataset, &groups, args.full, &scratch, &mut sink)?;
        sink.flush()?;
        eprintln!(
            "{}: {} issues / {} scanned (this file on disk)",
            dataset.id,
            sink.issues,
            sink.scanned
        );
    }

    let _ = fs::remove_dir_all(&scratch);
    sink.flush()?;

    if let Some(path) = &out {
        let issues = load_issues(path)?;
        print_summary(&issues);
        eprintln!("wrote {} issues → {}", issues.len(), path.display());
    } else {
        eprintln!("\nsummary (stdout; {} issues this session)", sink.issues);
    }

    Ok(())
}

fn load_issues(path: &Path) -> Result<Vec<Issue>> {
    let raw = fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        out.push(
            serde_json::from_str(line)
                .with_context(|| format!("{}:{}: bad issue json", path.display(), i + 1))?,
        );
    }
    Ok(out)
}

fn group_rows_by_path(rows: &[ProblemRow]) -> Vec<(String, Vec<&ProblemRow>)> {
    let mut order = Vec::new();
    let mut map: HashMap<String, Vec<&ProblemRow>> = HashMap::new();
    for row in rows {
        map.entry(row.json_path.clone())
            .or_insert_with(|| {
                order.push(row.json_path.clone());
                Vec::new()
            })
            .push(row);
    }
    order
        .into_iter()
        .map(|path| {
            let rows = map.remove(&path).unwrap_or_default();
            (path, rows)
        })
        .collect()
}

fn apply_resume<'a>(
    groups: Vec<(String, Vec<&'a ProblemRow>)>,
    progress: &ScanProgress,
) -> Result<Vec<(String, Vec<&'a ProblemRow>)>> {
    let mut out = Vec::new();
    let mut seen_file = false;
    for (path, rows) in groups {
        if !seen_file {
            if path != progress.json_path {
                continue;
            }
            seen_file = true;
            let Some(pos) = rows.iter().position(|row| row.task_id == progress.last_task_id) else {
                bail!(
                    "resume: {} not found in {} — progress file does not match this index",
                    progress.last_task_id,
                    path
                );
            };
            let rest = rows[pos + 1..].to_vec();
            if !rest.is_empty() {
                out.push((path, rest));
            }
            continue;
        }
        out.push((path, rows));
    }
    if !seen_file {
        bail!(
            "resume: json_path {} is not in this scan — progress file does not match",
            progress.json_path
        );
    }
    Ok(out)
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
    groups: &[(String, Vec<&ProblemRow>)],
    run_full: bool,
    scratch: &Path,
    sink: &mut IssueSink,
) -> Result<()> {
    let started = Instant::now();
    let session_total: usize = groups.iter().map(|(_, rows)| rows.len()).sum();
    let mut session_done = 0usize;

    for (json_path, path_rows) in groups {
        let wanted: HashSet<String> = path_rows.iter().map(|row| row.task_id.clone()).collect();
        let mut loaded: HashMap<String, Problem> = HashMap::new();
        let path = Path::new(json_path);

        if wanted.len() == 1 {
            let task_id = wanted.iter().next().unwrap();
            match problem::load_task_for(dataset, path, task_id) {
                Ok(p) => {
                    loaded.insert(task_id.clone(), p);
                }
                Err(err) => {
                    sink.push_issue(Issue {
                        dataset: dataset.id.to_string(),
                        task_id: task_id.clone(),
                        json_path: json_path.clone(),
                        kind: IssueKind::LoadError,
                        detail: format!("{err:#}"),
                    })?;
                }
            }
        } else {
            let mut remaining = wanted.clone();
            if let Err(err) = problem::for_each_for(dataset, path, |p| {
                if remaining.remove(&p.task_id) {
                    loaded.insert(p.task_id.clone(), p);
                }
                Ok(())
            }) {
                for row in path_rows {
                    sink.push_issue(Issue {
                        dataset: dataset.id.to_string(),
                        task_id: row.task_id.clone(),
                        json_path: json_path.clone(),
                        kind: IssueKind::LoadError,
                        detail: format!("{err:#}"),
                    })?;
                    session_done += 1;
                    sink.note_row(dataset.id, json_path, &row.task_id)?;
                }
                sink.flush()?;
                continue;
            }
            for row in path_rows {
                if remaining.contains(&row.task_id) {
                    sink.push_issue(Issue {
                        dataset: dataset.id.to_string(),
                        task_id: row.task_id.clone(),
                        json_path: json_path.clone(),
                        kind: IssueKind::LoadError,
                        detail: "task_id not found in corpus file".into(),
                    })?;
                }
            }
        }

        for row in path_rows {
            if let Some(problem) = loaded.get(&row.task_id) {
                if let Some(found) = audit_problem(dataset, row, problem, run_full, scratch) {
                    sink.push_issue(found)?;
                }
            }
            session_done += 1;
            sink.note_row(dataset.id, json_path, &row.task_id)?;
            if session_done % 25 == 0 || session_done == session_total {
                let secs = started.elapsed().as_secs_f32().max(0.001);
                eprintln!(
                    "  {} {}/{}  {:.1}/s  {} issues",
                    dataset.id,
                    sink.scanned,
                    sink.scanned + (session_total - session_done),
                    session_done as f32 / secs,
                    sink.issues
                );
            }
        }
        drop(loaded);
        sink.flush()?;
    }
    Ok(())
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

    fn dummy_row(task_id: &str, json_path: &str) -> ProblemRow {
        ProblemRow {
            dataset: "kodcode",
            task_id: task_id.into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            json_path: json_path.into(),
            test_count: 0,
        }
    }

    #[test]
    fn progress_path_sits_next_to_the_jsonl() {
        let path = progress_path_for(Path::new("audit-kodcode.jsonl"));
        assert!(path.to_string_lossy().ends_with("audit-kodcode.jsonl.progress.json"), "{path:?}");
    }

    #[test]
    fn resume_skips_completed_rows_in_the_current_shard() {
        let a1 = dummy_row("a1", "shard-a.jsonl");
        let a2 = dummy_row("a2", "shard-a.jsonl");
        let b1 = dummy_row("b1", "shard-b.jsonl");
        let groups = vec![
            ("shard-a.jsonl".into(), vec![&a1, &a2]),
            ("shard-b.jsonl".into(), vec![&b1]),
        ];
        let progress = ScanProgress {
            dataset: "kodcode".into(),
            json_path: "shard-a.jsonl".into(),
            last_task_id: "a1".into(),
            scanned: 1,
            issues: 0,
        };
        let next = apply_resume(groups, &progress).unwrap();
        assert_eq!(next.len(), 2);
        assert_eq!(next[0].1.iter().map(|r| r.task_id.as_str()).collect::<Vec<_>>(), vec!["a2"]);
        assert_eq!(next[1].1.iter().map(|r| r.task_id.as_str()).collect::<Vec<_>>(), vec!["b1"]);
    }

    #[test]
    fn resume_moves_on_when_the_shard_was_finished() {
        let a1 = dummy_row("a1", "shard-a.jsonl");
        let b1 = dummy_row("b1", "shard-b.jsonl");
        let groups = vec![
            ("shard-a.jsonl".into(), vec![&a1]),
            ("shard-b.jsonl".into(), vec![&b1]),
        ];
        let progress = ScanProgress {
            dataset: "kodcode".into(),
            json_path: "shard-a.jsonl".into(),
            last_task_id: "a1".into(),
            scanned: 1,
            issues: 0,
        };
        let next = apply_resume(groups, &progress).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].0, "shard-b.jsonl");
    }
}

